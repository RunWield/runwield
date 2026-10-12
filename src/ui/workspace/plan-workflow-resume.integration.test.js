import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { createTestWorktreeAttempt } from "../../shared/worktree-test-helpers.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { ownerSessionPlanWorkflowApi } from "./routes/owner-session-api.js";

const repository = defineCommittedGitFixture({
    ".gitignore": ".wld/internal/\n",
    "implementation.txt": "before\n",
});

test("Workspace Resume continues a paused validation repair in its existing worktree", async () => {
    await withRuntimeCommandFixture("deferred-validation-repair-", async (fixture) => {
        const { setModelResponseFactories, settingsPath } = fixture;
        const settings = JSON.parse(await fsReadFile(settingsPath, "utf8"));
        settings.retry = { enabled: false };
        await fsWriteFile(settingsPath, JSON.stringify(settings));
        const root = await repository.checkout();
        const worktreeRoot = await fsMkdtemp(join(tmpdir(), "deferred-repair-tree-"));
        const store = openOwnerCoordinationStore();
        const project = store.registerProject({ root });
        const runtime = createSessionRuntime({ sessionStore: store });
        try {
            const name = "interrupted-repair";
            const body = "# Interrupted repair\n\nImplement the requested change.\n";
            await savePlan(root, name, body, {
                planId: "interrupted-repair-plan",
                classification: "PLANNED_CHANGE",
                status: "validated_ci",
                executionAgent: "engineer",
                targetBranch: "main",
            });
            await git(root, ["add", "."]);
            await git(root, ["commit", "-m", "Plan"]);
            const baseline = await git(root, ["rev-parse", "HEAD^{tree}"]);
            const tree = await createTestWorktreeAttempt({
                projectRoot: root,
                planName: name,
                planId: "interrupted-repair-plan",
                worktreeRoot,
            });
            await fsWriteFile(join(tree.path, "implementation.txt"), "implemented\n");
            const plan = await loadPlan(tree.path, name);
            assertExists(plan);
            await savePlan(tree.path, name, body, {
                ...plan.attrs,
                executionMode: "worktree",
                executionBaselineTree: baseline,
                worktreeId: tree.id,
                worktreePath: tree.path,
                worktreeBranch: tree.branch,
                worktreeBaseBranch: "main",
            }, { expectedRevision: plan.revision });
            const ready = await loadPlan(tree.path, name);
            assertExists(ready);
            const id = await runtime.createPromptReadySession({
                cwd: root,
                agentName: "router",
                deferPersistenceUntilFirstMessage: true,
            });
            assertEquals(runtime.getSessionSnapshot(id)?.managed, null);
            let repairs = 0;
            setModelResponseFactories([
                () => fauxAssistantMessage(fauxToolCall("review_diff", { command: "list" })),
                () =>
                    fauxAssistantMessage(
                        fauxToolCall("review_diff", { command: "show", path: "implementation.txt" }),
                    ),
                () =>
                    fauxAssistantMessage(
                        fauxToolCall("review_diff", { command: "show", path: `docs/plans/${name}.md` }),
                    ),
                () =>
                    fauxAssistantMessage(fauxToolCall("review_complete", {
                        approved: false,
                        feedback: "The implementation is incomplete.",
                        findings: [{
                            title: "Missing guard",
                            requirement: "Implement the requested change",
                            evidence: "implementation.txt",
                        }],
                    })),
                () => {
                    repairs++;
                    return fauxAssistantMessage(fauxText("Inspecting the missing guard."));
                },
            ]);
            const result = await runtime.runValidation(id, {
                planName: name,
                planContent: body,
                triageMeta: { ...ready.attrs, revision: ready.revision },
            });
            assertEquals(repairs, 1, JSON.stringify(result));
            assertExists(result);
            assertEquals(result.kind, "paused");
            const managed = runtime.getSessionSnapshot(id)?.managed;
            assertExists(managed);
            const segments = store.listSessionTranscriptSegments(managed.runwieldSessionId);
            assertEquals(segments.map((segment) => segment.kind), ["planning", "semantic_repair"]);
            assertEquals(store.inspectSessionActivation(managed.runwieldSessionId).activation?.state, "idle");
            await runtime.closeAllSessionsWhenIdle();
            const service = new WorkspaceSessionContinuationService({ store });
            try {
                setModelResponseFactories([(context) => {
                    repairs++;
                    assertStringIncludes(JSON.stringify(context.messages), "Missing guard");
                    return fauxAssistantMessage(fauxText("Continuing the interrupted repair."));
                }]);
                const session = store.getSessionById(managed.runwieldSessionId);
                assertExists(session);
                const generation = store.inspectSessionActivation(managed.runwieldSessionId).generation;
                assertExists(generation);
                const response = await ownerSessionPlanWorkflowApi({
                    req: new Request("http://workspace.local", {
                        method: "POST",
                        body: JSON.stringify({
                            action: "resume",
                            planId: "interrupted-repair-plan",
                            expectedGeneration: generation.generation,
                        }),
                    }),
                    params: { projectId: project.projectId, runwieldSessionId: managed.runwieldSessionId },
                    state: { store, sessionContinuation: service },
                });
                const payload = await response.json();
                assertEquals(response.status, 202, JSON.stringify(payload));
                assertExists(payload.operationId);
                for (let i = 0; i < 500 && service.getOperation(payload.operationId).status === "running"; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                assertEquals(
                    service.getOperation(payload.operationId).status,
                    "completed",
                    JSON.stringify(service.getOperation(payload.operationId)),
                );
                assertEquals(repairs, 2, JSON.stringify(payload));
                assertEquals(store.inspectSessionActivation(managed.runwieldSessionId).activation?.state, "idle");
                const resumedSegments = store.listSessionTranscriptSegments(managed.runwieldSessionId);
                assertEquals(resumedSegments.every((segment) => segment.kind !== "execution"), true);
                assertEquals(resumedSegments.at(-1).transcriptCwd, await fsRealpath(tree.path));
                assertStringIncludes(
                    await fsReadFile(resumedSegments.at(-1).transcriptPath, "utf8"),
                    "Continuing the interrupted repair.",
                );
            } finally {
                await service.runtime.closeAllSessions();
                service.close();
            }
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
            await fsRm(worktreeRoot, { recursive: true });
            await fsRm(root, { recursive: true });
        }
    });
});
