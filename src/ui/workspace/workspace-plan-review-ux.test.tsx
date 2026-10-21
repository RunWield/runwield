// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { act } from "react";
import { withReview } from "./react/plan-review-test-dom.tsx";
import {
    createPlanReviewDraft,
    parsePlanReviewDraft,
    planReviewDraftKey,
    serializePlanReviewDraft,
} from "./react/plan-review-draft.ts";
import { match as assertMatch } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

const ROUTE_PATH = "src/ui/workspace/pages/projects/[projectId]/plans/[planId].astro";
const SURFACE_PATH = "src/ui/workspace/react/PlanReviewSurface.tsx";
const CODE_SURFACE_PATH = "src/ui/workspace/react/CodeReviewSurface.tsx";
const REMOTE_SURFACE_PATH = "src/ui/workspace/react/RemotePlanReview.tsx";
const ANNOTATION_TOOLSTRIP_PATH = "src/ui/workspace/react/RunWieldAnnotationToolstrip.tsx";
const SETTINGS_PATH = "src/ui/workspace/react/PlanReviewSettings.tsx";

test("Phone Plan review keeps full editing annotations and actions reachable", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(surface, "Edit");
    assertStringIncludes(surface, "Annotations");
    assertStringIncludes(surface, "Feedback");
    const styles = await fsReadFile("src/ui/workspace/react/plannotator.css", "utf8");
    // A base mobile selector loses to desktop selectors with sidebar-state attributes,
    // leaving a 320px annotations column inside a 390px phone viewport.
    const phoneStyles = styles.slice(styles.indexOf("@media (max-width: 980px)"));
    assertStringIncludes(phoneStyles, ".rw-plannotator-plan-layout[data-sidebar-open][data-annotations-open]");
    assertStringIncludes(phoneStyles, ".rw-plannotator-code-layout[data-file-tree-open][data-annotations-open]");
    assertStringIncludes(phoneStyles, "grid-template-columns: minmax(0, 1fr)");
    assertEquals(styles.includes("min-height: 72vh"), false);
});

test("Workspace reviews replace the owner shell with the shared full-window review layout", async () => {
    const planRoute = await fsReadFile(ROUTE_PATH, "utf8");
    const codeRoute = await fsReadFile(
        "src/ui/workspace/pages/projects/[projectId]/sessions/[runwieldSessionId]/review/code.astro",
        "utf8",
    );
    const layout = await fsReadFile("src/ui/workspace/layouts/ReviewLayout.astro", "utf8");
    assertStringIncludes(planRoute, "const Layout = reviewPayload ? ReviewLayout : WorkspaceLayout");
    assertStringIncludes(planRoute, '<PlanReviewSurface payload={reviewPayload} client:only="react">');
    assertStringIncludes(codeRoute, "<ReviewLayout");
    assertStringIncludes(codeRoute, '<CodeReviewSurface payload={payload} client:only="react">');
    assertEquals(codeRoute.includes("WorkspaceLayout"), false);
    assertStringIncludes(layout, "data-astro-review-shell");
    assertEquals(layout.includes("workspace-sidebar"), false);
    assertEquals(layout.includes("workspace-shell.js"), false);
    assertEquals(layout.includes("workspace-main-header"), false);
    // Full-window presentation must retain Workspace-specific actions and return destinations.
    for (const route of [planRoute, codeRoute]) {
        assertStringIncludes(route, 'mode: "workspace"');
        assertStringIncludes(route, "sessionHref");
        assertStringIncludes(route, "interactionAnswerUrl");
    }
    const surface = await fsReadFile(SURFACE_PATH, "utf8");
    assertStringIncludes(surface, 'initialPayload.mode === "workspace" || presentation === "workspace"');
});

test("Owner shell retains its shared navigation and header outside reviews", async () => {
    const layout = await fsReadFile("src/ui/workspace/layouts/WorkspaceLayout.astro", "utf8");
    const shell = await fsReadFile("src/ui/workspace/static/workspace-shell.ts", "utf8");
    const workspaceMenu = await fsReadFile("src/ui/workspace/react/WorkspaceMenu.tsx", "utf8");
    assertStringIncludes(layout, 'class="workspace-main-session-name" data-workspace-surface-title');
    assertStringIncludes(shell, 'header.querySelector("[data-workspace-main-session-name]")?.remove()');
    assertStringIncludes(layout, '<WorkspaceMenu client:only="react" />');
    assertStringIncludes(workspaceMenu, 'href="https://docs.runwield.dev"');
    assertStringIncludes(workspaceMenu, "Documentation");
    assertStringIncludes(layout, "data-workspace-header-actions");
    assertEquals(layout.includes("BrowserNotificationPermissionControl"), false);
});

test("Plan Review fixture navigation lives in the Surface Lab instead of the review page", async () => {
    const devSurface = await fsReadFile("src/ui/workspace/react/ReviewDevSurface.tsx", "utf8");
    const catalog = await fsReadFile("src/ui/workspace/pages/dev/index.astro", "utf8");

    assertStringIncludes(catalog, 'id: "feature"');
    assertStringIncludes(catalog, 'href: "/dev/plan-review?variant=read-only"');
    assertStringIncludes(catalog, "/dev/plan-review?variant=${variant.id}");
    assertStringIncludes(catalog, "/dev/workspace/plan-review?variant=${variant.id}");
    if (devSurface.includes('"aria-label": "Plan Review dev fixtures"')) {
        throw new Error("Plan Review fixture pages must not render a second navigation header");
    }
});

test("Plan Review fixtures show every callout kind next to a dense comparison without callouts", async () => {
    const devSurface = await fsReadFile("src/ui/workspace/react/ReviewDevSurface.tsx", "utf8");
    const catalog = await fsReadFile("src/ui/workspace/pages/dev/index.astro", "utf8");
    const between = (start: string, end: string) =>
        devSurface.slice(devSurface.indexOf(start), devSurface.indexOf(end, devSurface.indexOf(start)));
    const concise = between("const PLAN_FIXTURE =", "const DENSE_PLAN_FIXTURE =");
    const dense = between("const DENSE_PLAN_FIXTURE =", "const INITIAL_PLAN_FIXTURE =");
    const reader = between("const MARKDOWN_READER_FIXTURE =", "const CODE_REVIEW_FIXTURE =");

    for (const kind of ["WARNING", "NOTE", "TIP"]) {
        const authoredCallout = new RegExp(`\\n> \\[!${kind}\\]\\n> \\*\\*[^\\n]+\\*\\*\\n>\\n> `);
        assertMatch(concise, authoredCallout);
        assertMatch(reader, authoredCallout);
    }
    assertEquals(dense.includes("[!"), false);
    assertMatch(devSurface, /planVariant === "dense"\s*\? DENSE_PLAN_FIXTURE\s*: PLAN_FIXTURE/);
    assertStringIncludes(catalog, 'id: "dense"');
});

