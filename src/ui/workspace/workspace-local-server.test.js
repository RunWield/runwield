import { assertEquals, assertStringIncludes } from "@std/assert";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadPlanBodyById, savePlan } from "../../plan-store.js";
import { PLAN_UI_TOKEN_HEADER } from "../../constants.js";
import { loadBoard, loadWorkspaceDetail, workspaceMetadata as _workspaceMetadata } from "./server/plan-adapter.js";
import { PlanBoard } from "./components/Board.tsx";
import { PlanBoardToolbar } from "./components/PlanBoardToolbar.tsx";

import { PlanDetail } from "./components/PlanDetail.jsx";

import { createWorkspaceApp } from "./server.js";
import { createWorkRecordMnemotecaFixture } from "../../shared/work-records/test-fixtures/mnemoteca-port.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

Deno.test("Workspace wrapper protects page routes and serves public assets without token", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "workspace-card", "# Workspace Card\n\n## Context\n\nSSR card", {
            planId: "workspace-card-id",
            status: "draft",
            classification: "FEATURE",
            summary: "SSR card",
        });
        const app = createWorkspaceApp({
            cwd,
            token: "secret",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        }).handler();
        const rejected = await app(new Request("http://localhost/"));
        assertEquals(rejected.status, 401);
        const pageResponse = await app(new Request("http://localhost/?token=secret&q=workspace"));
        const pageBody = await pageResponse.text();
        if (pageResponse.status === 503) {
            assertStringIncludes(pageBody, "Workspace Astro build unavailable");
        } else {
            assertEquals(pageResponse.status, 200);
            assertStringIncludes(pageBody, "workspace-card");
        }
        const tokensCss = await app(new Request("http://localhost/tokens.css"));
        assertEquals(tokensCss.status, 200);
        assertStringIncludes(await tokensCss.text(), "--rw-font-sans:");
        const componentsCss = await app(new Request("http://localhost/components.css"));
        assertEquals(componentsCss.status, 200);
        assertStringIncludes(await componentsCss.text(), ".primary-action");
        const sidebarMotion = await app(new Request("http://localhost/design-system/sidebar-motion.js"));
        assertEquals(sidebarMotion.status, 200);
        assertEquals(sidebarMotion.headers.get("content-type"), "text/javascript; charset=utf-8");
        assertStringIncludes(await sidebarMotion.text(), "export function animateSidebarChange");
        const workspaceCss = await app(new Request("http://localhost/workspace.css"));
        assertEquals(workspaceCss.status, 200);
        assertStringIncludes(await workspaceCss.text(), ".workspace-shell");
        const themeCss = await app(new Request("http://localhost/theme.css"));
        assertEquals(themeCss.status, 200);
        assertEquals(themeCss.headers.get("cache-control"), "no-store");
        assertStringIncludes(await themeCss.text(), "--rw-theme-name:");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("PlanBoard SSR renders status column board cards", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "workspace-card", "# Workspace Card\n\n## Context\n\nSSR card\n\nBody", {
            planId: "workspace-card-id",
            status: "draft",
            classification: "FEATURE",
            summary: "SSR card",
        });
        const board = await loadBoard(cwd);
        const html = renderToStaticMarkup(
            React.createElement(PlanBoard, {
                board,
                view: "active",
                url: "http://localhost/?token=secret&q=workspace",
                staticRender: true,
            }),
        );
        const toolbarHtml = renderToStaticMarkup(
            React.createElement(PlanBoardToolbar, {
                board,
                view: "active",
                url: "http://localhost/?token=secret&q=workspace",
            }),
        );
        assertStringIncludes(toolbarHtml, 'aria-label="Search Plans"');
        assertStringIncludes(toolbarHtml, 'value="workspace"');
        assertEquals(html.includes("matching Plan"), false);
        assertEquals(html.includes("searchable Plan"), false);
        assertStringIncludes(html, 'data-plan-search-card="workspace-card-id"');
        assertStringIncludes(html, 'href="/plans/workspace-card-id?token=secret&amp;q=workspace"');
        assertStringIncludes(html, "Draft");
        assertStringIncludes(html, "Ready for Work");
        assertStringIncludes(html, "workspace-card");
        assertStringIncludes(html, "SSR card");
        assertStringIncludes(html, 'class="complexity-label complexity-medium"');
        assertStringIncludes(html, 'data-plan-board="true"');
        assertStringIncludes(html, 'data-draggable-plan-card="true"');
        assertStringIncludes(html, 'draggable="true"');
        assertStringIncludes(
            html,
            'data-allowed-target-statuses="feedback approved ready_for_work"',
        );
        assertStringIncludes(html, 'data-action-target-status="draft"');
        assertStringIncludes(html, "Drag this Plan Card to an allowed status column");
        assertEquals(html.includes("Move to Feedback"), false);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Workspace page routes require Astro handler instead of static React fallback", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "one", "# One\n", {
            planId: "duplicate-id",
            status: "draft",
            classification: "FEATURE",
            summary: "One",
        });
        await savePlan(cwd, "two", "# Two\n", {
            planId: "duplicate-id",
            status: "draft",
            classification: "FEATURE",
            summary: "Two",
        });
        const app = createWorkspaceApp({
            cwd,
            token: "secret",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        }).handler();
        const response = await app(new Request("http://localhost/?token=secret"));
        const body = await response.text();
        if (response.status === 503) {
            assertStringIncludes(body, "Workspace Astro build unavailable");
            assertEquals(body.includes("Duplicate planId"), false);
        } else {
            assertEquals(response.status, 409);
            assertStringIncludes(body, "Duplicate planId");
        }
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Workspace API and detail route return readable editable Plan body metadata", async () =>
    await withProcessGlobalTestLock(async () => {
        const cwd = await Deno.makeTempDir();
        try {
            await savePlan(
                cwd,
                "detail",
                "# Detail\n\nReadable body with [RunWield](https://runwield.dev)",
                /** @type {any} */ ({
                    planId: "detail-id",
                    status: "implemented",
                    classification: "FEATURE",
                    complexity: "HIGH",
                    summary: "Detail summary",
                    affectedPaths: ["src/ui/workspace/components/PlanDetail.jsx"],
                    tickets: [
                        { url: "https://example.com/tickets/DETAIL-123" },
                        { url: "javascript:alert(1)" },
                    ],
                    dependencies: ["sibling-plan"],
                    implementedAt: "2026-06-30T10:00:00.000Z",
                    executionBaselineTree: "tree-detail",
                    worktreeId: "wt-detail",
                    worktreePath: "/tmp/secret-worktree-path",
                    worktreeBranch: "runwield/worktree/detail",
                    worktreeStatus: "active",
                    humanReviewMode: "ask",
                    humanReviewDecision: "approved",
                    humanReviewedAt: "2026-06-30T11:00:00.000Z",
                    customPriority: "urgent",
                }),
            );
            const board = await loadBoard(cwd);
            assertEquals(board.plans.length, 1);

            const app = createWorkspaceApp({
                cwd,
                token: "secret",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
            }).handler();
            const api = await app(
                new Request("http://localhost/api/plans/detail-id", {
                    headers: { [PLAN_UI_TOKEN_HEADER]: "secret" },
                }),
            );
            assertEquals(api.status, 200);
            const apiBody = await api.json();
            assertEquals(apiBody.plan.readOnly, true);
            assertEquals(typeof apiBody.plan.bodyHash, "string");
            assertEquals(apiBody.plan.capabilities.bodyEditing, true);
            assertEquals(Object.hasOwn(apiBody.plan, "path"), false);
            assertEquals(Object.hasOwn(apiBody.plan.frontMatter, "worktreePath"), false);
            assertEquals(Object.hasOwn(apiBody.plan.attrs, "worktreePath"), false);
            assertEquals(apiBody.plan.frontMatter.tickets, [
                { url: "https://example.com/tickets/DETAIL-123" },
                { url: "javascript:alert(1)" },
            ]);

            const plan = await loadWorkspaceDetail(cwd, "detail-id");
            const html = renderToStaticMarkup(
                React.createElement(PlanDetail, {
                    plan,
                    url: "http://localhost/plans/detail-id?token=secret",
                    staticRender: true,
                }),
            );
            assertStringIncludes(html, "Readable body");
            assertStringIncludes(html, "data-plannotator-plan-body");
            assertStringIncludes(html, "data-plannotator-plan-body-json");
            assertStringIncludes(html, "data-plannotator-plan-body-root");
            assertStringIncludes(html, "Readable body");
            assertStringIncludes(html, 'data-plan-id="detail-id"');
            assertStringIncludes(html, 'data-plannotator-renderer="ssr-fallback"');
            assertStringIncludes(html, 'class="markdown-view"');
            assertStringIncludes(html, 'class="complexity-label complexity-high"');
            assertStringIncludes(html, 'href="https://runwield.dev"');
            assertStringIncludes(html, ">RunWield</a>");
            assertStringIncludes(html, ">Put on hold</button>");
            assertStringIncludes(html, ">Mark as User Verified</button>");
            assertStringIncludes(html, 'class="danger-action lifecycle-action"');
            assertStringIncludes(html, ">Close without verification</button>");
            assertStringIncludes(html, 'class="detail-title-row"');
            assertStringIncludes(html, "&lt; Back</a>");
            assertStringIncludes(html, 'class="detail-close-link"');
            assertStringIncludes(html, 'aria-label="Close plan detail"');
            assertStringIncludes(html, ">X</a>");
            assertEquals(html.includes(">Close</a>"), false);
            assertEquals(html.includes("Front matter summary"), false);
            assertStringIncludes(html, "Identity");
            assertStringIncludes(html, "Planning");
            assertStringIncludes(html, "Ticket references");
            assertStringIncludes(html, 'href="https://example.com/tickets/DETAIL-123"');
            assertStringIncludes(html, 'target="_blank"');
            assertStringIncludes(html, 'rel="noreferrer noopener"');
            assertEquals(html.includes('href="javascript:alert(1)"'), false);
            assertEquals(html.includes("{&quot;url&quot;"), false);
            assertStringIncludes(html, "Hierarchy &amp; dependencies");
            assertStringIncludes(html, "Lifecycle");
            assertStringIncludes(html, "Execution worktree");
            assertStringIncludes(html, "Review");
            assertStringIncludes(html, "Additional metadata");
            assertStringIncludes(html, "Plan ID");
            assertStringIncludes(html, "detail-id");
            assertStringIncludes(html, "Affected paths");
            assertStringIncludes(html, "src/ui/workspace/components/PlanDetail.jsx");
            assertStringIncludes(html, "Depends on");
            assertStringIncludes(html, "sibling-plan");
            assertStringIncludes(html, "Implemented at");
            assertStringIncludes(html, "2026-06-30T10:00:00.000Z");
            assertStringIncludes(html, "Execution baseline tree");
            assertStringIncludes(html, "tree-detail");
            assertStringIncludes(html, "Worktree branch");
            assertStringIncludes(html, "runwield/worktree/detail");
            assertStringIncludes(html, "Code review decision");
            assertStringIncludes(html, "approved");
            assertStringIncludes(html, "Custom Priority");
            assertStringIncludes(html, "urgent");
            assertEquals(html.includes("/tmp/secret-worktree-path"), false);
        } finally {
            await Deno.remove(cwd, { recursive: true });
        }
    }));

