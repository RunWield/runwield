// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";

const ROUTE_PATH = "src/ui/workspace/pages/projects/[projectId]/plans/[planId].astro";
const SURFACE_PATH = "src/ui/workspace/react/PlanReviewSurface.tsx";
const CODE_SURFACE_PATH = "src/ui/workspace/react/CodeReviewSurface.tsx";
const REMOTE_SURFACE_PATH = "src/ui/workspace/react/RemotePlanReview.tsx";
const ANNOTATION_TOOLSTRIP_PATH = "src/ui/workspace/react/RunWieldAnnotationToolstrip.tsx";
const SETTINGS_PATH = "src/ui/workspace/react/PlanReviewSettings.tsx";

Deno.test("Phone Plan review keeps full editing annotations and actions reachable", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(surface, "Edit");
    assertStringIncludes(surface, "Annotations");
    assertStringIncludes(surface, "Feedback");
    const styles = await Deno.readTextFile("src/ui/workspace/react/plannotator.css");
    // A base mobile selector loses to desktop selectors with sidebar-state attributes,
    // leaving a 320px annotations column inside a 390px phone viewport.
    const phoneStyles = styles.slice(styles.indexOf("@media (max-width: 980px)"));
    assertStringIncludes(phoneStyles, ".rw-plannotator-plan-layout[data-sidebar-open][data-annotations-open]");
    assertStringIncludes(phoneStyles, ".rw-plannotator-code-layout[data-file-tree-open][data-annotations-open]");
    assertStringIncludes(phoneStyles, "grid-template-columns: minmax(0, 1fr)");
    assertEquals(styles.includes("min-height: 72vh"), false);
});

Deno.test("Workspace reviews replace the owner shell with the shared full-window review layout", async () => {
    const planRoute = await Deno.readTextFile(ROUTE_PATH);
    const codeRoute = await Deno.readTextFile(
        "src/ui/workspace/pages/projects/[projectId]/sessions/[runwieldSessionId]/review/code.astro",
    );
    const layout = await Deno.readTextFile("src/ui/workspace/layouts/ReviewLayout.astro");
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
    const surface = await Deno.readTextFile(SURFACE_PATH);
    assertStringIncludes(surface, 'initialPayload.mode === "workspace" || presentation === "workspace"');
});

Deno.test("Owner shell retains its shared navigation and header outside reviews", async () => {
    const layout = await Deno.readTextFile("src/ui/workspace/layouts/WorkspaceLayout.astro");
    const shell = await Deno.readTextFile("src/ui/workspace/static/workspace-shell.ts");
    const workspaceMenu = await Deno.readTextFile("src/ui/workspace/react/WorkspaceMenu.tsx");
    assertStringIncludes(layout, 'class="workspace-main-session-name" data-workspace-surface-title');
    assertStringIncludes(shell, 'header.querySelector("[data-workspace-main-session-name]")?.remove()');
    assertStringIncludes(layout, '<WorkspaceMenu client:only="react" />');
    assertStringIncludes(workspaceMenu, 'href="https://docs.runwield.dev"');
    assertStringIncludes(workspaceMenu, "Documentation");
    assertStringIncludes(layout, "data-workspace-header-actions");
    assertEquals(layout.includes("BrowserNotificationPermissionControl"), false);
});

Deno.test("Plan Review fixture navigation lives in the Surface Lab instead of the review page", async () => {
    const devSurface = await Deno.readTextFile("src/ui/workspace/react/ReviewDevSurface.tsx");
    const catalog = await Deno.readTextFile("src/ui/workspace/pages/dev/index.astro");

    assertStringIncludes(catalog, 'id: "feature"');
    assertStringIncludes(catalog, 'href: "/dev/plan-review?variant=read-only"');
    assertStringIncludes(catalog, "/dev/plan-review?variant=${variant.id}");
    assertStringIncludes(catalog, "/dev/workspace/plan-review?variant=${variant.id}");
    if (devSurface.includes('"aria-label": "Plan Review dev fixtures"')) {
        throw new Error("Plan Review fixture pages must not render a second navigation header");
    }
});

Deno.test("Plan Review fixtures show every callout kind next to a dense comparison without callouts", async () => {
    const devSurface = await Deno.readTextFile("src/ui/workspace/react/ReviewDevSurface.tsx");
    const catalog = await Deno.readTextFile("src/ui/workspace/pages/dev/index.astro");
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
    assertStringIncludes(devSurface, 'planVariant === "dense" ? DENSE_PLAN_FIXTURE : PLAN_FIXTURE');
    assertStringIncludes(catalog, 'id: "dense"');
});

