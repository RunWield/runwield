import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { getHomeDir } from "../../constants.js";
import { loadPlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { createGitPort } from "../../shared/git-port.ts";
import { resolveProjectRuntimeLayout } from "../../shared/project-runtime-layout.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { findById } from "../../shared/worktree-registry.js";
import { type ControllerRecord, readControllerRecord } from "../../shared/workflow/controller-registry.ts";
import { finalizePlanImplementation } from "../../shared/workflow/implementation-checkpoint.ts";
import { makeValidationCheckpoint } from "../../shared/workflow/validation-checkpoint.ts";
import { runLocalCI } from "../../shared/workflow/validation-local-ci.ts";
import { runWorkflowValidationToStableBoundary } from "../../shared/workflow/validation-supervisor.ts";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";

const planPath = "docs/plans/demo.md";
const seed = defineCommittedGitFixture({
    ".gitignore": ".wld/\n",
    "implementation.txt": "before\n",
    [planPath]:
        "---\nplanId: migration-demo\nclassification: PLANNED_CHANGE\nstatus: ready_for_work\ntargetBranch: main\n---\n# Demo\n",
});

const stages = [
    { name: "uncommitted implementation", status: "in_progress", ci: 1, review: 1 },
    { name: "implementation complete", status: "implemented", ci: 1, review: 1 },
    { name: "interrupted CI", status: "implemented", checkpoint: "running", ci: 1, review: 1 },
    { name: "interrupted CI repair", status: "implemented", checkpoint: "paused", ci: 2, review: 1 },
    { name: "awaiting Reviewer", status: "validated_ci", ci: 0, review: 1 },
    { name: "awaiting human review", status: "reviewed", ci: 0, review: 0 },
] as const;

for (
    const stage of stages.flatMap((stage) => [
        { ...stage, reappeared: false },
        { ...stage, reappeared: true },
    ])
) {
    Deno.test(`legacy migration continues ${stage.name}${stage.reappeared ? " after old writes return" : ""} using the saved execution tree`, async () => {
        await withRuntimeCommandFixture("migration-validation-", async () => {
            const sandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            const root = await Deno.realPath(await seed.checkout());
            const directory = await Deno.realPath(await Deno.makeTempDir({ prefix: "migration-validation-tree-" }));
            const tree = join(directory, "execution");
            const runtime = createSessionRuntime();
            const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: root });
            try {
                // Arrange the on-disk state produced by an older binary. No new-layout
                // storage APIs run until the user selects this Plan below.
                const baseCommit = await git(root, ["rev-parse", "HEAD"]);
                const baseTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
                await git(root, ["worktree", "add", "-b", "worktree/demo", tree]);
                const planText =
                    `---\nplanId: migration-demo\nclassification: PLANNED_CHANGE\nstatus: ${stage.status}\ntargetBranch: main\n---\n# Demo\n`;
                await Deno.writeTextFile(join(tree, planPath), planText);
                await Deno.writeTextFile(join(tree, "implementation.txt"), "implemented\n");
                if (stage.status !== "in_progress") {
                    await git(tree, ["add", "."]);
                    await git(tree, ["commit", "-m", "Implementation before upgrade"]);
                }
                await Deno.mkdir(join(tree, ".wld"), { recursive: true });
                await Deno.writeTextFile(
                    join(tree, ".wld", "settings.json"),
                    JSON.stringify({ verification_command: "git diff --check && test ! -f broken.txt" }),
                );
                const repair = stage.name === "interrupted CI repair";
                if (repair) await Deno.writeTextFile(join(tree, "broken.txt"), "unfinished repair\n");
                const controller: ControllerRecord = {
                    version: 1,
                    revision: 7,
                    planId: "migration-demo",
                    planName: "demo",
                    state: {
                        documentWorktreeId: "attempt-demo",
                        executionMode: "worktree",
                        executionReport: "Implementation from the previous binary",
                        humanReviewMode: "always",
                        humanReviewDecision: null,
                        validationCiAttempts: repair ? 1 : 0,
                        validationSemanticRounds: 0,
                        ...("checkpoint" in stage
                            ? {
                                validationCheckpoint: makeValidationCheckpoint({
                                    attemptId: "attempt-demo",
                                    generation: "before-upgrade",
                                    status: stage.status,
                                    phase: "mechanical",
                                    state: stage.checkpoint,
                                    ownerHostname: "previous-host",
                                    ownerPid: 1,
                                }),
                            }
                            : {}),
                    },
                };
                const legacy = join(root, ".wld");
                await Deno.mkdir(join(legacy, "controller", "plans"), { recursive: true });
                await Deno.writeTextFile(
                    join(legacy, "controller", "plans", "migration-demo.json"),
                    JSON.stringify(controller),
                );
                await Deno.writeTextFile(
                    join(legacy, "worktrees.json"),
                    JSON.stringify({
                        version: 2,
                        entries: [{
                            id: "attempt-demo",
                            planId: "migration-demo",
                            planName: "demo",
                            baseBranch: "main",
                            baseRef: "refs/heads/main",
                            baseCommit,
                            baseTree,
                            branch: "worktree/demo",
                            path: tree,
                            status: stage.status === "in_progress" ? "active" : "completed",
                            createdAt: "2026-09-01T00:00:00Z",
                            updatedAt: "2026-09-01T00:00:00Z",
                        }],
                    }),
                );
                await Deno.writeTextFile(join(root, "implementation.txt"), "unrelated primary edits\n");
                const executionHead = await git(tree, ["rev-parse", "HEAD"]);
                const messages: string[] = [];
                const sessionId = await runtime.createPromptReadySession({ cwd: root, agentName: "router" });

                if (stage.reappeared) {
                    // Arrange an upgraded project whose old binary flushes its
                    // saved controller again. The command must recover it itself.
                    await readControllerRecord(root, { planId: "migration-demo", planName: "demo" });
                    const oldDirectory = join(root, ".wld", "controller", "plans");
                    await Deno.mkdir(oldDirectory, { recursive: true });
                    await Deno.writeTextFile(join(oldDirectory, "migration-demo.json"), JSON.stringify(controller));
                    await Deno.writeTextFile(join(root, ".wld", "worktrees.json"), '{"version":2,"entries":[]}');
                    await Deno.mkdir(join(tree, ".wld", "plan-locks"), { recursive: true });
                }
                // Act: select and reload through the actual command, with no migration
                // helper or manually copied controller records in the execution phase.
                for (let i = 0; i < 2; i++) {
                    await runLoadPlanCommand([join(root, planPath)], {
                        sessionRuntime: runtime,
                        sessionId,
                        uiAPI: {
                            abortActivePrompt: () => {},
                            appendSystemMessage: (message) => messages.push(message),
                            appendAgentMessageStart: () => ({ appendText: () => {} }),
                            requestRender: () => {},
                            promptSelect: () => Promise.resolve("cancel"),
                            promptText: () => Promise.resolve(null),
                            showModelSelector: () => {},
                        },
                        editor: {
                            disableSubmit: true,
                            setText: () => {},
                            setAutocompleteProvider: () => {},
                            handleInput: () => {},
                        },
                    });
                }
                assertStringIncludes(
                    messages.join("\n"),
                    `Status: ${stage.status === "validated_ci" ? "implemented" : stage.status}`,
                );
                assertEquals(
                    await readControllerRecord(root, { planId: "migration-demo", planName: "demo" }),
                    controller,
                );
                assertEquals(await Deno.readTextFile(join(tree, planPath)), planText);
                assertEquals(await git(tree, ["rev-parse", "HEAD"]), executionHead);
                assertEquals(await Deno.readTextFile(join(tree, "implementation.txt")), "implemented\n");
                if (repair) assertEquals(await Deno.readTextFile(join(tree, "broken.txt")), "unfinished repair\n");

                // A fresh session has no cached workflow. Production resolves the
                // migrated execution identity and then drives the next real phases.
                if (stage.status === "in_progress") {
                    const entry = await findById(root, "attempt-demo");
                    assertExists(entry);
                    await finalizePlanImplementation({
                        projectRoot: root,
                        planName: "demo",
                        executionContext: {
                            projectRoot: root,
                            planName: "demo",
                            executionMode: "worktree",
                            executionCwd: entry.path,
                            baselineTree: entry.baseTree,
                            worktreeId: entry.id,
                            worktreeBranch: entry.branch,
                            worktreeBaseBranch: entry.baseBranch,
                            executionAgent: "engineer",
                            triageMeta: { classification: "PLANNED_CHANGE", status: "in_progress" },
                        },
                    });
                    assertEquals((await findById(root, "attempt-demo"))?.status, "completed");
                    assertEquals(await git(tree, ["status", "--porcelain"]), "");
                }
                let ciRuns = 0;
                let reviews = 0;
                let repairs = 0;
                let humanReviews = 0;
                hostedSession.setInteractionAdapter({
                    requestInteraction: (request) => {
                        assertEquals(request.type, "code_review");
                        humanReviews++;
                        return Promise.resolve({ outcome: "canceled" });
                    },
                });
                const result = await runWorkflowValidationToStableBoundary({
                    trigger: "session_resume",
                    hostedSession,
                    planName: "demo",
                    planContent: "# stale primary Plan",
                    triageMeta: { classification: "PLANNED_CHANGE", status: "ready_for_work" },
                    git: createGitPort(),
                    localCI: {
                        run: (options) => {
                            assertEquals(options.cwd, tree);
                            ciRuns++;
                            return runLocalCI(options);
                        },
                    },
                    semanticReviewPort: {
                        runIsolatedAgentSession: async (options) => {
                            assertEquals(options.cwd, tree);
                            if (options.customTools?.some((tool) => tool.name === "review_diff")) {
                                reviews++;
                                await executeWorkflowTestTools(options, [
                                    { name: "review_diff", arguments: { command: "list" } },
                                    ...["implementation.txt", planPath, ".gitignore"].map((path) => ({
                                        name: "review_diff",
                                        arguments: { command: "show", path },
                                    })),
                                    { name: "review_complete", arguments: { approved: true, findings: [] } },
                                ]);
                            } else {
                                assertEquals(repair, true);
                                repairs++;
                                // The scripted external Engineer edits code, then calls
                                // the real completion tool. It never writes workflow state.
                                await Deno.remove(join(tree, "broken.txt"));
                                await executeWorkflowTestTools(options, [{
                                    name: "task_completed",
                                    arguments: { message: "Removed unfinished repair marker." },
                                }]);
                            }
                            return [];
                        },
                    },
                    workRecordMnemotecaPort: {
                        run: () => Promise.reject(new Error("Must stop for human review before publication")),
                    },
                });
                const diagnostics = JSON.stringify(result) + "\n" +
                    await Deno.readTextFile(join(getHomeDir(), ".wld", "debug", "validation-errors.jsonl")).catch(() =>
                        ""
                    );
                assertEquals(result.kind, "paused", diagnostics);
                assertEquals(humanReviews, 1, diagnostics);
                assertEquals(ciRuns, stage.ci);
                assertEquals(reviews, stage.review);
                assertEquals(repairs, repair ? 1 : 0);
                assertEquals((await loadPlan(tree, "demo"))?.attrs.status, "reviewed");
                assertEquals(await git(root, ["rev-parse", "HEAD"]), baseCommit);
                assertEquals(await Deno.readTextFile(join(root, "implementation.txt")), "unrelated primary edits\n");
                assertEquals((await findById(root, "attempt-demo"))?.path, tree);
            } finally {
                runtime.closeAllSessions();
                hostedSession.dispose();
                if (sandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
                else Deno.env.set("WLD_TEST_SANDBOX_HOME", sandboxHome);
                await git(root, ["worktree", "remove", "--force", tree]).catch(() => {});
                await Deno.remove(root, { recursive: true });
                await Deno.remove(directory, { recursive: true });
            }
        });
    });
}

