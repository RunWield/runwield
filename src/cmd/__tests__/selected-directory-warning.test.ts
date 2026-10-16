import { mkdtempSync, readdirSync, rmSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runLoadPlanCommand } from "../load-plan/index.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { addEntry } from "../../shared/worktree-registry.js";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));
const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const fixture = defineCommittedGitFixture();

for (const command of ["load-plan", "plans"]) {
    for (const allow of [false, true]) {
        test(`${command} ${allow ? "override does not authorize" : "refuses"} a registered home document before retired-status repair`, async () => {
            await withRuntimeCommandFixture("selected-plan-directory-", async ({ homeDir: home }) => {
                const project = await fixture.checkout();
                try {
                    mkdirSync(join(home, "docs/plans"), { recursive: true });
                    const path = join(home, "docs/plans/selected.md");
                    const text = "---\nplanId: selected-id\nstatus: ready_for_review\n---\n# Selected\n";
                    writeText(path, text);
                    await addEntry(project, {
                        id: "selected-tree",
                        planId: "selected-id",
                        planName: "selected",
                        path: home,
                        branch: "selected",
                        baseBranch: "main",
                        baseRef: "main",
                        baseCommit: await git(project, ["rev-parse", "HEAD"]),
                        status: "planning",
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                    const output = await collectOutput(
                        Bun.spawn({
                            cmd: [
                                process.execPath,
                                "--no-env-file",
                                "--no-install",
                                cli,
                                ...(allow ? ["--allow-system-directory"] : []),
                                ...(command === "load-plan"
                                    ? ["load-plan", "selected"]
                                    : ["plans", "archive", "selected", "--force"]),
                            ],
                            cwd: project,
                            env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                            stdin: "ignore",
                            stdout: "pipe",
                            stderr: "pipe",
                        }),
                    );
                    assertEquals(output.code, 1);
                    assertStringIncludes(decode(output.stderr), "--allow-system-directory");
                    assertEquals(readText(path), text);
                    assertEquals(
                        [...readdirSync(home, { withFileTypes: true })].some((entry) => entry.name === "docs"),
                        true,
                    );
                } finally {
                    rmSync(project, { recursive: true });
                }
            });
        });
    }
}

test("direct chat startup checks the primary checkout before runtime writers", async () => {
    const home = await fixture.checkout();
    const trees = mkdtempSync(join(tmpdir(), "directory-warning-"));
    const tree = join(trees, "linked");
    try {
        await git(home, ["worktree", "add", "-b", "direct-chat-folder-warning", tree]);
        const script = join(trees, "startup.ts");
        writeText(
            script,
            `import { startInteractiveSession } from ${JSON.stringify(
                moduleUrl("../../ui/tui/chat-session.ts"),
            )};\nawait startInteractiveSession(null, {});`,
        );
        writeText(join(home, ".gitignore"), "# unchanged\n");
        const before = readText(join(home, ".gitignore"));
        const output = await collectOutput(
            Bun.spawn({
                cmd: [process.execPath, "--no-env-file", "--no-install", script],
                cwd: tree,
                env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            }),
        );
        assertEquals(output.code, 1);
        assertStringIncludes(decode(output.stderr), "--allow-system-directory");
        assertEquals(readText(join(home, ".gitignore")), before);
        assertEquals(
            [...readdirSync(home, { withFileTypes: true })].some((entry) => entry.name === ".wld"),
            false,
        );
    } finally {
        rmSync(trees, { recursive: true });
        rmSync(home, { recursive: true });
    }
});

test("real stdin closure cancels the directory selector and restores terminal resources", async () => {
    const home = mkdtempSync(join(tmpdir(), "directory-warning-"));
    const scripts = mkdtempSync(join(tmpdir(), "directory-warning-"));
    try {
        const script = join(scripts, "closure.ts");
        writeText(
            script,
            `
import process from "node:process";
import { confirmProjectDirectory } from ${JSON.stringify(moduleUrl("../../ui/tui/directory-warning.ts"))};
import { initTUIWithPair, RunWieldTui, stopTUI } from ${JSON.stringify(moduleUrl("../../ui/tui/tui.ts"))};
import { VirtualTerminal } from ${JSON.stringify(moduleUrl("../../ui/tui/testing/virtual-terminal.js"))};
const terminal = new VirtualTerminal();
const tui = new RunWieldTui(terminal);
initTUIWithPair({ terminal, tui });
process.stdin.resume();
const ended = process.stdin.listenerCount("end");
const closed = process.stdin.listenerCount("close");
console.log("READY");
const continued = await confirmProjectDirectory();
if (continued) throw new Error("EOF continued startup");
if (process.stdin.listenerCount("end") !== ended || process.stdin.listenerCount("close") !== closed) throw new Error("Input listeners leaked");
stopTUI();
if (!terminal.stopped) throw new Error("Terminal was not restored");
console.log("CANCELED");
`,
        );
        const child = Bun.spawn({
            cmd: [process.execPath, "--no-env-file", "--no-install", script],
            cwd: home,
            env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        const [readyStream, outputStream] = child.stdout.tee();
        const reader = readyStream.getReader();
        const first = await reader.read();
        assertStringIncludes(decode(first.value!), "READY");
        void reader.cancel();
        reader.releaseLock();
        child.stdin.end();
        const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
        try {
            const output = await collectOutput(child, outputStream);
            assertEquals(output.code, 0, decode(output.stderr));
            assertStringIncludes(decode(output.stdout), "CANCELED");
        } finally {
            clearTimeout(timeout);
        }
    } finally {
        rmSync(home, { recursive: true });
        rmSync(scripts, { recursive: true });
    }
});

test("ACP Load Plan at a registered home root keeps protocol behavior without a terminal gate", async () => {
    await withRuntimeCommandFixture("acp-selected-directory-", async ({ homeDir, projectRoot }) => {
        const runtime = createSessionRuntime();
        const messages: string[] = [];
        try {
            mkdirSync(join(homeDir, "docs/plans"), { recursive: true });
            writeText(
                join(homeDir, "docs/plans/acp.md"),
                "---\nplanId: acp-plan\nstatus: invalid-status\n---\n# ACP\n",
            );
            await addEntry(projectRoot, {
                id: "acp-tree",
                planId: "acp-plan",
                planName: "acp",
                path: homeDir,
                branch: "acp",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: "fixture",
                status: "planning",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
            await runLoadPlanCommand(["acp"], {
                slashSurface: "acp",
                sessionRuntime: runtime,
                sessionId,
                uiAPI: {
                    abortActivePrompt: () => {},
                    appendSystemMessage: (message) => messages.push(message),
                    appendAgentMessageStart: () => ({ appendText: () => {} }),
                    requestRender: () => {},
                    promptSelect: () => Promise.resolve(null),
                    promptText: () => Promise.resolve(null),
                    showModelSelector: () => {},
                },
            });
            assertStringIncludes(messages.join("\n"), "Plan has unknown status: invalid-status");
            assertEquals(messages.join("\n").includes("System or home folder"), false);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("explicit acknowledgement covers only its inspected root and canonical aliases", async () => {
    const home = mkdtempSync(join(tmpdir(), "directory-warning-"));
    const scripts = mkdtempSync(join(tmpdir(), "directory-warning-"));
    try {
        const alias = join(scripts, "home-alias");
        symlinkSync(home, alias);
        const script = join(scripts, "bound-consent.ts");
        writeText(
            script,
            `
import { confirmProjectDirectory } from ${JSON.stringify(moduleUrl("../../ui/tui/directory-warning.ts"))};
if (!await confirmProjectDirectory(${JSON.stringify(home)}, true)) throw new Error("Acknowledgement failed");
if (!await confirmProjectDirectory(${JSON.stringify(alias)})) throw new Error("Alias asked twice");
try {
    await confirmProjectDirectory(${JSON.stringify(process.platform === "win32" ? "C:\\" : "/")});
    throw new Error("Different root was authorized");
} catch (error) {
    if (!error.message.includes("--allow-system-directory")) throw error;
}
`,
        );
        const output = await collectOutput(
            Bun.spawn({
                cmd: [process.execPath, "--no-env-file", "--no-install", script],
                cwd: home,
                env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            }),
        );
        assertEquals(output.code, 0, decode(output.stderr));
    } finally {
        rmSync(scripts, { recursive: true });
        rmSync(home, { recursive: true });
    }
});

for (const allow of [false, true]) {
    test(`plans doctor refuses a registered home root before repair${allow ? " even with cwd acknowledgement" : ""}`, async () => {
        await withRuntimeCommandFixture("doctor-selected-directory-", async ({ homeDir: home }) => {
            const project = await fixture.checkout();
            try {
                mkdirSync(join(home, "docs/plans"), { recursive: true });
                const path = join(home, "docs/plans/selected.md");
                const text = "---\nstatus: draft\n---\n# Selected\n";
                writeText(path, text);
                await addEntry(project, {
                    id: "doctor-home-tree",
                    planId: "doctor-home-plan",
                    planName: "selected",
                    path: home,
                    branch: "selected",
                    baseBranch: "main",
                    baseRef: "main",
                    baseCommit: await git(project, ["rev-parse", "HEAD"]),
                    status: "planning",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
                const output = await collectOutput(
                    Bun.spawn({
                        cmd: [
                            process.execPath,
                            "--no-env-file",
                            "--no-install",
                            cli,
                            ...(allow ? ["--allow-system-directory"] : []),
                            "plans",
                            "doctor",
                        ],
                        cwd: project,
                        env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                        stdin: "ignore",
                        stdout: "pipe",
                        stderr: "pipe",
                    }),
                );
                assertEquals(output.code, 1);
                assertStringIncludes(decode(output.stderr), "--allow-system-directory");
                assertEquals(readText(path), text);
                assertEquals(
                    [...readdirSync(home, { withFileTypes: true })].some((entry) => entry.name === ".gitignore"),
                    false,
                );
            } finally {
                rmSync(project, { recursive: true });
            }
        });
    });
}

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