Deno.test("PlanDetail derives Epic UI from classification rather than legacy subtype metadata", () => {
    const html = renderToStaticMarkup(
        React.createElement(PlanDetail, {
            plan: {
                planId: "legacy-type-id",
                planName: "Legacy type plan",
                title: "Legacy type plan",
                status: "draft",
                classification: "FEATURE",
                type: "epic",
                detailKind: "epic",
                summary: "Feature with legacy metadata",
                capabilities: { bodyEditing: true },
                body: "# Body",
                bodyJson: { type: "doc", content: [] },
                bodyHash: "hash",
            },
            url: "http://localhost/plans/legacy-type-id?token=secret",
            staticRender: true,
        }),
    );

    assertStringIncludes(html, "Feature with legacy metadata");
    assertEquals(html.includes("Epic progress"), false);
    assertEquals(html.includes("Child plans"), false);
});

Deno.test("Workspace detail SSR fallback renders visible empty Plan body state", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "empty-detail", "", {
            planId: "empty-detail-id",
            status: "draft",
            classification: "FEATURE",
            summary: "Empty body detail",
        });

        const plan = await loadWorkspaceDetail(cwd, "empty-detail-id");
        const html = renderToStaticMarkup(
            React.createElement(PlanDetail, {
                plan,
                url: "http://localhost/plans/empty-detail-id?token=secret",
                staticRender: true,
            }),
        );
        assertStringIncludes(html, "data-plannotator-plan-body");
        assertStringIncludes(html, 'data-plannotator-renderer="ssr-fallback"');
        assertStringIncludes(html, 'class="markdown-view"');
        assertStringIncludes(html, "No Plan body content.");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Workspace body-save API preserves front matter rejects stale writes and requires token", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await Deno.mkdir(`${cwd}/docs/plans`, { recursive: true });
        const frontMatter =
            "---\nplanId: api-id\n# comment remains\nclassification: FEATURE\nstatus: draft\nunknown: kept\n---\n";
        await Deno.writeTextFile(`${cwd}/docs/plans/api.md`, `${frontMatter}# Original\n`);
        const loaded = await loadPlanBodyById(cwd, "api-id");
        const app = createWorkspaceApp({
            cwd,
            token: "secret",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        }).handler();

        const rejected = await app(new Request("http://localhost/api/plans/api-id/body", { method: "POST" }));
        assertEquals(rejected.status, 401);

        const invalid = await app(
            new Request("http://localhost/api/plans/api-id/body", {
                method: "POST",
                headers: { [PLAN_UI_TOKEN_HEADER]: "secret", "content-type": "application/json" },
                body: JSON.stringify({ body: 1, expectedBodyHash: loaded.bodyHash }),
            }),
        );
        assertEquals(invalid.status, 400);

        const saved = await app(
            new Request("http://localhost/api/plans/api-id/body", {
                method: "POST",
                headers: { [PLAN_UI_TOKEN_HEADER]: "secret", "content-type": "application/json" },
                body: JSON.stringify({
                    body: "# Saved\n",
                    expectedBodyHash: loaded.bodyHash,
                    expectedRevision: loaded.revision,
                }),
            }),
        );
        assertEquals(saved.status, 200);
        const savedBody = await saved.json();
        assertEquals(typeof savedBody.bodyHash, "string");
        assertEquals(await Deno.readTextFile(`${cwd}/docs/plans/api.md`), `${frontMatter}# Saved\n`);

        const stale = await app(
            new Request("http://localhost/api/plans/api-id/body", {
                method: "POST",
                headers: { [PLAN_UI_TOKEN_HEADER]: "secret", "content-type": "application/json" },
                body: JSON.stringify({
                    body: "# Stale\n",
                    expectedBodyHash: loaded.bodyHash,
                    expectedRevision: loaded.revision,
                }),
            }),
        );
        assertEquals(stale.status, 409);
        assertStringIncludes((await stale.json()).error, "changed on disk");

        await savePlan(cwd, "epic", "# Epic\n", {
            planId: "epic-id",
            classification: "PROJECT",
            status: "draft",
        });
        const epic = await loadWorkspaceDetail(cwd, "epic-id");
        const epicRejected = await app(
            new Request("http://localhost/api/plans/epic-id/body", {
                method: "POST",
                headers: { [PLAN_UI_TOKEN_HEADER]: "secret", "content-type": "application/json" },
                body: JSON.stringify({
                    body: "# Edited Epic\n",
                    expectedBodyHash: "hash",
                    expectedRevision: epic.revision,
                }),
            }),
        );
        assertEquals(epicRejected.status, 409);
        assertStringIncludes((await epicRejected.json()).error, "Epic Plan bodies are not editable");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Workspace Epic detail SSR-renders child FEATURE Plans by status", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(
            cwd,
            "epic",
            "# Epic\n\n## Context\n\nEpic summary\n\nEpic body",
            /** @type {any} */ ({
                planId: "epic-id",
                status: "draft",
                classification: "PROJECT",
                summary: "Epic summary",
                epicCompletionMode: "done_enough",
                epicDoneEnoughAt: "2026-06-30T12:00:00.000Z",
                epicDoneEnoughSummary: "Shipped enough",
                customRisk: false,
            }),
        );
        await savePlan(cwd, "epic/done", "# Done\n\n## Context\n\nDone summary", {
            planId: "done-id",
            status: "verified",
            classification: "FEATURE",
            parentPlan: "epic",
            summary: "Done summary",
        });
        await savePlan(cwd, "epic/child", "# Child\n\n## Context\n\nChild summary\n\nChild body", {
            planId: "child-id",
            status: "in_progress",
            classification: "FEATURE",
            parentPlan: "epic",
            summary: "Child summary",
            dependencies: ["done", "missing-child"],
        });
        await savePlan(cwd, "epic/held", "# Held\n\n## Context\n\nHeld summary", {
            planId: "held-id",
            status: "on_hold",
            classification: "FEATURE",
            parentPlan: "epic",
            summary: "Held summary",
            heldFromStatus: "ready_for_work",
            heldAt: "2026-01-04T00:00:00.000Z",
            holdReason: "child capacity pause",
        });
        await savePlan(cwd, "epic/failed", "# Failed\n\n## Context\n\nFailed summary", {
            planId: "failed-id",
            status: "failed",
            classification: "FEATURE",
            parentPlan: "epic",
            summary: "Failed summary",
        });
        await savePlan(cwd, "missing/orphan", "# Orphan\n\n## Context\n\nOrphan summary", {
            planId: "orphan-id",
            status: "draft",
            classification: "FEATURE",
            parentPlan: "missing",
            summary: "Orphan summary",
        });
        await savePlan(cwd, "held-epic", "# Held Epic\n\n## Context\n\nHeld Epic summary", {
            planId: "held-epic-id",
            status: "on_hold",
            classification: "PROJECT",
            summary: "Held Epic summary",
            heldFromStatus: "in_progress",
            heldAt: "2026-01-03T00:00:00.000Z",
            holdReason: "waiting for budget",
        });
        const board = await loadBoard(cwd);
        const boardHtml = renderToStaticMarkup(
            React.createElement(PlanBoard, {
                board,
                view: "active",
                url: "http://localhost/?token=secret",
                staticRender: true,
            }),
        );
        assertStringIncludes(boardHtml, "Epic summary");
        assertStringIncludes(boardHtml, "Orphan summary");
        assertStringIncludes(boardHtml, "Missing parent Epic");
        assertEquals(boardHtml.includes("Child summary"), false);

        const onHoldBoardHtml = renderToStaticMarkup(
            React.createElement(PlanBoard, {
                board,
                view: "onHold",
                url: "http://localhost/on-hold?token=secret",
                staticRender: true,
            }),
        );
        assertStringIncludes(onHoldBoardHtml, "held from in_progress; held at 2026-01-03T00:00:00.000Z");
        assertStringIncludes(onHoldBoardHtml, "reason: waiting for budget");

        const detailPlan = await loadWorkspaceDetail(cwd, "epic-id");
        const detailHtml = renderToStaticMarkup(
            React.createElement(PlanDetail, {
                plan: detailPlan,
                url: "http://localhost/plans/epic-id?token=secret",
                staticRender: true,
            }),
        );
        assertStringIncludes(detailHtml, 'class="detail-title-row"');
        assertStringIncludes(detailHtml, "&lt; Back</a>");
        assertStringIncludes(detailHtml, 'class="detail-close-link"');
        assertStringIncludes(detailHtml, 'aria-label="Close plan detail"');
        assertStringIncludes(detailHtml, ">X</a>");
        assertEquals(detailHtml.includes('class="detail-sidebar-edit"'), false);
        assertEquals(detailHtml.includes("edit=body"), false);
        assertStringIncludes(detailHtml, "Done enough");
        assertStringIncludes(detailHtml, "In Progress");
        assertStringIncludes(detailHtml, "Child summary");
        assertStringIncludes(detailHtml, "Failed summary");
        assertStringIncludes(detailHtml, "Held summary");
        assertStringIncludes(
            detailHtml,
            "held from ready_for_work; held at 2026-01-04T00:00:00.000Z; reason: child capacity pause",
        );
        assertStringIncludes(detailHtml, "done: verified");
        assertStringIncludes(detailHtml, "missing-child: missing");
        assertStringIncludes(detailHtml, "missing dependencies");
        assertEquals(detailHtml.includes("Front matter summary"), false);
        assertStringIncludes(detailHtml, "Metadata");
        assertStringIncludes(detailHtml, "Identity");
        assertStringIncludes(detailHtml, "Planning");
        assertStringIncludes(detailHtml, "Epic completion");
        assertStringIncludes(detailHtml, "Epic completion mode");
        assertStringIncludes(detailHtml, "done_enough");
        assertStringIncludes(detailHtml, "Epic done enough at");
        assertStringIncludes(detailHtml, "2026-06-30T12:00:00.000Z");
        assertStringIncludes(detailHtml, "Additional metadata");
        assertStringIncludes(detailHtml, "Custom Risk");
        assertStringIncludes(detailHtml, "false");

        const heldDetailPlan = await loadWorkspaceDetail(cwd, "held-epic-id");
        const heldDetailHtml = renderToStaticMarkup(
            React.createElement(PlanDetail, {
                plan: heldDetailPlan,
                url: "http://localhost/plans/held-epic-id?token=secret",
                staticRender: true,
            }),
        );
        assertStringIncludes(heldDetailHtml, "Epic on hold from in_progress at 2026-01-03T00:00:00.000Z");
        assertStringIncludes(heldDetailHtml, "reason: waiting for budget");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});