Deno.test("Plan approval outcomes use shared completion routing", async () => {
    const route = await Deno.readTextFile(ROUTE_PATH);
    const surface = await Deno.readTextFile(SURFACE_PATH);

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

Deno.test("Plan review exposes Workspace recovery when live Plan evidence requires it", async () => {
    const route = await Deno.readTextFile(ROUTE_PATH);
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(route, "recoveryUrl");
    assertStringIncludes(route, "force-recovery");
    assertStringIncludes(surface, "recovery_required");
    assertStringIncludes(surface, "Recover in Workspace");
    assertStringIncludes(surface, "runRecoveryAction");
});

Deno.test("Plan review stale errors offer a clear reload action", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(surface, "staleReviewError");
    assertStringIncludes(surface, "Review is out of date");
    assertStringIncludes(surface, "Reload review");
    assertStringIncludes(surface, "globalThis.location.reload()");
});

Deno.test("Plan feedback action sits above the annotation list with theme accent styling", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);
    const styles = await Deno.readTextFile("src/ui/workspace/react/plannotator.css");
    const sidebarIndex = surface.indexOf('className="rw-plan-review-annotation-sidebar"');
    const actionIndex = surface.indexOf('label="Send Annotations"');
    const panelIndex = surface.indexOf('presentation="embedded"');

    const components = await Deno.readTextFile("src/ui/design-system/components.css");

    assertStringIncludes(surface, 'className="rw-review-feedback-action rw-review-action');
    assertStringIncludes(styles, ".rw-review-feedback-action");
    assertStringIncludes(components, ".rw-review-action-button");
    assertStringIncludes(components, "var(--rw-accent)");
    if (sidebarIndex < 0 || actionIndex < sidebarIndex || panelIndex < actionIndex) {
        throw new Error("Send Annotations must sit above the right-side annotation list");
    }
});

Deno.test("Plan review offers a reusable Planner conversation without replacing Send Annotations", async () => {
    const route = await Deno.readTextFile(ROUTE_PATH);
    const surface = await Deno.readTextFile(SURFACE_PATH);
    const conversation = await Deno.readTextFile("src/ui/workspace/react/ArtifactConversationSidebar.tsx");
    const components = await Deno.readTextFile("src/ui/design-system/components.css");
    const docs = await Deno.readTextFile("docs/design-system.md");

    assertStringIncludes(route, "operationStatusUrl");
    assertStringIncludes(route, "planDetailUrl");
    assertStringIncludes(route, "interactionAnswerBaseUrl");
    assertStringIncludes(surface, "initialPayload.conversationStatusUrl");
    assertStringIncludes(surface, "waitForStandaloneReview");
    assertStringIncludes(surface, 'label="Send Annotations"');
    assertStringIncludes(surface, "Add to {agentLabel} chat");
    assertStringIncludes(surface, "<ArtifactConversationSidebar");
    assertStringIncludes(surface, "waitForPlannerReview");
    assertStringIncludes(surface, "setPlannerDiffBase(options.priorPlan)");
    assertStringIncludes(conversation, "Message ${props.agentLabel}");
    assertStringIncludes(conversation, "RunWieldThinkingDots");
    assertStringIncludes(conversation, "Send to {props.agentLabel}");
    assertEquals(conversation.includes("props.agentLabel} working"), false);
    assertStringIncludes(components, ".rw-artifact-conversation {");
    assertStringIncludes(docs, "**Artifact conversation**");
});

Deno.test("Code feedback action matches the Plan annotation sidebar treatment", async () => {
    const surface = await Deno.readTextFile(CODE_SURFACE_PATH);
    const sidebarIndex = surface.indexOf('className="rw-code-review-annotation-sidebar"');
    const actionIndex = surface.indexOf('label="Send Annotations"');
    const listIndex = surface.indexOf("<ReviewSidebar", sidebarIndex);

    assertStringIncludes(surface, 'className="rw-review-feedback-action rw-review-action');
    assertStringIncludes(surface, 'label="Send Annotations"');
    if (sidebarIndex < 0 || actionIndex < sidebarIndex || listIndex < actionIndex) {
        throw new Error("Code Review's Send Annotations action must sit above the annotation list");
    }
});