test("Plan approval outcomes use shared completion routing", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(route, "interactionAnswerUrl");
    assertStringIncludes(route, "progressUrl");
    assertStringIncludes(surface, "Approve & Run");
    assertStringIncludes(surface, "PLAN_APPROVAL_ACTIONS.RUN");
    assertStringIncludes(surface, "<ReviewCompletion");
    assertStringIncludes(surface, "payload={initialPayload}");
    assertStringIncludes(surface, 'document.addEventListener?.("astro:before-preparation", persistBeforeClose)');
    assertStringIncludes(surface, "Later");
    assertStringIncludes(surface, "approved-later");
});

test("Plan review exposes Workspace recovery when live Plan evidence requires it", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(route, "recoveryUrl");
    assertStringIncludes(route, "force-recovery");
    assertStringIncludes(surface, "recovery_required");
    assertStringIncludes(surface, "Recover in Workspace");
    assertStringIncludes(surface, "runRecoveryAction");
});

test("Plan review stale errors offer a clear reload action", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(surface, "staleReviewError");
    assertStringIncludes(surface, "Review is out of date");
    assertStringIncludes(surface, "Reload review");
    assertStringIncludes(surface, "globalThis.location.reload()");
});

test("Plan annotations use default chat and a per-type queue instead of sending or attaching from the pane", async () => {
    await withReview(async ({ container, button, addNote, openChat, fill, submitted }) => {
        const opener = container.querySelector('[aria-label="Open annotations sidebar"]');
        if (opener) await act(() => opener.click());
        assertEquals(container.querySelector('button[title="Planner"]').getAttribute("aria-selected"), "true");
        await addNote("Keep the existing URLs.");
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 annotations");
        await act(() => button("Exclude annotations").click());
        await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Why is this needed?");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[0].feedback.includes("Keep the existing URLs."), false);
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 annotations");
        await act(() => container.querySelector('button[title="Annotations"]').click());
        assertStringIncludes(container.textContent, "Keep the existing URLs.");
        assertEquals(button("Send Annotations"), undefined);
        assertEquals(button("Add to Planner chat"), undefined);
        await openChat();
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[1].feedback, "Keep the existing URLs.");
        assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
    }, "# Plan\n\nPreserve saved URLs.\n");
});

test("Plan reviews without a conversation retain the Send Annotations fallback", async () => {
    await withReview(
        async ({ container, button, addNote, submitted }) => {
            await addNote("Clarify offline use.");
            assertEquals(Boolean(button("Send Annotations")), true);
            await act(() => button("Send Annotations").click());
            assertStringIncludes(submitted[0].feedback, "Clarify offline use.");
            assertEquals(submitted[0].conversationTurn, undefined);
            assertEquals(container.querySelector('[aria-label="Planner conversation"]'), null);
        },
        "# Plan\n",
        { conversationStatusUrl: undefined },
    );
});

test("Code feedback action matches the Plan annotation sidebar treatment", async () => {
    const surface = await fsReadFile(CODE_SURFACE_PATH, "utf8");
    const sidebarIndex = surface.indexOf('className="rw-code-review-annotation-sidebar"');
    const actionIndex = surface.indexOf(': "Send Annotations"');
    const listIndex = surface.indexOf("<ReviewSidebar", sidebarIndex);

    assertStringIncludes(surface, 'className="rw-review-feedback-action rw-review-action');
    assertStringIncludes(surface, ': "Send Annotations"');
    if (sidebarIndex < 0 || actionIndex < sidebarIndex || listIndex < actionIndex) {
        throw new Error("Code Review's Send Annotations action must sit above the annotation list");
    }
});

test("Code Review reuses artifact chat and reloads the republished file diff", async () => {
    const route = await fsReadFile(
        "src/ui/workspace/pages/projects/[projectId]/sessions/[runwieldSessionId]/review/code.astro",
        "utf8",
    );
    const surface = await fsReadFile(CODE_SURFACE_PATH, "utf8");

    assertStringIncludes(route, "operationStatusUrl");
    assertStringIncludes(route, "interactionAnswerBaseUrl");
    assertStringIncludes(surface, "<ArtifactConversationSidebar");
    assertStringIncludes(surface, "Add to {agentLabel} chat");
    assertStringIncludes(surface, 'artifactKind: "code"');
    assertStringIncludes(surface, "waitForStandaloneCodeReview");
    assertStringIncludes(surface, "waitForWorkspaceCodeReview");
    assertStringIncludes(surface, "setActiveRawPatch(options.rawPatch)");
    assertStringIncludes(surface, "conversationTurn: true");
    assertStringIncludes(surface, ': "Send Annotations"');
});

test("Code Review uses the Workspace header when embedded and preserves standalone controls", async () => {
    const surface = await fsReadFile(CODE_SURFACE_PATH, "utf8");
    const headingIndex = surface.indexOf('className="rw-plan-review-heading"');
    const optionsIndex = surface.indexOf("{reviewOptions}", headingIndex);
    const logoIndex = surface.indexOf('<img src="/brand/logo.svg"', headingIndex);
    const actionsIndex = surface.indexOf('className="rw-plannotator-actions"');
    const approveIndex = surface.indexOf("<ApproveButton", actionsIndex);
    assertStringIncludes(surface, "<WorkspaceHeaderActionsPortal>{reviewActions}</WorkspaceHeaderActionsPortal>");
    assertStringIncludes(surface, '{presentation === "workspace" && reviewOptions}');

    assertStringIncludes(surface, "function CodeReviewOptionsMenu({\n    iconOnly = false,");
    assertStringIncludes(surface, '<RunWieldMenu label="Options" iconOnly={iconOnly}');
    const menu = await fsReadFile("src/ui/design-system/components/react/RunWieldMenu.tsx", "utf8");
    assertStringIncludes(menu, "!iconOnly && <span");
    assertStringIncludes(surface, "const codeReviewHeading = `Code Review - ${codeReviewPlanTitle}`;");
    assertStringIncludes(surface, "<h1 title={codeReviewHeading}>{codeReviewHeading}</h1>");
    if (headingIndex < 0 || optionsIndex < headingIndex || logoIndex < optionsIndex) {
        throw new Error("Code Review options must be icon-only before the logo, matching Plan Review");
    }
    if (actionsIndex < 0 || approveIndex < actionsIndex) {
        throw new Error("Code Review header actions must retain approval");
    }
});

