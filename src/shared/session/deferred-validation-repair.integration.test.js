import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { createTestWorktreeAttempt } from "../worktree-test-helpers.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { openFileSessionStore } from "./file-session-store.ts";

const repository = defineCommittedGitFixture({
    ".gitignore": ".wld/internal/\n",
    "implementation.txt": "before\n",
});

for (const interruption of ["disconnect", "stop", "cancel", "disconnect_compaction"]) {
    Deno.test(`first-command validation survives repair ${interruption} and accepts continue in the worktree`, async () => {
        await withRuntimeCommandFixture("deferred-validation-repair-", async (fixture) => {
            const { setModelResponseFactories, settingsPath } = fixture;
            const settings = JSON.parse(await Deno.readTextFile(settingsPath));
            settings.retry = { enabled: false };
            await Deno.writeTextFile(settingsPath, JSON.stringify(settings));
            const root = await repository.checkout();
            const worktreeRoot = await Deno.makeTempDir({ prefix: "deferred-repair-tree-" });
            const store = openFileSessionStore();
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
                await Deno.writeTextFile(join(tree.path, "implementation.txt"), "implemented\n");
                const plan = await loadPlan(tree.path, name);
                assertExists(plan);
                assertEquals(plan.attrs.status, "implemented");
                assertEquals(plan.attrs.validationPhase, "semantic");
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
                assertEquals(ready.attrs.status, "implemented");
                assertEquals(ready.attrs.validationPhase, "semantic");
                const id = await runtime.createPromptReadySession({
                    cwd: root,
                    agentName: "router",
                    deferPersistenceUntilFirstMessage: true,
                });
                assertEquals(runtime.getSessionSnapshot(id)?.managed, null);
                let repairs = 0;
                let canceled = false;
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
                        if (interruption === "cancel") {
                            queueMicrotask(() => {
                                canceled = runtime.cancelSession(id).aborted;
                            });
                            return fauxAssistantMessage(fauxText("Inspecting the missing guard.".repeat(100)));
                        }
                        if (interruption === "stop") {
                            return fauxAssistantMessage(fauxText("Inspecting the missing guard."));
                        }
                        const responseText = interruption === "disconnect_compaction"
                            ? "Inspecting the missing guard. ".repeat(18000)
                            : "Inspecting the missing guard.";
                        return fauxAssistantMessage(fauxText(responseText), {
                            stopReason: "error",
                            errorMessage: "Unexpected EOF",
                        });
                    },
                    ...interruption === "disconnect_compaction"
                        ? [() =>
                            fauxAssistantMessage(
                                fauxText("Missing guard. Repair interrupted by EOF; resume it."),
                            )]
                        : [],
                ]);
                const result = await runtime.runValidation(id, {
                    planName: name,
                    planContent: body,
                    triageMeta: { ...ready.attrs, revision: ready.revision },
                });
                assertEquals(repairs, 1, JSON.stringify(result));
                assertExists(result);
                assertEquals(result.kind, "paused");
                assertEquals(canceled, interruption === "cancel");
                const managed = runtime.getSessionSnapshot(id)?.managed;
                assertExists(managed);
                const segments = store.listSessionTranscriptSegments(managed.runwieldSessionId);
                assertEquals(segments.map((segment) => segment.kind), ["planning", "semantic_repair"]);
                const repairSegment = segments[1];
                const transcript = await Deno.readTextFile(repairSegment.transcriptPath);
                if (interruption.startsWith("disconnect")) assertStringIncludes(transcript, "Unexpected EOF");
                if (interruption === "disconnect_compaction") {
                    assertEquals(
                        transcript.split("\n").filter(Boolean).some((line) => JSON.parse(line).type === "compaction"),
                        true,
                    );
                }
                assertEquals(store.inspectSessionActivation(managed.runwieldSessionId).activation?.state, "idle");
                let replies = 0;
                setModelResponseFactories([(context) => {
                    replies++;
                    assertStringIncludes(JSON.stringify(context.messages), "continue");
                    assertStringIncludes(JSON.stringify(context.messages), "Missing guard");
                    return fauxAssistantMessage(fauxText("Continuing the interrupted repair."));
                }]);
                const followUp = await runtime.promptUserTurn(id, { initialRequest: "continue" });
                assertEquals(followUp.ok, true);
                assertEquals(replies, 1);
                assertEquals(runtime.getSessionSnapshot(id)?.cwd, await Deno.realPath(tree.path));
                assertExists(runtime.getSessionSnapshot(id)?.managed);
                await runtime.closeAllSessionsWhenIdle();
                const restarted = createSessionRuntime({ sessionStore: store });
                try {
                    const loaded = await restarted.loadSession({
                        cwd: root,
                        sessionId: segments[0].piSessionId,
                        sessionPath: segments[0].transcriptPath,
                    });
                    setModelResponseFactories([(context) => {
                        replies++;
                        assertStringIncludes(JSON.stringify(context.messages), "Continuing the interrupted repair.");
                        return fauxAssistantMessage(fauxText("Repair resumed after restart."));
                    }]);
                    assertEquals(
                        (await restarted.promptUserTurn(loaded.sessionId, { initialRequest: "continue" })).ok,
                        true,
                    );
                    assertEquals(restarted.getSessionSnapshot(loaded.sessionId)?.cwd, await Deno.realPath(tree.path));
                    assertEquals(replies, 2);
                } finally {
                    await restarted.closeAllSessionsWhenIdle();
                }
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
                await Deno.remove(worktreeRoot, { recursive: true });
                await Deno.remove(root, { recursive: true });
            }
        });
    });
}
