// @ts-nocheck: Workspace React islands compile TSX, but this module uses JSDoc-style JavaScript only.
import { animateSidebarUpdate } from "../../design-system/components/react/sidebar-motion.ts";

import { useEffect, useMemo, useState } from "react";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider.tsx";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip.tsx";
import { Viewer } from "@plannotator/ui/components/Viewer.tsx";
import { OverlayScrollArea } from "@plannotator/ui/components/OverlayScrollArea.tsx";
import { SidebarContainer } from "@plannotator/ui/components/sidebar/SidebarContainer.tsx";
import { ScrollViewportContext } from "@plannotator/ui/hooks/useScrollViewport.ts";
import { useDocumentPrintMode } from "../../design-system/components/react/useDocumentPrintMode.ts";
import { useConfigValue } from "@plannotator/ui/config/index.ts";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser.ts";
import { getUIPreferences, PLAN_WIDTH_OPTIONS } from "@plannotator/ui/utils/uiPreferences.ts";
import { RunWieldPanelToggle, RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { sessionArtifactKindLabel } from "../../../shared/session/session-sidebar.ts";
import { WorkspaceHeaderActionsPortal } from "./WorkspaceHeaderActionsPortal.tsx";
import "./plannotator.css";

const DEFAULT_READ_PAYLOAD = {
    markdown: "",
    plan: "",
    token: "",
    mode: "dev",
    artifactKind: "plan",
    title: "Untitled artifact",
    notices: [],
};

function workspaceNavigate(href) {
    const event = new CustomEvent("runwield:workspace-navigate", {
        cancelable: true,
        detail: { href, history: "push" },
    });
    if (document.dispatchEvent(event)) globalThis.location.assign(href);
}

export function ArtifactReadSurface(
    { payload, workflowSidebar = null, showLogo = true, contentsInitiallyOpen = true, embedded = false },
) {
    useDocumentPrintMode();
    const initialPayload = useMemo(() => payload || readEmbeddedPayload("review-payload") || DEFAULT_READ_PAYLOAD, [
        payload,
    ]);
    const markdown = initialPayload.markdown || initialPayload.plan || "";
    const artifactKind = initialPayload.artifactKind || "report";
    const artifactLabel = sessionArtifactKindLabel(artifactKind);
    const title = initialPayload.title || `Untitled ${artifactLabel}`;
    const notices = Array.isArray(initialPayload.notices) ? initialPayload.notices.filter(Boolean) : [];
    const sourceLinks = Array.isArray(initialPayload.sourceLinks) ? initialPayload.sourceLinks : [];
    const [activeSection, setActiveSection] = useState(null);
    const [scrollViewport, setScrollViewport] = useState(null);
    const [closing, setClosing] = useState(false);
    const [closed, setClosed] = useState(false);
    const [closeBlocked, setCloseBlocked] = useState(false);
    const [error, setError] = useState("");
    const uiPreferences = useMemo(() => getUIPreferences(), []);
    const [sidebarOpen, setSidebarOpen] = useState(() =>
        contentsInitiallyOpen && !globalThis.matchMedia("(max-width: 980px)").matches && uiPreferences.tocEnabled
    );
    const [workflowOpen, setWorkflowOpen] = useState(() => !globalThis.matchMedia("(max-width: 980px)").matches);
    useEffect(() => {
        const narrow = globalThis.matchMedia("(max-width: 980px)");
        const collapseOnPhone = () => {
            if (narrow.matches) {
                setSidebarOpen(false);
                setWorkflowOpen(false);
            }
        };
        narrow.addEventListener("change", collapseOnPhone);
        return () => narrow.removeEventListener("change", collapseOnPhone);
    }, []);
    const gridEnabled = useConfigValue("gridEnabled");
    const planMaxWidth = useMemo(
        () => PLAN_WIDTH_OPTIONS.find((option) => option.id === uiPreferences.planWidth)?.px || 832,
        [uiPreferences.planWidth],
    );
    const parsed = useMemo(() => {
        const frontmatterResult = extractFrontmatter(markdown);
        return {
            blocks: parseMarkdownToBlocks(markdown),
            frontmatter: frontmatterResult.frontmatter,
        };
    }, [markdown]);

    async function closeReadSurface() {
        if (closing || closed) return;
        if (initialPayload.returnHref || initialPayload.launch === "project") {
            workspaceNavigate(initialPayload.returnHref || "/search");
            return;
        }
        setClosing(true);
        setError("");
        try {
            if (initialPayload.mode !== "dev") {
                const response = await fetch(`/api/review/exit?token=${encodeURIComponent(initialPayload.token)}`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-runwield-review-token": initialPayload.token,
                    },
                    body: JSON.stringify({ reviewType: "plan" }),
                });
                if (!response.ok) {
                    const message = await response.text();
                    throw new Error(message || `Close failed: ${response.status}`);
                }
            }
            setClosed(true);
            setClosing(false);
            globalThis.setTimeout(() => {
                globalThis.close?.();
                globalThis.setTimeout(() => {
                    if (!globalThis.closed) setCloseBlocked(true);
                }, 400);
            }, 0);
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            setError(message || "Close failed.");
            setClosing(false);
        }
    }

    const closeAction = (
        <button
            className="rw-artifact-close-button rw-review-action-button"
            type="button"
            onClick={closeReadSurface}
            disabled={closing || closed}
        >
            {initialPayload.returnHref || initialPayload.launch === "project"
                ? initialPayload.returnLabel ||
                    (initialPayload.launch === "project" ? "Back to Search" : "Back to Session")
                : closing
                ? <RunWieldThinkingDots label="Closing" />
                : closed
                ? "Closed"
                : "Close"}
        </button>
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
                    className={`rw-plannotator-host rw-plan-review rw-artifact-read${
                        embedded ? " rw-artifact-embedded" : ""
                    }`}
                    data-artifact-kind={artifactKind}
                    data-workflow-open={Boolean(workflowSidebar && workflowOpen)}
                >
                    {embedded
                        ? <WorkspaceHeaderActionsPortal>{closeAction}</WorkspaceHeaderActionsPortal>
                        : (
                            <header className="rw-plannotator-toolbar">
                                <div className="rw-plan-review-heading rw-artifact-read-heading">
                                    {showLogo && <img src="/brand/logo.svg" alt="" aria-hidden="true" />}
                                    <div className="rw-artifact-read-title-block">
                                        <h1>{title}</h1>
                                        {initialPayload.artifactPath && (
                                            <p className="rw-artifact-path">{initialPayload.artifactPath}</p>
                                        )}
                                    </div>
                                </div>
                                <div className="rw-plan-review-header-actions rw-plannotator-actions">
                                    {closeAction}
                                </div>
                            </header>
                        )}
                    <div className="rw-artifact-document-toolbar" data-sidebar-open={sidebarOpen}>
                        <div className="rw-artifact-contents-heading">
                            {sidebarOpen && <span>Contents</span>}
                            <RunWieldPanelToggle
                                side="left"
                                collapsed={!sidebarOpen}
                                label="Contents"
                                controls="artifact-contents"
                                onClick={() =>
                                    animateSidebarUpdate(() => {
                                        setSidebarOpen((open) => !open);
                                        if (globalThis.matchMedia("(max-width: 980px)").matches) setWorkflowOpen(false);
                                    })}
                            />
                        </div>
                        {workflowSidebar && (
                            <div className="rw-artifact-workflow-heading" data-open={workflowOpen}>
                                {workflowOpen && <span>Workflow</span>}
                                <RunWieldPanelToggle
                                    side="right"
                                    collapsed={!workflowOpen}
                                    label="Workflow"
                                    controls="artifact-workflow"
                                    onClick={() =>
                                        animateSidebarUpdate(() => {
                                            setWorkflowOpen((open) => !open);
                                            if (globalThis.matchMedia("(max-width: 980px)").matches) {
                                                setSidebarOpen(false);
                                            }
                                        })}
                                />
                            </div>
                        )}
                    </div>
                    {error && <p className="rw-review-error" role="alert">{error}</p>}
                    {closed && closeBlocked && (
                        <div className="rw-artifact-close-notice" role="status">
                            <strong>{artifactLabel} view closed.</strong>
                            <span>
                                The RunWield read session has ended. Your browser blocked automatic tab closure; you can
                                close this tab manually.
                            </span>
                        </div>
                    )}
                    <ScrollViewportContext.Provider value={scrollViewport}>
                        <div
                            className="rw-plannotator-plan-layout rw-artifact-read-layout"
                            data-sidebar-open={sidebarOpen}
                            data-annotations-open="false"
                        >
                            {sidebarOpen && (
                                <div
                                    id="artifact-contents"
                                    className="rw-artifact-contents"
                                    onKeyDown={(event) => {
                                        if (event.key === "Escape") animateSidebarUpdate(() => setSidebarOpen(false));
                                    }}
                                >
                                    <SidebarContainer
                                        activeTab="toc"
                                        onTabChange={() => {}}
                                        onClose={() => animateSidebarUpdate(() => setSidebarOpen(false))}
                                        width={280}
                                        blocks={parsed.blocks}
                                        annotations={[]}
                                        activeSection={activeSection}
                                        onTocNavigate={(section) => {
                                            setActiveSection(section);
                                            if (globalThis.matchMedia("(max-width: 980px)").matches) {
                                                animateSidebarUpdate(() => setSidebarOpen(false));
                                            }
                                        }}
                                        showFilesTab={false}
                                        showVersionsTab={false}
                                        versionInfo={null}
                                        versions={[]}
                                        selectedBaseVersion={null}
                                        onSelectBaseVersion={() => {}}
                                        isPlanDiffActive={false}
                                        hasPreviousVersion={false}
                                        onActivatePlanDiff={() => {}}
                                        isLoadingVersions={false}
                                        isSelectingVersion={false}
                                        fetchingVersion={null}
                                        onFetchVersions={() => {}}
                                        showArchiveTab={false}
                                        archivePlans={[]}
                                        selectedArchiveFile={null}
                                        onArchiveSelect={() => {}}
                                        isLoadingArchive={false}
                                    />
                                </div>
                            )}
                            <main className="rw-plannotator-main-pane">
                                {(notices.length > 0 || sourceLinks.length > 0) && (
                                    <section className="rw-artifact-notices" aria-label={`${artifactLabel} notices`}>
                                        {notices.map((notice) => <p key={notice}>{notice}</p>)}
                                        {sourceLinks.length > 0 && (
                                            <p>
                                                Source Plans:{" "}
                                                {sourceLinks.map((source, index) => (
                                                    <span key={source.href}>
                                                        {index > 0 && ", "}
                                                        <a href={source.href}>{source.label}</a>
                                                    </span>
                                                ))}
                                            </p>
                                        )}
                                    </section>
                                )}
                                <div className="rw-plan-content-area">
                                    <OverlayScrollArea
                                        className="rw-plannotator-scroll-area"
                                        onViewportReady={setScrollViewport}
                                    >
                                        <div className="rw-plan-document-canvas">
                                            <Viewer
                                                blocks={parsed.blocks}
                                                markdown={markdown}
                                                frontmatter={parsed.frontmatter}
                                                annotations={[]}
                                                onAddAnnotation={() => {}}
                                                onSelectAnnotation={() => {}}
                                                selectedAnnotationId={null}
                                                mode="selection"
                                                inputMethod="drag"
                                                taterMode={false}
                                                stickyActions={false}
                                                copyLabel="Copy Markdown"
                                                gridEnabled={gridEnabled}
                                                maxWidth={planMaxWidth}
                                                imageBaseDir={initialPayload.imageBaseDir}
                                                readOnly
                                            />
                                        </div>
                                    </OverlayScrollArea>
                                </div>
                            </main>
                            {workflowSidebar && workflowOpen && (
                                <div
                                    id="artifact-workflow"
                                    className="rw-artifact-workflow"
                                    onKeyDown={(event) => {
                                        if (event.key === "Escape") {
                                            animateSidebarUpdate(() => setWorkflowOpen(false));
                                        }
                                    }}
                                >
                                    {workflowSidebar}
                                </div>
                            )}
                        </div>
                    </ScrollViewportContext.Provider>
                </div>
            </TooltipProvider>
        </ThemeProvider>
    );
}

function readEmbeddedPayload(attribute) {
    const node = document.querySelector(`script[type="application/json"][data-${attribute}]`);
    if (!node?.textContent) return null;
    try {
        return JSON.parse(node.textContent);
    } catch {
        return null;
    }
}