test("Code Review title ellipsizes without moving toolbar actions", async () => {
    const styles = await fsReadFile("src/ui/workspace/react/plannotator.css", "utf8");

    assertStringIncludes(styles, ".rw-code-review .rw-plan-review-heading {");
    assertStringIncludes(styles, "flex: 1 1 auto;");
    assertStringIncludes(styles, "overflow: hidden;");
    assertStringIncludes(styles, ".rw-code-review .rw-plan-review-heading h1 {");
    assertStringIncludes(styles, "text-overflow: ellipsis;");
    assertStringIncludes(styles, ".rw-code-review .rw-plannotator-actions {");
    assertStringIncludes(styles, "flex: none;");
});

test("Code Review uses the Plan Review card surface for review panels", async () => {
    const styles = await fsReadFile("src/ui/workspace/react/plannotator.css", "utf8");

    assertStringIncludes(styles, ".rw-review-file-tree {");
    assertStringIncludes(styles, ".rw-code-review-annotation-sidebar {");
    assertStringIncludes(styles, ".rw-code-review-annotation-sidebar > aside {");
    assertStringIncludes(styles, ".rw-review-all-files-host {");
    assertStringIncludes(styles, ".rw-code-diff-stage {");
    assertStringIncludes(styles, ".rw-code-review diffs-container {");
    assertStringIncludes(styles, "background: var(--card);");
    assertStringIncludes(styles, "background: var(--card) !important;");
});