Deno.test("Code Review reuses artifact chat and reloads the republished file diff", async () => {
    const route = await Deno.readTextFile(
        "src/ui/workspace/pages/projects/[projectId]/sessions/[runwieldSessionId]/review/code.astro",
    );
    const surface = await Deno.readTextFile(CODE_SURFACE_PATH);

    assertStringIncludes(route, "operationStatusUrl");
    assertStringIncludes(route, "interactionAnswerBaseUrl");
    assertStringIncludes(surface, "<ArtifactConversationSidebar");
    assertStringIncludes(surface, "Add to {agentLabel} chat");
    assertStringIncludes(surface, 'artifactKind: "code"');
    assertStringIncludes(surface, "waitForStandaloneCodeReview");
    assertStringIncludes(surface, "waitForWorkspaceCodeReview");
    assertStringIncludes(surface, "setActiveRawPatch(options.rawPatch)");
    assertStringIncludes(surface, "conversationTurn: true");
    assertStringIncludes(surface, 'label="Send Annotations"');
});

Deno.test("Code Review uses the Workspace header when embedded and preserves standalone controls", async () => {
    const surface = await Deno.readTextFile(CODE_SURFACE_PATH);
    const headingIndex = surface.indexOf('className="rw-plan-review-heading"');
    const optionsIndex = surface.indexOf("{reviewOptions}", headingIndex);
    const logoIndex = surface.indexOf('<img src="/brand/logo.svg"', headingIndex);
    const actionsIndex = surface.indexOf('className="rw-plannotator-actions"');
    const approveIndex = surface.indexOf("<ApproveButton", actionsIndex);
    assertStringIncludes(surface, "<WorkspaceHeaderActionsPortal>{reviewActions}</WorkspaceHeaderActionsPortal>");
    assertStringIncludes(surface, '{presentation === "workspace" && reviewOptions}');

    assertStringIncludes(surface, "function CodeReviewOptionsMenu({\n    iconOnly = false,");
    assertStringIncludes(surface, '<RunWieldMenu label="Options" iconOnly={iconOnly}');
    const menu = await Deno.readTextFile("src/ui/design-system/components/react/RunWieldMenu.tsx");
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

Deno.test("Code Review title ellipsizes without moving toolbar actions", async () => {
    const styles = await Deno.readTextFile("src/ui/workspace/react/plannotator.css");

    assertStringIncludes(styles, ".rw-code-review .rw-plan-review-heading {");
    assertStringIncludes(styles, "flex: 1 1 auto;");
    assertStringIncludes(styles, "overflow: hidden;");
    assertStringIncludes(styles, ".rw-code-review .rw-plan-review-heading h1 {");
    assertStringIncludes(styles, "text-overflow: ellipsis;");
    assertStringIncludes(styles, ".rw-code-review .rw-plannotator-actions {");
    assertStringIncludes(styles, "flex: none;");
});

Deno.test("Code Review uses the Plan Review card surface for review panels", async () => {
    const styles = await Deno.readTextFile("src/ui/workspace/react/plannotator.css");

    assertStringIncludes(styles, ".rw-review-file-tree {");
    assertStringIncludes(styles, ".rw-code-review-annotation-sidebar {");
    assertStringIncludes(styles, ".rw-code-review-annotation-sidebar > aside {");
    assertStringIncludes(styles, ".rw-review-all-files-host {");
    assertStringIncludes(styles, ".rw-code-diff-stage {");
    assertStringIncludes(styles, ".rw-code-review diffs-container {");
    assertStringIncludes(styles, "background: var(--card);");
    assertStringIncludes(styles, "background: var(--card) !important;");
});

Deno.test("Plan and Code review use shared toolbar structure with edge-aligned restore buttons", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);
    const codeSurface = await Deno.readTextFile(CODE_SURFACE_PATH);
    const styles = await Deno.readTextFile("src/ui/workspace/react/plannotator.css");
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
    assertStringIncludes(styles, ".rw-plan-review .rw-plannotator-plan-layout:has(> .rw-plan-sidebar-tab-toggle)");
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
    const sharedStyles = await Deno.readTextFile("src/ui/design-system/components.css");
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
        surface.includes("rw-annotation-reopen") || surface.includes("<SidebarTabs") ||
        surface.includes("<ResizeHandle")
    ) {
        throw new Error("Plan Review must use one Code Review-style collapse and toolbar restore pattern");
    }
    if (
        leftRestoreIndex < 0 || contentsIndex < leftRestoreIndex || modeActionsIndex < contentsIndex ||
        rightRestoreIndex < modeActionsIndex || saveControlsIndex < rightRestoreIndex ||
        annotationsIndex < rightRestoreIndex || sidebarIndex < 0 || collapseIndex < sidebarIndex
    ) {
        throw new Error(
            "Plan Review must align Contents left, edit Save controls right, and Annotations right in the toolbar",
        );
    }
});

