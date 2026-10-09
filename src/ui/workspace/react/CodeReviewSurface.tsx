// @ts-nocheck: Workspace React islands compile TSX, but this module uses JSDoc-style JavaScript only.
import { updateReviewInteractionUrl } from "../browser/review-navigation.ts";
import { RunWieldMenu, RunWieldMenuItem } from "../../design-system/components/react/RunWieldMenu.tsx";
import { RunWieldIconButton } from "../../design-system/components/react/RunWieldIconButton.tsx";
import { animateSidebarUpdate } from "../../design-system/components/react/sidebar-motion.ts";
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

import { RunWieldSegmentedControl } from "../../design-system/components/react/RunWieldSegmentedControl.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { GuideView } from "@plannotator/guide-viewer/GuideView.tsx";
import { GuideHostProvider } from "@plannotator/guide-viewer/host.tsx";
import { renderMarkdownProse } from "@plannotator/guide-viewer/renderMarkdownProse.tsx";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider.tsx";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip.tsx";
import { ApproveButton, FeedbackButton } from "@plannotator/ui/components/ToolbarButtons.tsx";
import { ReviewCompletion } from "./ReviewCompletion.tsx";
import { CommentPopover } from "@plannotator/ui/components/CommentPopover.tsx";
import { configStore, setReviewPanelView, useConfigValue } from "@plannotator/ui/config/index.ts";
import { AllFilesCodeView } from "../../../../third_party/plannotator/packages/review-editor/components/AllFilesCodeView.tsx";
import { FileTree } from "../../../../third_party/plannotator/packages/review-editor/components/FileTree.tsx";
import { ReviewSidebar } from "../../../../third_party/plannotator/packages/review-editor/components/ReviewSidebar.tsx";
import { SectionsPanel } from "../../../../third_party/plannotator/packages/review-editor/components/SectionsPanel.tsx";
import { parseDiffToFiles } from "../../../../third_party/plannotator/packages/review-editor/utils/diffParser.ts";
import { exportReviewFeedback } from "../../../../third_party/plannotator/packages/review-editor/utils/exportFeedback.ts";
import { PlanReviewSettings } from "./PlanReviewSettings.tsx";
import { WorkspaceHeaderActionsPortal } from "./WorkspaceHeaderActionsPortal.tsx";
import { ReviewContextBar } from "./ReviewContextBar.tsx";
import { ArtifactConversationSidebar } from "./ArtifactConversationSidebar.tsx";
import { buildArtifactConversationFeedback, collectArtifactConversationReply } from "./artifact-conversation.ts";
import { useCodeReviewHighlighting } from "./code-review-highlighting.ts";
import { formatGuidedReviewGenerator, formatGuidedReviewUsageStatus } from "./guided-review-status.ts";
import "./plannotator.css";

const DEFAULT_CODE_PAYLOAD = {
    rawPatch: "",
    gitRef: "",
    agentCwd: "",
    planName: "",
    planTitle: "",
    token: "",
    mode: "dev",
    reviewStatus: null,
    guidedReview: null,
};

const FILE_PANEL_DEFAULT_WIDTH = 288;
const FILE_PANEL_MIN_WIDTH = 208;
const FILE_PANEL_MAX_WIDTH = 520;
const DIFF_STYLE_STORAGE_KEY = "runwield-code-review-diff-style";
const FILE_PANEL_MODE_STORAGE_KEY = "runwield-code-review-file-panel-mode";

function readLocalPreference(key) {
    try {
        return globalThis.localStorage?.getItem(key) || null;
    } catch {
        return null;
    }
}

function writeLocalPreference(key, value) {
    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        // The in-memory choice can continue when browser storage is unavailable.
    }
}

function readStoredDiffStyle() {
    const value = readLocalPreference(DIFF_STYLE_STORAGE_KEY);
    return value === "split" || value === "unified" ? value : null;
}

function readStoredFilePanelMode() {
    const value = readLocalPreference(FILE_PANEL_MODE_STORAGE_KEY);
    return value === "tree" || value === "changes" ? value : null;
}

function toReviewPanelView(filePanelMode) {
    return filePanelMode === "tree" ? "tree" : "sections";
}

function getInitialFilePanelMode() {
    return readStoredFilePanelMode() || "tree";
}

function getInitialDiffStyle() {
    return readStoredDiffStyle() || configStore.get("diffStyle") || "split";
}

function clampFilePanelWidth(width) {
    return Math.min(FILE_PANEL_MAX_WIDTH, Math.max(FILE_PANEL_MIN_WIDTH, width));
}

async function waitForGuideJob(jobId, token, setGuideJob) {
    const started = Date.now();
    while (Date.now() - started < 120000) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 750));
        const response = await fetch(`/api/agents/jobs?token=${encodeURIComponent(token)}`, {
            headers: { "x-runwield-review-token": token },
        });
        if (!response.ok) throw new Error(await response.text() || `Guide job status failed: ${response.status}`);
        const data = await response.json();
        const job = (data.jobs || []).find((candidate) => candidate.id === jobId);
        if (job) {
            setGuideJob(job);
            if (["done", "failed", "killed"].includes(job.status)) return job;
        }
    }
    throw new Error("Timed out waiting for Guided Review generation.");
}

