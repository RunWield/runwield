import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { addEntry } from "../../shared/worktree-registry.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n" });
const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

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
    test(`CLI Load Plan defers restoration of a missing managed directory ${allow ? "with" : "without"} override`, async () => {
        await withRuntimeCommandFixture("missing-cli-directory-", async ({ homeDir }) => {
            const root = await fixture.checkout();
            const container = mkdtempSync(join(tmpdir(), "directory-warning-"));
            const path = join(container, "absent-parent/execution");
            try {
                await registerMissingExecution(root, path);
                const child = Bun.spawn({
                    cmd: [
                        process.execPath,
                        "--no-env-file",
                        "--no-install",
                        cli,
                        ...(allow ? ["--allow-system-directory"] : []),
                        "load-plan",
                        "missing",
                    ],
                    cwd: root,
                    env: { ...process.env, HOME: homeDir, WLD_TEST_SANDBOX_HOME: homeDir },
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [readiness, captured] = child.stdout.tee();
                const output = collectOutput(child, captured);
                const reader = readiness.getReader();
                let rendered = "";
                const timeout = setTimeout(() => child.kill("SIGTERM"), 20000);
                try {
                    while (!rendered.includes("Plan recovery")) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        rendered += new TextDecoder().decode(chunk.value);
                    }
                } finally {
                    clearTimeout(timeout);
                    void reader.cancel();
                    reader.releaseLock();
                }
                try {
                    child.kill("SIGTERM");
                } catch {
                    /* Startup may already have stopped without a terminal. */
                }
                const result = await output;
                const diagnostics = new TextDecoder().decode(result.stderr);
                assertStringIncludes(new TextDecoder().decode(result.stdout), "Plan recovery");
                assertEquals(diagnostics.includes("ENOENT"), false, diagnostics);
                assertEquals(diagnostics.includes("Fatal error"), false, diagnostics);
                assertEquals(await loadPlan(path, "missing"), null);
                assertEquals(await loadPlan(root, "missing"), null);
            } finally {
                await git(root, ["worktree", "remove", "--force", path]).catch(() => {});
                rmSync(container, { recursive: true });
                rmSync(root, { recursive: true });
            }
        });
    });
}

for (const continueWork of [false, true]) {
    test(`${continueWork ? "continuing" : "canceling"} UI Load Plan recovery ${continueWork ? "restores" : "does not restore"} the missing managed directory`, async () => {
        await withRuntimeCommandFixture("missing-ui-directory-", async ({ setModelResponseFactory }) => {
            setModelResponseFactory(() => {
                throw new Error("Stop at external Agent boundary");
            });
            const root = await fixture.checkout();
            const container = mkdtempSync(join(tmpdir(), "directory-warning-"));
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
                            return Promise.resolve(continueWork ? "follow_up" : null);
                        },
                        promptText: () => Promise.resolve(null),
                        showModelSelector: () => {},
                    },
                });
                if (continueWork) {
                    assertEquals(
                        (await loadPlan(path, "missing"))?.attrs.planId,
                        "missing-directory-plan",
                        messages.join("\n"),
                    );
                    assertEquals(await git(path, ["branch", "--show-current"]), "worktree/missing");
                } else {
                    assertEquals(await loadPlan(path, "missing"), null, messages.join("\n"));
                }
                assertEquals(messages.join("\n").includes("is back on branch"), false);
                assert(
                    prompts.some((prompt) => prompt.includes("Plan recovery")),
                    prompts.join("\n"),
                );
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                await git(root, ["worktree", "remove", "--force", path]).catch(() => {});
                rmSync(container, { recursive: true });
                rmSync(root, { recursive: true });
            }
        });
    });
}

test("CLI Load Plan gates an external absolute Plan in home before onboarding", async () => {
    await withRuntimeCommandFixture("external-plan-directory-", async ({ homeDir, projectRoot }) => {
        const path = join(homeDir, "external.md");
        const text = "---\nstatus: approved\n---\n# External\n";
        writeText(path, text);
        const result = await collectOutput(
            Bun.spawn({
                cmd: [process.execPath, "--no-env-file", "--no-install", cli, "load-plan", path],
                cwd: projectRoot,
                env: { ...process.env, HOME: homeDir, WLD_TEST_SANDBOX_HOME: homeDir },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            }),
        );
        assertEquals(result.code, 1);
        assertStringIncludes(new TextDecoder().decode(result.stderr), "--allow-system-directory");
        assertEquals(readText(path), text);
        assertEquals(await loadPlan(projectRoot, "external"), null);
    });
});

async function collectOutput(
    child: Bun.Subprocess<"pipe" | "ignore" | "inherit", "pipe", "pipe">,
    outputStream = child.stdout,
) {
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(outputStream).bytes(),
        new Response(child.stderr).bytes(),
    ]);
    return { code, stdout, stderr };
}

function readText(path: string): string {
    return readFileSync(path, "utf8");
}
function writeText(path: string, text: string): void {
    writeFileSync(path, text);
}