Deno.test("Review segmented toggles use shared compact icon-label behavior", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);
    const remoteSurface = await Deno.readTextFile(REMOTE_SURFACE_PATH);
    const settings = await Deno.readTextFile(SETTINGS_PATH);
    const wrapper = await Deno.readTextFile(ANNOTATION_TOOLSTRIP_PATH);
    const styles = await Deno.readTextFile("src/ui/workspace/react/plannotator.css");
    const components = await Deno.readTextFile("src/ui/design-system/components.css");
    const docs = await Deno.readTextFile("docs/design-system.md");

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

Deno.test("Feedback and Run return to Session while Later stays on confirmation", async () => {
    const route = await Deno.readTextFile(ROUTE_PATH);
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(route, "interactionAnswerUrl");
    assertStringIncludes(surface, "Approve & Run");
    assertStringIncludes(surface, "Later");
    assertStringIncludes(surface, "approved-later");
});

Deno.test("Plan and Epic reviews expose classification-correct actions", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(surface, "PLAN_APPROVAL_ACTIONS.DECOMPOSE");
    assertStringIncludes(surface, "Approve & Slice");
    assertStringIncludes(surface, "Approve & Run");
});

Deno.test("revised Plan reviews expose selectable Plannotator version history", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(surface, "usePlanDiff");
    assertStringIncludes(surface, "PlanDiffViewer");
    assertStringIncludes(surface, "normalizePlanReviewVersions");
    assertStringIncludes(surface, "showVersionsTab={versionInfo !== null}");
    assertStringIncludes(surface, "onSelectBaseVersion={selectPlanVersion}");
    assertStringIncludes(surface, "Changes");
});

Deno.test("Plan reviews inspect affected files and export complete feedback", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(surface, "AffectedFilesMenu");
    assertStringIncludes(surface, "onOpenCodeFile={codeFilePopout.open}");
    assertStringIncludes(surface, "CodeFilePopout");
    assertStringIncludes(surface, "codeAnnotations={codeAnnotations}");
    assertStringIncludes(surface, "Export review feedback");
    assertStringIncludes(surface, 'annotationsOutput={exportOpen ? currentFeedback() : ""}');
});

Deno.test("Plan reviews recover unfinished work and send direct edits as feedback", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);

    assertStringIncludes(surface, "Unfinished review found");
    assertStringIncludes(surface, "Restore draft");
    assertStringIncludes(surface, "persistReviewDraftLocally");
    assertStringIncludes(surface, "directEdits={directEditPanel}");
    assertStringIncludes(surface, "disabled={!hasGroupFeedback || submitting !== null ||");
    assertStringIncludes(surface, "plannerWorking || reviewGroup?.busy}");
    assertStringIncludes(surface, "buildPlanReviewFeedback");
});

Deno.test("Plan and Code annotation tabs occupy the shared header in every presentation", async () => {
    for (
        const [path, headingClass] of [
            [SURFACE_PATH, "rw-plan-review-annotation-heading"],
            [CODE_SURFACE_PATH, "rw-review-annotation-heading"],
        ]
    ) {
        const source = await Deno.readTextFile(path);
        const heading = source.indexOf(`className="${headingClass}`);
        const tabs = source.indexOf('role="tablist"', heading);
        const collapse = source.indexOf('title="Collapse annotations sidebar"', heading);
        const actions = source.indexOf('className="rw-review-feedback-action rw-review-action', heading);
        assertEquals(heading >= 0 && tabs > heading && tabs < collapse && collapse < actions, true);
        assertEquals(source.slice(heading, actions).includes("presentation ==="), false);
        assertStringIncludes(source.slice(heading, tabs), "conversationEnabled");
    }
});
Deno.test("Compact Plan Review starts collapsed and keeps panel controls outside document scrolling", async () => {
    const surface = await Deno.readTextFile(SURFACE_PATH);
    const styles = await Deno.readTextFile("src/ui/workspace/react/plannotator.css");
    assertStringIncludes(surface, 'globalThis.matchMedia?.("(max-width: 980px)")');
    assertStringIncludes(surface, "!compactLayout && getUIPreferences().tocEnabled");
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
