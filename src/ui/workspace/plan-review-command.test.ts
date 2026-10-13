import { assertEquals } from "../../testing/assertions.ts";
// @ts-nocheck: owner Workspace app and managed fixture expose JavaScript records.
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { ensurePlanIdentity, savePlan } from "../../plan-store.js";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createOwnerWorkspaceApp } from "./server.js";

test("owner Plan review command opens a saved review through the authorized route without a user turn", async () => {
    await withRuntimeCommandFixture(
        "workspace-reopen-plan-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            setModelResponseFactory(fixture.recordedModelResponse("Unexpected model turn"));
            const store = fixture.openStore();
            let app;
            try {
                await savePlan(fixture.projectRoot, "saved", "# Saved\n\n## Context\n\nReview this plan.", {
                    planId: "saved-id",
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    affectedPaths: [],
                });
                const plan = await ensurePlanIdentity(fixture.projectRoot, "saved");
                const activation = store.inspectSessionActivation(fixture.session.runwieldSessionId);
                const proof = store.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "review-setup",
                    ownerProcessKind: "test",
                    expectedGeneration: activation.generation.generation,
                    expectedCurrentSegmentId: activation.generation.currentSegmentId,
                });
                store.recordLastPlanReview(proof, {
                    planId: plan.attrs.planId,
                    planName: "saved",
                    planningAgentName: "planner",
                });
                store.releaseUnchangedActivation(proof);
                const pairing = store.createPairingRequest({
                    codeFactory: () => "REV123",
                    proofFactory: () => "review-proof",
                });
                store.approvePairingRequest(pairing.code);
                const device = store.claimPairingRequest(pairing.proof, {
                    credentialFactory: () => "review-credential",
                    csrfFactory: () => "review-csrf",
                });
                app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
                const options = await app.sessionContinuation.listSessionOptions(fixture.project.projectId);
                assertEquals(options.commands.find((command) => command.name === "plan-review")?.kind, "action");
                const base = `http://127.0.0.1:8787/api/owner/projects/${fixture.project.projectId}/sessions/${fixture.session.runwieldSessionId}`;
                const cookie = `rw_owner_device=${device.credential}; rw_owner_csrf=review-csrf`;
                const get = async (path) =>
                    (
                        await app.handler()(
                            new Request(`${base}/${path}`, {
                                headers: { cookie },
                            }),
                        )
                    ).json();
                const post = (requestId) =>
                    app.handler()(
                        new Request(`${base}/plan-review`, {
                            method: "POST",
                            headers: { origin: "http://127.0.0.1:8787", cookie, "x-runwield-csrf": "review-csrf" },
                            body: JSON.stringify({ requestId, expectedGeneration: 0 }),
                        }),
                    );
                const forbidden = await app.handler()(
                    new Request(`${base}/plan-review`, {
                        method: "POST",
                        body: JSON.stringify({ requestId: "unpaired", expectedGeneration: 0 }),
                    }),
                );
                assertEquals(forbidden.status, 403);
                const opened = await post("open-saved");
                assertEquals(opened.status, 202);
                const accepted = await opened.json();
                assertEquals(accepted.kind, "starting");
                assertEquals((await (await post("open-saved")).json()).operationId, accepted.operationId);
                let review;
                for (let index = 0; index < 300; index++) {
                    const live = await get("live");
                    review = live.operation?.liveInteraction?.request;
                    if (review?.reviewUrl) break;
                    if (live.operation?.status === "failed") throw new Error(live.operation.error);
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(
                    review?.reviewUrl?.startsWith(`/projects/${fixture.project.projectId}/plans/saved-id?`),
                    JSON.stringify({
                        review,
                        plan,
                        operation: app.sessionContinuation.getOperation(accepted.operationId),
                    }),
                );
                assertEquals(review.type, "plan_review");
                assertEquals((await get("live")).operation.operationId, accepted.operationId);
                const reopened = await (await post("open-again")).json();
                assertEquals(reopened.kind, "live");
                assertEquals(reopened.operationId, accepted.operationId);
                assertEquals(reopened.url, review.reviewUrl);
                const answer = await app.handler()(
                    new Request(
                        `http://127.0.0.1:8787/api/owner/projects/${fixture.project.projectId}/session-operations/${accepted.operationId}/interactions/${review.id}/answer`,
                        {
                            method: "POST",
                            headers: { origin: "http://127.0.0.1:8787", cookie, "x-runwield-csrf": "review-csrf" },
                            body: JSON.stringify({
                                runwieldSessionId: fixture.session.runwieldSessionId,
                                requestId: "approve-later",
                                response: {
                                    approved: true,
                                    approvalAction: "later",
                                    executionAgent: "engineer",
                                    collaborationRecommendation: "autonomous",
                                },
                            }),
                        },
                    ),
                );
                assertEquals(answer.status, 202, JSON.stringify(await answer.clone().json()));
                const settled = Promise.withResolvers<void>();
                const unsubscribe = app.sessionContinuation.subscribeOperationChanges(
                    accepted.operationId,
                    (status) => {
                        if (status !== "running" && status !== "accepted") settled.resolve();
                    },
                );
                let timeout;
                try {
                    await Promise.race([
                        settled.promise,
                        new Promise((_, reject) => {
                            timeout = setTimeout(() => {
                                reject(
                                    new Error(
                                        `Plan review did not settle: ${JSON.stringify(
                                            app.sessionContinuation.getOperation(accepted.operationId),
                                        )}`,
                                    ),
                                );
                            }, 60_000);
                        }),
                    ]);
                } finally {
                    clearTimeout(timeout);
                    unsubscribe();
                }
                assertEquals(app.sessionContinuation.getOperation(accepted.operationId).status, "completed");
                assertEquals(fixture.modelRequests.length, 0);
            } finally {
                await app?.close();
                store.close();
                await fixture.cleanup();
            }
        },
    );
});
