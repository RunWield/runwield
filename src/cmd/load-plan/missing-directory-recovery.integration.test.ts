import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { addEntry } from "../../shared/worktree-registry.js";
import { ProjectRuntimeEntryRefusedError } from "../../shared/project-runtime-layout.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n" });
const config = fromFileUrl(new URL("../../../deno.json", import.meta.url));
const cli = fromFileUrl(new URL("../../cli.ts", import.meta.url));

async function registerMissingExecution(root: string, path: string): Promise<void> {
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const baseTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
    await git(root, ["switch", "-c", "worktree/missing"]);
    await savePlan(root, "missing", "# Missing execution\n", {
        planId: "missing-directory-plan",
        classification: "PLANNED_CHANGE",
        status: "implemented",
        targetBranch: "main",
    });
    await git(root, ["add", "docs"]);
    await git(root, ["commit", "-m", "save execution Plan"]);
    await git(root, ["switch", "main"]);
    await addEntry(root, {
        id: "missing-directory-attempt",
        planId: "missing-directory-plan",
        planName: "missing",
        path,
        branch: "worktree/missing",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit,
        baseTree,
        executionBaselineTree: baseTree,
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
}

for (const allow of [false, true]) {
    Deno.test(`CLI Load Plan restores a missing managed directory ${allow ? "with" : "without"} override`, async () => {
        await withRuntimeCommandFixture("missing-cli-directory-", async ({ homeDir }) => {
            const root = await fixture.checkout();
            const container = Deno.makeTempDirSync();
            const path = join(container, "absent-parent/execution");
            try {
                await registerMissingExecution(root, path);
                const child = new Deno.Command(Deno.execPath(), {
                    args: [
                        "run",
                        "-A",
                        "--config",
                        config,
                        cli,
                        ...(allow ? ["--allow-system-directory"] : []),
                        "load-plan",
                        "missing",
                    ],
                    cwd: root,
                    env: { HOME: homeDir, WLD_TEST_SANDBOX_HOME: homeDir },
                    stdin: "null",
                    stdout: "piped",
                    stderr: "piped",
                }).spawn();
                let ended = false;
                const output = child.output().then((result) => {
                    ended = true;
                    return result;
                });
                const deadline = Date.now() + 20000;
                while (!ended && Date.now() < deadline) {
                    try {
                        if ((await loadPlan(path, "missing"))?.attrs.planId === "missing-directory-plan") break;
                    } catch (error) {
                        if (
                            !(error instanceof Deno.errors.NotFound) &&
                            !(error instanceof ProjectRuntimeEntryRefusedError)
                        ) throw error;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                try {
                    child.kill("SIGTERM");
                } catch { /* Startup may already have stopped without a terminal. */ }
                const result = await output;
                assertEquals(
                    (await loadPlan(path, "missing"))?.attrs.planId,
                    "missing-directory-plan",
                    new TextDecoder().decode(result.stderr),
                );
                assertEquals(await git(path, ["branch", "--show-current"]), "worktree/missing");
                assertEquals(await loadPlan(root, "missing"), null);
            } finally {
                await git(root, ["worktree", "remove", "--force", path]).catch(() => {});
                Deno.removeSync(container, { recursive: true });
                Deno.removeSync(root, { recursive: true });
            }
        });
    });
}

Deno.test("UI Load Plan restores a missing managed directory before offering recovery", async () => {
    await withRuntimeCommandFixture("missing-ui-directory-", async ({ setModelResponseFactory }) => {
        setModelResponseFactory(() => {
            throw new Error("Canceled recovery must not run an Agent turn");
        });
        const root = await fixture.checkout();
        const container = Deno.makeTempDirSync();
        const path = join(container, "absent-parent/execution");
        const runtime = createSessionRuntime();
        const messages: string[] = [];
        const prompts: string[] = [];
        try {
            await registerMissingExecution(root, path);
            const sessionId = await runtime.createPromptReadySession({ cwd: root, agentName: "router" });
            await runLoadPlanCommand(["missing"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: {
                    abortActivePrompt: () => {},
                    appendSystemMessage: (message) => messages.push(message),
                    appendAgentMessageStart: () => ({ appendText: () => {} }),
                    requestRender: () => {},
                    promptSelect: (prompt) => {
                        prompts.push(prompt);
                        return Promise.resolve(null);
                    },
                    promptText: () => Promise.resolve(null),
                    showModelSelector: () => {},
                },
            });
            assertEquals(
                (await loadPlan(path, "missing"))?.attrs.planId,
                "missing-directory-plan",
                messages.join("\n"),
            );
            assertStringIncludes(messages.join("\n"), "is back on branch");
            assert(prompts.some((prompt) => prompt.includes("Plan recovery")), prompts.join("\n"));
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            await git(root, ["worktree", "remove", "--force", path]).catch(() => {});
            Deno.removeSync(container, { recursive: true });
            Deno.removeSync(root, { recursive: true });
        }
    });
});

Deno.test("CLI Load Plan gates an external absolute Plan in home before onboarding", async () => {
    await withRuntimeCommandFixture("external-plan-directory-", async ({ homeDir, projectRoot }) => {
        const path = join(homeDir, "external.md");
        const text = "---\nstatus: approved\n---\n# External\n";
        Deno.writeTextFileSync(path, text);
        const result = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--config", config, cli, "load-plan", path],
            cwd: projectRoot,
            env: { HOME: homeDir, WLD_TEST_SANDBOX_HOME: homeDir },
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(result.code, 1);
        assertStringIncludes(new TextDecoder().decode(result.stderr), "--allow-system-directory");
        assertEquals(Deno.readTextFileSync(path), text);
        assertEquals(await loadPlan(projectRoot, "external"), null);
    });
});
