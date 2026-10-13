// @ts-nocheck: Owner Workspace routes and projected operations are JavaScript.
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { createOwnerWorkspaceApp } from "./server.js";

const origin = "http://127.0.0.1:8787";

test("owner Workspace reopens an Architect Epic review and projects the revised live review", async () => {
    await withRuntimeCommandFixture("owner-epic-live-review-", async ({ projectRoot, setModelResponseFactories }) => {
        const store = openOwnerCoordinationStore();
        const project = store.registerProject({ root: projectRoot, displayName: "Epic Project" });
        const runtime = createSessionRuntime({ sessionStore: store });
        let ownerApp;
        let operationId;
        try {
            await savePlan(projectRoot, "epic-review", "# Epic review\n\nFirst architecture proposal.\n", {
                planId: "epic-review-id",
                classification: "PROJECT",
                type: "epic",
                complexity: "HIGH",
                summary: "Epic architecture",
                status: "ready_for_work",
                humanReviewMode: "ask",
            });
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, agentName: "architect" });
            await runtime.recordPlanAssociation(sessionId, {
                planId: "epic-review-id",
                planName: "epic-review",
                purpose: "planning",
            });
            const managed = runtime.getSessionSnapshot(sessionId)?.managed;
            assertExists(managed);
            await runtime.closeAllSessionsWhenIdle();

            const pairing = store.createPairingRequest({ codeFactory: () => "EPI123", proofFactory: () => "proof" });
            store.approvePairingRequest(pairing.code);
            const device = store.claimPairingRequest(pairing.proof, {
                credentialFactory: () => "epic-device-secret",
                csrfFactory: () => "epic-csrf-secret",
            });
            ownerApp = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
            const app = ownerApp.handler();
            const cookie = `rw_owner_device=${encodeURIComponent(device.credential)}; rw_owner_csrf=epic-csrf-secret`;
            const headers = {
                origin,
                cookie,
                "x-runwield-csrf": "epic-csrf-secret",
                "content-type": "application/json",
            };
            const sessionBase =
                `${origin}/api/owner/projects/${project.projectId}/sessions/${managed.runwieldSessionId}`;
            const post = (url, body) => app(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
            const live = () => app(new Request(`${sessionBase}/live`, { headers: { cookie } }));
            const generation = store.inspectSessionActivation(managed.runwieldSessionId).generation?.generation;
            let modelTurns = 0;
            const reviseArchitecture = async () => {
                modelTurns++;
                const current = await loadPlan(projectRoot, "epic-review");
                assertExists(current);
                await savePlan(
                    projectRoot,
                    "epic-review",
                    modelTurns === 1
                        ? "# Epic review\n\nRevised architecture proposal.\n"
                        : "# Epic review\n\nRevised architecture proposal round 2.\n",
                    current.attrs,
                    {
                        expectedRevision: current.revision,
                    },
                );
                return fauxAssistantMessage(fauxToolCall("plan_written", { planName: "epic-review" }));
            };
            setModelResponseFactories([reviseArchitecture, reviseArchitecture]);
            // Start the route while observing its live review. The route waits for the review URL.
            const opening = post(`${sessionBase}/plan-workflow`, {
                action: "review_plan",
                planId: "epic-review-id",
                requestId: crypto.randomUUID(),
                expectedGeneration: generation,
            });
            let firstLiveResponse;
            for (let i = 0; i < 500; i++) {
                firstLiveResponse = await live();
                const projected = await firstLiveResponse.clone().json();
                if (projected.operation?.liveInteraction?.request.type === "plan_review") break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assertExists(firstLiveResponse);
            assertEquals(firstLiveResponse.status, 200);
            const firstLive = await firstLiveResponse.json();
            const firstReview = firstLive.operation?.liveInteraction;
            assertExists(firstReview);
            assertEquals(firstReview.request.type, "plan_review");
            assertEquals(firstReview.request.planReview.classification, "PROJECT");
            assertEquals(firstReview.request.planReview.planId, "epic-review-id");
            assertEquals(firstReview.request.planReview.agentLabel, "Architect");
            assertEquals(
                store.getLastPlanReview(managed.runwieldSessionId, project.projectId)?.planId,
                "epic-review-id",
            );
            assertStringIncludes(
                firstReview.request.planReview.reviewedSource.markdown,
                "First architecture proposal.",
            );
            operationId = firstLive.operation.operationId;
            assertStringIncludes(firstReview.request.reviewUrl, `operation=${operationId}`);
            assertStringIncludes(firstReview.request.reviewUrl, `interaction=${firstReview.interactionId}`);
            const originalRevision = firstReview.request.planReview.expectedRevision;
            assertExists(originalRevision);

            // Opening review did not call the model.
            assertEquals(modelTurns, 0);
            const answer = await post(
                `${origin}/api/owner/projects/${project.projectId}/session-operations/${operationId}/interactions/${firstReview.interactionId}/answer`,
                {
                    runwieldSessionId: managed.runwieldSessionId,
                    requestId: crypto.randomUUID(),
                    response: {
                        approved: false,
                        feedback: "Clarify the architecture boundaries.",
                        conversationTurn: true,
                    },
                },
            );
            assertEquals(answer.status, 202, await answer.text());
            let secondLive;
            for (let i = 0; i < 500; i++) {
                const response = await live();
                assertEquals(response.status, 200);
                secondLive = await response.json();
                if (
                    secondLive.operation?.liveInteraction?.interactionId !== firstReview.interactionId &&
                    secondLive.operation?.liveInteraction?.request.type === "plan_review"
                ) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const secondReview = secondLive?.operation?.liveInteraction;
            assertExists(secondReview, JSON.stringify(secondLive));
            assertEquals(modelTurns, 1);
            assertEquals(secondReview.request.type, "plan_review");
            assert(secondReview.interactionId !== firstReview.interactionId);
            assert(secondReview.request.planReview.expectedRevision !== originalRevision);
            assertEquals(secondReview.request.planReview.agentLabel, "Architect");
            assertStringIncludes(
                secondReview.request.planReview.reviewedSource.markdown,
                "Revised architecture proposal.",
            );
            assertStringIncludes(secondReview.request.reviewUrl, `interaction=${secondReview.interactionId}`);
            assertStringIncludes(secondReview.request.reviewUrl, `operation=${operationId}`);
            assertStringIncludes(
                (await loadPlan(projectRoot, "epic-review")).markdown,
                "Revised architecture proposal.",
            );
            const secondAnswer = await post(
                `${origin}/api/owner/projects/${project.projectId}/session-operations/${operationId}/interactions/${secondReview.interactionId}/answer`,
                {
                    runwieldSessionId: managed.runwieldSessionId,
                    requestId: crypto.randomUUID(),
                    response: {
                        approved: false,
                        feedback: "Clarify the revised architecture boundaries.",
                        conversationTurn: true,
                    },
                },
            );
            assertEquals(secondAnswer.status, 202, await secondAnswer.text());
            let thirdLive;
            for (let i = 0; i < 500; i++) {
                const response = await live();
                assertEquals(response.status, 200);
                thirdLive = await response.json();
                if (
                    thirdLive.operation?.liveInteraction?.interactionId !== secondReview.interactionId &&
                    thirdLive.operation?.liveInteraction?.request.type === "plan_review"
                ) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const thirdReview = thirdLive?.operation?.liveInteraction;
            assertExists(thirdReview, JSON.stringify(thirdLive));
            assertEquals(modelTurns, 2);
            assertEquals(thirdReview.request.type, "plan_review");
            assert(thirdReview.interactionId !== secondReview.interactionId);
            assert(thirdReview.interactionId !== firstReview.interactionId);
            assertEquals(thirdReview.request.planReview.agentLabel, "Architect");
            assertStringIncludes(
                thirdReview.request.planReview.reviewedSource.markdown,
                "Revised architecture proposal round 2.",
            );
            assertStringIncludes(thirdReview.request.reviewUrl, `interaction=${thirdReview.interactionId}`);
            assertStringIncludes(thirdReview.request.reviewUrl, `operation=${operationId}`);
            assertStringIncludes(
                (await loadPlan(projectRoot, "epic-review")).markdown,
                "Revised architecture proposal round 2.",
            );
            const opened = await opening;
            assertEquals(opened.status, 202);
            assertEquals((await opened.json()).reviewUrl, firstReview.request.reviewUrl);
        } finally {
            if (operationId) await ownerApp?.sessionContinuation.cancelOperation({ operationId });
            await ownerApp?.close();
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});
