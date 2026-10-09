// @ts-nocheck: owner Workspace routes and the fixture expose JavaScript records.
import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createOwnerWorkspaceApp } from "./server.js";

async function withOpenReview(run) {
    await withRuntimeCommandFixture(
        "workspace-review-decision-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            setModelResponseFactory(fixture.recordedModelResponse("Review feedback received."));
            const store = fixture.openStore();
            let app;
            try {
                await savePlan(projectRoot, "saved", "# Saved\n\n## Context\n\nReview this plan.", {
                    planId: "saved-id",
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    affectedPaths: [],
                });
                const plan = await ensurePlanIdentity(projectRoot, "saved");
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
                const base = `http://127.0.0.1:8787/api/owner/projects/${fixture.project.projectId}`;
                const cookie = `rw_owner_device=${device.credential}; rw_owner_csrf=review-csrf`;
                const headers = { origin: "http://127.0.0.1:8787", cookie, "x-runwield-csrf": "review-csrf" };
                const sessionBase = `${base}/sessions/${fixture.session.runwieldSessionId}`;
                const opened = await app.handler()(
                    new Request(`${sessionBase}/plan-review`, {
                        method: "POST",
                        headers,
                        body: JSON.stringify({ requestId: "open-saved", expectedGeneration: 0 }),
                    }),
                );
                assertEquals(opened.status, 202, await opened.clone().text());
                const { operationId } = await opened.json();
                let review;
                for (let index = 0; index < 300; index++) {
                    const live =
                        await (await app.handler()(new Request(`${sessionBase}/live`, { headers: { cookie } }))).json();
                    review = live.operation?.liveInteraction?.request;
                    if (review?.reviewUrl) break;
                    if (live.operation?.status === "failed") throw new Error(live.operation.error);
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(review?.reviewUrl, "Plan review did not open");
                const answer = (requestId, response) =>
                    app.handler()(
                        new Request(
                            `${base}/session-operations/${operationId}/interactions/${review.id}/answer`,
                            {
                                method: "POST",
                                headers,
                                body: JSON.stringify({
                                    runwieldSessionId: fixture.session.runwieldSessionId,
                                    requestId,
                                    response,
                                }),
                            },
                        ),
                    );
                await run({ fixture, review, operationId, app, answer });
                let answeredRetry = false;
                for (let index = 0; index < 300; index++) {
                    const operation = app.sessionContinuation.getOperation(operationId);
                    if (operation.status !== "running") break;
                    const retry = operation.liveInteraction?.request;
                    if (!answeredRetry && retry?.type === "select") {
                        answeredRetry = true;
                        await app.handler()(
                            new Request(`${base}/session-operations/${operationId}/interactions/${retry.id}/answer`, {
                                method: "POST",
                                headers,
                                body: JSON.stringify({
                                    runwieldSessionId: fixture.session.runwieldSessionId,
                                    requestId: "decline-retry",
                                    response: { outcome: "selected", value: "no" },
                                }),
                            }),
                        );
                    }
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(app.sessionContinuation.getOperation(operationId).status !== "running", "Review did not settle");
            } finally {
                await app?.close();
                store.close();
                await fixture.cleanup();
            }
        },
    );
}

test("Workspace rejects an approval if the reviewed Plan body changes while the review is open", async () => {
    await withOpenReview(async ({ fixture, answer }) => {
        const before = await loadPlan(fixture.projectRoot, "saved");
        await savePlan(
            fixture.projectRoot,
            "saved",
            "# Saved\n\n## Context\n\nNew content not reviewed.",
            before.attrs,
            {
                expectedRevision: before.revision,
            },
        );
        const response = await answer("stale-approval", {
            approved: true,
            approvalAction: "later",
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        assert(response.status >= 400, await response.clone().text());
        assertStringIncludes((await loadPlan(fixture.projectRoot, "saved")).body, "New content not reviewed.");
        assertEquals(fixture.modelRequests.length, 0);
    });
});

test("Workspace sends review feedback images to the resumed planning Agent", async () => {
    await withOpenReview(async ({ fixture, answer, app, operationId }) => {
        const imagePath = join(fixture.projectRoot, "review.png");
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        await fsWriteFile(imagePath, Uint8Array.from(atob(png), (char) => char.charCodeAt(0)));
        const response = await answer("image-feedback", {
            approved: false,
            feedback: "Please use this screenshot.",
            images: [{ path: imagePath, name: "review.png" }],
        });
        assertEquals(response.status, 202, await response.clone().text());
        const deadline = performance.now() + 15_000;
        while (!fixture.modelRequests.length && performance.now() < deadline) {
            const operation = app.sessionContinuation.getOperation(operationId);
            if (operation.status !== "running") break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert(
            fixture.modelRequests.length > 0,
            `Planning Agent did not receive the feedback: ${JSON.stringify(app.sessionContinuation.getOperation(operationId))}`,
        );
        assertStringIncludes(fixture.modelRequests[0].messages, "Please use this screenshot.");
        assertStringIncludes(fixture.modelRequests[0].messages, "image/png");
    });
});
