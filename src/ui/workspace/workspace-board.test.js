import { readWorkspaceStyles } from "./workspace-styles.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";

import { savePlan } from "../../plan-store.js";

import {
    buildBoardGroups,
    buildWorkspaceBoard,
    loadPlanSummaries,
    loadWorkspaceDetail,
    serializePlanSummary,
    workspaceMetadata as _workspaceMetadata,
} from "./server/plan-adapter.js";
import { buildPlanBoardSearchIndex } from "./components/Board.tsx";

import { renderMarkdown } from "./components/MarkdownView.tsx";

import { detailHref, workspaceHref } from "./components/PlanCard.tsx";
import { draftRecoveryState, planBodyDraftKey, restoredDraftExpectedBodyHash } from "./islands/PlanBodyEditor.jsx";

import { matchingPlanIds, normalizePlanSearchQuery, PLAN_SEARCH_QUERY_PARAM } from "./islands/PlanBoardSearch.tsx";

Deno.test("serializePlanSummary omits absolute paths and surfaces hierarchy/dependency metadata", () => {
    const summary = serializePlanSummary({
        planId: "p1",
        planName: "epic/child",
        relativePath: "docs/plans/epic/child.md",
        path: "/tmp/project/docs/plans/epic/child.md",
        attrs: {
            status: "draft",
            classification: "FEATURE",
            parentPlan: "epic",
            summary: "Child",
            dependencies: ["sibling-id"],
            executionMode: "worktree",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: "a".repeat(40),
                targetBranch: "main",
                targetHeadBeforeMerge: "b".repeat(40),
            },
            worktreePath: "/tmp/project-runwield-worktree",
        },
    });
    assertEquals(summary.relativePath, "docs/plans/epic/child.md");
    assertEquals(Object.hasOwn(summary, "path"), false);
    assertEquals(Object.hasOwn(summary.attrs, "worktreePath"), false);
    assertEquals(summary.attrs.executionMode, "worktree");
    assertEquals(summary.attrs.deliveryEvidence, {
        version: 1,
        mode: "worktree_merge",
        executionCommit: "a".repeat(40),
        targetBranch: "main",
        targetHeadBeforeMerge: "b".repeat(40),
    });
    assertEquals(summary.isChild, true);
    assertEquals(summary.hierarchyRole, "child");
    assertEquals(summary.dependsOn, ["sibling-id"]);
    assertEquals(summary.dependencies, ["sibling-id"]);
});

Deno.test("buildBoardGroups separates active closed and on-hold Plans", () => {
    const plans = [
        { name: "active", planName: "active", planId: "a", status: "draft", attrs: {}, classification: "FEATURE" },
        {
            name: "closed",
            planName: "closed",
            planId: "c",
            status: "closed_without_verification",
            attrs: {},
            classification: "FEATURE",
        },
        { name: "hold", planName: "hold", planId: "h", status: "on_hold", attrs: {}, classification: "FEATURE" },
    ];
    const groups = /** @type {any} */ (buildBoardGroups(/** @type {any} */ (plans)));
    assertEquals(groups.active.standalone.map(/** @param {any} plan */ (plan) => plan.planName), ["active"]);
    assertEquals(groups.closed.standalone.map(/** @param {any} plan */ (plan) => plan.planName), ["closed"]);
    assertEquals(groups.onHold.standalone.map(/** @param {any} plan */ (plan) => plan.planName), ["hold"]);
});

Deno.test("buildWorkspaceBoard groups top-level cards into status columns and hides resolved children", () => {
    const plans = [
        {
            name: "epic",
            planName: "epic",
            planId: "epic-id",
            status: "draft",
            attrs: { classification: "PROJECT" },
            classification: "PROJECT",
            isEpic: true,
            isChild: false,
            hierarchyRole: "epic",
        },
        {
            name: "epic/child",
            planName: "epic/child",
            planId: "child-id",
            status: "draft",
            attrs: { classification: "FEATURE", parentPlan: "epic" },
            classification: "FEATURE",
            parentPlan: "epic",
            isEpic: false,
            isChild: true,
            hierarchyRole: "child",
        },
        {
            name: "standalone",
            planName: "standalone",
            planId: "standalone-id",
            status: "ready_for_work",
            attrs: { classification: "FEATURE" },
            classification: "FEATURE",
            isEpic: false,
            isChild: false,
            hierarchyRole: "top-level",
        },
    ];
    const board = /** @type {any} */ (buildWorkspaceBoard(/** @type {any} */ (plans)));
    const draftCards = board.active.columns.find((/** @type {any} */ column) => column.status === "draft").cards;
    const readyCards =
        board.active.columns.find((/** @type {any} */ column) => column.status === "ready_for_work").cards;
    assertEquals(draftCards.map((/** @type {any} */ plan) => plan.planName), ["epic"]);
    assertEquals(draftCards[0].childProgress.total, 1);
    assertEquals(readyCards.map((/** @type {any} */ plan) => plan.planName), ["standalone"]);
});

