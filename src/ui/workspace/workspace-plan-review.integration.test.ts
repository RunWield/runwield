// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertFalse, assertStringIncludes } from "../../testing/assertions.ts";

const ROUTE_PATH = "src/ui/workspace/pages/projects/[projectId]/plans/[planId].astro";
const SESSION_CONTINUATION_PATH = "src/ui/workspace/server/session-continuation.js";
const PLAN_REVIEW_SURFACE_PATH = "src/ui/workspace/react/PlanReviewSurface.tsx";

test("stable Plan page switches from live review to settled Plan home", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");

    assertStringIncludes(route, "PlanReviewSurface");
    assertStringIncludes(route, "PlanHomeSurface");
    assertStringIncludes(route, "getLivePlanReview");
    assertFalse(route.includes("const liveReview = Boolean(runwieldSessionId && operationId && interactionId)"));
    assertStringIncludes(route, "WorkspaceLayout");
    assertStringIncludes(route, "const Layout = reviewPayload ? ReviewLayout : WorkspaceLayout");
    assertStringIncludes(route, 'presentation="workspace"');
});

test("Workspace Plan review returns Feedback to the same live Core interaction", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const surface = await fsReadFile(PLAN_REVIEW_SURFACE_PATH, "utf8");
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");

    assertStringIncludes(route, "interactionAnswerUrl");
    assertStringIncludes(route, "/session-operations/${");
    assertStringIncludes(surface, 'response: { outcome: "accepted", _meta: body }');
    assertStringIncludes(continuation, "operation.answer.resolve(runtimeResponse)");
});

test("Workspace Plan review carries the initial Plan into revised review rounds", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");

    assertStringIncludes(continuation, 'previousPlan: typeof meta.previousPlan === "string"');
    assertStringIncludes(continuation, "planVersions: Array.isArray(meta.planVersions)");
    assertStringIncludes(route, "previousPlan: liveReview.request?.planReview?.previousPlan");
    assertStringIncludes(route, "planVersions: liveReview.request?.planReview?.planVersions");
});

test("lost review interaction prepares but does not send Agent resubmission", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");

    assertStringIncludes(continuation, 'request.type === "plan_review"');
    assertStringIncludes(continuation, "operation=${");
    assert(!route.includes("startContinuation"));
});