test("Plan and Code review use shared toolbar structure with edge-aligned restore buttons", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");
    const codeSurface = await fsReadFile(CODE_SURFACE_PATH, "utf8");
    const styles = await fsReadFile("src/ui/workspace/react/plannotator.css", "utf8");
    const leftRestoreIndex = surface.indexOf(
        'className="rw-review-toolbar-edge rw-review-toolbar-edge-left rw-plan-review-sidebar-restore rw-plan-review-sidebar-restore-left"',
    );
    const contentsIndex = surface.indexOf("Contents", leftRestoreIndex);
    const modeActionsIndex = surface.indexOf('className="rw-review-toolbar-center rw-plan-review-mode-actions"');
    const rightRestoreIndex = surface.indexOf(
        'className="rw-review-toolbar-edge rw-review-toolbar-edge-right rw-plan-review-sidebar-restore rw-plan-review-sidebar-restore-right"',
    );
    const annotationsIndex = surface.indexOf("Annotations", rightRestoreIndex);
    const saveControlsIndex = surface.indexOf('className="rw-editor-save-controls"', rightRestoreIndex);
    const sidebarIndex = surface.indexOf('className="rw-plan-review-annotation-sidebar"');
    const collapseIndex = surface.indexOf('<PanelCollapseIcon side="right" />', sidebarIndex);

    assertStringIncludes(surface, "data-plan-width={planWidthMode}");
    assertStringIncludes(surface, 'className="rw-review-toolbar rw-plan-review-controls"');
    assertStringIncludes(surface, 'className="rw-plan-sidebar-tab-toggle rw-underline-tabs rw-review-sidebar-tabs"');
    assertStringIncludes(surface, 'aria-label="Plan sidebar"');
    assertStringIncludes(surface, '<ToggleIcon name="contents" />');
    assertStringIncludes(surface, '<ToggleIcon name="versions" />');
    assertStringIncludes(surface, '<ToggleIcon name="view" />');
    assertStringIncludes(surface, '<ToggleIcon name="edit" />');
    assertStringIncludes(surface, '<ToggleIcon name="changes" />');
    assertStringIncludes(surface, '<ToggleIcon name="annotations" />');
    assertStringIncludes(surface, '<h2 id="rw-plan-review-annotations-heading">Annotations</h2>');
    assertStringIncludes(surface, "<span>Contents</span>");
    assertStringIncludes(surface, "<span>Annotations</span>");
    assertStringIncludes(surface, 'className="rw-toolbar-button"');
    assertStringIncludes(surface, "disabled={!editorDirty}");
    if (styles.includes(".rw-editor-save-controls button")) {
        throw new Error("Plan Review Save button must use shared rw-toolbar-button CSS");
    }
    assertStringIncludes(surface, '{ value: "engineer", label: "Engineer", icon: "engineer" }');
    assertStringIncludes(surface, '{ value: "frontend-engineer", label: "Frontend Engineer", icon: "frontend" }');
    assertStringIncludes(surface, '{ value: "pair", label: "Pair Execution", icon: "pair" }');
    assertStringIncludes(surface, '{ value: "autonomous", label: "Autonomous", icon: "autonomous" }');
    assertStringIncludes(
        styles.replace(/\s+/g, " "),
        ".rw-plan-review .rw-plannotator-plan-layout:has(> .rw-plan-sidebar-tab-toggle)",
    );
    assertStringIncludes(styles, ".rw-plan-sidebar-tab-toggle {\n    position: absolute;\n    top: 0;");
    assertStringIncludes(surface.replace(/\s+/g, " "), "compact showHelpLink={false}");
    assertStringIncludes(codeSurface, 'className="rw-review-toolbar rw-code-diff-toolbar"');
    assertStringIncludes(codeSurface, "<FileTreeIcon />");
    assertStringIncludes(codeSurface, "<CommentIcon />");
    assertStringIncludes(codeSurface, "<h2>Annotations</h2>");
    assertStringIncludes(codeSurface, 'return readStoredFilePanelMode() || "tree";');
    const filesToggleIndex = codeSurface.indexOf('title="Files"');
    const changesToggleIndex = codeSurface.indexOf('title="Changes"');
    if (filesToggleIndex === -1 || changesToggleIndex === -1 || filesToggleIndex > changesToggleIndex) {
        throw new Error("Code Review file panel toggle must show Files before Changes");
    }
    assertStringIncludes(codeSurface, "<span>Files</span>");
    assertStringIncludes(codeSurface, "<span>Annotations</span>");
    assertStringIncludes(
        codeSurface,
        'className="rw-review-toolbar-edge rw-review-toolbar-edge-left rw-code-diff-left-controls"',
    );
    assertStringIncludes(
        codeSurface,
        'className="rw-review-toolbar-edge rw-review-toolbar-edge-right rw-code-diff-layout-controls"',
    );
    assertStringIncludes(surface, "data-annotations-open={annotationsOpen}");
    assertStringIncludes(surface, 'className="rw-plan-review-sidebar-collapse"');
    assertStringIncludes(surface, 'title="Collapse contents sidebar"');
    assertStringIncludes(surface, 'aria-label="Collapse contents sidebar"');
    assertStringIncludes(surface, '<PanelCollapseIcon side="left" />');
    assertStringIncludes(surface, 'title="Collapse annotations sidebar"');
    assertStringIncludes(surface, 'aria-label="Collapse annotations sidebar"');
    const sharedStyles = await fsReadFile("src/ui/design-system/components.css", "utf8");
    assertStringIncludes(sharedStyles, ".rw-menu-positioner {\n    z-index: 90;");
    assertStringIncludes(surface, 'planWidthMode === "wide"');
    assertStringIncludes(surface, "function PanelCollapseIcon({ side })");
    assertStringIncludes(styles, ".fixed.inset-0.z-50.bg-black\\/50.backdrop-blur-\\[2px\\]");
    assertStringIncludes(styles, '[data-popout="true"] {');
    assertStringIncludes(styles, "z-index: 1100 !important;");
    assertStringIncludes(styles, '[data-popout="true"] diffs-container');
    assertStringIncludes(styles, ".rw-review-toolbar {");
    assertStringIncludes(styles, "grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);");
    assertStringIncludes(styles, "min-height: var(--rw-review-toolbar-h, 4rem);");
    assertStringIncludes(styles, "padding: var(--rw-review-toolbar-padding, 0.75rem);");
    assertStringIncludes(styles, ".rw-review-toolbar-edge-left");
    assertStringIncludes(styles, "grid-column: 1;");
    assertStringIncludes(styles, ".rw-review-toolbar-edge-right");
    assertStringIncludes(styles, "grid-column: 3;");
    assertStringIncludes(styles, ".rw-review-toolbar-center");
    assertStringIncludes(styles, "grid-column: 2;");
    assertStringIncludes(styles, ".rw-code-file-tabs {");
    assertStringIncludes(
        styles,
        ".rw-plan-review .rw-plannotator-plan-layout > aside:not([data-annotation-panel]) > div:first-child {",
    );
    assertStringIncludes(styles, "background: color-mix(in oklab, var(--plannotator-surface) 92%, transparent);");
    assertStringIncludes(styles, ".rw-plan-review-annotation-heading,");
    assertStringIncludes(styles, ".rw-review-annotation-heading {");
    assertStringIncludes(styles, "grid-template-columns: 17.5rem minmax(0, 1fr) 20rem;");
    assertStringIncludes(styles, "grid-template-columns: 17.5rem minmax(0, 1fr);");
    assertStringIncludes(styles, '.rw-plannotator-plan-layout[data-annotations-open="false"]');
    assertStringIncludes(
        styles,
        '.rw-plannotator-plan-layout[data-sidebar-open="false"][data-annotations-open="false"]',
    );
    assertStringIncludes(styles, ".rw-plan-review-controls {");
    assertStringIncludes(styles, "grid-template-columns: auto minmax(0, 1fr) auto;");
    assertStringIncludes(styles, ".rw-plan-review-mode-actions {");
    assertStringIncludes(styles, '.rw-plan-review[data-plan-width="wide"] .rw-plan-document-canvas');
    assertStringIncludes(styles, '.rw-plan-review[data-plan-width="wide"] article[data-print-region="article"]');
    assertStringIncludes(styles, "max-width: none !important;");
    assertStringIncludes(styles, "border: 0 !important;");
    assertStringIncludes(styles, "border-radius: 0 !important;");
    assertStringIncludes(styles, "box-shadow: none !important;");
    assertStringIncludes(styles, "justify-content: flex-start;");
    assertStringIncludes(styles, "justify-self: start;");
    assertStringIncludes(styles, ".rw-plan-review-sidebar-collapse");
    if (
        styles.includes("--rw-review-toolbar-h: var(--panel-header-h, 2.5rem)") ||
        styles.includes("--rw-review-toolbar-padding: 0.35rem 0.75rem")
    ) {
        throw new Error("Code Review must not opt out of the shared review toolbar height and padding");
    }
    if (
        surface.includes("rw-annotation-reopen") ||
        surface.includes("<SidebarTabs") ||
        surface.includes("<ResizeHandle")
    ) {
        throw new Error("Plan Review must use one Code Review-style collapse and toolbar restore pattern");
    }
    if (
        leftRestoreIndex < 0 ||
        contentsIndex < leftRestoreIndex ||
        modeActionsIndex < contentsIndex ||
        rightRestoreIndex < modeActionsIndex ||
        saveControlsIndex < rightRestoreIndex ||
        annotationsIndex < rightRestoreIndex ||
        sidebarIndex < 0 ||
        collapseIndex < sidebarIndex
    ) {
        throw new Error(
            "Plan Review must align Contents left, edit Save controls right, and Annotations right in the toolbar",
        );
    }
});

