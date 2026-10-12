import { runLoadPlanCommand } from "../load-plan/index.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { addEntry } from "../../shared/worktree-registry.js";

const config = fromFileUrl(new URL("../../../deno.json", import.meta.url));
const cli = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const fixture = defineCommittedGitFixture();

for (const command of ["load-plan", "plans"]) {
    for (const allow of [false, true]) {
        Deno.test(`${command} ${allow ? "override does not authorize" : "refuses"} a registered home document before retired-status repair`, async () => {
            await withRuntimeCommandFixture("selected-plan-directory-", async ({ homeDir: home }) => {
                const project = await fixture.checkout();
                try {
                    Deno.mkdirSync(join(home, "docs/plans"), { recursive: true });
                    const path = join(home, "docs/plans/selected.md");
                    const text = "---\nplanId: selected-id\nstatus: ready_for_review\n---\n# Selected\n";
                    Deno.writeTextFileSync(path, text);
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
                    const output = await new Deno.Command(Deno.execPath(), {
                        args: [
                            "run",
                            "-A",
                            "--config",
                            config,
                            cli,
                            ...(allow ? ["--allow-system-directory"] : []),
                            ...(command === "load-plan"
                                ? ["load-plan", "selected"]
                                : ["plans", "archive", "selected", "--force"]),
                        ],
                        cwd: project,
                        env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
                        stdin: "null",
                        stdout: "piped",
                        stderr: "piped",
                    }).output();
                    assertEquals(output.code, 1);
                    assertStringIncludes(decode(output.stderr), "--allow-system-directory");
                    assertEquals(Deno.readTextFileSync(path), text);
                    assertEquals([...Deno.readDirSync(home)].some((entry) => entry.name === "docs"), true);
                } finally {
                    Deno.removeSync(project, { recursive: true });
                }
            });
        });
    }
}

Deno.test("direct chat startup checks the primary checkout before runtime writers", async () => {
    const home = await fixture.checkout();
    const trees = Deno.makeTempDirSync();
    const tree = join(trees, "linked");
    try {
        await git(home, ["worktree", "add", "-b", "direct-chat-folder-warning", tree]);
        const script = join(trees, "startup.ts");
        Deno.writeTextFileSync(
            script,
            `import { startInteractiveSession } from ${
                JSON.stringify(moduleUrl("../../ui/tui/chat-session.ts"))
            };\nawait startInteractiveSession(null, {});`,
        );
        Deno.writeTextFileSync(join(home, ".gitignore"), "# unchanged\n");
        const before = Deno.readTextFileSync(join(home, ".gitignore"));
        const output = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--config", config, script],
            cwd: tree,
            env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(output.code, 1);
        assertStringIncludes(decode(output.stderr), "--allow-system-directory");
        assertEquals(Deno.readTextFileSync(join(home, ".gitignore")), before);
        assertEquals([...Deno.readDirSync(home)].some((entry) => entry.name === ".wld"), false);
    } finally {
        Deno.removeSync(trees, { recursive: true });
        Deno.removeSync(home, { recursive: true });
    }
});

Deno.test("real stdin closure cancels the directory selector and restores terminal resources", async () => {
    const home = Deno.makeTempDirSync();
    const scripts = Deno.makeTempDirSync();
    try {
        const script = join(scripts, "closure.ts");
        Deno.writeTextFileSync(
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
        const child = new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--config", config, script],
            cwd: home,
            env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn();
        const reader = child.stdout.getReader();
        const first = await reader.read();
        assertStringIncludes(decode(first.value!), "READY");
        reader.releaseLock();
        await child.stdin.close();
        const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
        try {
            const output = await child.output();
            assertEquals(output.code, 0, decode(output.stderr));
            assertStringIncludes(decode(output.stdout), "CANCELED");
        } finally {
            clearTimeout(timeout);
        }
    } finally {
        Deno.removeSync(home, { recursive: true });
        Deno.removeSync(scripts, { recursive: true });
    }
});

Deno.test("ACP Load Plan at a registered home root keeps protocol behavior without a terminal gate", async () => {
    await withRuntimeCommandFixture("acp-selected-directory-", async ({ homeDir, projectRoot }) => {
        const runtime = createSessionRuntime();
        const messages: string[] = [];
        try {
            Deno.mkdirSync(join(homeDir, "docs/plans"), { recursive: true });
            Deno.writeTextFileSync(
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

Deno.test("explicit acknowledgement covers only its inspected root and canonical aliases", async () => {
    const home = Deno.makeTempDirSync();
    const scripts = Deno.makeTempDirSync();
    try {
        const alias = join(scripts, "home-alias");
        Deno.symlinkSync(home, alias);
        const script = join(scripts, "bound-consent.ts");
        Deno.writeTextFileSync(
            script,
            `
import { confirmProjectDirectory } from ${JSON.stringify(moduleUrl("../../ui/tui/directory-warning.ts"))};
if (!await confirmProjectDirectory(${JSON.stringify(home)}, true)) throw new Error("Acknowledgement failed");
if (!await confirmProjectDirectory(${JSON.stringify(alias)})) throw new Error("Alias asked twice");
try {
    await confirmProjectDirectory(${JSON.stringify(Deno.build.os === "windows" ? "C:\\" : "/")});
    throw new Error("Different root was authorized");
} catch (error) {
    if (!error.message.includes("--allow-system-directory")) throw error;
}
`,
        );
        const output = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--config", config, script],
            cwd: home,
            env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(output.code, 0, decode(output.stderr));
    } finally {
        Deno.removeSync(scripts, { recursive: true });
        Deno.removeSync(home, { recursive: true });
    }
});

for (const allow of [false, true]) {
    Deno.test(`plans doctor refuses a registered home root before repair${allow ? " even with cwd acknowledgement" : ""}`, async () => {
        await withRuntimeCommandFixture("doctor-selected-directory-", async ({ homeDir: home }) => {
            const project = await fixture.checkout();
            try {
                Deno.mkdirSync(join(home, "docs/plans"), { recursive: true });
                const path = join(home, "docs/plans/selected.md");
                const text = "---\nstatus: draft\n---\n# Selected\n";
                Deno.writeTextFileSync(path, text);
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
                const output = await new Deno.Command(Deno.execPath(), {
                    args: [
                        "run",
                        "-A",
                        "--config",
                        config,
                        cli,
                        ...(allow ? ["--allow-system-directory"] : []),
                        "plans",
                        "doctor",
                    ],
                    cwd: project,
                    env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
                    stdin: "null",
                    stdout: "piped",
                    stderr: "piped",
                }).output();
                assertEquals(output.code, 1);
                assertStringIncludes(decode(output.stderr), "--allow-system-directory");
                assertEquals(Deno.readTextFileSync(path), text);
                assertEquals([...Deno.readDirSync(home)].some((entry) => entry.name === ".gitignore"), false);
            } finally {
                Deno.removeSync(project, { recursive: true });
            }
        });
    });
}