Deno.test("buildWorkspaceBoard keeps closed children with their active Epic instead of closed tab cards", () => {
    const board = /** @type {any} */ (buildWorkspaceBoard(
        /** @type {any} */ ([
            {
                name: "epic",
                planName: "epic",
                planId: "epic-id",
                status: "in_progress",
                attrs: { classification: "PROJECT", status: "in_progress" },
                classification: "PROJECT",
                isEpic: true,
                isChild: false,
                hierarchyRole: "epic",
            },
            {
                name: "epic/closed-child",
                planName: "epic/closed-child",
                planId: "closed-child-id",
                status: "verified",
                attrs: { classification: "FEATURE", parentPlan: "epic", status: "verified" },
                classification: "FEATURE",
                parentPlan: "epic",
                isEpic: false,
                isChild: true,
                hierarchyRole: "child",
            },
        ]),
    ));
    const inProgressColumn = board.active.columns.find((/** @type {any} */ column) => column.status === "in_progress");
    const verifiedColumn = board.closed.columns.find((/** @type {any} */ column) => column.status === "verified");
    assertEquals(inProgressColumn.cards.map((/** @type {any} */ plan) => plan.planId), ["epic-id"]);
    assertEquals(inProgressColumn.cards[0].childProgress.verified, 1);
    assertEquals(verifiedColumn.cards.length, 0);
});

Deno.test("buildWorkspaceBoard keeps orphan children visible for repair outside main status cards", () => {
    const board = /** @type {any} */ (buildWorkspaceBoard(
        /** @type {any} */ ([{
            name: "missing/child",
            planName: "missing/child",
            planId: "orphan-id",
            status: "draft",
            attrs: { classification: "FEATURE", parentPlan: "missing" },
            classification: "FEATURE",
            parentPlan: "missing",
            isEpic: false,
            isChild: true,
            hierarchyRole: "orphan-child",
        }]),
    ));
    const draftColumn = board.active.columns.find((/** @type {any} */ column) => column.status === "draft");
    assertEquals(draftColumn.cards.length, 0);
    assertEquals(draftColumn.orphanChildren.map((/** @type {any} */ plan) => plan.planId), ["orphan-id"]);
    assertEquals(board.active.orphanChildren.map((/** @type {any} */ plan) => plan.planId), ["orphan-id"]);
});

Deno.test("Plan Board search helpers normalize query and match title name and summary", () => {
    const searchIndex = [
        {
            planId: "fuzzy-id",
            title: "Add Fuzzy Search",
            planName: "plans-ui-fuzzy-search",
            summary: "Filter the board by title, name, or summary",
        },
        {
            planId: "archive-id",
            title: "Archive Plans",
            planName: "implementing-plan-archival",
            summary: "Move closed Plans into an archive folder",
        },
    ];

    assertEquals(normalizePlanSearchQuery("  fuzzy\n search  "), "fuzzy search");
    assertEquals([...matchingPlanIds(searchIndex, "")].sort(), ["archive-id", "fuzzy-id"]);
    assertEquals(matchingPlanIds(searchIndex, "archival").has("archive-id"), true);
    assertEquals(matchingPlanIds(searchIndex, "fuzzy").has("fuzzy-id"), true);
});

Deno.test("buildPlanBoardSearchIndex includes top-level cards and orphan repair cards once", () => {
    const searchIndex = buildPlanBoardSearchIndex({
        columns: [
            {
                cards: [{ planId: "epic-id", planName: "epic", title: "Epic", summary: "Parent project" }],
                orphanChildren: [{ planId: "orphan-id", planName: "missing/child", summary: "Repair me" }],
            },
            {
                cards: [{ planId: "epic-id", planName: "epic", title: "Duplicate", summary: "Duplicate" }],
                orphanChildren: [],
            },
        ],
        orphanChildren: [{ planId: "orphan-id", planName: "missing/child", summary: "Repair me" }],
    });

    assertEquals(searchIndex.map((/** @type {any} */ entry) => entry.planId), ["epic-id", "orphan-id"]);
    assertEquals(searchIndex[1].title, "missing/child");
});