test("owner requests retain admitted document identity and reject stale saves without changing metadata", async () => {
    const { packageFixture, create, read } = await import("../../shared/testing/plan-package-fixture.ts");
    const { withPlanAccess, selectPlanAccess } = await import("../../plan-store/index.ts");
    const { openOwnerCoordinationStore } = await import("../../shared/owner-coordination/index.js");
    const { createOwnerWorkspaceApp } = await import("./server.js");
    const { equal, deepEqual } = await import("node:assert/strict");
    const f = await packageFixture();
    const store = openOwnerCoordinationStore({ dbPath: ":memory:" });
    let app;
    try {
        const p = await create(f.identity);
        const project = store.registerProject({ root: f.root, displayName: "Package project" });
        const pairing = store.createPairingRequest();
        store.approvePairingRequest(pairing.code);
        const device = store.claimPairingRequest(pairing.proof);
        const origin = "http://127.0.0.1:8787";
        app = await withPlanAccess(
            f.root,
            (await selectPlanAccess(f.root, p.metadata.planId))!,
            async () => await createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store }),
        );
        const handler = app.handler();
        const headers = {
            origin,
            cookie: `rw_owner_device=${device.credential}; rw_owner_csrf=${device.csrf}`,
            "x-runwield-csrf": device.csrf,
            "content-type": "application/json",
        };
        const url = `${origin}/api/owner/projects/${project.projectId}/plans/plan-one/documents/context.md`;
        const get = () => handler(new Request(url, { headers }));
        const initialResponse = await get();
        equal(initialResponse.status, 200);
        const initial = await initialResponse.json();
        const save = (body, revision) =>
            handler(new Request(url, { method: "POST", headers, body: JSON.stringify({ body, revision }) }));
        const saved = await save("# Edited in another tab\n", initial.revision);
        equal(saved.status, 200, await saved.clone().text());
        const stale = await save("# Stale local draft\n", initial.revision);
        equal(stale.status, 409, await stale.clone().text());
        equal((await (await get()).json()).body, "# Edited in another tab\n");
        deepEqual((await read(f.identity)).metadata, p.metadata);
        const denied = await handler(new Request(url.replace("context.md", "%2E%2E%2Fplan.wld.json"), { headers }));
        assert(denied.status >= 400);
        const links = `${origin}/api/owner/projects/${project.projectId}/files/content?planId=plan-one&path=`;
        const validationLink = await handler(new Request(`${links}validation.md`, { headers }));
        equal(validationLink.status, 200);
        assert((await validationLink.json()).contents.includes("Run checks."));
        await create(f.identity, { planId: "nested-child", name: "nested/child" });
        const nested = await handler(new Request(`${links}nested/child.md`, { headers }));
        equal(nested.status, 200);
        assert((await nested.json()).contents.includes("Prose — 世界"));
        const parent = await handler(new Request(`${links.replace("plan-one", "nested-child")}../one.md`, { headers }));
        equal(parent.status, 200);
        assert((await parent.json()).contents.includes("Edited in another tab"));

        const repositoryReadme = await handler(new Request(`${links}../../README.md&base=docs/plans`, { headers }));
        equal(repositoryReadme.status, 200);
        assert((await repositoryReadme.json()).contents.includes("package fixture"));
        equal((await handler(new Request(`${links}../../../outside.md&base=docs/plans`, { headers }))).status, 403);
        const page = await handler(new Request(`${origin}/projects/${project.projectId}/plans/plan-one`, { headers }));
        equal(page.status, 200);
        assert((await page.text()).includes("Edited in another tab"));
        const { defineCommittedGitFixture } = await import("../../shared/git-test-fixture.ts");
        const { tree } = await import("../../shared/testing/plan-package-fixture.ts");
        const emptyRoot = await defineCommittedGitFixture({ "README.md": "Unimported\n" }).checkout();
        const empty = store.registerProject({ root: emptyRoot, displayName: "Unimported" });
        const beforeEmpty = await tree(emptyRoot);
        const [sidebarResponse, independentRead, unrelatedRead] = await Promise.all([
            handler(new Request(`${origin}/api/owner/sidebar`, { headers })),
            get(),
            handler(new Request(url.replace(project.projectId, empty.projectId), { headers })),
        ]);
        equal(independentRead.status, 200);
        equal(unrelatedRead.status, 403);
        const sidebar = await sidebarResponse.json();
        equal(sidebar.projects.find((entry) => entry.projectId === empty.projectId).plans.length, 0);
        equal(sidebar.projects.find((entry) => entry.projectId === project.projectId).plans.length, 2);

        const emptyPage = await handler(new Request(`${origin}/projects/${empty.projectId}/plans`, { headers }));
        equal(emptyPage.status, 200);
        assert((await emptyPage.text()).includes("import"));
        equal((await handler(new Request(url.replace(project.projectId, empty.projectId), { headers }))).status, 403);
        deepEqual(await tree(emptyRoot), beforeEmpty);
        const noAuth = await handler(new Request(url));
        equal(noAuth.status, 401);
    } finally {
        await app?.close();
        store.close();
        await f.cleanup();
    }
});

test("document reads keep the revision paired with the displayed bytes during external edits", async () => {
    const { packageFixture, create } = await import("../../shared/testing/plan-package-fixture.ts");
    const { withPlanAccess, selectPlanAccess } = await import("../../plan-store/index.ts");
    const { readPlanDocuments, savePlanDocument } = await import("../../plan-store/index.ts");
    const { writeFile, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { equal } = await import("node:assert/strict");
    const f = await packageFixture();
    try {
        const plan = await create(f.identity);
        await withPlanAccess(f.root, (await selectPlanAccess(f.root, "plan-one"))!, async () => {
            const first = await readPlanDocuments("plan-one");
            const second = await savePlanDocument("plan-one", "context.md", first.revision, "# External revision\n");
            const revisions = new Map([
                [first.body, first.revision],
                [second.body, second.revision],
            ]);
            let running = true;
            const writer = (async () => {
                while (running) {
                    for (const body of revisions.keys()) {
                        await writeFile(join(plan.path, "editor-save.tmp"), body);
                        await rename(join(plan.path, "editor-save.tmp"), join(plan.path, "context.md"));
                    }
                }
            })();
            try {
                for (let index = 0; index < 30; index++) {
                    const current = await readPlanDocuments("plan-one");
                    equal(current.revision, revisions.get(current.body), "Revision must describe the returned bytes");
                }
            } finally {
                running = false;
                await writer;
            }
        });
    } finally {
        await f.cleanup();
    }
});
