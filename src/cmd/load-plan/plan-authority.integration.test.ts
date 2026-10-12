import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { runLoadPlanCommand } from "./index.ts";
import { loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { addEntry, findById } from "../../shared/worktree-registry.js";
import { git } from "../../shared/git-test-fixture.ts";
import { resolveValidationExecutionContext } from "../../shared/workflow/execution-context.ts";
import type { UiAPI } from "../../ui/tui/types.js";

for (const action of ["hold", "review", "validate"]) {
    test(`load-plan ${action} acts on the execution Plan and leaves primary bytes unchanged`, async () => {
        await withRuntimeCommandFixture("rw-authority-load-", async ({ projectRoot, alternateRoot }) => {
            await git(projectRoot, ["init", "-b", "main"]);
            await git(projectRoot, ["config", "user.name", "Authority Fixture"]);
            await git(projectRoot, ["config", "user.email", "authority@example.test"]);
            await fsWriteFile(join(projectRoot, ".gitignore"), ".wld/\n");
            await fsWriteFile(join(projectRoot, "app.ts"), "export const ready = false;\n");
            await savePlan(projectRoot, "demo", "# Demo\n\n## Context\n\nDemo.", {
                planId: "authority-plan",
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                targetBranch: "main",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            await git(projectRoot, ["add", "."]);
            await git(projectRoot, ["commit", "-m", "approved plan"]);
            const baseCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
            const baseTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
            await git(projectRoot, ["worktree", "add", "-b", "worktree/demo", alternateRoot]);
            await addEntry(projectRoot, {
                id: "authority-attempt",
                planId: "authority-plan",
                planName: "demo",
                path: alternateRoot,
                branch: "worktree/demo",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit,
                baseTree,
                executionBaselineTree: baseTree,
                status: action === "validate" ? "completed" : "active",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            const before = await loadPlan(alternateRoot, "demo");
            assert(before);
            await updatePlanFrontMatter(
                alternateRoot,
                "demo",
                {
                    status: action === "validate" ? "implemented" : "in_progress",
                },
                {},
                { expectedRevision: before.revision },
            );
            const primaryPath = join(projectRoot, "docs/plans/demo.md");
            if (action === "validate") {
                await fsWriteFile(primaryPath, '---\nstatus: "unfinished edit\n---\n# Demo\n');
                await fsWriteFile(join(alternateRoot, "app.ts"), "export const ready = true;\n");
                const context = await resolveValidationExecutionContext({ projectRoot, planName: "demo" });
                assertEquals(context.kind, "ok");
                if (context.kind === "ok") assertEquals(context.context.executionCwd, alternateRoot);
            }
            const primaryBytes = await fsReadFile(primaryPath, "utf8");
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
            const messages: string[] = [];
            const choices: string[] = [action];
            const uiAPI: UiAPI = {
                appendSystemMessage: (message) => messages.push(message),
                promptSelect: (_title, options) => {
                    const choice = choices.shift() || null;
                    if (choice) assert(options.some((option) => option.value === choice));
                    return Promise.resolve(choice);
                },
                promptText: () => Promise.resolve(""),
                abortActivePrompt: () => {},
                requestRender: () => {},
                showModelSelector: () => {},
                appendAgentMessageStart: () => ({ appendText: () => {} }),
            };
            try {
                await runLoadPlanCommand(["demo"], { sessionRuntime: runtime, sessionId, uiAPI });
                assertEquals(choices.length, 0, "must reach the selected recovery action");
                assert(!messages.some((message) => message.includes("could not check for safe fixes")));
                if (action !== "validate") {
                    assertEquals(
                        (await loadPlan(alternateRoot, "demo"))?.attrs.status,
                        action === "hold" ? "on_hold" : "feedback",
                    );
                    assertEquals(
                        (await findById(projectRoot, "authority-attempt"))?.status,
                        "active",
                    );
                }
                assertEquals(await fsReadFile(primaryPath, "utf8"), primaryBytes);
            } finally {
                runtime.closeAllSessions();
            }
        });
    });
}