Deno.test("workspaceHref preserves token and board search query", () => {
    const url = new URL("http://localhost/plans/plan-id?token=secret&q=fuzzy%20plan&edit=body");
    assertEquals(workspaceHref("/closed", url), "/closed?token=secret&q=fuzzy+plan");
    assertEquals(detailHref({ planId: "plan id" }, url), "/plans/plan%20id?token=secret&q=fuzzy+plan");
    assertEquals(PLAN_SEARCH_QUERY_PARAM, "q");
});

Deno.test("workspaceHref omits ephemeral token on owner Project Plan routes", () => {
    const url = new URL("http://localhost/projects/project-id/plans?token=secret&q=fuzzy%20plan");
    assertEquals(workspaceHref("/closed", url), "/projects/project-id/plans/closed?q=fuzzy+plan");
    assertEquals(detailHref({ planId: "plan id" }, url), "/projects/project-id/plans/plan%20id?q=fuzzy+plan");
});

Deno.test("loadPlanSummaries marks top-level, Epic, child, and orphan-child hierarchy roles", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "top", "# Top", { planId: "top-id", classification: "FEATURE" });
        await savePlan(cwd, "epic", "# Epic", {
            planId: "epic-id",
            classification: "PROJECT",
        });
        await savePlan(cwd, "epic/child", "# Child", {
            planId: "child-id",
            classification: "FEATURE",
            parentPlan: "epic",
        });
        await savePlan(cwd, "missing/child", "# Orphan", {
            planId: "orphan-id",
            classification: "FEATURE",
            parentPlan: "missing",
        });
        const byId = new Map((await loadPlanSummaries(cwd)).map((plan) => [plan.planId, plan.hierarchyRole]));
        assertEquals(byId.get("top-id"), "top-level");
        assertEquals(byId.get("epic-id"), "epic");
        assertEquals(byId.get("child-id"), "child");
        assertEquals(byId.get("orphan-id"), "orphan-child");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("loadPlanSummaries preserves the core plan-list order", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const plans = [
            ["held", "held-id", "FEATURE", "on_hold"],
            ["ready-feature", "ready-feature-id", "FEATURE", "ready_for_work"],
            ["failed-feature", "failed-feature-id", "FEATURE", "failed"],
            ["ready-project", "ready-project-id", "PROJECT", "ready_for_work"],
            ["failed-project", "failed-project-id", "PROJECT", "failed"],
            ["verified", "verified-id", "FEATURE", "verified"],
        ];
        for (const [name, planId, classification, status] of plans) {
            await savePlan(cwd, name, `# ${name}`, {
                planId,
                classification: /** @type {any} */ (classification),
                status: /** @type {any} */ (status),
            });
        }

        assertEquals((await loadPlanSummaries(cwd)).map((plan) => plan.name), [
            "failed-project",
            "failed-feature",
            "ready-project",
            "ready-feature",
            "verified",
            "held",
        ]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("loadWorkspaceDetail returns Epic detail with children grouped by status", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(
            cwd,
            "epic",
            "# Epic\n\nBody",
            {
                planId: "epic-id",
                classification: "PROJECT",
                status: "draft",
                type: "epic",
            },
        );
        await savePlan(cwd, "epic/child", "# Child", {
            planId: "child-id",
            classification: "FEATURE",
            parentPlan: "epic",
            status: "failed",
        });
        const detail = /** @type {any} */ (await loadWorkspaceDetail(cwd, "epic-id"));
        assertEquals(detail.detailKind, "epic");
        assertEquals(detail.attrs.type, "epic");
        assertEquals(detail.frontMatter.type, "epic");
        assertEquals(detail.childProgress.total, 1);
        assertEquals(detail.childProgress.byStatus.failed, 1);
        assertEquals(detail.childHealth.failed.map((/** @type {any} */ plan) => plan.planId), ["child-id"]);
        const failedColumn = detail.childColumns.find((/** @type {any} */ column) => column.status === "failed");
        assertEquals(failedColumn.cards.map((/** @type {any} */ plan) => plan.planId), ["child-id"]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("workspace adapter exposes Epic dependency health done-enough held and orphan repair metadata", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic", "# Epic", {
            planId: "epic-id",
            classification: "PROJECT",
            status: "on_hold",
            heldFromStatus: "in_progress",
            heldAt: "2026-01-01T00:00:00.000Z",
            holdReason: "paused",
            epicCompletionMode: "done_enough",
            epicDoneEnoughSummary: "Enough value shipped",
            epicDoneEnoughAt: "2026-01-02T00:00:00.000Z",
        });
        await savePlan(cwd, "epic/01-done", "# Done", {
            planId: "done-id",
            classification: "FEATURE",
            parentPlan: "epic",
            status: "validated",
        });
        await savePlan(cwd, "epic/02-blocked", "# Blocked", {
            planId: "blocked-id",
            classification: "FEATURE",
            parentPlan: "epic",
            status: "draft",
            dependencies: ["01-done", "03-held", "04-missing"],
        });
        await savePlan(cwd, "epic/03-held", "# Held", {
            planId: "held-id",
            classification: "FEATURE",
            parentPlan: "epic",
            status: "on_hold",
            holdReason: "child paused",
        });
        await savePlan(cwd, "missing/child", "# Orphan", {
            planId: "orphan-id",
            classification: "FEATURE",
            parentPlan: "missing",
            status: "draft",
            dependencies: ["other"],
        });

        const detail = /** @type {any} */ (await loadWorkspaceDetail(cwd, "epic-id"));
        const blocked = detail.children.find((/** @type {any} */ child) => child.planId === "blocked-id");
        assertEquals(detail.doneEnough, true);
        assertEquals(detail.childHealth.held.map((/** @type {any} */ child) => child.planId), ["held-id"]);
        assertEquals(detail.childHealth.blocked.map((/** @type {any} */ child) => child.planId), ["blocked-id"]);
        assertEquals(detail.childHealth.missingDependencies.map((/** @type {any} */ child) => child.planId), [
            "blocked-id",
        ]);
        assertEquals(blocked.dependencyStates.map((/** @type {any} */ entry) => entry.state), [
            "verified",
            "unverified",
            "missing",
        ]);

        const orphan = /** @type {any} */ (await loadWorkspaceDetail(cwd, "orphan-id"));
        assertEquals(orphan.hierarchyRole, "orphan-child");
        assertEquals(orphan.parentResolved, false);
        assertStringIncludes(orphan.orphanReason, "missing");
        assertEquals(orphan.dependencyStates, [{ dependency: "other", state: "missing" }]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("workspace metadata advertises real board drag/drop capability", () => {
    const metadata = _workspaceMetadata("/tmp/example-project");
    assertEquals(metadata.capabilities.lifecycleActions, true);
    assertEquals(metadata.capabilities.dragDrop, true);
});

Deno.test("draft helpers scope recovery to workspace plan and hash", () => {
    assertEquals(planBodyDraftKey("workspace", "plan"), "runwield:workspace:workspace:plan:plan:bodyDraft");
    assertEquals(draftRecoveryState(null, "hash"), "none");
    assertEquals(draftRecoveryState({ baseBodyHash: "hash" }, "hash"), "same-base");
    assertEquals(draftRecoveryState({ baseBodyHash: "old" }, "hash"), "changed-on-disk");
    assertEquals(restoredDraftExpectedBodyHash({ baseBodyHash: "old" }), "old");
});

Deno.test("renderMarkdown renders links and escapes unsafe markdown input", () => {
    const html = renderMarkdown(
        "# Title\n\nParagraph <script>alert(1)</script> with [RunWield](https://runwield.dev) and [bad](javascript:alert(1))\n\n- one\n- two\n\n```\ncode\n```",
    );
    assertStringIncludes(html, "<h1");
    assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
    assertStringIncludes(html, 'href="https://runwield.dev"');
    assertStringIncludes(html, 'href="#"');
    assertStringIncludes(html, "<pre");
});

Deno.test("workspace detail header CSS lets lifecycle actions wrap without squeezing summary", async () => {
    const workspaceCss = await readWorkspaceStyles(new URL("./static/workspace.css", import.meta.url));
    const componentsCss = await Deno.readTextFile(new URL("../design-system/components.css", import.meta.url));
    assertStringIncludes(workspaceCss, ".detail-title-row {\n    align-items: center;\n    display: grid;");
    assertStringIncludes(workspaceCss, "grid-template-columns: auto minmax(0, 1fr) auto;");
    assertStringIncludes(workspaceCss, ".split-header {\n    align-items: flex-start;\n    display: grid;");
    assertStringIncludes(workspaceCss, "grid-template-columns: minmax(0, 1fr);");
    assertStringIncludes(workspaceCss, ".header-actions .lifecycle-actions {\n    flex: 1 1 100%;");
    assertStringIncludes(
        workspaceCss,
        ".tabs a,\n    .tab-search-slot,\n    .plan-search-clear {\n        box-sizing: border-box;",
    );
    assertStringIncludes(workspaceCss, ".detail-grid > * {\n    min-width: 0;");
    assertStringIncludes(workspaceCss, ".plan-card.drop-rejected {");
    assertStringIncludes(workspaceCss, "animation: rw-card-return-to-origin 420ms");
    assertStringIncludes(workspaceCss, ".column-cards,\n.plan-card {");
    assertStringIncludes(componentsCss, ".markdown-view {\n    background:");
    assertStringIncludes(componentsCss, "overflow-wrap: anywhere;");
});
