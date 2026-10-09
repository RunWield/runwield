// @ts-nocheck: Workspace React UI is the scoped TypeScript/TSX exception zone.
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCollaborationClient } from "../../../shared/collaboration/client.js";
import { decryptJsonPayload, encryptJsonPayload, importContentKey } from "../../../shared/collaboration/crypto.ts";
import { normalizeEncryptedPlanPayload } from "../../../shared/collaboration/protocol.js";
import { parseCollaborationUrl } from "../../../shared/collaboration/urls.ts";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider.tsx";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip.tsx";
import { Viewer } from "@plannotator/ui/components/Viewer.tsx";
import { RunWieldAnnotationToolstrip } from "./RunWieldAnnotationToolstrip.tsx";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser.ts";
import { AnnotationType } from "@plannotator/ui/types.ts";
import { RemoteCommentPanel } from "./RemoteCommentPanel.tsx";
import {
    buildRemoteCommentPayload,
    normalizeRemoteCommentPayload,
    remoteCommentToPlannotatorAnnotation,
} from "./remote-review-payload.js";
import "./plannotator.css";

const DISPLAY_NAME_KEY = "runwield.remoteReview.displayName";

export function RemotePlanReview({ spaceId }) {
    const shellRef = useRef(null);
    const viewerHandleRef = useRef(null);
    const [client, setClient] = useState(null);
    const [contentKey, setContentKey] = useState(null);
    const [role, setRole] = useState("reviewer");
    const [space, setSpace] = useState(null);
    const [selectedRevision, setSelectedRevision] = useState(null);
    const [plan, setPlan] = useState(null);
    const [comments, setComments] = useState([]);
    const [selectedCommentId, setSelectedCommentId] = useState(null);
    const [displayName, setDisplayName] = useState("");
    const [annotationMode, setAnnotationMode] = useState("comment");
    const [inputMethod, setInputMethod] = useState("drag");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [pendingCommentId, setPendingCommentId] = useState(null);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");

    const closed = space?.status === "closed";
    const expiresAt = typeof space?.expiresAt === "string" ? space.expiresAt : "";
    const markdown = plan?.body || "";
    const parsed = useMemo(() => {
        const frontmatterResult = extractFrontmatter(markdown);
        return {
            blocks: parseMarkdownToBlocks(markdown),
            frontmatter: frontmatterResult.frontmatter,
        };
    }, [markdown]);
    const planTitle = plan?.title?.trim() ||
        parsed.blocks.find((block) => block.type === "heading" && block.level === 1)?.content.trim() || "Untitled plan";
    useEffect(() => {
        if (plan) document.title = `Plan Review - ${planTitle}`;
    }, [plan, planTitle]);
    const annotations = useMemo(() => comments.map(remoteCommentToPlannotatorAnnotation), [comments]);

    useEffect(() => {
        setDisplayName(localStorage.getItem(DISPLAY_NAME_KEY) || "");
        try {
            const parsedUrl = parseCollaborationUrl(globalThis.location.href);
            if (parsedUrl.spaceId !== spaceId) throw new Error("Collaboration URL does not match this Shared Space.");
            setRole(parsedUrl.role);
            setClient(createCollaborationClient({
                serverUrl: parsedUrl.apiBaseUrl,
                bearerCapability: parsedUrl.bearerCapability,
                fetch: globalThis.fetch.bind(globalThis),
            }));
            importContentKey(parsedUrl.contentKey).then(setContentKey).catch(() => {
                setError("The link contains an invalid content key. Ask the maintainer for a fresh Shared Space URL.");
                setLoading(false);
            });
        } catch (caught) {
            setError(safeMessage(caught) || "The collaboration link is missing key, capability, or role details.");
            setLoading(false);
        }
    }, [spaceId]);

    const loadRevision = useCallback(async (targetRevision) => {
        if (!client || !contentKey) return;
        setLoading(true);
        setError("");
        setStatus("");
        try {
            const metadata = await client.getSharedSpace(spaceId);
            const nextSpace = normalizeSpace(metadata);
            const revisionNumber = targetRevision || nextSpace.latestRevision;
            const revisionResponse = await client.getRevision(spaceId, revisionNumber);
            const nextRevision = normalizeRevisionResponse(revisionResponse);
            const decryptedPlan = normalizeEncryptedPlanPayload(
                await decryptJsonPayload(nextRevision.payloadCiphertext, contentKey),
            );
            const commentResponse = await client.listComments(spaceId, revisionNumber);
            const nextComments = await decryptComments(commentResponse, contentKey);
            setSpace(nextSpace);
            setSelectedRevision(revisionNumber);
            setPlan(decryptedPlan);
            setComments(nextComments);
            setSelectedCommentId(null);
        } catch (caught) {
            setError(messageForFailure(caught));
        } finally {
            setLoading(false);
        }
    }, [client, contentKey, spaceId]);

    useEffect(() => {
        loadRevision(null);
    }, [loadRevision]);

    useEffect(() => {
        const root = globalThis.document?.documentElement;
        if (!root) return;
        root.classList.toggle("rw-remote-review-closed", closed);
        return () => root.classList.remove("rw-remote-review-closed");
    }, [closed]);

    useEffect(() => {
        viewerHandleRef.current?.clearAllHighlights?.();
        const applyTimer = globalThis.setTimeout(() => {
            viewerHandleRef.current?.applySharedAnnotations?.(annotations);
            globalThis.setTimeout(() => {
                markMissingAnnotationAnchors(shellRef.current, comments, setComments);
            }, 80);
        }, 0);
        return () => globalThis.clearTimeout(applyTimer);
    }, [annotations, comments, markdown, selectedRevision]);

    function rememberDisplayName(value) {
        setDisplayName(value);
        localStorage.setItem(DISPLAY_NAME_KEY, value);
    }

    async function addRemoteAnnotation(annotation) {
        if (!client || !contentKey || !selectedRevision) return;
        if (closed) {
            viewerHandleRef.current?.removeHighlight?.(annotation.id);
            setError("This Shared Space is closed. New comments are disabled.");
            return;
        }
        if (annotation.type !== AnnotationType.COMMENT && annotation.type !== AnnotationType.GLOBAL_COMMENT) {
            viewerHandleRef.current?.removeHighlight?.(annotation.id);
            setError("Remote review currently supports comments only. Use the Comment annotation mode.");
            return;
        }
        if (!displayName.trim()) {
            viewerHandleRef.current?.removeHighlight?.(annotation.id);
            setError("Enter a display name before saving an encrypted comment.");
            return;
        }
        setSaving(true);
        setError("");
        try {
            const payload = buildRemoteCommentPayload({ displayName, annotation });
            const ciphertext = await encryptJsonPayload(payload, contentKey);
            await client.appendComment(spaceId, selectedRevision, { ciphertext });
            setStatus("Encrypted comment saved.");
            await loadRevision(selectedRevision);
        } catch (caught) {
            viewerHandleRef.current?.removeHighlight?.(annotation.id);
            setError(messageForFailure(caught));
        } finally {
            setSaving(false);
        }
    }

    async function setCommentState(commentId, action) {
        if (!client || closed) return;
        setPendingCommentId(commentId);
        setError("");
        try {
            const response = await client.setCommentState(spaceId, commentId, { action });
            const updated = normalizeCommentRecord(response?.comment || response);
            setComments((items) =>
                items.map((item) => item.id === commentId ? { ...item, resolved: updated.resolved } : item)
            );
            const metadata = await client.getSharedSpace(spaceId);
            setSpace(normalizeSpace(metadata));
        } catch (caught) {
            setError(messageForFailure(caught));
        } finally {
            setPendingCommentId(null);
        }
    }

    function selectComment(commentId) {
        setSelectedCommentId(commentId);
    }

    function changeMode(nextMode) {
        setAnnotationMode(nextMode === "comment" ? "comment" : "comment");
    }

    return (
        <ThemeProvider
            defaultTheme="dark"
            defaultColorTheme="runwield"
            storageKey="runwield-remote-review-theme-mode"
            colorThemeStorageKey="runwield-remote-review-color-theme"
        >
            <TooltipProvider>
                <section
                    ref={shellRef}
                    className="rw-remote-review-shell rw-plannotator-host rw-remote-plannotator-review"
                    data-closed={closed ? "true" : "false"}
                >
                    <header className="rw-remote-review-header">
                        <div>
                            <p className="eyebrow">Shared Space Review · {role}</p>
                            <h1>{plan?.title || "Remote Plan Review"}</h1>
                            {space
                                ? <p>Space {space.spaceId} · Plan {space.planId}</p>
                                : <p>Decrypting Shared Space…</p>}
                        </div>
                        <div className="rw-remote-review-actions">
                            {saving
                                ? (
                                    <span className="badge warning">
                                        <RunWieldThinkingDots label="Saving encrypted comment" />
                                    </span>
                                )
                                : null}
                            {space?.status
                                ? <span className={closed ? "badge warning" : "badge success"}>{space.status}</span>
                                : null}
                        </div>
                    </header>

                    {error ? <p className="rw-review-error" role="alert">{error}</p> : null}
                    {status ? <p className="notice" role="status">{status}</p> : null}
                    {closed
                        ? (
                            <p className="notice muted">
                                This Shared Space is closed. You can read comments, but cannot create, resolve, or
                                reopen them.
                            </p>
                        )
                        : null}
                    {expiresAt
                        ? (
                            <p className="notice warning" role="status">
                                Inactivity retention is enabled. This Shared Space currently expires at{" "}
                                {expiresAt}. New revisions, comments, resolve/reopen, or close actions refresh the
                                expiry; viewing alone does not.
                            </p>
                        )
                        : null}

                    <div className="rw-remote-review-toolbar">
                        <label>
                            Revision
                            <select
                                value={selectedRevision || ""}
                                disabled={loading || !space?.revisions?.length}
                                onChange={(event) => loadRevision(Number(event.currentTarget.value))}
                            >
                                {(space?.revisions || []).map((item) => (
                                    <option key={item.revision} value={item.revision}>Revision {item.revision}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Display name
                            <input
                                value={displayName}
                                onChange={(event) => rememberDisplayName(event.currentTarget.value)}
                                placeholder="Your name"
                                autoComplete="name"
                                maxLength={80}
                            />
                        </label>
                        <div className="rw-remote-toolstrip" aria-label="Annotation mode">
                            <RunWieldAnnotationToolstrip
                                inputMethod={inputMethod}
                                onInputMethodChange={setInputMethod}
                                mode={annotationMode}
                                onModeChange={changeMode}
                                compact
                                showHelpLink={false}
                            />
                            <p className="help-text">Select Plan text to create an encrypted Plannotator comment.</p>
                        </div>
                    </div>

                    {loading
                        ? (
                            <p className="notice">
                                <RunWieldThinkingDots label="Loading encrypted Shared Space" />
                            </p>
                        )
                        : null}

                    <div className="rw-remote-review-grid rw-remote-plannotator-grid">
                        <article className="rw-remote-plan-card rw-remote-plannotator-plan-card">
                            {plan?.body
                                ? (
                                    <Viewer
                                        ref={viewerHandleRef}
                                        blocks={parsed.blocks}
                                        markdown={markdown}
                                        frontmatter={parsed.frontmatter}
                                        annotations={annotations}
                                        onAddAnnotation={addRemoteAnnotation}
                                        onSelectAnnotation={selectComment}
                                        selectedAnnotationId={selectedCommentId}
                                        mode={closed ? "selection" : annotationMode}
                                        inputMethod={inputMethod}
                                        taterMode={false}
                                        stickyActions
                                        gridEnabled
                                        maxWidth={920}
                                        copyLabel="Copy Plan"
                                        actionsLabelMode="full"
                                    />
                                )
                                : (
                                    <div className="markdown-view rw-remote-plan-document">
                                        <p className="empty">No Plan body content.</p>
                                    </div>
                                )}
                        </article>

                        <RemoteCommentPanel
                            comments={comments}
                            annotations={annotations}
                            blocks={parsed.blocks}
                            selectedId={selectedCommentId}
                            closed={closed}
                            pendingId={pendingCommentId}
                            onSelect={selectComment}
                            onResolve={(id) => setCommentState(id, "resolve")}
                            onReopen={(id) => setCommentState(id, "reopen")}
                        />
                    </div>
                </section>
            </TooltipProvider>
        </ThemeProvider>
    );
}

async function decryptComments(response, contentKey) {
    const records = Array.isArray(response?.comments) ? response.comments : [];
    return await Promise.all(records.map(async (record) => {
        const normalized = normalizeCommentRecord(record);
        try {
            const payload = normalizeRemoteCommentPayload(await decryptJsonPayload(normalized.ciphertext, contentKey));
            return {
                ...normalized,
                ...payload,
                anchorMissing: hasLegacyInlineAnchorWithoutMetadata(payload),
                unreadable: false,
            };
        } catch {
            return {
                ...normalized,
                schemaVersion: 1,
                type: "global_comment",
                displayName: "",
                body: "",
                originalText: "",
                anchor: null,
                anchorMissing: false,
                unreadable: true,
            };
        }
    }));
}

function hasLegacyInlineAnchorWithoutMetadata(payload) {
    return payload.type === "comment" && payload.anchor && (!payload.anchor.startMeta || !payload.anchor.endMeta);
}

function normalizeSpace(value) {
    if (!value || typeof value !== "object") throw new Error("Invalid Shared Space response.");
    const record = value.space && typeof value.space === "object" ? value.space : value;
    return {
        ...record,
        latestRevision: Number(record.latestRevision),
        revisions: Array.isArray(record.revisions)
            ? record.revisions.map((item) => ({ ...item, revision: Number(item.revision) }))
            : [],
    };
}

function normalizeRevisionResponse(value) {
    const record = value?.revision || value;
    if (!record?.payloadCiphertext) throw new Error("Invalid revision response.");
    return { ...record, revision: Number(record.revision) };
}

function normalizeCommentRecord(value) {
    const record = value?.comment || value;
    if (!record?.id) throw new Error("Invalid comment response.");
    return {
        ...record,
        id: String(record.id),
        resolved: Boolean(record.resolved),
        createdAt: String(record.createdAt || new Date().toISOString()),
    };
}

function markMissingAnnotationAnchors(root, comments, setComments) {
    if (!root) return;
    const missingIds = new Set();
    for (const comment of comments) {
        if (comment.unreadable || comment.type !== "comment") continue;
        const selector = `[data-bind-id="${cssEscape(comment.id)}"]`;
        if (!root.querySelector(selector)) missingIds.add(comment.id);
    }
    const nextComments = comments.map((comment) => {
        const anchorMissing = missingIds.has(comment.id);
        return comment.anchorMissing === anchorMissing ? comment : { ...comment, anchorMissing };
    });
    if (JSON.stringify(nextComments.map(anchorState)) !== JSON.stringify(comments.map(anchorState))) {
        setComments(nextComments);
    }
}

function anchorState(comment) {
    return `${comment.id}:${comment.anchorMissing ? "missing" : "ok"}`;
}

function cssEscape(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function messageForFailure(caught) {
    const message = safeMessage(caught);
    if (/decrypt|content key|payload/i.test(message)) {
        return "Unable to decrypt this Shared Space with the provided key. Ask the maintainer for a fresh link.";
    }
    if (/401|Bearer/i.test(message)) return "This link is missing an authorization capability.";
    if (/403|authorized|forbidden/i.test(message)) return "This link is not authorized for the requested Shared Space.";
    if (/404|not found|deleted/i.test(message)) return "Shared Space not found or deleted.";
    if (/closed/i.test(message)) return "This Shared Space is closed. Updates are disabled.";
    return message || "Unable to load the Shared Space.";
}

function safeMessage(caught) {
    const message = caught instanceof Error ? caught.message : String(caught || "");
    return message.replace(/#.*$/g, "#[redacted]").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
}