export function CodeReviewSurface({ payload, presentation = "standalone" }) {
    const initialPayload = useMemo(
        () => payload || readEmbeddedPayload("code-review-payload") || DEFAULT_CODE_PAYLOAD,
        [payload],
    );
    const [activeRawPatch, setActiveRawPatch] = useState(initialPayload.rawPatch || "");
    const [activeReviewStatus, setActiveReviewStatus] = useState(initialPayload.reviewStatus || null);
    const files = useMemo(() => parseDiffToFiles(activeRawPatch), [activeRawPatch]);
    const codeReviewPlanTitle = typeof initialPayload.planTitle === "string" && initialPayload.planTitle.trim()
        ? initialPayload.planTitle.trim()
        : typeof initialPayload.planName === "string" && initialPayload.planName.trim()
        ? initialPayload.planName.trim()
        : "Code changes";
    const codeReviewHeading = `Code Review - ${codeReviewPlanTitle}`;
    useEffect(() => {
        document.title = codeReviewHeading;
    }, [codeReviewHeading]);
    const highlightingReady = useCodeReviewHighlighting(files);
    const [activeFileIndex, setActiveFileIndex] = useState(0);
    const [annotations, setAnnotations] = useState([]);
    const [selectedAnnotationId, setSelectedAnnotationId] = useState(null);
    const [scrollTargetAnnotation, setScrollTargetAnnotation] = useState(null);
    const [pendingSelection, setPendingSelection] = useState(null);
    const [globalCommentOpen, setGlobalCommentOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [fileTreeOpen, setFileTreeOpen] = useState(true);
    const [filePanelMode, setFilePanelMode] = useState(getInitialFilePanelMode);
    const [filePanelWidth, setFilePanelWidth] = useState(FILE_PANEL_DEFAULT_WIDTH);
    const [resizingFilePanel, setResizingFilePanel] = useState(false);
    const [annotationsOpen, setAnnotationsOpen] = useState(true);
    const [rightSidebarView, setRightSidebarView] = useState("annotations");
    const [submitting, setSubmitting] = useState(null);
    const [submitted, setSubmitted] = useState(null);
    const [error, setError] = useState("");
    const [viewedFiles, setViewedFiles] = useState(new Set());
    const [fileNavigationTarget, setFileNavigationTarget] = useState(null);
    const [allFilesContentFits, setAllFilesContentFits] = useState(false);
    const [guideOpen, setGuideOpen] = useState(false);
    const [guideJob, setGuideJob] = useState(initialPayload.devGuideJob || null);
    const [guideCapabilities, setGuideCapabilities] = useState(
        initialPayload.devGuideCapabilities ||
            (initialPayload.mode === "workspace" ? { available: false, providers: [] } : null),
    );
    const [guide, setGuide] = useState(initialPayload.guidedReviewFixture || null);
    const [guideGenerating, setGuideGenerating] = useState(false);
    const [guideError, setGuideError] = useState("");
    const [conversationMessages, setConversationMessages] = useState([]);
    const [conversationComposer, setConversationComposer] = useState("");
    const [conversationContextAttached, setConversationContextAttached] = useState(false);
    const [agentWorking, setAgentWorking] = useState(false);
    const [agentError, setAgentError] = useState("");
    const [activeInteractionId, setActiveInteractionId] = useState(initialPayload.interactionId || "");
    const [activeInteractionAnswerUrl, setActiveInteractionAnswerUrl] = useState(
        initialPayload.interactionAnswerUrl || "",
    );
    const reviewMountedRef = useRef(true);
    useEffect(() => {
        reviewMountedRef.current = true;
        return () => {
            reviewMountedRef.current = false;
        };
    }, []);
    const autoGuideStartedRef = useRef(false);
    const filePanelResizeRef = useRef(null);
    const globalCommentButtonRef = useRef(null);
    const allFilesHostRef = useRef(null);
    const navigationLockRef = useRef(null);
    const configuredDiffStyle = useConfigValue("diffStyle") || "split";
    const [diffStyle, setLocalDiffStyle] = useState(getInitialDiffStyle);
    const diffOverflow = useConfigValue("diffOverflow") || "scroll";
    const diffIndicators = useConfigValue("diffIndicators") || "bars";
    const diffLineDiffType = useConfigValue("diffLineDiffType") || "word-alt";
    const diffShowLineNumbers = useConfigValue("diffShowLineNumbers") !== false;
    const diffShowBackground = useConfigValue("diffShowBackground") !== false;
    const diffExpandUnchanged = useConfigValue("diffExpandUnchanged") === true;
    const diffFontFamily = useConfigValue("diffFontFamily") || undefined;
    const diffFontSize = useConfigValue("diffFontSize") || undefined;
    const setDiffStyle = useCallback((style) => {
        setLocalDiffStyle(style);
        writeLocalPreference(DIFF_STYLE_STORAGE_KEY, style);
        configStore.setLocal("diffStyle", style);
    }, []);
    const setRememberedFilePanelMode = useCallback((mode) => {
        setFilePanelMode(mode);
        writeLocalPreference(FILE_PANEL_MODE_STORAGE_KEY, mode);
        setReviewPanelView(toReviewPanelView(mode));
    }, []);
    const currentFile = files[activeFileIndex] || files[0] || null;
    const sections = useMemo(
        () => buildReviewSections(files, activeReviewStatus),
        [files, activeReviewStatus],
    );
    const stagedFiles = useMemo(() =>
        new Set(
            Object.entries(sections.files)
                .filter(([, entry]) => entry?.staged === true)
                .map(([filePath]) => filePath),
        ), [sections]);
    const accordionFiles = useMemo(
        () => filePanelMode === "changes" ? orderFilesForChanges(files, sections, stagedFiles) : files,
        [filePanelMode, files, sections, stagedFiles],
    );
    const feedbackMarkdown = useMemo(
        () => annotations.length > 0 ? exportReviewFeedbackWithImages(annotations) : "",
        [annotations],
    );
    const agentLabel = initialPayload.agentLabel || "Reviewer Feedback Engineer";
    const conversationEnabled = initialPayload.mode === "dev" || Boolean(initialPayload.conversationStatusUrl) ||
        Boolean(initialPayload.operationStatusUrl && initialPayload.interactionAnswerBaseUrl);
    const attachedContextLabel = conversationContextAttached && annotations.length > 0
        ? `${annotations.length} code ${annotations.length === 1 ? "annotation" : "annotations"} attached`
        : undefined;
    const guidePolicy = initialPayload.guidedReview ||
        { mode: "auto", autoStart: false, manualAvailable: true, reasons: [] };
    const guideReady = Boolean(guide);
    const guideCapabilitiesKnown = initialPayload.mode === "dev" || guideCapabilities !== null;
    const guideProviderAvailable = initialPayload.mode === "dev"
        ? guideCapabilities?.available !== false
        : Boolean(guideCapabilities?.available);

    useEffect(() => {
        if (!readStoredDiffStyle()) setLocalDiffStyle(configuredDiffStyle);
    }, [configuredDiffStyle]);

    useEffect(() => {
        if (activeFileIndex < files.length) return;
        setActiveFileIndex(Math.max(0, files.length - 1));
    }, [activeFileIndex, files.length]);

    useEffect(() => {
        let canceled = false;
        if (!initialPayload.token || initialPayload.mode === "dev" || initialPayload.mode === "workspace") {
            return undefined;
        }
        fetch(`/api/agents/capabilities?token=${encodeURIComponent(initialPayload.token)}`, {
            headers: { "x-runwield-review-token": initialPayload.token },
        }).then((response) => response.ok ? response.json() : null).then((capabilities) => {
            if (!canceled) setGuideCapabilities(capabilities);
        }).catch(() => {
            if (!canceled) setGuideCapabilities({ available: false, providers: [] });
        });
        return () => {
            canceled = true;
        };
    }, [initialPayload.mode, initialPayload.token]);

    const generateGuide = useCallback(async () => {
        if (guideGenerating) return;
        setGuideError("");
        setGuideGenerating(true);
        try {
            if (initialPayload.mode === "dev") {
                await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
                if (initialPayload.devGuideFailure) throw new Error(initialPayload.devGuideFailure);
                if (!initialPayload.guidedReviewFixture) throw new Error("No dev Guided Review fixture is configured.");
                setGuide(initialPayload.guidedReviewFixture);
                setGuideJob(
                    initialPayload.devGuideJobDone || {
                        id: "dev-guide",
                        provider: "guide",
                        status: "done",
                        label: "Guided Review Explainer",
                    },
                );
                return;
            }
            const response = await fetch(`/api/agents/jobs?token=${encodeURIComponent(initialPayload.token)}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": initialPayload.token,
                },
                body: JSON.stringify({ provider: "guide", label: "Guided Review Explainer" }),
            });
            if (!response.ok) throw new Error(await response.text() || `Guide launch failed: ${response.status}`);
            const data = await response.json();
            const job = data.job;
            setGuideJob(job);
            const readyJob = await waitForGuideJob(job.id, initialPayload.token, setGuideJob);
            if (readyJob.status !== "done") throw new Error(readyJob.error || `Guide generation ${readyJob.status}`);
            const guideResponse = await fetch(
                `/api/guide/${encodeURIComponent(job.id)}?token=${encodeURIComponent(initialPayload.token)}`,
                {
                    headers: { "x-runwield-review-token": initialPayload.token },
                },
            );
            if (!guideResponse.ok) {
                throw new Error(await guideResponse.text() || `Guide load failed: ${guideResponse.status}`);
            }
            setGuide(await guideResponse.json());
        } catch (err) {
            setGuideError(err instanceof Error ? err.message : String(err));
        } finally {
            setGuideGenerating(false);
        }
    }, [guideGenerating, initialPayload]);

    useEffect(() => {
        if (!guidePolicy.autoStart || autoGuideStartedRef.current || guideReady || !guideCapabilitiesKnown) return;
        if (!guideProviderAvailable) return;
        autoGuideStartedRef.current = true;
        void generateGuide();
    }, [generateGuide, guideCapabilitiesKnown, guidePolicy.autoStart, guideProviderAvailable, guideReady]);

    const startFilePanelResize = useCallback((event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        filePanelResizeRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: filePanelWidth,
        };
        setResizingFilePanel(true);
    }, [filePanelWidth]);

    const resizeFilePanel = useCallback((event) => {
        const resize = filePanelResizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        setFilePanelWidth(clampFilePanelWidth(resize.startWidth + event.clientX - resize.startX));
    }, []);

    const finishFilePanelResize = useCallback((event) => {
        const resize = filePanelResizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        filePanelResizeRef.current = null;
        setResizingFilePanel(false);
    }, []);

    const resizeFilePanelWithKeyboard = useCallback((event) => {
        const step = event.shiftKey ? 48 : 16;
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            setFilePanelWidth((width) => clampFilePanelWidth(width - step));
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            setFilePanelWidth((width) => clampFilePanelWidth(width + step));
        } else if (event.key === "Home") {
            event.preventDefault();
            setFilePanelWidth(FILE_PANEL_MIN_WIDTH);
        } else if (event.key === "End") {
            event.preventDefault();
            setFilePanelWidth(FILE_PANEL_MAX_WIDTH);
        }
    }, []);

    const toggleViewedFile = useCallback((filePath) => {
        const wasViewed = viewedFiles.has(filePath);
        setViewedFiles((items) => {
            const next = new Set(items);
            if (next.has(filePath)) next.delete(filePath);
            else next.add(filePath);
            return next;
        });
        if (!wasViewed) return;

        const file = files.find((item) => item.path === filePath);
        if (!file) return;
        const scrollport = allFilesHostRef.current?.querySelector(".overflow-y-auto");
        setFileNavigationTarget({
            ...buildFileNavigationTarget(file),
            preserveScroll: true,
            scrollTop: scrollport?.scrollTop ?? 0,
        });
    }, [files, viewedFiles]);

    const navigateToFile = useCallback((index) => {
        const file = files[index];
        if (!file) return;
        navigationLockRef.current = file.path;
        setActiveFileIndex(index);
        setPendingSelection(null);
        setFileNavigationTarget(buildFileNavigationTarget(file));
    }, [files]);

    const handleVisibleFileChange = useCallback((filePath) => {
        if (navigationLockRef.current && navigationLockRef.current !== filePath) return;
        const index = files.findIndex((file) => file.path === filePath);
        if (index >= 0) setActiveFileIndex(index);
    }, [files]);

    useEffect(() => {
        if (!fileNavigationTarget || guideOpen) return;

        if (fileNavigationTarget.preserveScroll) {
            const scrollport = allFilesHostRef.current?.querySelector(".overflow-y-auto");
            if (!scrollport) return;
            const scrollTop = fileNavigationTarget.scrollTop;
            let frame;
            let attempts = 0;

            const preservePosition = () => {
                scrollport.scrollTop = scrollTop;
                if (attempts++ < 3) {
                    frame = requestAnimationFrame(preservePosition);
                    return;
                }
                setFileNavigationTarget((target) => target?.id === fileNavigationTarget.id ? null : target);
            };

            frame = requestAnimationFrame(preservePosition);
            return () => cancelAnimationFrame(frame);
        }

        let canceled = false;
        let timer;
        let attempts = 0;

        const alignSelectedFile = () => {
            if (canceled) return;
            const host = allFilesHostRef.current;
            const scrollport = host?.querySelector(".overflow-y-auto");
            const header = Array.from(host?.querySelectorAll("[slot='header-custom']") || [])
                .find((node) => node.textContent?.includes(fileNavigationTarget.filePath));

            if (!scrollport || !header) {
                if (attempts++ < 20) timer = globalThis.setTimeout(alignSelectedFile, 25);
                return;
            }

            const offset = header.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
            if (Math.abs(offset) > 1) scrollport.scrollTop += offset;
            const index = files.findIndex((file) => file.path === fileNavigationTarget.filePath);
            if (index >= 0) setActiveFileIndex(index);
            timer = globalThis.setTimeout(() => {
                if (navigationLockRef.current === fileNavigationTarget.filePath) {
                    navigationLockRef.current = null;
                }
            }, 150);
        };

        timer = globalThis.setTimeout(alignSelectedFile, 50);
        return () => {
            canceled = true;
            globalThis.clearTimeout(timer);
        };
    }, [fileNavigationTarget, files, guideOpen]);

    useEffect(() => {
        let canceled = false;
        let observer;
        let timer;

        const connect = () => {
            if (canceled) return;
            const scrollport = allFilesHostRef.current?.querySelector(".overflow-y-auto");
            const content = scrollport?.firstElementChild;
            if (!scrollport || !content) {
                timer = globalThis.setTimeout(connect, 25);
                return;
            }

            const update = () => {
                const fits = content.getBoundingClientRect().height <= scrollport.clientHeight;
                setAllFilesContentFits(fits);
            };
            observer = new ResizeObserver(update);
            observer.observe(scrollport);
            observer.observe(content);
            update();
        };

        connect();
        return () => {
            canceled = true;
            globalThis.clearTimeout(timer);
            observer?.disconnect();
        };
    }, [
        files,
        filePanelMode,
        diffStyle,
        diffOverflow,
        diffIndicators,
        diffLineDiffType,
        diffShowLineNumbers,
        diffShowBackground,
        diffExpandUnchanged,
        diffFontFamily,
        diffFontSize,
    ]);

    function addAnnotationForFile(
        file,
        type = "comment",
        text = "",
        suggestedCode,
        originalCode,
        conventionalLabel,
        decorations,
        tokenMeta,
    ) {
        if (!file) return;
        const range = pendingSelection || { start: 1, end: 1, side: "additions" };
        const next = {
            id: crypto.randomUUID(),
            type,
            scope: "line",
            filePath: file.path,
            lineStart: range.start,
            lineEnd: range.end,
            side: range.side === "deletions" ? "old" : "new",
            text,
            suggestedCode,
            originalCode,
            conventionalLabel,
            decorations,
            ...(tokenMeta && {
                charStart: tokenMeta.charStart,
                charEnd: tokenMeta.charEnd,
                tokenText: tokenMeta.tokenText,
            }),
            createdAt: Date.now(),
        };
        setAnnotations((items) => [...items, next]);
        setSelectedAnnotationId(next.id);
        setPendingSelection(null);
    }

    function addFileComment(filePath, text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        const next = {
            id: crypto.randomUUID(),
            type: "comment",
            scope: "file",
            filePath,
            lineStart: 1,
            lineEnd: 1,
            side: "new",
            text: trimmed,
            createdAt: Date.now(),
        };
        setAnnotations((items) => [...items, next]);
        setSelectedAnnotationId(next.id);
    }

    function editAnnotation(id, text, suggestedCode, originalCode, conventionalLabel, decorations) {
        setAnnotations((items) =>
            items.map((item) =>
                item.id === id
                    ? {
                        ...item,
                        ...(text !== undefined && { text }),
                        ...(suggestedCode !== undefined && { suggestedCode }),
                        ...(originalCode !== undefined && { originalCode }),
                        ...(conventionalLabel !== undefined && {
                            conventionalLabel: conventionalLabel ?? undefined,
                        }),
                        ...(decorations !== undefined && { decorations }),
                    }
                    : item
            )
        );
    }

    function addGlobalComment(text, images) {
        const next = {
            id: crypto.randomUUID(),
            type: "comment",
            scope: "general",
            filePath: "",
            lineStart: 0,
            lineEnd: 0,
            side: "new",
            text,
            ...(images?.length ? { images } : {}),
            createdAt: Date.now(),
        };
        setAnnotations((items) => [...items, next]);
        setSelectedAnnotationId(next.id);
        setGlobalCommentOpen(false);
    }

    function buildReviewPayload() {
        const workflowAnnotations = toWorkflowAnnotations(annotations);
        return {
            feedback: feedbackMarkdown,
            annotations: workflowAnnotations,
        };
    }

    async function submitApprove() {
        setSubmitting("approve");
        try {
            await submit("feedback", { approved: true, ...buildReviewPayload() });
            setSubmitted("approved");
        } catch {
            // submit() owns the visible error state.
        } finally {
            setSubmitting(null);
        }
    }

    async function submitFeedback() {
        if (conversationEnabled) {
            setRightSidebarView("agent");
            await sendAgentMessage(true);
            return;
        }
        setSubmitting("feedback");
        try {
            await submit("feedback", { approved: false, ...buildReviewPayload() });
            setSubmitted("feedback");
        } catch {
            // submit() owns the visible error state.
        } finally {
            setSubmitting(null);
        }
    }

    function attachReviewContextToConversation() {
        if (annotations.length === 0) return;
        setConversationContextAttached(true);
        setRightSidebarView("agent");
        setAgentError("");
    }

    async function sendAgentMessage(attachAnnotations = false) {
        const message = conversationComposer.trim();
        const attachedFeedback = (attachAnnotations === true || conversationContextAttached) && annotations.length > 0
            ? feedbackMarkdown
            : "";
        if ((!message && !attachedFeedback) || agentWorking) return;
        const userMessageId = `user-${crypto.randomUUID()}`;
        const agentMessageId = `agent-${crypto.randomUUID()}`;
        let eventStartIndex = 0;
        let conversationRevision = 0;
        let conversationEventStartIndex = 0;

        setAgentWorking(true);
        setAgentError("");
        setError("");
        setConversationComposer("");
        setConversationMessages((items) => [...items, {
            id: userMessageId,
            role: "user",
            body: message || "Review annotations",
            ...(attachedFeedback &&
                { contextLabel: attachedContextLabel || `${annotations.length} code annotations attached` }),
        }]);

        try {
            if (initialPayload.mode !== "dev") {
                const statusResponse = await fetch(
                    initialPayload.conversationStatusUrl || initialPayload.operationStatusUrl,
                );
                const statusPayload = await statusResponse.json().catch(() => ({}));
                if (!statusResponse.ok) throw new Error(statusPayload.error || `${agentLabel} status is unavailable.`);
                eventStartIndex = Array.isArray(statusPayload.events) ? statusPayload.events.length : 0;
                conversationRevision = Number.isInteger(statusPayload.revision) ? statusPayload.revision : 0;
                conversationEventStartIndex =
                    statusPayload.liveInteraction?.request?.codeReview?.conversationEvents?.length || 0;
            }

            await submit("deny", {
                approved: false,
                feedback: buildArtifactConversationFeedback({
                    message,
                    attachedFeedback,
                    agentLabel,
                    artifactKind: "code",
                }),
                annotations: attachedFeedback ? toWorkflowAnnotations(annotations) : [],
                conversationTurn: true,
            });

            if (initialPayload.mode === "dev") {
                await pause(600);
                const revisedRawPatch = initialPayload.agentConversation?.revisedRawPatch || activeRawPatch;
                applyAgentRevision({
                    rawPatch: revisedRawPatch,
                    reviewStatus: activeReviewStatus,
                    interactionId: `dev-${crypto.randomUUID()}`,
                    reply: initialPayload.agentConversation?.reply ||
                        "I applied the request. Code Review has reloaded the current file changes.",
                    agentMessageId,
                    clearAttachedContext: Boolean(attachedFeedback),
                });
                return;
            }

            if (initialPayload.conversationStatusUrl) {
                await waitForStandaloneCodeReview({
                    previousRevision: conversationRevision,
                    eventStartIndex,
                    agentMessageId,
                    clearAttachedContext: Boolean(attachedFeedback),
                });
                return;
            }

            await waitForWorkspaceCodeReview({
                previousInteractionId: activeInteractionId,
                conversationEventStartIndex,
                eventStartIndex,
                agentMessageId,
                clearAttachedContext: Boolean(attachedFeedback),
            });
        } catch (caught) {
            setAgentError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setAgentWorking(false);
        }
    }

    async function waitForStandaloneCodeReview(options) {
        // Repairs and their required validation can outlast a short UI timeout.
        while (reviewMountedRef.current) {
            const response = await fetch(initialPayload.conversationStatusUrl);
            const conversation = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(conversation.error || `${agentLabel} status is unavailable.`);
            const events = Array.isArray(conversation.events) ? conversation.events : [];
            const reply = collectArtifactConversationReply(events, options.eventStartIndex);
            if (reply.text) upsertAgentReply(options.agentMessageId, reply.text);
            if (Number.isInteger(conversation.revision) && conversation.revision > options.previousRevision) {
                if (typeof conversation.rawPatch !== "string") {
                    throw new Error("The refreshed Code Review response is incomplete.");
                }
                applyAgentRevision({
                    rawPatch: conversation.rawPatch,
                    reviewStatus: conversation.reviewStatus || null,
                    interactionId: `conversation-${conversation.revision}`,
                    reply: reply.text || "I updated the working files. Code Review has reloaded the current diff.",
                    agentMessageId: options.agentMessageId,
                    clearAttachedContext: options.clearAttachedContext,
                });
                return;
            }
            await pause(750);
        }
    }

    async function waitForWorkspaceCodeReview(options) {
        // Repairs and their required validation can outlast a short UI timeout.
        while (reviewMountedRef.current) {
            const response = await fetch(initialPayload.operationStatusUrl);
            const operation = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(operation.error || `${agentLabel} status is unavailable.`);
            const events = Array.isArray(operation.events) ? operation.events : [];
            const reply = collectArtifactConversationReply(events, options.eventStartIndex);
            if (reply.text) upsertAgentReply(options.agentMessageId, reply.text);

            const interaction = operation.liveInteraction;
            const codeReview = interaction?.request?.codeReview;
            if (
                interaction?.interactionId && interaction.interactionId !== options.previousInteractionId &&
                interaction.request?.type === "code_review" && typeof codeReview?.rawPatch === "string"
            ) {
                applyAgentRevision({
                    rawPatch: codeReview.rawPatch,
                    reviewStatus: codeReview.reviewStatus || null,
                    interactionId: interaction.interactionId,
                    reply: collectArtifactConversationReply(
                        codeReview.conversationEvents || [],
                        options.conversationEventStartIndex,
                    ).text ||
                        reply.text || "I updated the working files. Code Review has reloaded the current diff.",
                    agentMessageId: options.agentMessageId,
                    clearAttachedContext: options.clearAttachedContext,
                });
                return;
            }
            if (["failed", "canceled", "completed"].includes(operation.status)) {
                throw new Error(operation.error || `${agentLabel} ended without reopening Code Review.`);
            }
            await pause(750);
        }
    }

    function applyAgentRevision(options) {
        upsertAgentReply(options.agentMessageId, options.reply);
        const nextFiles = parseDiffToFiles(options.rawPatch);
        const nextFileIndex = nextFiles.findIndex((file) => file.path === currentFile?.path);
        setActiveFileIndex(nextFileIndex < 0 ? 0 : nextFileIndex);
        setActiveRawPatch(options.rawPatch);
        setActiveReviewStatus(options.reviewStatus);
        setActiveInteractionId(options.interactionId);
        if (initialPayload.interactionAnswerBaseUrl) {
            setActiveInteractionAnswerUrl(
                `${initialPayload.interactionAnswerBaseUrl}/${encodeURIComponent(options.interactionId)}/answer`,
            );
            try {
                updateReviewInteractionUrl(options.interactionId);
            } catch {
                // In-place diff refresh remains usable when browser history is unavailable.
            }
        }
        // Keep the guide's organization and UI state, but label its prose as from the prior revision.
        setGuide((current) => current ? { ...current, moved: true } : current);
        setViewedFiles(new Set());
        setFileNavigationTarget(null);
        if (options.clearAttachedContext) {
            setAnnotations([]);
            setSelectedAnnotationId(null);
            setConversationContextAttached(false);
        }
    }

    function upsertAgentReply(messageId, body) {
        setConversationMessages((items) => {
            const existing = items.findIndex((item) => item.id === messageId);
            const message = { id: messageId, role: "agent", body };
            if (existing < 0) return [...items, message];
            return items.map((item, index) => index === existing ? message : item);
        });
    }

    const reviewOptions = (
        <CodeReviewOptionsMenu
            iconOnly
            annotationsOpen={annotationsOpen}
            fileTreeOpen={fileTreeOpen}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleAnnotations={() => animateSidebarUpdate(() => setAnnotationsOpen((open) => !open))}
            onToggleFileTree={() => animateSidebarUpdate(() => setFileTreeOpen((open) => !open))}
        />
    );

    const reviewActions = (
        <div className="rw-plannotator-actions">
            {presentation === "workspace" && reviewOptions}
            <ApproveButton
                loadingLabel={<RunWieldThinkingDots label="Approving" />}
                mobileLoadingLabel={<RunWieldThinkingDots label="Approving" showLabel={false} />}
                onClick={submitApprove}
                disabled={submitting !== null || agentWorking}
                isLoading={submitting === "approve"}
            />
        </div>
    );

    return (
        <ThemeProvider
            defaultTheme="dark"
            defaultColorTheme="runwield"
            storageKey="runwield-review-theme-mode"
            colorThemeStorageKey="runwield-review-color-theme"
        >
            <TooltipProvider>
                <div
                    className={`rw-plannotator-host rw-code-review ${
                        presentation === "workspace" ? "rw-review-embedded" : ""
                    }`}
                    data-review-mode={initialPayload.mode}
                >
                    {presentation === "workspace"
                        ? <WorkspaceHeaderActionsPortal>{reviewActions}</WorkspaceHeaderActionsPortal>
                        : (
                            <>
                                <header className="rw-plannotator-toolbar">
                                    <div className="rw-plan-review-heading">
                                        {reviewOptions}
                                        <img src="/brand/logo.svg" alt="" aria-hidden="true" />
                                        <h1 title={codeReviewHeading}>{codeReviewHeading}</h1>
                                        {initialPayload.mode === "dev" && (
                                            <p className="rw-plan-review-dev-notice" role="status">
                                                DEV MODE — Feedback and approval won’t go anywhere.
                                            </p>
                                        )}
                                    </div>
                                    {reviewActions}
                                </header>
                                <ReviewContextBar context={initialPayload.reviewContext} artifactLabel="Code review" />
                            </>
                        )}
                    {error && <p className="rw-review-error" role="alert">{error}</p>}
                    <div
                        className="rw-plannotator-code-layout"
                        data-annotations-open={annotationsOpen}
                        data-file-tree-open={fileTreeOpen}
                        data-resizing-file-panel={resizingFilePanel}
                        style={{ "--rw-code-review-files-width": `${filePanelWidth}px` }}
                    >
                        {fileTreeOpen && (
                            <aside className="rw-review-file-tree">
                                <div className="rw-code-file-tabs">
                                    <div
                                        className="rw-underline-tabs rw-review-sidebar-tabs"
                                        role="tablist"
                                        aria-label="Code review files"
                                    >
                                        <button
                                            aria-selected={filePanelMode === "tree"}
                                            className={filePanelMode === "tree" ? "active" : ""}
                                            onClick={() => setRememberedFilePanelMode("tree")}
                                            role="tab"
                                            title="Files"
                                            type="button"
                                        >
                                            <FileTreeIcon />
                                            <span>Files</span>
                                        </button>
                                        <button
                                            aria-selected={filePanelMode === "changes"}
                                            className={filePanelMode === "changes" ? "active" : ""}
                                            onClick={() => setRememberedFilePanelMode("changes")}
                                            role="tab"
                                            title="Changes"
                                            type="button"
                                        >
                                            <CodeToggleIcon name="changes" />
                                            <span>Changes</span>
                                        </button>
                                    </div>
                                    <RunWieldIconButton
                                        className="rw-code-file-sidebar-close"
                                        type="button"
                                        onClick={() => animateSidebarUpdate(() => setFileTreeOpen(false))}
                                        title="Collapse file sidebar"
                                        aria-label="Collapse file sidebar"
                                    >
                                        <PanelCollapseIcon side="left" />
                                    </RunWieldIconButton>
                                </div>
                                <div
                                    aria-label="Resize file panel"
                                    aria-orientation="vertical"
                                    aria-valuemax={FILE_PANEL_MAX_WIDTH}
                                    aria-valuemin={FILE_PANEL_MIN_WIDTH}
                                    aria-valuenow={filePanelWidth}
                                    className="rw-code-file-resize-handle"
                                    onKeyDown={resizeFilePanelWithKeyboard}
                                    onPointerDown={startFilePanelResize}
                                    onPointerMove={resizeFilePanel}
                                    onPointerUp={finishFilePanelResize}
                                    onPointerCancel={finishFilePanelResize}
                                    role="separator"
                                    tabIndex={0}
                                />
                                <div className="rw-code-file-panel">
                                    {filePanelMode === "tree"
                                        ? (
                                            <FileTree
                                                files={files}
                                                activeFileIndex={activeFileIndex}
                                                scrollHighlightIndex={activeFileIndex}
                                                onSelectFile={navigateToFile}
                                                annotations={annotations}
                                                viewedFiles={viewedFiles}
                                                stagedFiles={stagedFiles}
                                                onToggleViewed={toggleViewedFile}
                                                onSelectDiff={() => {}}
                                                activeDiffType="working"
                                                onSelectPanelView={() => {}}
                                            />
                                        )
                                        : (
                                            <SectionsPanel
                                                files={files}
                                                sections={sections}
                                                activeFileIndex={activeFileIndex}
                                                scrollHighlightIndex={activeFileIndex}
                                                onSelectFile={navigateToFile}
                                                annotations={annotations}
                                                viewedFiles={viewedFiles}
                                                stagedFiles={stagedFiles}
                                                onToggleViewed={toggleViewedFile}
                                                onSelectPanelView={() => {}}
                                            />
                                        )}
                                </div>
                            </aside>
                        )}
                        <main
                            className="rw-review-all-files-host"
                            aria-label="All file changes"
                            data-content-fits={allFilesContentFits}
                        >
                            <DiffStyleToggle
                                diffStyle={diffStyle}
                                onChange={setDiffStyle}
                                fileTreeOpen={fileTreeOpen}
                                annotationsOpen={annotationsOpen}
                                onRestoreFiles={() => animateSidebarUpdate(() => setFileTreeOpen(true))}
                                onRestoreAnnotations={() => animateSidebarUpdate(() => setAnnotationsOpen(true))}
                                guideReady={guideReady}
                                guideOpen={guideOpen}
                                guideGenerating={guideGenerating}
                                guideProviderAvailable={guideProviderAvailable}
                                guideJob={guideJob}
                                guideCapabilities={guideCapabilities}
                                guidePolicy={guidePolicy}
                                onToggleGuide={() => {
                                    animateSidebarUpdate(() => {
                                        if (!guideOpen) setFileTreeOpen(false);
                                        if (guideReady) setGuideOpen(!guideOpen);
                                    });
                                    if (!guideReady) generateGuide();
                                }}
                                globalCommentButtonRef={globalCommentButtonRef}
                                onToggleGlobalComment={() => setGlobalCommentOpen((open) => !open)}
                            />
                            <div className="rw-code-diff-stage">
                                {!highlightingReady && (
                                    <div className="rw-empty-diff">
                                        <RunWieldThinkingDots label="Preparing syntax highlighting" />
                                    </div>
                                )}
                                {guide && (
                                    <div className="rw-code-review-retained-view" hidden={!guideOpen}>
                                        <GuidedReviewExplainer
                                            guide={guide}
                                            job={guideJob}
                                            onRegenerate={generateGuide}
                                            isActive={guideOpen}
                                            files={files}
                                            token={initialPayload.token}
                                            onToggleReviewed={(index) =>
                                                setGuide((current) => ({
                                                    ...current,
                                                    reviewed: current.sections.map((_, sectionIndex) =>
                                                        sectionIndex === index
                                                            ? !current.reviewed?.[sectionIndex]
                                                            : !!current.reviewed?.[sectionIndex]
                                                    ),
                                                }))}
                                            diffProps={{
                                                fileNavigationTarget,
                                                diffStyle,
                                                diffOverflow,
                                                diffIndicators,
                                                diffLineDiffType,
                                                diffShowLineNumbers,
                                                diffShowBackground,
                                                diffExpandUnchanged,
                                                diffFontFamily,
                                                diffFontSize,
                                                annotations,
                                                selectedAnnotationId,
                                                scrollTargetAnnotation,
                                                pendingSelection,
                                                setPendingSelection,
                                                addAnnotationForFile,
                                                editAnnotation,
                                                setSelectedAnnotationId,
                                                setAnnotations,
                                                addFileComment,
                                                viewedFiles,
                                                toggleViewedFile,
                                                stagedFiles,
                                            }}
                                        />
                                    </div>
                                )}
                                <div
                                    ref={allFilesHostRef}
                                    className="rw-code-review-retained-view"
                                    hidden={Boolean(guideOpen && guide)}
                                >
                                    {files.length > 0
                                        ? (
                                            <AllFilesCodeView
                                                key={[
                                                    diffStyle,
                                                    diffOverflow,
                                                    diffIndicators,
                                                    diffLineDiffType,
                                                    diffShowLineNumbers,
                                                    diffShowBackground,
                                                    diffExpandUnchanged,
                                                    diffFontFamily,
                                                    diffFontSize,
                                                ].join("|")}
                                                files={accordionFiles}
                                                diffStyle={diffStyle}
                                                diffOverflow={diffOverflow}
                                                diffIndicators={diffIndicators}
                                                lineDiffType={diffLineDiffType}
                                                disableLineNumbers={!diffShowLineNumbers}
                                                disableBackground={!diffShowBackground}
                                                expandUnchanged={diffExpandUnchanged}
                                                fontFamily={diffFontFamily}
                                                fontSize={diffFontSize}
                                                annotations={annotations}
                                                selectedAnnotationId={selectedAnnotationId}
                                                scrollTargetAnnotation={scrollTargetAnnotation}
                                                pendingSelection={pendingSelection}
                                                onLineSelection={setPendingSelection}
                                                onAddAnnotationForFile={(filePath, ...args) =>
                                                    addAnnotationForFile(
                                                        files.find((file) => file.path === filePath),
                                                        ...args,
                                                    )}
                                                onEditAnnotation={editAnnotation}
                                                onSelectAnnotation={setSelectedAnnotationId}
                                                onDeleteAnnotation={(id) =>
                                                    setAnnotations((items) => items.filter((item) => item.id !== id))}
                                                onAddFileCommentForFile={addFileComment}
                                                viewedFiles={viewedFiles}
                                                onToggleViewed={toggleViewedFile}
                                                stagedFiles={stagedFiles}
                                                activeSearchMatchId={fileNavigationTarget?.id ?? null}
                                                activeSearchMatch={fileNavigationTarget}
                                                onVisibleFileChange={handleVisibleFileChange}
                                                fileOrder={filePanelMode === "tree" ? "tree" : "list"}
                                                isActive={!guideOpen}
                                            />
                                        )
                                        : <div className="rw-empty-diff">No diff content.</div>}
                                </div>
                                {guideError && <p className="rw-review-error" role="alert">{guideError}</p>}
                            </div>
                        </main>
                        {annotationsOpen && (
                            <div className="rw-code-review-annotation-sidebar">
                                <div className="rw-review-annotation-heading">
                                    {conversationEnabled
                                        ? (
                                            <div
                                                className="rw-underline-tabs rw-review-sidebar-tabs"
                                                role="tablist"
                                                aria-label="Review sidebar"
                                            >
                                                <button
                                                    className={rightSidebarView === "annotations" ? "active" : ""}
                                                    type="button"
                                                    role="tab"
                                                    aria-selected={rightSidebarView === "annotations"}
                                                    onClick={() => setRightSidebarView("annotations")}
                                                    title="Annotations"
                                                >
                                                    <CommentIcon />
                                                    <span>Annotations</span>
                                                    {annotations.length > 0 && (
                                                        <span className="rw-review-annotation-count">
                                                            {annotations.length}
                                                        </span>
                                                    )}
                                                </button>
                                                <button
                                                    className={rightSidebarView === "agent" ? "active" : ""}
                                                    type="button"
                                                    role="tab"
                                                    aria-selected={rightSidebarView === "agent"}
                                                    onClick={() => setRightSidebarView("agent")}
                                                    title={agentLabel}
                                                >
                                                    <CommentIcon />
                                                    <span>{agentLabel}</span>
                                                </button>
                                            </div>
                                        )
                                        : (
                                            <div>
                                                <CommentIcon />
                                                <h2>Annotations</h2>
                                                {annotations.length > 0 && (
                                                    <span className="rw-review-annotation-count">
                                                        {annotations.length}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    <RunWieldIconButton
                                        className="rw-code-annotation-sidebar-close"
                                        type="button"
                                        onClick={() => animateSidebarUpdate(() => setAnnotationsOpen(false))}
                                        title="Collapse annotations sidebar"
                                        aria-label="Collapse annotations sidebar"
                                    >
                                        <PanelCollapseIcon side="right" />
                                    </RunWieldIconButton>
                                </div>
                                {rightSidebarView === "annotations"
                                    ? (
                                        <>
                                            <div className="rw-review-feedback-action rw-review-action">
                                                <FeedbackButton
                                                    onClick={submitFeedback}
                                                    disabled={annotations.length === 0 || submitting !== null ||
                                                        agentWorking}
                                                    isLoading={submitting === "feedback"}
                                                    label="Send Annotations"
                                                    loadingLabel={<RunWieldThinkingDots label="Sending Annotations" />}
                                                    title={annotations.length === 0
                                                        ? "Add an annotation before sending annotations"
                                                        : "Send annotations"}
                                                />
                                                {conversationEnabled && (
                                                    <button
                                                        className="rw-review-context-to-chat"
                                                        type="button"
                                                        disabled={annotations.length === 0 || agentWorking}
                                                        onClick={attachReviewContextToConversation}
                                                    >
                                                        <CommentIcon />
                                                        Add to {agentLabel} chat
                                                    </button>
                                                )}
                                            </div>
                                            <ReviewSidebar
                                                isOpen
                                                width={352}
                                                onClose={() => animateSidebarUpdate(() => setAnnotationsOpen(false))}
                                                activeTab="annotations"
                                                annotations={annotations}
                                                files={files}
                                                selectedAnnotationId={selectedAnnotationId}
                                                onSelectAnnotation={setSelectedAnnotationId}
                                                onNavigateToAnnotation={(id) => {
                                                    setSelectedAnnotationId(id);
                                                    if (id) setScrollTargetAnnotation({ id, token: Date.now() });
                                                }}
                                                onDeleteAnnotation={(id) =>
                                                    setAnnotations((items) => items.filter((item) => item.id !== id))}
                                                feedbackMarkdown={feedbackMarkdown}
                                                activeFilePath={currentFile?.path}
                                            />
                                        </>
                                    )
                                    : (
                                        <ArtifactConversationSidebar
                                            agentLabel={agentLabel}
                                            artifactLabel="code changes"
                                            messages={conversationMessages}
                                            composer={conversationComposer}
                                            attachedContextLabel={attachedContextLabel}
                                            working={agentWorking}
                                            disabled={submitting !== null}
                                            error={agentError}
                                            onComposerChange={setConversationComposer}
                                            onSend={sendAgentMessage}
                                            onDetachContext={() => setConversationContextAttached(false)}
                                        />
                                    )}
                            </div>
                        )}
                    </div>
                    {globalCommentOpen && globalCommentButtonRef.current && (
                        <CommentPopover
                            anchorEl={globalCommentButtonRef.current}
                            contextText="Code review"
                            draftKey={`code-review:${initialPayload.token}:global`}
                            isGlobal
                            onSubmit={addGlobalComment}
                            onClose={() => setGlobalCommentOpen(false)}
                        />
                    )}
                    <PlanReviewSettings
                        mode="code"
                        open={settingsOpen}
                        onClose={() => setSettingsOpen(false)}
                    />
                    <ReviewCompletion
                        payload={initialPayload}
                        submitted={submitted}
                        title={submitted === "approved" ? "Changes approved" : "Feedback sent"}
                        subtitle="You can return to RunWield."
                        agentLabel="RunWield"
                    />
                </div>
            </TooltipProvider>
        </ThemeProvider>
    );

    async function submit(endpoint, body) {
        setError("");
        if (initialPayload.mode === "dev") {
            console.log("Code review dev decision", { endpoint, body });
            return;
        }
        const targetUrl = activeInteractionAnswerUrl ||
            `/api/review/${endpoint}?token=${encodeURIComponent(initialPayload.token)}`;
        const headers = {
            "content-type": "application/json",
            "x-runwield-review-token": initialPayload.token,
        };
        if (initialPayload.csrfToken) headers["x-runwield-csrf"] = initialPayload.csrfToken;
        const response = await fetch(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(
                initialPayload.interactionAnswerUrl
                    ? {
                        requestId: crypto.randomUUID(),
                        runwieldSessionId: initialPayload.runwieldSessionId,
                        response: {
                            outcome: body.approved ? "accepted" : "selected",
                            _meta: body,
                        },
                    }
                    : body,
            ),
        });
        if (!response.ok) {
            const message = await response.text();
            setError(message || `Decision failed: ${response.status}`);
            throw new Error(message || `Decision failed: ${response.status}`);
        }
    }
}

function DiffStyleToggle({
    diffStyle,
    onChange,
    fileTreeOpen,
    annotationsOpen,
    onRestoreFiles,
    onRestoreAnnotations,
    guideReady,
    guideOpen,
    guideGenerating,
    guideProviderAvailable,
    guideJob,
    guideCapabilities,
    guidePolicy,
    onToggleGuide,
    globalCommentButtonRef,
    onToggleGlobalComment,
}) {
    return (
        <div className="rw-review-toolbar rw-code-diff-toolbar" aria-label="Diff view options">
            <div className="rw-review-toolbar-edge rw-review-toolbar-edge-left rw-code-diff-left-controls">
                <div className="rw-code-diff-sidebar-restore rw-code-diff-sidebar-restore-left">
                    {!fileTreeOpen && (
                        <RunWieldIconButton type="button" onClick={onRestoreFiles}>
                            <FileTreeIcon />
                            <span>Files</span>
                        </RunWieldIconButton>
                    )}
                </div>
                <div className="rw-guide-actions">
                    <button
                        className="rw-toolbar-button"
                        type="button"
                        onClick={onToggleGuide}
                        disabled={guideGenerating || (!guideReady && !guideProviderAvailable)}
                        title="Guided Review generation uses an additional LLM call when backed by an agent provider."
                    >
                        {guideGenerating
                            ? <RunWieldThinkingDots label="Generating guided review" />
                            : guideReady
                            ? (guideOpen ? "Back to diff" : "Guided Review ready")
                            : "Generate guided review"}
                    </button>
                    <span className="rw-guide-cost-note">
                        {formatGuideStatus(guideJob, guideCapabilities, guidePolicy)}
                    </span>
                </div>
            </div>
            <div className="rw-review-toolbar-edge rw-review-toolbar-edge-right rw-code-diff-layout-controls">
                <span>Diff view</span>
                <RunWieldSegmentedControl className="rw-code-diff-style-toggle" role="group" aria-label="Diff layout">
                    <button
                        aria-pressed={diffStyle === "split"}
                        className={diffStyle === "split" ? "active" : ""}
                        onClick={() => onChange("split")}
                        title="Side by side"
                        type="button"
                    >
                        <CodeToggleIcon name="side-by-side" />
                        <span>Side by side</span>
                    </button>
                    <button
                        aria-pressed={diffStyle === "unified"}
                        className={diffStyle === "unified" ? "active" : ""}
                        onClick={() => onChange("unified")}
                        title="Unified"
                        type="button"
                    >
                        <CodeToggleIcon name="unified" />
                        <span>Unified</span>
                    </button>
                </RunWieldSegmentedControl>
                <button
                    ref={globalCommentButtonRef}
                    className="rw-toolbar-button"
                    type="button"
                    onClick={onToggleGlobalComment}
                >
                    <CommentIcon />
                    Global comment
                </button>
                <div className="rw-code-diff-sidebar-restore rw-code-diff-sidebar-restore-right">
                    {!annotationsOpen && (
                        <RunWieldIconButton type="button" onClick={onRestoreAnnotations}>
                            <CommentIcon />
                            <span>Annotations</span>
                        </RunWieldIconButton>
                    )}
                </div>
            </div>
        </div>
    );
}

function PanelCollapseIcon({ side }) {
    const path = side === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6";
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
            <path d="M5 4v16" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M19 4v16" strokeWidth="1.5" strokeLinecap="round" />
            <path d={path} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function formatGuideStatus(job, capabilities, policy) {
    if (job) {
        const elapsed = typeof job.elapsedMs === "number" ? `${(job.elapsedMs / 1000).toFixed(1)}s` : "elapsed pending";
        const model = [job.providerName || job.engine || job.provider, job.model].filter(Boolean).join("/") ||
            "provider unknown";
        const usage = formatGuidedReviewUsageStatus(job);
        return `${job.status} · ${model} · ${elapsed} · ${usage.tokens} · ${usage.cost}`;
    }
    if (capabilities && !capabilities.available) {
        return "Guided Review provider unavailable · configure provider to make the extra LLM call";
    }
    return `extra LLM call · ${policy.reasons?.join(", ") || policy.mode || "manual"} · cost unavailable until run`;
}

function pause(milliseconds) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function GuidedReviewExplainer({ guide, job, files, token, onToggleReviewed, onRegenerate, isActive, diffProps }) {
    const [focusedFile, setFocusedFile] = useState(null);
    const [revealFile, setRevealFile] = useState(null);
    const revealToken = useRef(0);
    const reveal = useCallback((path) => {
        setRevealFile({ path, token: ++revealToken.current });
    }, []);
    useEffect(() => {
        if (diffProps.fileNavigationTarget) reveal(diffProps.fileNavigationTarget.filePath);
    }, [diffProps.fileNavigationTarget, reveal]);
    useEffect(() => {
        const annotation = diffProps.annotations.find((item) => item.id === diffProps.scrollTargetAnnotation?.id);
        if (annotation?.filePath) reveal(annotation.filePath);
    }, [diffProps.scrollTargetAnnotation, diffProps.annotations, reveal]);
    // Keep the existing block format: prose becomes the chapter overview, while
    // diagrams, callouts, widgets, and checkpoints accompany it as chapter notes.
    const chapters = useMemo(() => {
        const placed = new Set();
        const sections = (guide.sections || []).map((section) => ({
            title: section.title,
            overview: (section.blocks || []).filter((block) => block.type === "prose")
                .map((block) => block.markdown || block.text || "").join("\n\n"),
            diffs: (section.blocks || []).filter((block) => {
                if (block.type !== "diff" || placed.has(block.file)) return false;
                placed.add(block.file);
                return true;
            }),
        }));
        const remaining = [...(guide.everythingElse || []).map((ref) => ref.file), ...files.map((file) => file.path)]
            .filter((file) => {
                if (placed.has(file)) return false;
                placed.add(file);
                return true;
            });
        return {
            title: guide.title || "Guided Review",
            intent: guide.intent,
            moved: guide.moved,
            sections,
            unplacedFiles: remaining,
        };
    }, [guide, files]);
    const sectionNotes = (guide.sections || []).map((section) => (
        <div className="rw-guide-notes">
            {(section.blocks || []).filter((block) => !["prose", "diff"].includes(block.type))
                .map((block, index) => <GuideBlock key={index} block={block} token={token} />)}
        </div>
    ));
    const host = {
        files,
        DiffRenderer: AllFilesCodeView,
        revealFile,
        onRevealFile: reveal,
        getDiffRendererProps: ({ focused }) => ({
            isActive: isActive && focused,
            diffStyle: diffProps.diffStyle,
            diffOverflow: diffProps.diffOverflow,
            diffIndicators: diffProps.diffIndicators,
            lineDiffType: diffProps.diffLineDiffType,
            disableLineNumbers: !diffProps.diffShowLineNumbers,
            disableBackground: !diffProps.diffShowBackground,
            expandUnchanged: diffProps.diffExpandUnchanged,
            fontFamily: diffProps.diffFontFamily,
            fontSize: diffProps.diffFontSize,
            annotations: diffProps.annotations,
            selectedAnnotationId: diffProps.selectedAnnotationId,
            scrollTargetAnnotation: diffProps.scrollTargetAnnotation,
            pendingSelection: focused ? diffProps.pendingSelection : null,
            onLineSelection: diffProps.setPendingSelection,
            onAddAnnotationForFile: (filePath, ...args) =>
                diffProps.addAnnotationForFile(files.find((file) => file.path === filePath), ...args),
            onEditAnnotation: diffProps.editAnnotation,
            onSelectAnnotation: diffProps.setSelectedAnnotationId,
            onDeleteAnnotation: (id) => diffProps.setAnnotations((items) => items.filter((item) => item.id !== id)),
            onAddFileCommentForFile: diffProps.addFileComment,
            viewedFiles: diffProps.viewedFiles,
            onToggleViewed: diffProps.toggleViewedFile,
            stagedFiles: diffProps.stagedFiles,
            activeSearchMatchId: diffProps.fileNavigationTarget?.id ?? null,
            activeSearchMatch: diffProps.fileNavigationTarget,
        }),
    };
    return (
        <article className="rw-guide-explainer" aria-label="Guided Review Explainer">
            <GuideHostProvider value={host}>
                <GuideView
                    guide={chapters}
                    onRegenerate={onRegenerate}
                    showTitle={false}
                    engineLabel={formatGuidedReviewGenerator(job)}
                    sectionNotes={sectionNotes}
                    reviewed={guide.reviewed || []}
                    onToggleReviewed={onToggleReviewed}
                    focusedFile={focusedFile}
                    onFocusFile={setFocusedFile}
                />
            </GuideHostProvider>
        </article>
    );
}

function GuideBlock({ block, token }) {
    if (block.type === "prose") {
        return <div className="rw-guide-prose">{renderMarkdownProse(block.markdown || block.text || "")}</div>;
    }
    if (block.type === "callout") {
        return (
            <aside className={`rw-guide-callout rw-guide-callout-${block.tone || "note"}`}>
                {block.title && <strong>{block.title}</strong>}
                <div>{renderMarkdownProse(block.markdown || block.text || "")}</div>
            </aside>
        );
    }
    if (block.type === "mermaid") return <MermaidBlock block={block} />;
    if (block.type === "widget") {
        const id = encodeURIComponent(block.id || block.widgetId || "widget");
        const entry = encodeURIComponent(block.entry || "index.html");
        return (
            <figure className="rw-guide-widget">
                <figcaption>
                    <strong>{block.title || "Interactive explainer"}</strong>
                    {block.reason && <span>{block.reason}</span>}
                </figcaption>
                <iframe
                    title={block.title || "Guided Review widget"}
                    sandbox="allow-scripts"
                    src={`/api/review/widgets/${id}/${entry}?token=${encodeURIComponent(token)}`}
                />
            </figure>
        );
    }
    if (block.type === "reviewCheckpoint") {
        return <div className="rw-guide-checkpoint">{renderMarkdownProse(block.markdown || block.text || "")}</div>;
    }
    return null;
}

function MermaidBlock({ block }) {
    const [svg, setSvg] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        let canceled = false;
        setError("");
        setSvg("");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
        mermaid.render(`guide-${crypto.randomUUID()}`, block.source || "flowchart TD\nA[Empty diagram]").then(
            (result) => {
                if (!canceled) setSvg(result.svg || "");
            },
        ).catch((err) => {
            if (!canceled) setError(err instanceof Error ? err.message : String(err));
        });
        return () => {
            canceled = true;
        };
    }, [block.source]);
    return (
        <figure className="rw-guide-mermaid">
            {block.title && (
                <figcaption>
                    <strong>{block.title}</strong>
                    {block.description && <span>{block.description}</span>}
                </figcaption>
            )}
            {error ? <pre>{error}</pre> : <div dangerouslySetInnerHTML={{ __html: svg }} />}
        </figure>
    );
}

function buildFileNavigationTarget(file) {
    const hunk = file.patch.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/m);
    const isDeletion = file.status === "deleted";
    return {
        id: `file:${file.path}:${crypto.randomUUID()}`,
        filePath: file.path,
        side: isDeletion ? "deletion" : "addition",
        lineNumber: Number(hunk?.[isDeletion ? 1 : 2] || 1),
        text: "",
        matchStart: 0,
        matchEnd: 0,
        snippet: "",
    };
}

function buildReviewSections(files, reviewStatus) {
    const staged = new Set(Array.isArray(reviewStatus?.stagedFiles) ? reviewStatus.stagedFiles : []);
    const unstaged = new Set(Array.isArray(reviewStatus?.unstagedFiles) ? reviewStatus.unstagedFiles : []);
    const untracked = new Set(Array.isArray(reviewStatus?.untrackedFiles) ? reviewStatus.untrackedFiles : []);
    return {
        files: Object.fromEntries(files.map((file) => {
            const isStaged = staged.has(file.path);
            const group = untracked.has(file.path)
                ? "untracked"
                : isStaged || unstaged.has(file.path)
                ? "changes"
                : "committed";
            return [file.path, { group, staged: isStaged }];
        })),
    };
}

function orderFilesForChanges(files, sections, stagedFiles) {
    const grouped = {
        committed: [],
        changes: [],
        untracked: [],
    };

    files.forEach((file, index) => {
        const entry = sections.files[file.path];
        const staged = stagedFiles.has(file.path);
        let group = entry?.group ?? "committed";

        if (group === "untracked" && staged) {
            group = "changes";
        } else if (group === "changes" && entry?.staged && !staged && file.status === "added") {
            group = "untracked";
        }

        grouped[group].push({ file, index, staged });
    });

    grouped.changes.sort((left, right) => Number(right.staged) - Number(left.staged) || left.index - right.index);

    return [
        ...grouped.committed,
        ...grouped.changes,
        ...grouped.untracked,
    ].map(({ file }) => file);
}

function toWorkflowAnnotations(annotations) {
    return annotations.map((annotation) => ({
        ...annotation,
        file: annotation.filePath,
        path: annotation.filePath,
        line: annotation.lineStart,
        comment: annotation.text || "",
    }));
}

function exportReviewFeedbackWithImages(annotations) {
    const feedback = exportReviewFeedback(annotations);
    const references = annotations.flatMap((annotation) =>
        Array.isArray(annotation.images) ? annotation.images.map((image) => ({ annotation, image })) : []
    );
    if (references.length === 0) return feedback;

    const lines = references.map(({ annotation, image }) => {
        const scope = annotation.scope === "general"
            ? "Global comment"
            : `${annotation.filePath || "Code review"}:${annotation.lineStart || 1}`;
        return `- ${scope}: [${image.name || "image"}](${image.path})`;
    });
    return `${feedback}\n\n## Attached images\n\n${lines.join("\n")}`;
}

function CodeReviewOptionsMenu({
    iconOnly = false,
    annotationsOpen,
    fileTreeOpen,
    onOpenSettings,
    onToggleAnnotations,
    onToggleFileTree,
}) {
    return (
        <RunWieldMenu label="Options" iconOnly={iconOnly} align={iconOnly ? "start" : "end"}>
            {({ closeMenu }) => (
                <>
                    <RunWieldMenuItem
                        onClick={() => {
                            closeMenu();
                            onToggleFileTree();
                        }}
                        icon={<FileTreeIcon />}
                        label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                    />
                    <RunWieldMenuItem
                        onClick={() => {
                            closeMenu();
                            onToggleAnnotations();
                        }}
                        icon={<CommentIcon />}
                        label={annotationsOpen ? "Hide annotations" : "Show annotations"}
                    />
                    <RunWieldMenuItem
                        onClick={() => {
                            closeMenu();
                            onOpenSettings();
                        }}
                        icon={<SettingsIcon />}
                        label="Settings"
                    />
                </>
            )}
        </RunWieldMenu>
    );
}

function CodeToggleIcon({ name }) {
    const paths = {
        changes: "M7 7h10M7 12h6M7 17h10",
        "side-by-side": "M4 5h7v14H4z M13 5h7v14h-7z",
        unified: "M5 5h14v14H5z M8 9h8M8 13h8M8 17h5",
    };
    return (
        <svg
            aria-hidden="true"
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
        >
            <path strokeLinecap="round" strokeLinejoin="round" d={paths[name]} />
        </svg>
    );
}

function FileTreeIcon() {
    return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h6l2 2h8v12H4z" />
        </svg>
    );
}

function CommentIcon() {
    return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 8h10M7 12h6m-8 8 3.5-4H19a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z"
            />
        </svg>
    );
}

function SettingsIcon() {
    return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
        </svg>
    );
}

function readEmbeddedPayload(name) {
    const node = document.querySelector(`script[data-${name}]`);
    if (!node?.textContent) return null;
    try {
        return JSON.parse(node.textContent);
    } catch {
        return null;
    }
}
