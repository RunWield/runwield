import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { createTestWorktreeAttempt } from "../../shared/worktree-test-helpers.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { ownerSessionPlanWorkflowApi } from "./routes/owner-session-api.js";
import { ownerProjectPlanProgressApi } from "./routes/owner-api.js";

const repository = defineCommittedGitFixture({ ".gitignore": ".wld/internal/\n", "implementation.txt": "before\n" });

for (const status of ["reviewed", "ready_for_decomposition"]) {
    Deno.test(`Workspace continuation routes ${status} to its interactive workflow`, async () => {
        await withRuntimeCommandFixture("workspace-gates-", async ({ setModelResponseFactory }) => {
            const root = await repository.checkout();
            const worktreeRoot = await Deno.makeTempDir({ prefix: "workspace-gate-tree-" });
            const store = openOwnerCoordinationStore();
            const project = store.registerProject({ root });
            const runtime = createSessionRuntime({ sessionStore: store });
            const service = new WorkspaceSessionContinuationService({ store });
            try {
                const epic = status === "ready_for_decomposition";
                const name = epic ? "epic-plan" : "review-plan";
                const planId = `${name}-id`;
                const body = `# ${name}\n\nImplement the requested change.\n`;
                await savePlan(root, name, body, {
                    planId,
                    status,
                    classification: epic ? "PROJECT" : "PLANNED_CHANGE",
                    ...(epic ? {} : { executionAgent: "engineer" }),
                    targetBranch: "main",
                    humanReviewMode: "ask",
                });
                await savePlan(root, "earlier-plan", "# Earlier Plan\n", {
                    planId: "earlier-plan-id",
                    status: "ready_for_work",
                    classification: "PLANNED_CHANGE",
                    executionAgent: "engineer",
                });
                await git(root, ["add", "."]);
                await git(root, ["commit", "-m", "Plan"]);
                if (!epic) {
                    const baseline = await git(root, ["rev-parse", "HEAD^{tree}"]);
                    const tree = await createTestWorktreeAttempt({
                        projectRoot: root,
                        planName: name,
                        planId,
                        worktreeRoot,
                    });
                    await Deno.writeTextFile(join(tree.path, "implementation.txt"), "implemented\n");
                    const plan = await loadPlan(tree.path, name);
                    await savePlan(tree.path, name, body, {
                        ...plan.attrs,
                        executionMode: "worktree",
                        executionBaselineTree: baseline,
                        worktreeId: tree.id,
                        worktreePath: tree.path,
                        worktreeBranch: tree.branch,
                        worktreeBaseBranch: "main",
                    }, { expectedRevision: plan.revision });
                }
                const { sessionId } = await runtime.createInteractiveSession({ cwd: root, agentName: "engineer" });
                await runtime.recordPlanAssociation(sessionId, {
                    planId: "earlier-plan-id",
                    planName: "earlier-plan",
                    purpose: "planning",
                });
                const managed = runtime.getSessionSnapshot(sessionId).managed;
                await runtime.closeAllSessionsWhenIdle();
                let turns = 0;
                setModelResponseFactory(() => {
                    turns++;
                    return fauxAssistantMessage(fauxText("Preparing the Epic decomposition."));
                });
                const generation = store.inspectSessionActivation(managed.runwieldSessionId).generation;
                const response = await ownerSessionPlanWorkflowApi({
                    req: new Request("http://workspace.local", {
                        method: "POST",
                        body: JSON.stringify({
                            action: "resume",
                            requestId: crypto.randomUUID(),
                            planId,
                            expectedGeneration: generation.generation,
                        }),
                    }),
                    params: { projectId: project.projectId, runwieldSessionId: managed.runwieldSessionId },
                    state: { store, sessionContinuation: service },
                });
                const started = await response.json();
                assertEquals(response.status, 202, JSON.stringify(started));
                assertExists(started.operationId);
                if (epic) {
                    for (let i = 0; i < 500 && service.getOperation(started.operationId).status === "running"; i++) {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    const operation = service.getOperation(started.operationId);
                    assertEquals(operation.status, "completed", JSON.stringify(operation));
                    assertEquals(turns, 1);
                    const timeline = await service.timeline(managed.runwieldSessionId, {
                        projectId: project.projectId,
                    });
                    assertEquals(
                        timeline.events.some((event) =>
                            event.type === "system_status" && event.message === "Agent switched to Slicer"
                        ),
                        true,
                    );
                } else {
                    const interaction = async (type) => {
                        for (let i = 0; i < 500; i++) {
                            const operation = service.getOperation(started.operationId);
                            if (operation.liveInteraction?.request.type === type) return operation.liveInteraction;
                            if (operation.status !== "running") throw new Error(JSON.stringify(operation));
                            await new Promise((resolve) => setTimeout(resolve, 20));
                        }
                        throw new Error(`Waiting for ${type}`);
                    };
                    const question = await interaction("select");
                    assertStringIncludes(question.request.prompt.toLowerCase(), "review");
                    const progressResponse = await ownerProjectPlanProgressApi({
                        req: new Request(`http://workspace.local/progress?session=${managed.runwieldSessionId}`),
                        params: { projectId: project.projectId, planId },
                        state: { store, sessionContinuation: service },
                    });
                    const progress = await progressResponse.json();
                    assertEquals(progress.canResume, false, JSON.stringify(progress));
                    assertEquals(progress.canRun, false);
                    assertStringIncludes(progress.interactionHref, question.interactionId);
                    const otherProgress = async () =>
                        await (await ownerProjectPlanProgressApi({
                            req: new Request(`http://workspace.local/progress?session=${managed.runwieldSessionId}`),
                            params: { projectId: project.projectId, planId: "earlier-plan-id" },
                            state: { store, sessionContinuation: service },
                        })).json();
                    assertEquals(
                        (await otherProgress()).interactionHref,
                        "",
                        "Historical Plans do not own live questions",
                    );
                    await service.answerInteraction({
                        projectId: project.projectId,
                        operationId: started.operationId,
                        interactionId: question.interactionId,
                        requestId: crypto.randomUUID(),
                        response: { outcome: "selected", value: "open" },
                    });
                    const review = await interaction("code_review");
                    assertStringIncludes(review.request.reviewUrl, "/review/code?");
                    assertEquals(
                        (await otherProgress()).reviewHref,
                        "",
                        "Historical Plans do not own another Plan review",
                    );
                    assertEquals(turns, 0);
                    await service.cancelOperation({ operationId: started.operationId });
                }
            } finally {
                await service.runtime.closeAllSessions();
                service.close();
                await runtime.closeAllSessionsWhenIdle();
                store.close();
                await Deno.remove(worktreeRoot, { recursive: true });
                await Deno.remove(root, { recursive: true });
            }
        });
    });
}