Deno.test("legacy writer returning after migration does not block current controller reads", async () => {
    await withRuntimeCommandFixture("migration-old-writer-", async () => {
        const sandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        Deno.env.delete("WLD_TEST_SANDBOX_HOME");
        const root = await seed.checkout();
        try {
            const directory = join(root, ".wld", "controller", "plans");
            const path = join(directory, "migration-demo.json");
            const identity = { planId: "migration-demo", planName: "demo" };
            const record: ControllerRecord = {
                version: 1,
                revision: 1,
                ...identity,
                state: { executionMode: "non_git_in_place", executionReport: "Unsaved completion receipt" },
            };
            const bytes = JSON.stringify(record);
            await Deno.mkdir(directory, { recursive: true });
            await Deno.writeTextFile(path, bytes);
            assertEquals(await readControllerRecord(root, identity), record);

            // Simulate an old binary flushing its still-current record after the
            // new binary has moved the original directory. No conflicting edit.
            await Deno.mkdir(directory, { recursive: true });
            await Deno.writeTextFile(path, bytes);
            assertEquals(await readControllerRecord(root, identity), record);
            assertEquals(await readControllerRecord(root, identity), record);
            assertEquals(
                await Deno.readTextFile(
                    join(resolveProjectRuntimeLayout(root).primary.controllerPlansDir, "migration-demo.json"),
                ),
                bytes,
            );
        } finally {
            if (sandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", sandboxHome);
            await Deno.remove(root, { recursive: true });
        }
    });
});