test("Review segmented toggles use shared compact icon-label behavior", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");
    const remoteSurface = await fsReadFile(REMOTE_SURFACE_PATH, "utf8");
    const settings = await fsReadFile(SETTINGS_PATH, "utf8");
    const wrapper = await fsReadFile(ANNOTATION_TOOLSTRIP_PATH, "utf8");
    const styles = await fsReadFile("src/ui/workspace/react/plannotator.css", "utf8");
    const components = await fsReadFile("src/ui/design-system/components.css", "utf8");
    const docs = await fsReadFile("docs/design-system.md", "utf8");

    assertStringIncludes(surface, "<RunWieldAnnotationToolstrip");
    assertStringIncludes(remoteSurface, "<RunWieldAnnotationToolstrip");
    assertStringIncludes(wrapper, 'classList.add("rw-segmented-toggle")');
    assertStringIncludes(wrapper, "button.title = label;");
    assertStringIncludes(wrapper, 'button.setAttribute("aria-label", label);');
    assertStringIncludes(wrapper, 'className="rw-plannotator-annotation-toolstrip"');
    if (styles.includes(".rw-plannotator-annotation-toolstrip .rw-segmented-toggle button")) {
        throw new Error("Workspace CSS must not customize segmented-toggle buttons");
    }
    assertStringIncludes(components, ".rw-segmented-toggle button > div");
    assertStringIncludes(components, ".rw-segmented-toggle button span:not([aria-hidden])");
    assertStringIncludes(components, ".rw-segmented-toggle button:hover:not(:disabled)");
    assertStringIncludes(docs, "Inactive options stay icon-only.");
    assertStringIncludes(docs, "hover must not expand labels");
    assertStringIncludes(settings, "<SettingsToggleIcon name={option.id} />");
    assertStringIncludes(settings, "<SettingsToggleIcon name={option.value} />");
    assertStringIncludes(settings, "title={option.label}");
});

test("Run returns to Session while Later stays on confirmation", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(route, "interactionAnswerUrl");
    assertStringIncludes(surface, "Approve & Run");
    assertStringIncludes(surface, "Later");
    assertStringIncludes(surface, "approved-later");
});

test("Plan and Epic reviews expose classification-correct actions", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(surface, "PLAN_APPROVAL_ACTIONS.DECOMPOSE");
    assertStringIncludes(surface, "Approve & Slice");
    assertStringIncludes(surface, "Approve & Run");
});

test("revised Plan reviews expose selectable Plannotator version history", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(surface, "usePlanDiff");
    assertStringIncludes(surface, "PlanDiffViewer");
    assertStringIncludes(surface, "normalizePlanReviewVersions");
    assertStringIncludes(surface, "showVersionsTab={versionInfo !== null}");
    assertStringIncludes(surface, "onSelectBaseVersion={selectPlanVersion}");
    assertStringIncludes(surface, "Changes");
});

test("Plan reviews inspect affected files and export complete feedback", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(surface, "AffectedFilesMenu");
    assertStringIncludes(surface, "onOpenCodeFile={codeFilePopout.open}");
    assertStringIncludes(surface, "CodeFilePopout");
    assertStringIncludes(surface, "codeAnnotations={codeAnnotations}");
    assertStringIncludes(surface, "Export review feedback");
    assertStringIncludes(surface, 'annotationsOutput={exportOpen ? currentFeedback() : ""}');
});

test("Plan reviews recover unfinished work and send direct edits as feedback", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");

    assertStringIncludes(surface, "Unfinished review found");
    assertStringIncludes(surface, "Restore draft");
    assertStringIncludes(surface, "persistReviewDraftLocally");
    assertStringIncludes(surface, "directEdits={directEditPanel}");
    assertMatch(surface, /disabled=\{\s*!hasGroupFeedback \|\| submitting !== null \|\| plannerWorking\s*\}/);
    assertStringIncludes(surface, "plannerWorking || reviewGroup?.busy}");
    assertStringIncludes(surface, "buildPlanReviewFeedback");
});

test("Plan and Code annotation tabs occupy the shared header in every presentation", async () => {
    for (const [path, headingClass] of [
        [SURFACE_PATH, "rw-plan-review-annotation-heading"],
        [CODE_SURFACE_PATH, "rw-review-annotation-heading"],
    ]) {
        const source = await fsReadFile(path, "utf8");
        const heading = source.indexOf(`className="${headingClass}`);
        const tabs = source.indexOf('role="tablist"', heading);
        const collapse = source.indexOf('title="Collapse annotations sidebar"', heading);
        const actions = source.indexOf('className="rw-review-feedback-action rw-review-action', heading);
        assertEquals(heading >= 0 && tabs > heading && tabs < collapse && collapse < actions, true);
        assertEquals(source.slice(heading, actions).includes("presentation ==="), false);
        assertStringIncludes(source.slice(heading, tabs), "conversationEnabled");
    }
});
test("Compact Plan Review starts collapsed and keeps panel controls outside document scrolling", async () => {
    const surface = await fsReadFile(SURFACE_PATH, "utf8");
    const styles = await fsReadFile("src/ui/workspace/react/plannotator.css", "utf8");
    assertStringIncludes(surface, 'globalThis.matchMedia?.("(max-width: 980px)")');
    assertStringIncludes(surface, "!compactLayout && uiPreferences.tocEnabled");
    assertStringIncludes(surface, "useReviewAnnotations(annotations.length + codeAnnotations.length)");
    assertStringIncludes(surface, 'media.addEventListener("change", syncLayout)');
    assertStringIncludes(surface, 'media.removeEventListener("change", syncLayout)');
    assertStringIncludes(surface, "if (compactLayout) setAnnotationsOpen(false)");
    assertStringIncludes(surface, "if (compactLayout) setSidebarOpen(false)");
    assertStringIncludes(surface, 'aria-label="Open contents sidebar"');
    assertStringIncludes(surface, 'aria-label="Open annotations sidebar"');
    assertStringIncludes(surface, '<RunWieldMenu label="Review tools"');
    assertStringIncludes(surface, '<RunWieldMenu label="Execution options"');
    const mobilePanels = styles.slice(styles.indexOf("/* Compact review follows Plannotator"));
    assertStringIncludes(mobilePanels, "position: absolute;");
    assertStringIncludes(mobilePanels, "inset: 0;");
    assertStringIncludes(mobilePanels, "max-height: none;");
    assertStringIncludes(mobilePanels, "visibility: hidden;");
});

