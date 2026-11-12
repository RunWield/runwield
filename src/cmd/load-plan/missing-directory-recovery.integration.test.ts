import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";
import { continueMissingPlanExecution } from "../../plan-store/index.ts";
import { readPlanPackage } from "../../plan-store/packages.ts";
import { inspectProjectIdentity } from "../../shared/project-identity.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";
import { withRetainedPlanFixture, importCanonicalPlanFixture } from "../../shared/testing/retained-plan-fixture.ts";
import { mkdirSync, realpathSync, mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan } from "../../plan-store/index.ts";

import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { addEntry, getWorktreeRegistryPath } from "../../shared/worktree-registry.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n" });
const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

async function registerMissingExecution(root: string, path: string, importCanonical = false): Promise<void> {
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const baseTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
    await git(root, ["switch", "-c", "worktree/missing"]);
    await seedPlan(root, "missing", "# Missing execution\n", {
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
    if (importCanonical) {
        await git(root, ["worktree", "add", path, "worktree/missing"]);
        await enterProjectRuntime(path);
        mkdirSync(join(root, "docs/plans"), { recursive: true });
        const source = join(root, "docs/plans/missing.md");
        writeFileSync(source, readFileSync(join(path, "docs/plans/missing.md")));
        const owner = inspectProjectIdentity(root);
        assert(owner.kind === "existing");
        const imported = await importCanonicalPlanFixture(root, realpathSync(source));
        assert(!("message" in imported), JSON.stringify(imported));
        rmSync(source);
        await git(root, ["worktree", "remove", "--force", path]);
    }
}

for (const allow of [false, true]) {
    test(`CLI Load Plan defers restoration of a missing managed directory ${allow ? "with" : "without"} override`, async () => {
        await withRuntimeCommandFixture("missing-cli-directory-", async ({ homeDir }) => {
            const root = await fixture.checkout();
            return await withRetainedPlanFixture(root, async () => {
                const container = realpathSync(mkdtempSync(join(tmpdir(), "directory-warning-")));
                const path = join(container, "absent-parent/execution");
                try {
                    await registerMissingExecution(root, path, true);
                    const identity = inspectProjectIdentity(root);
                    assert(identity.kind === "existing");
                    const beforePackage = await readPlanPackage(identity.identity, { name: "missing" });
                    const beforeRegistry = readText(getWorktreeRegistryPath(root));
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
                    assertStringIncludes(new TextDecoder().decode(result.stdout), "Plan recovery", diagnostics);
                    assertEquals(diagnostics.includes("ENOENT"), false, diagnostics);
                    assertEquals(diagnostics.includes("Fatal error"), false, diagnostics);
                    assertEquals(existsSync(path), false);
                    assertEquals(await readPlanPackage(identity.identity, { name: "missing" }), beforePackage);
                    assertEquals(readText(getWorktreeRegistryPath(root)), beforeRegistry);
                    assertEquals(await loadPlan(root, "missing"), null);
                } finally {
                    await git(root, ["worktree", "remove", "--force", path]).catch(() => {});
                    rmSync(container, { recursive: true });
                    rmSync(root, { recursive: true });
                }
            });
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
            return await withRetainedPlanFixture(root, async () => {
                const container = realpathSync(mkdtempSync(join(tmpdir(), "directory-warning-")));
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
                        assertEquals(existsSync(path), false, messages.join("\n"));
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
    });
}

test("CLI Load Plan gates an external absolute Plan in home before onboarding", async () => {
    await withRuntimeCommandFixture("external-plan-directory-", async ({ homeDir, projectRoot }) => {
        const path = join(homeDir, "external.md");
        const text = "---\nstatus: approved\n---\n# External\n";
        writeText(path, text);
        const result = await collectOutput(
            Bun.spawn({
                cmd: [
                    process.execPath,
                    "--no-env-file",
                    "--no-install",
                    fileURLToPath(new URL("../../cli.ts", import.meta.url)),
                    "load-plan",
                    path,
                ],
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

test("missing imported recovery rejects every changed attempt owner without writes", async () => {
    await withRuntimeCommandFixture("missing-owner-guard-", async () => {
        const root = await fixture.checkout();
        const container = realpathSync(mkdtempSync(join(tmpdir(), "missing-owner-guard-")));
        const path = join(container, "execution");
        try {
            await withRetainedPlanFixture(root, () => registerMissingExecution(root, path, true));
            const owner = inspectProjectIdentity(root);
            assert(owner.kind === "existing");
            const selected = await readPlanPackage(owner.identity, { name: "missing" });
            assert(selected.kind === "loaded");
            const originalRegistry = JSON.parse(readText(getWorktreeRegistryPath(root)));
            const original = originalRegistry.entries[0];
            for (const change of [
                { planId: "another-plan" },
                { path: join(container, "another") },
                { branch: "another-branch" },
                { baseBranch: "another-target" },
                { baseCommit: "0".repeat(40) },
            ]) {
                writeText(
                    getWorktreeRegistryPath(root),
                    JSON.stringify({ ...originalRegistry, entries: [{ ...original, ...change }] }),
                );
                const beforeRegistry = readText(getWorktreeRegistryPath(root));
                let ran = false;
                await assertRejects(
                    () =>
                        continueMissingPlanExecution(root, "missing", () => {
                            ran = true;
                            return Promise.resolve();
                        }),
                    Error,
                    "Imported execution owner changed",
                );
                assertEquals(ran, false);
                assertEquals(existsSync(path), false);
                assertEquals(readText(getWorktreeRegistryPath(root)), beforeRegistry);
                assertEquals(await readPlanPackage(owner.identity, { name: "missing" }), selected);
            }
        } finally {
            rmSync(root, { recursive: true });
            rmSync(container, { recursive: true });
        }
    });
});
