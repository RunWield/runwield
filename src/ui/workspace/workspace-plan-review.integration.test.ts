import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { savePlan } from "../../plan-store.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { withExistingRuntimeInteraction } from "./testing/live-interaction-fixture.ts";

// Real owner Session, HTTP routes and Plan reads; only the model turn waits at its boundary.
test("Workspace Plan review carries revision history, returns feedback to Core, and settles into Plan home", async () => {
    await withRuntimeCommandFixture("workspace-plan-review-http-", async (fixture) => {
        await savePlan(fixture.projectRoot, "review-plan", "# Scope\n\nRevised requirement.\n", {
            planId: "review-plan",
            classification: "FEATURE",
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
                    classification: "FEATURE",
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
                const { loadPlan, injectFrontMatter } = await import("../../plan-store.ts");
                const { writeFile } = await import("node:fs/promises");
                const { assertRejects } = await import("../../testing/assertions.ts");
                const plan = await loadPlan(root, "stale");
                if (!plan) throw new Error("missing review fixture");
                await writeFile(plan.path, injectFrontMatter(plan.markdown, { status: "approved" }));
                await assertRejects(
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
                    Error,
                    "Plan Status changed after review opened",
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
        const { prepareSequenceReview } = await import("../../shared/workflow/sequence-review.ts");
        const { writeFile } = await import("node:fs/promises");
        const { assertRejects } = await import("../../testing/assertions.ts");
        const { loadPlan } = await import("../../plan-store.ts");
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
                await assertRejects(
                    () => service.answerInteraction({ ...reference, requestId: "stale-sequence", response: decision }),
                    Error,
                    "changed while review was open",
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