const questionPlan =
    '# Plan\n\n- [ ] Keep saved links\n\n```wld-question\n{"id":"scope","type":"yes_no","prompt":"Keep old links?","default":true}\n```\n';

test("excluded direct edits cannot be saved by a chat turn and approval still forwards them", async () => {
    await withReview(async ({ container, button, openChat, fill, submitted, confirm }) => {
        await act(() => container.querySelector('[role="checkbox"]').click());
        await openChat();
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
        await act(() => button("Exclude direct edits").click());
        await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the current Plan.");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[0].plan, questionPlan);
        assertEquals(submitted[0].feedback.includes("### Direct"), false);
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
        await act(() => button("Exclude direct edits").click());
        await act(() => button("Approve & Run").click());
        assertEquals(submitted.length, 1);
        confirm(true);
        await act(() => button("Approve as is").click());
        assertStringIncludes(submitted[1].plan, "- [x] Keep saved links");
        assertStringIncludes(submitted[1].feedback, "Keep saved links");
    }, questionPlan);
});

for (const sentEdit of [false, true]) {
    test(`an Agent revision preserves direct edits made while waiting ${sentEdit ? "after sending an earlier edit" : "without a sent edit"}`, async () => {
        await withReview(
            async ({ browser, container, button, openChat, fill, submitted, hold, release, revise, confirm }) => {
                if (sentEdit) await act(() => container.querySelector('[role="checkbox"]').click());
                await openChat();
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Clarify the rollout.");
                hold();
                await act(() => button("Send to Planner").click());
                assertEquals(submitted.length, 1);
                const sentPlan = sentEdit ? questionPlan.replace("- [ ]", "- [x]") : questionPlan;
                assertEquals(submitted[0].plan, sentPlan);

                await act(() => container.querySelector('[role="checkbox"]').click());
                const ownerDraft = sentEdit ? questionPlan : questionPlan.replace("- [ ]", "- [x]");
                const revisedPlan = `${sentPlan}\nAgent rollout detail.\n`;
                revise(revisedPlan);
                await release();

                assertStringIncludes(
                    container.querySelector('[aria-label="Review Queue"]')?.textContent || "",
                    "1 direct edits",
                );
                browser.dispatchEvent(new browser.Event("pagehide"));
                const saved = parsePlanReviewDraft(
                    browser.localStorage.getItem(planReviewDraftKey("questions")),
                    revisedPlan,
                );
                assertEquals(saved?.editedPlan, ownerDraft);
                confirm(true);
                await act(() => button("Approve & Run").click());
                assertEquals(submitted.length, 2);
                assertEquals(submitted[1].plan, ownerDraft);
                assertStringIncludes(submitted[1].feedback, "Keep saved links");
            },
            questionPlan,
        );
    });
}

for (const revised of [false, true]) {
    test(`approval ${revised ? "does not warn after a revision" : "warns after a reply-only turn and Cancel keeps review open"}`, async () => {
        await withReview(async ({ container, button, openChat, fill, submitted, revise, reply }) => {
            await openChat();
            await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the choice.");
            if (revised) revise("# Plan\n\nUpdated choice.\n");
            reply("Here is the reason.");
            await act(() => button("Send to Planner").click());
            assertStringIncludes(
                container.querySelector('[aria-label="Planner conversation"]').textContent,
                "Here is the reason.",
            );
            await act(() => button("Approve & Run").click());
            if (revised) {
                assertEquals(submitted.length, 2);
                assertEquals(container.querySelector("dialog"), null);
            } else {
                assertEquals(submitted.length, 1);
                assertStringIncludes(container.querySelector("dialog").textContent, "Ask Planner to update the Plan");
                await act(() => button("Cancel").click());
                assertEquals(container.querySelector("dialog"), null);
                assertEquals(submitted.length, 1);
                await act(() => button("Approve & Run").click());
                await act(() => button("Approve as is").click());
                assertEquals(submitted[1].approved, true);
            }
        }, "# Plan\n\nCurrent choice.\n");
    });
}

test("a saved owner revision permits approval when the Agent echoes the sent Plan unchanged", async () => {
    await withReview(async ({ container, button, openChat, fill, submitted, revise, reply, confirm }) => {
        await openChat();
        const composer = container.querySelector('textarea[aria-label="Message Planner"]');
        await fill(composer, "Explain the choice.");
        await act(() => button("Send to Planner").click());
        await act(() => container.querySelector('[role="checkbox"]').click());
        const editedPlan = questionPlan.replace("- [ ]", "- [x]");
        revise(editedPlan);
        reply("The saved task change is sufficient.");
        await fill(composer, "Keep my task change.");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[1].plan, editedPlan);
        assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
        confirm(true);
        await act(() => button("Approve & Run").click());
        assertEquals(container.querySelector("dialog"), null);
        assertEquals(submitted.length, 3);
        assertEquals(submitted[2].approved, true);
        assertEquals(submitted[2].plan, editedPlan);
    }, questionPlan);
});

test("Workspace reply-only recovery displays the Agent error and keeps review approvable", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted, failAgent }) => {
            await openChat();
            await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the scope.");
            failAgent("The planning provider is unavailable.");
            await act(() => button("Send to Planner").click());
            assertStringIncludes(
                container.querySelector('[aria-label="Planner conversation"]').textContent,
                "Agent error: The planning provider is unavailable.",
            );
            assertEquals(container.textContent.includes("I reviewed that request and left the Plan unchanged."), false);
            await act(() => button("Approve & Run").click());
            await act(() => button("Approve as is").click());
            assertEquals(submitted[1].approved, true);
        },
        "# Plan\n\nCurrent scope.\n",
        {
            conversationStatusUrl: undefined,
            operationStatusUrl: "/operation",
            planDetailUrl: "/detail",
            interactionAnswerBaseUrl: "/answers",
            interactionId: "initial",
        },
    );
});

