import { rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { buildWorkflowPresentation } from "../../shared/workflow/workflow-presentation.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { ownerProjectPlanProgressApi } from "./routes/owner-api.js";
import { ownerPlanContinuationApi } from "./routes/owner-plan-continuation.ts";
import { ownerSessionPlanWorkflowApi } from "./routes/owner-session-api.js";

const repository = defineCommittedGitFixture({ ".gitignore": ".wld/internal/\n" });

for (const withSession of [false, true]) {
    test(`Workspace resumes a held Plan ${withSession ? "with" : "without"} a Session, then offers review`, async () => {
        await withRuntimeCommandFixture("workspace-held-", async () => {
            const root = await repository.checkout();
            const store = openOwnerCoordinationStore();
            const project = store.registerProject({ root });
            const runtime = createSessionRuntime({ sessionStore: store });
            const service = new WorkspaceSessionContinuationService({ store });
            try {
                await savePlan(root, "held", "# Held Plan\n", {
                    planId: "held-id",
                    status: "on_hold",
                    heldFromStatus: "ready_for_work",
                    classification: "PLANNED_CHANGE",
                    executionAgent: "engineer",
                    holdStalenessBaseline: "saved-baseline",
                });
                let sessionId;
                if (withSession) {
                    const created = await runtime.createInteractiveSession({ cwd: root });
                    await runtime.recordPlanAssociation(created.sessionId, {
                        planId: "held-id",
                        planName: "held",
                        purpose: "planning",
                    });
                    sessionId = runtime.getSessionSnapshot(created.sessionId).managed.runwieldSessionId;
                    await runtime.closeAllSessionsWhenIdle();
                }
                const params = { projectId: project.projectId, planId: "held-id", runwieldSessionId: sessionId };
                const state = { store, sessionContinuation: service };
                const progress = await (await ownerProjectPlanProgressApi({
                    req: new Request("http://workspace.local/progress"),
                    params,
                    state,
                })).json();
                assertEquals(progress.canResume, true, JSON.stringify(progress));
                assertExists(progress.expectedRevision);
                const presentation = buildWorkflowPresentation({
                    status: progress.plan.status,
                    canResume: progress.canResume,
                });
                assertEquals(presentation.action.kind, "resume_from_hold");
                const action = async (acceptResumeWarnings, expectedRevision = progress.expectedRevision) => {
                    const req = new Request("http://workspace.local/workflow", {
                        method: "POST",
                        body: JSON.stringify({
                            action: "resume_from_hold",
                            planId: "held-id",
                            requestId: crypto.randomUUID(),
                            expectedRevision,
                            expectedGeneration: progress.expectedGeneration,
                            acceptResumeWarnings,
                        }),
                    });
                    return await (withSession ? ownerSessionPlanWorkflowApi : ownerPlanContinuationApi)({
                        req,
                        params,
                        state,
                    });
                };
                const warning = await action(false);
                assertEquals(warning.status, 409);
                assertEquals((await warning.json()).requiresConfirmation, true);
                assertEquals((await loadPlan(root, "held")).attrs.status, "on_hold");
                const stale = await action(true, "stale-revision");
                assertEquals(stale.status, 409);
                assertEquals((await loadPlan(root, "held")).attrs.status, "on_hold");
                const restored = await action(true);
                assertEquals(restored.status, 200, await restored.text());
                assertEquals((await loadPlan(root, "held")).attrs.status, "ready_for_work");
                const refreshed = await (await ownerProjectPlanProgressApi({
                    req: new Request("http://workspace.local/progress"),
                    params,
                    state,
                })).json();
                assertEquals(
                    buildWorkflowPresentation({ status: refreshed.plan.status, canResume: refreshed.canResume }).action
                        .kind,
                    "review_plan",
                );
            } finally {
                await service.runtime.closeAllSessions();
                service.close();
                await runtime.closeAllSessionsWhenIdle();
                store.close();
                await fsRm(root, { recursive: true });
            }
        });
    });
}

test("Workspace opens saved Plan review without a Session, deduplicates concurrent requests, and remembers retries", async () => {
    await withRuntimeCommandFixture("workspace-unassociated-", async ({ setModelResponseFactory }) => {
        const root = await repository.checkout();
        const store = openOwnerCoordinationStore();
        const project = store.registerProject({ root });
        const service = new WorkspaceSessionContinuationService({ store });
        const restarted = new WorkspaceSessionContinuationService({ store });
        try {
            await savePlan(root, "saved", "# Saved Plan\n", {
                planId: "saved-id",
                status: "ready_for_work",
                classification: "PLANNED_CHANGE",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                targetBranch: "main",
            });
            await git(root, ["add", "."]);
            await git(root, ["commit", "-m", "Saved Plan"]);
            let turns = 0;
            setModelResponseFactory(() => {
                turns++;
                throw new Error("Review must not run an Agent");
            });
            const params = { projectId: project.projectId, planId: "saved-id" };
            const progress = await (await ownerProjectPlanProgressApi({
                req: new Request("http://workspace.local/progress"),
                params,
                state: { store, sessionContinuation: service },
            })).json();
            assertEquals(progress.sessionHref, "");
            assertEquals(progress.canResume, true);
            assertStringIncludes(progress.planWorkflowUrl, "/plans/saved-id/workflow");
            const requestId = crypto.randomUUID();
            const open = async (sessionContinuation = service) => {
                const response = await ownerPlanContinuationApi({
                    req: new Request("http://workspace.local/workflow", {
                        method: "POST",
                        body: JSON.stringify({ requestId, action: "review_plan" }),
                    }),
                    params,
                    state: { store, sessionContinuation },
                });
                const body = await response.json();
                assertEquals(response.status, 202, JSON.stringify(body));
                return body;
            };
            const [first, second] = await Promise.all([open(), open()]);
            assertEquals(first.operationId, second.operationId);
            assertEquals(first.reviewUrl, second.reviewUrl);
            assertEquals(turns, 0);
            const operation = service.getOperation(first.operationId);
            assertExists(operation.runwieldSessionId);
            await service.answerInteraction({
                projectId: project.projectId,
                operationId: first.operationId,
                interactionId: operation.liveInteraction.interactionId,
                requestId: crypto.randomUUID(),
                response: {
                    approved: true,
                    approvalAction: "later",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                },
            });
            for (let i = 0; i < 500 && service.getOperation(first.operationId).status === "running"; i++) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assertEquals(service.getOperation(first.operationId).status, "completed");
            assertEquals((await open(restarted)).operationId, first.operationId);
            assertEquals((await store.listProjectSessions(project.projectId, { catalog: false })).sessions.length, 1);
            assertEquals(turns, 0);
            assertEquals((await loadPlan(root, "saved")).attrs.status, "ready_for_work");
        } finally {
            await service.runtime.closeAllSessions();
            service.close();
            await restarted.runtime.closeAllSessions();
            restarted.close();
            store.close();
            await fsRm(root, { recursive: true });
        }
    });
});
