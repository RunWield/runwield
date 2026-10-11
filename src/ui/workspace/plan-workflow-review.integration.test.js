import { recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan, withPlanCatalogLock } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { loadWorkspaceDetail } from "./server/plan-adapter.js";
import { ownerProjectPlanProgressApi } from "./routes/owner-api.js";
import { loadOwnerPlanProgress } from "./server/owner-plan-progress.ts";
import { ownerSessionPlanWorkflowApi } from "./routes/owner-session-api.js";

/**
 * Wait for background review/execution work to publish its settled status.
 * @param {WorkspaceSessionContinuationService} service
 * @param {string} operationId
 */
async function waitForOperationSettlement(service, operationId) {
    const settled = Promise.withResolvers();
    const unsubscribe = service.subscribeOperationChanges(operationId, (status) => {
        if (status !== "running" && status !== "accepted") settled.resolve();
    });
    let timeout;
    try {
        await Promise.race([
            settled.promise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`Operation ${operationId} did not settle`)), 60_000);
            }),
        ]);
        return service.getOperation(operationId);
    } finally {
        clearTimeout(timeout);
        unsubscribe();
    }
}

const repository = defineCommittedGitFixture({ ".gitignore": ".wld/internal/\n", "implementation.txt": "before\n" });

for (const resumeStatus of ["in_progress", "failed"]) {
    Deno.test(`saved Plan review preserves Later, starts Run, and resumes ${resumeStatus} in its worktree`, async () => {
        await withRuntimeCommandFixture(
            "workspace-saved-review-",
            async ({ setModelResponseFactory, setModelResponseFactories }) => {
                const root = await repository.checkout();
                const store = openOwnerCoordinationStore();
                const project = store.registerProject({ root });
                const runtime = createSessionRuntime({ sessionStore: store });
                const service = new WorkspaceSessionContinuationService({ store });
                try {
                    await savePlan(root, "saved-plan", "# Saved Plan\n\nImplement the requested change.\n", {
                        planId: "saved-plan-id",
                        classification: "PLANNED_CHANGE",
                        workKind: "FEATURE",
                        status: "ready_for_work",
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                        targetBranch: "main",
                    });
                    await git(root, ["add", "."]);
                    await git(root, ["commit", "-m", "Saved plan"]);
                    const { sessionId } = await runtime.createInteractiveSession({ cwd: root, agentName: "planner" });
                    const managed = runtime.getSessionSnapshot(sessionId)?.managed;
                    assertExists(managed);
                    await runtime.closeAllSessionsWhenIdle();
                    let turns = 0;
                    setModelResponseFactory(() => {
                        turns++;
                        return fauxAssistantMessage(fauxText("I am implementing the approved saved Plan."));
                    });
                    for (const approvalAction of ["later", "run"]) {
                        const generation = store.inspectSessionActivation(managed.runwieldSessionId).generation;
                        assertExists(generation);
                        const requestId = crypto.randomUUID();
                        const open = async () => {
                            const response = await ownerSessionPlanWorkflowApi({
                                req: new Request("http://workspace.local", {
                                    method: "POST",
                                    body: JSON.stringify({
                                        action: "resume",
                                        requestId,
                                        planId: "saved-plan-id",
                                        expectedGeneration: generation.generation,
                                    }),
                                }),
                                params: { projectId: project.projectId, runwieldSessionId: managed.runwieldSessionId },
                                state: { store, sessionContinuation: service },
                            });
                            const result = await response.json();
                            assertEquals(response.status, 202, JSON.stringify(result));
                            return result;
                        };
                        const started = await open();
                        assertEquals(turns, 0);
                        assertStringIncludes(
                            started.reviewUrl,
                            `/plans/saved-plan-id?session=${managed.runwieldSessionId}`,
                        );
                        assertEquals((await open()).reviewUrl, started.reviewUrl);
                        const interaction = service.getOperation(started.operationId).liveInteraction;
                        assertExists(interaction);
                        const plan = await loadPlan(root, "saved-plan");
                        assertEquals(plan?.attrs.status, "ready_for_work");
                        assertEquals(interaction.request.planReview.expectedStatus, "ready_for_work");
                        assertExists(interaction.request.planReview.expectedRevision);
                        // A live review must not wait for board/catalog work elsewhere in the process.
                        const locked = Promise.withResolvers();
                        const release = Promise.withResolvers();
                        const holdCatalog = withPlanCatalogLock(root, async () => {
                            locked.resolve();
                            await release.promise;
                        });
                        await locked.promise;
                        let timeout;
                        try {
                            const detail = await Promise.race([
                                loadWorkspaceDetail(root, "saved-plan-id", { reviewOnly: true }),
                                new Promise((_, reject) => {
                                    timeout = setTimeout(
                                        () => reject(new Error("Review waited for the board catalog")),
                                        2000,
                                    );
                                }),
                            ]);
                            assertStringIncludes(detail.markdown, "# Saved Plan");
                            assertEquals(detail.attrs.planId, "saved-plan-id");
                        } finally {
                            clearTimeout(timeout);
                            release.resolve();
                            await holdCatalog;
                        }

                        const decision = await service.answerInteraction({
                            projectId: project.projectId,
                            operationId: started.operationId,
                            interactionId: interaction.interactionId,
                            runwieldSessionId: managed.runwieldSessionId,
                            requestId: crypto.randomUUID(),
                            response: {
                                approved: true,
                                approvalAction,
                                executionAgent: "engineer",
                                collaborationRecommendation: "autonomous",
                            },
                        });
                        assertEquals(decision.status, "accepted");
                        const finished = await waitForOperationSettlement(service, started.operationId);
                        assertEquals(finished.status, "completed", JSON.stringify(finished));
                        if (approvalAction === "later") {
                            assertEquals(turns, 0);
                            assertEquals((await loadPlan(root, "saved-plan"))?.attrs.status, "ready_for_work");
                            const progressResponse = await ownerProjectPlanProgressApi({
                                req: new Request("http://workspace.local/api/progress"),
                                params: { projectId: project.projectId, planId: "saved-plan-id" },
                                state: { store, sessionContinuation: service },
                            });
                            const progress = await progressResponse.json();
                            assertEquals(progressResponse.status, 200, JSON.stringify(progress));
                            assertStringIncludes(progress.sessionHref, managed.runwieldSessionId);
                            assertStringIncludes(progress.planWorkflowUrl, managed.runwieldSessionId);
                            assertEquals(progress.canResume, true);
                        } else {
                            assertEquals(turns, 1);
                            const segments = store.listSessionTranscriptSegments(managed.runwieldSessionId);
                            assertEquals(segments.at(-1)?.kind, "execution");
                            assertStringIncludes(
                                await Deno.readTextFile(segments.at(-1).transcriptPath),
                                "implementing the approved saved Plan",
                            );
                        }
                    }
                    const progress = await loadOwnerPlanProgress(store, {
                        projectId: project.projectId,
                        planId: "saved-plan-id",
                        runwieldSessionId: managed.runwieldSessionId,
                    });
                    assertEquals(progress.plan.status, "in_progress");
                    if (resumeStatus === "failed") {
                        const location = await resolveWorkflowPlanLocation(root, "saved-plan");
                        await recordPlanEvent({
                            cwd: location.documentRoot,
                            planName: "saved-plan",
                            event: "execution_failed",
                            currentStatus: "in_progress",
                            details: { triageMeta: location.plan.attrs },
                        });
                    }
                    const before = store.listSessionTranscriptSegments(managed.runwieldSessionId).at(-1);
                    const generation = store.inspectSessionActivation(managed.runwieldSessionId).generation;
                    setModelResponseFactories([
                        () =>
                            fauxAssistantMessage(
                                fauxToolCall("write", { path: "continued.txt", content: "continued" }),
                            ),
                        () => {
                            turns++;
                            return fauxAssistantMessage(
                                fauxToolCall("task_completed", { message: "Implemented the saved change." }),
                            );
                        },
                    ]);
                    const resumeRequestId = crypto.randomUUID();
                    const resume = () =>
                        ownerSessionPlanWorkflowApi({
                            req: new Request("http://workspace.local", {
                                method: "POST",
                                body: JSON.stringify({
                                    action: "resume",
                                    planId: "saved-plan-id",
                                    requestId: resumeRequestId,
                                    expectedGeneration: generation.generation,
                                }),
                            }),
                            params: { projectId: project.projectId, runwieldSessionId: managed.runwieldSessionId },
                            state: { store, sessionContinuation: service },
                        });
                    const resumed = await resume();
                    const result = await resumed.json();
                    assertEquals(resumed.status, 202, JSON.stringify(result));
                    assertExists(result.operationId);
                    for (let i = 0; i < 3000; i++) {
                        const operation = service.getOperation(result.operationId);
                        if (operation.liveInteraction || operation.status !== "running") break;
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    const resumedOperation = service.getOperation(result.operationId);
                    assertEquals(resumedOperation.status, "running", JSON.stringify(resumedOperation));
                    assertEquals(
                        resumedOperation.liveInteraction?.request.type,
                        "text",
                        JSON.stringify(resumedOperation),
                    );
                    assertStringIncludes(resumedOperation.liveInteraction.request.prompt.toLowerCase(), "command");
                    const hosted = service.operations.get(result.operationId);
                    const workflow =
                        service.runtime.getSessionSnapshot(hosted.runtimeSessionId).activeExecutionWorkflow;
                    assertExists(workflow?.executionCwd);
                    assertEquals(await Deno.readTextFile(`${workflow.executionCwd}/continued.txt`), "continued");
                    assertEquals(await Deno.stat(`${root}/continued.txt`).then(() => true).catch(() => false), false);
                    assertEquals((await loadPlan(workflow.executionCwd, "saved-plan")).attrs.status, "implemented");
                    await service.cancelOperation({ operationId: result.operationId });
                    for (let i = 0; i < 500 && service.getOperation(result.operationId).status === "running"; i++) {
                        const stopped = service.getOperation(result.operationId);
                        if (stopped.liveInteraction?.request.type === "select") {
                            assertStringIncludes(stopped.liveInteraction.request.prompt, "stopped");
                            await service.answerInteraction({
                                projectId: project.projectId,
                                operationId: result.operationId,
                                interactionId: stopped.liveInteraction.interactionId,
                                runwieldSessionId: managed.runwieldSessionId,
                                requestId: crypto.randomUUID(),
                                response: "stop",
                            });
                        }
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    assertEquals(service.getOperation(result.operationId).status, "completed");
                    assertEquals(turns, 2);
                    const after = store.listSessionTranscriptSegments(managed.runwieldSessionId).at(-1);
                    assertEquals(after.segmentId, before.segmentId);
                    assertEquals(after.transcriptCwd, before.transcriptCwd);
                    const retried = await resume();
                    assertEquals(retried.status, 202);
                    assertEquals((await retried.json()).operationId, result.operationId);
                    assertEquals(turns, 2);
                    const staleReview = await ownerSessionPlanWorkflowApi({
                        req: new Request("http://workspace.local", {
                            method: "POST",
                            body: JSON.stringify({
                                action: "review_plan",
                                planId: "saved-plan-id",
                                requestId: crypto.randomUUID(),
                                expectedGeneration:
                                    store.inspectSessionActivation(managed.runwieldSessionId).generation.generation,
                            }),
                        }),
                        params: { projectId: project.projectId, runwieldSessionId: managed.runwieldSessionId },
                        state: { store, sessionContinuation: service },
                    });
                    assertEquals(staleReview.status, 409);
                    assertStringIncludes((await staleReview.json()).error, "Plan review requires");
                    assertEquals(turns, 2);
                } finally {
                    await service.runtime.closeAllSessions();
                    await service.close();
                    await runtime.closeAllSessionsWhenIdle();
                    store.close();
                    await Deno.remove(root, { recursive: true });
                }
            },
        );
    });
}