test("Ask Architect to update sends a fixed chat turn, not approval, and retains the composer", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted }) => {
            // The helper's openChat also opens the rail for other agent labels.
            await openChat();
            await fill(container.querySelector('textarea[aria-label="Message Architect"]'), "Explain the design.");
            await act(() => button("Send to Architect").click());
            await fill(container.querySelector('textarea[aria-label="Message Architect"]'), "Unsent owner text.");
            await act(() => button("Approve & Slice").click());
            await act(() => button("Ask Architect to update the Plan").click());
            assertEquals(submitted[1].conversationTurn, true);
            assertEquals(submitted[1].approved, undefined);
            assertStringIncludes(submitted[1].feedback, "Please update the Plan to reflect our review conversation.");
            assertEquals(submitted[1].feedback.includes("Unsent owner text."), false);
            assertEquals(
                container.querySelector('textarea[aria-label="Message Architect"]').value,
                "Unsent owner text.",
            );
        },
        "# Epic\n",
        { agentLabel: "Architect", classification: "PROJECT", executionPolicy: { classification: "PROJECT" } },
    );
});

test("failed chat keeps its message, excluded notes, and retry route", async () => {
    await withReview(async ({ container, button, addNote, openChat, fill, submitted, failNext }) => {
        await addNote("Keep this annotation.");
        await openChat();
        await act(() => button("Exclude annotations").click());
        const composer = container.querySelector('textarea[aria-label="Message Planner"]');
        await fill(composer, "Explain the behavior.");
        failNext();
        await act(() => button("Send to Planner").click());
        assertEquals(submitted.length, 0);
        assertEquals(composer.value, "Explain the behavior.");
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "excluded");
        assertStringIncludes(container.textContent, "Connection lost. Try again.");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted.length, 1);
        assertEquals(submitted[0].feedback.includes("Keep this annotation."), false);
    }, "# Plan\n");
});

test("all queue types are included by default and only included types leave after Send", async () => {
    await withReview(async ({ browser, container, button, openChat, reload, submitted }) => {
        const draft = createPlanReviewDraft({
            basePlan: questionPlan,
            editedPlan: questionPlan.replace("[ ]", "[x]"),
            annotations: [{ id: "note", type: "GLOBAL_COMMENT", text: "Plan note.", createdA: 1 }],
            codeAnnotations: [
                {
                    id: "file",
                    type: "comment",
                    scope: "line",
                    filePath: "src/link.ts",
                    lineStart: 1,
                    lineEnd: 1,
                    side: "new",
                    text: "File note.",
                    createdAt: 1,
                },
            ],
            globalAttachments: [{ path: "/image.png", name: "Link image" }],
            questionAnswers: [{ id: "scope", value: false }],
        });
        browser.localStorage.setItem(planReviewDraftKey("questions"), serializePlanReviewDraft(draft));
        await reload();
        await act(() => button("Restore draft").click());
        await openChat();
        for (const type of ["annotations", "file annotations", "images", "direct edits", "answers"]) {
            assertEquals(Boolean(button(`Exclude ${type}`)), true);
        }
        await act(() => button("Exclude images").click());
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[0].feedback, "Plan note.");
        assertStringIncludes(submitted[0].feedback, "File note.");
        assertEquals(submitted[0].globalAttachments, []);
        const queue = container.querySelector('[aria-label="Review Queue"]');
        assertStringIncludes(queue.textContent, "1 images");
        assertEquals(queue.querySelectorAll(".rw-review-queue-item").length, 1);
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[1].globalAttachments.length, 1);
    }, questionPlan);
});

const sequenceDocuments = [
    {
        planId: "sequence",
        planName: "sequence",
        plan: "# Sequence\n",
        frontmatter: { classification: "PLANNED_CHANGE", type: "SEQUENCE" },
    },
    { planId: "child", planName: "child", plan: questionPlan, frontmatter: { classification: "PLANNED_CHANGE" } },
];

