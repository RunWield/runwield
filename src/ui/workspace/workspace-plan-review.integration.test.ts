import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { seedPlan as savePlan } from "../../shared/testing/plan-state-fixture.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { withExistingRuntimeInteraction } from "./testing/live-interaction-fixture.ts";

// Real owner Session, HTTP routes and Plan reads; only the model turn waits at its boundary.
test("Workspace Plan review carries revision history, returns feedback to Core, and settles into Plan home", async () => {
    await withRuntimeCommandFixture("workspace-plan-review-http-", async (fixture) => {
        await savePlan(fixture.projectRoot, "review-plan", "# Scope\n\nRevised requirement.\n", {
            planId: "review-plan",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        await withExistingRuntimeInteraction(
            fixture,
            {
                type: "plan_review",
                prompt: "Review revised scope",
                _meta: {
                    planId: "review-plan",
                    planName: "review-plan",
                    planningAgentName: "planner",
                    classification: "PLANNED_CHANGE",
                    expectedStatus: "draft",
                    previousPlan: "# Scope\n\nOriginal requirement.\n",
                    planVersions: [
                        { plan: "# Scope\n\nOriginal requirement.\n" },
                        { plan: "# Scope\n\nRevised requirement.\n" },
                    ],
                },
            },
            async ({ app, origin, cookie, csrf, reference, service, response }) => {
                const path = `/projects/${reference.projectId}/plans/review-plan?session=${reference.runwieldSessionId}&operation=${reference.operationId}&interaction=${reference.interactionId}`;
                const read = () => app.handler()(new Request(origin + path, { headers: { cookie } }));
                const page = await read();
                assertEquals(page.status, 200);
                const html = await page.text();
                assertStringIncludes(html, "Original requirement.");
                assertStringIncludes(html, "Revised requirement.");
                assertStringIncludes(html, "interactionAnswerUrl");
                const request = new Request(
                    `${origin}/api/owner/projects/${reference.projectId}/session-operations/${reference.operationId}/interactions/${reference.interactionId}/answer`,
                    {
                        method: "POST",
                        headers: { cookie, "x-runwield-csrf": csrf, "content-type": "application/json", origin },
                        body: JSON.stringify({
                            requestId: "review-feedback",
                            response: {
                                outcome: "accepted",
                                _meta: { approved: false, feedback: "Clarify the revised requirement." },
                            },
                        }),
                    },
                );
                const answered = await app.handler()(request);
                assertEquals(answered.status, 202, await answered.clone().text());
                assertEquals((await response)._meta?.feedback, "Clarify the revised requirement.");
                assertEquals(await service.getLivePlanReview({ ...reference, planId: "review-plan" }), null);
                const settled = await read();
                assertEquals(settled.status, 200);
                const settledHtml = await settled.text();
                assertStringIncludes(settledHtml, "Revised requirement.");
                assertEquals(settledHtml.includes("interactionAnswerUrl"), false);
                assertEquals(settledHtml.includes("PlanHomeSurface"), true);
            },
        );
    });
});

test("owner Plan review refuses approval after real status evidence changes", async () => {
    await withRuntimeCommandFixture("owner-review-stale-", async (fixture) => {
        await savePlan(fixture.projectRoot, "stale", "# Stale review\n", {
            planId: "stale-plan",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        await withExistingRuntimeInteraction(
            fixture,
            {
                type: "plan_review",
                prompt: "Review this Plan",
                _meta: { planId: "stale-plan", planName: "stale", planningAgentName: "planner" },
            },
            async ({ service, reference, response, root }) => {
                const { loadPlan } = await import("../../plan-store/index.ts");
                const { withLocalPlanWorkflow } = await import("../../plan-store/index.ts");
                const { recordPlanEvent } = await import("../../plan-store/index.ts");

                const plan = await loadPlan(root, "stale");
                if (!plan) throw new Error("missing review fixture");
                await withLocalPlanWorkflow(root, "stale", () =>
                    recordPlanEvent({ cwd: root, planName: "stale", event: "review_approved", currentStatus: "draft" }),
                );
                await assert.rejects(
                    () =>
                        service.answerInteraction({
                            ...reference,
                            requestId: "stale-approval",
                            response: {
                                approved: true,
                                approvalAction: "run",
                                executionAgent: "engineer",
                                collaborationRecommendation: "autonomous",
                            },
                        }),
                    /Plan Status changed after review opened/,
                );
                const staleResponse = await response;
                assertEquals(staleResponse.outcome, "unsupported");
                assertStringIncludes(staleResponse.message || "", "Plan Status changed after review opened");
                assertEquals((await loadPlan(root, "stale"))?.attrs.status, "approved");
                assertEquals(service.getOperation(reference.operationId).liveInteraction, undefined);
            },
        );
    });
});

test("owner Sequence review refuses changed siblings and returns the complete current decision to Core", async () => {
    await withRuntimeCommandFixture("owner-sequence-review-", async (fixture) => {
        const root = fixture.projectRoot;
        const { prepareSequenceReview } = await import("../../plan-store/index.ts");
        const { writeFile } = await import("node:fs/promises");

        const { loadPlan } = await import("../../plan-store/index.ts");
        await savePlan(root, "sequence", "# Sequence\n", {
            classification: "PROJECT",
            type: "sequence",
            status: "draft",
        });
        for (const [index, name] of ["first", "second"].entries())
            await savePlan(root, `sequence/${name}`, `# ${name}\n`, {
                classification: "PLANNED_CHANGE",
                status: "draft",
                parentPlan: "sequence",
                order: index + 1,
            });
        const documents = await prepareSequenceReview(root, "sequence");
        await withExistingRuntimeInteraction(
            fixture,
            {
                type: "plan_review",
                prompt: "Review complete Sequence",
                _meta: {
                    planId: documents[0].planId,
                    planName: "sequence",
                    planningAgentName: "architect",
                    sequenceDocuments: documents,
                },
            },
            async ({ service, reference, response }) => {
                const second = documents[2];
                await writeFile(second.planPath, `${second.plan}\nNew requirements.`);
                const decision = {
                    approved: true,
                    approvalAction: "run",
                    documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                };
                await assert.rejects(
                    () => service.answerInteraction({ ...reference, requestId: "stale-sequence", response: decision }),
                    /Required Plan documents changed/,
                );
                assertEquals((await loadPlan(root, "sequence/first"))?.attrs.status, "draft");
                assertEquals(
                    service.getOperation(reference.operationId).liveInteraction?.interactionId,
                    reference.interactionId,
                );
                await writeFile(second.planPath, second.plan);
                await service.answerInteraction({ ...reference, requestId: "current-sequence", response: decision });
                const result = await response;
                assertEquals(result.outcome, "accepted");
                assertEquals(JSON.stringify(result._meta?.sequenceDecision), JSON.stringify(decision));
                assertEquals((await loadPlan(root, "sequence"))?.attrs.status, "draft");
            },
        );
        await withExistingRuntimeInteraction(
            fixture,
            {
                type: "plan_review",
                prompt: "Discuss Sequence",
                _meta: {
                    planId: documents[0].planId,
                    planName: "sequence",
                    planningAgentName: "architect",
                    sequenceDocuments: documents,
                },
            },
            async ({ service, reference, response }) => {
                await service.answerInteraction({
                    ...reference,
                    requestId: "sequence-feedback",
                    response: {
                        approved: false,
                        feedback: "Clarify the group.",
                        conversationTurn: true,
                        documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                    },
                });
                const result = await response;
                assertEquals(result._meta?.conversationTurn, true);
                assertStringIncludes(JSON.stringify(result._meta?.sequenceDecision), "Clarify the group.");
            },
        );
    });
});

test("owner requests retain admitted document identity and reject stale saves without changing metadata", async () => {
    const { packageFixture, create, read } = await import("../../shared/testing/plan-package-fixture.ts");
    const { withPlanAccess, selectPlanAccess } = await import("../../plan-store/index.ts");
    const { openOwnerCoordinationStore } = await import("../../shared/owner-coordination/index.ts");
    const { createOwnerWorkspaceApp } = await import("./server.ts");
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
        const { withLocalPlanWorkflow, operatePlanFile, loadPlan } = await import("../../plan-store/index.ts");
        const { recordPlanEvent } = await import("../../plan-store/index.ts");
        await withLocalPlanWorkflow(f.root, "one", async () => {
            await recordPlanEvent({ cwd: f.root, planName: "one", event: "review_approved", currentStatus: "draft" });
            await recordPlanEvent({
                cwd: f.root,
                planName: "one",
                event: "readiness_passed",
                currentStatus: "approved",
            });
        });
        const ready = await (await get()).json();
        equal((await save(ready.body, ready.revision)).status, 200);
        equal((await loadPlan(f.root, "one"))?.attrs.status, "ready_for_work");
        equal((await save("# Revised acceptance criteria\n", ready.revision)).status, 200);
        equal((await loadPlan(f.root, "one"))?.attrs.status, "draft");
        assert((await save("# Stale approval\n", ready.revision)).status >= 400);
        const { archivePlan } = await import("../../plan-store/index.ts");
        const admission = await selectPlanAccess(f.root, "one");
        await archivePlan(f.root, "one", { force: true, reason: "retired" });
        const archived = await read(f.identity);
        await assert.rejects(
            () =>
                withPlanAccess(f.root, admission, () => {
                    throw new Error("stale action ran");
                }),
            /selection changed|archived/i,
        );
        await assert.rejects(
            () =>
                operatePlanFile(f.root, {
                    mode: "edit",
                    path: archived.path + "/context.md",
                    oldText: "Revised",
                    newText: "Overwritten",
                }),
            /archived|protected/i,
        );
        deepEqual(await read(f.identity), archived);

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