test("a Sequence revision keeps a new child draft after an earlier direct edit was sent", async () => {
    await withReview(
        async ({ browser, container, button, openChat, fill, submitted, hold, release, reviseDocuments, confirm }) => {
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            await act(() => child.querySelector('[role="checkbox"]').click());
            await openChat();
            await fill(child.querySelector('textarea[aria-label="Message Planner"]'), "Clarify this child.");
            hold();
            await act(() => button("Send to Planner").click());
            assertStringIncludes(submitted[0].documents[1].plan, "- [x] Keep saved links");
            await act(() => child.querySelector('[role="checkbox"]').click());
            const revisedPlan = `${questionPlan.replace("- [ ]", "- [x]")}\nAgent rollout detail.\n`;
            reviseDocuments([sequenceDocuments[0], { ...sequenceDocuments[1], plan: revisedPlan }]);
            await release();

            assertStringIncludes(child.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
            browser.dispatchEvent(new browser.Event("pagehide"));
            const saved = parsePlanReviewDraft(
                browser.localStorage.getItem(planReviewDraftKey("questions:child")),
                revisedPlan,
            );
            assertEquals(saved?.editedPlan, questionPlan);
            confirm(true);
            await act(() => button("Approve & Execute").click());
            assertEquals(submitted.length, 2);
            assertEquals(submitted[1].documents[1].plan, questionPlan);
            assertStringIncludes(submitted[1].documents[1].feedback, "Keep saved links");
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

test("a saved owner child revision clears the Sequence warning when the Agent echoes every sent Plan", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted, reviseDocuments, reply, confirm, hold, release }) => {
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            await act(() => child.querySelector('[role="checkbox"]').click());
            const editedPlan = questionPlan.replace("- [ ]", "- [x]");
            reviseDocuments([sequenceDocuments[0], { ...sequenceDocuments[1], plan: editedPlan }]);
            reply("The saved child task change is sufficient.");
            await openChat();
            await fill(child.querySelector('textarea[aria-label="Message Planner"]'), "Keep my child task change.");
            hold();
            await act(() => button("Send to Planner").click());
            assertEquals(
                submitted[0].documents.map((document) => document.plan),
                [sequenceDocuments[0].plan, editedPlan],
            );
            await release();
            await act(() => button("Sequence overview").focus());
            confirm(true);
            await act(() => button("Approve & Execute").click());
            assertEquals(container.querySelector("dialog"), null);
            assertEquals(submitted.length, 2);
            assertEquals(submitted[1].approved, true);
            assertEquals(submitted[1].documents[1].plan, editedPlan);
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

test("Sequence Submit answer isolates one child answer from group notes, messages, and direct edits", async () => {
    await withReview(
        async ({ container, button, openChat, addNote, fill, submitted }) => {
            await addNote("Sequence note must stay queued.");
            await openChat();
            await fill(
                container.querySelector('textarea[aria-label="Message Planner"]'),
                "Sequence message must stay unsent.",
            );
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            await act(() => child.querySelector('[role="checkbox"]').click());
            const no = [...child.querySelectorAll("label")]
                .find((element) => element.textContent === "No")
                .querySelector("input");
            await act(() => no.click());
            await act(() => child.querySelector(".rw-question-card button").click());
            assertEquals(submitted[0].documents.length, 2);
            assertEquals(submitted[0].documents[0].feedback, "");
            assertEquals(submitted[0].documents[0].plan, sequenceDocuments[0].plan);
            assertEquals(submitted[0].documents[1].plan, questionPlan);
            assertStringIncludes(submitted[0].feedback, "### Question answers");
            assertEquals(submitted[0].feedback.includes("must stay"), false);
            assertEquals(submitted[0].feedback.includes("Direct"), false);
            assertStringIncludes(child.querySelector(".rw-question-card").textContent, "Answer sent");
            await act(() => button("Sequence overview").focus());
            assertEquals(
                container.querySelector('textarea[aria-label="Message Planner"]').value,
                "Sequence message must stay unsent.",
            );
            assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 annotations");
            assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

test("Sequence exclusions apply across tabs, preserve excluded notes, and approval forwards the entire queue", async () => {
    await withReview(
        async ({ container, button, openChat, addNote, fill, submitted, confirm }) => {
            await addNote("Sequence unsent note.");
            await openChat();
            await act(() => button("Exclude annotations").click());
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            const opener = child.querySelector('[aria-label="Open annotations sidebar"]');
            if (opener) await act(() => opener.click());
            assertStringIncludes(child.querySelector('[aria-label="Review Queue"]').textContent, "excluded");
            const composer = child.querySelector('textarea[aria-label="Message Planner"]');
            await fill(composer, "Explain the Sequence.");
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.textContent.trim() === "Send to Planner")
                    .click(),
            );
            assertEquals(submitted[0].feedback.includes("Sequence unsent note."), false);
            assertEquals(submitted[0].documents[0].annotations.length, 0);
            await act(() => child.querySelector('[aria-label="Exclude annotations"]').click());
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.getAttribute("aria-label") === "Approve & Execute")
                    .click(),
            );
            confirm(true);
            await act(() => button("Approve as is").click());
            assertStringIncludes(submitted[1].documents[0].feedback, "Sequence unsent note.");
            assertEquals(submitted[1].documents[0].annotations.length, 1);
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

for (const workspace of [false, true]) {
    test(`${workspace ? "Workspace" : "standalone"} chat accepts the backend rearmed review after more than 180 seconds`, async () => {
        await withReview(
            async ({ container, button, openChat, fill, submitted, delayRearm }) => {
                await openChat();
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain this Plan.");
                const realNow = Date.now;
                let now = realNow();
                try {
                    Date.now = () => (now += 181_000);
                    if (workspace) delayRearm(1);
                    await act(() => button("Send to Planner").click());
                    if (workspace) await act(async () => await new Promise((resolve) => setTimeout(resolve, 800)));
                    assertEquals(button("Send to Planner").disabled, true); // No text or queue remains.
                    assertEquals(button("Approve & Run").disabled, false);
                    assertEquals(container.querySelector('[role="alert"]'), null);
                    await act(() => button("Approve & Run").click());
                    await act(() => button("Approve as is").click());
                    assertEquals(submitted.length, 2);
                    assertEquals(submitted[1].approved, true);
                } finally {
                    Date.now = realNow;
                }
            },
            "# Plan\n",
            workspace
                ? {
                      mode: "workspace",
                      conversationStatusUrl: undefined,
                      operationStatusUrl: "/operation",
                      planDetailUrl: "/detail",
                      interactionAnswerBaseUrl: "/answers",
                      interactionId: "review-0",
                  }
                : {},
        );
    });
}

test("a Sequence child revision clears the group approval warning and preserves excluded answers", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted, reviseDocuments }) => {
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            const no = [...child.querySelectorAll("label")]
                .find((element) => element.textContent === "No")
                .querySelector("input");
            await act(() => no.click());
            await openChat();
            const exclude = child.querySelector('[aria-label="Exclude answers"]');
            await act(() => exclude.click());
            await fill(child.querySelector('textarea[aria-label="Message Planner"]'), "Revise this child only.");
            reviseDocuments([
                sequenceDocuments[0],
                { ...sequenceDocuments[1], plan: `${questionPlan}\nUpdated verification.\n` },
            ]);
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.textContent.trim() === "Send to Planner")
                    .click(),
            );
            assertEquals(submitted[0].documents[1].questionAnswers, []);
            assertEquals(no.checked, true);
            assertStringIncludes(child.querySelector('[aria-label="Review Queue"]').textContent, "1 answers");
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.getAttribute("aria-label") === "Approve & Execute")
                    .click(),
            );
            assertEquals(container.querySelector("dialog"), null);
            assertEquals(submitted.length, 2);
            assertEquals(submitted[1].documents[1].questionAnswers, [{ id: "scope", value: false }]);
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

for (const workspace of [false, true]) {
    test(`${workspace ? "Workspace" : "standalone"} reports a failed review re-arm instead of waiting indefinitely`, async () => {
        await withReview(
            async ({ container, button, fill, failRearm }) => {
                const opener = container.querySelector('[aria-label="Open annotations sidebar"]');
                if (opener) await act(() => opener.click());
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the scope.");
                failRearm("Plan target cannot be reviewed in its current status.");
                await act(() => button("Send to Planner").click());
                assertStringIncludes(container.textContent, "Plan target cannot be reviewed in its current status.");
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Try again.");
                assertEquals(button("Send to Planner").disabled, false);
                assertEquals(button("Approve & Run").disabled, false);
            },
            "# Plan\n",
            workspace
                ? {
                      conversationStatusUrl: undefined,
                      operationStatusUrl: "/operation",
                      planDetailUrl: "/detail",
                      interactionAnswerBaseUrl: "/answers",
                      interactionId: "initial",
                  }
                : {},
        );
    });
}
