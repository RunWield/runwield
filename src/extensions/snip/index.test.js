import process from "node:process";
import { bashFixtureExecutable } from "../../../scripts/bash-fixture.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { getCwd } from "../../constants.js";
import { readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import snipExtension, { __testing } from "./index.js";

/** @param {string} command @param {string | null} [failureLabel] */
function expectedRewrite(command, failureLabel = null) {
    return __testing.withFilteredSnipStderr(command, failureLabel);
}

function setup() {
    /** @type {Map<string, (event: any, ctx: any) => any>} */
    const handlers = new Map();

    const pi = /** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({
        on(event, handler) {
            handlers.set(event, handler);
        },
    });

    snipExtension(pi);

    /** @param {string} event */
    const getHandler = (event) => handlers.get(event);
    return { getHandler };
}

test("snip extension rewrites bash tool calls in place", async () => {
    const setupResult = setup();

    const handler = setupResult.getHandler("tool_call");
    if (!handler) throw new Error("tool_call handler not registered");

    const event = { toolName: "bash", input: { command: "deno test" } };
    await handler(event, {});

    assertEquals(event.input.command, expectedRewrite("snip run -- deno test", "tests"));
});

test("snip extension ignores non-bash, empty, and already snip commands", async () => {
    const noOp = setup();
    const noOpHandler = noOp.getHandler("tool_call");
    if (!noOpHandler) throw new Error("tool_call handler not registered");

    const readEvent = { toolName: "read", input: { command: "deno test" } };
    await noOpHandler(readEvent, {});

    const emptyEvent = { toolName: "bash", input: { command: "  " } };
    await noOpHandler(emptyEvent, {});
    assertEquals(emptyEvent.input.command, "  ");

    const snipEvent = { toolName: "bash", input: { command: "snip run -- deno test" } };
    await noOpHandler(snipEvent, {});
    assertEquals(snipEvent.input.command, "snip run -- deno test");
});

test("snip extension handles shell safety and env prefixes", async () => {
    const { getHandler } = setup();
    const handler = getHandler("tool_call");
    if (!handler) throw new Error("tool_call handler not registered");

    const cdEvent = { toolName: "bash", input: { command: "cd repo && deno test" } };
    await handler(cdEvent, {});
    assertEquals(cdEvent.input.command, "cd repo && deno test");

    const gitCloneEvent = {
        toolName: "bash",
        input: { command: "git clone https://example.test/repo.git third_party/repo" },
    };
    await handler(gitCloneEvent, {});
    assertEquals(gitCloneEvent.input.command, "git clone https://example.test/repo.git third_party/repo");

    const gitWorktreeEvent = { toolName: "bash", input: { command: "git worktree add -b demo ../demo HEAD" } };
    await handler(gitWorktreeEvent, {});
    assertEquals(gitWorktreeEvent.input.command, "git worktree add -b demo ../demo HEAD");

    const gitDiffEvent = { toolName: "bash", input: { command: "/usr/bin/git -C repo diff --cached" } };
    await handler(gitDiffEvent, {});
    assertEquals(gitDiffEvent.input.command, "/usr/bin/git -C repo diff --cached");

    const envEvent = { toolName: "bash", input: { command: "FOO=1 deno test" } };
    await handler(envEvent, {});
    assertEquals(envEvent.input.command, expectedRewrite("FOO=1 snip run -- deno test", "tests"));

    const chainEvent = { toolName: "bash", input: { command: "deno test && echo done" } };
    await handler(chainEvent, {});
    assertEquals(chainEvent.input.command, `${expectedRewrite("snip run -- deno test", "tests")}&& echo done`);

    const extraEnvEvent = {
        toolName: "bash",
        input: { command: "BAR=/tmp/custom deno lint" },
    };
    await handler(extraEnvEvent, {});
    assertEquals(extraEnvEvent.input.command, expectedRewrite("BAR=/tmp/custom snip run -- deno lint", "lint"));

    const snippetEvent = { toolName: "bash", input: { command: "snippets list" } };
    await handler(snippetEvent, {});
    assertEquals(snippetEvent.input.command, expectedRewrite("snip run -- snippets list"));
});

test("snip extension does not rewrite command substitutions", async () => {
    const { getHandler } = setup();
    const handler = getHandler("tool_call");
    if (!handler) throw new Error("tool_call handler not registered");

    const tempDirEvent = { toolName: "bash", input: { command: 'tmp=$(mktemp -d); cd "$tmp"; pwd' } };
    await handler(tempDirEvent, {});
    assertEquals(tempDirEvent.input.command, 'tmp=$(mktemp -d); cd "$tmp"; pwd');

    const inlineEvent = { toolName: "bash", input: { command: "echo $(date)" } };
    await handler(inlineEvent, {});
    assertEquals(inlineEvent.input.command, "echo $(date)");

    const backtickEvent = { toolName: "bash", input: { command: "echo `date`" } };
    await handler(backtickEvent, {});
    assertEquals(backtickEvent.input.command, "echo `date`");
});

test("snip extension filters the no-filter notice without changing output or exit status", async () => {
    const successCommand = __testing.rewriteCommand("printf success && printf chained");
    if (!successCommand) throw new Error("Expected success command to be rewritten.");

    const fakeSnip = `snip() { shift 2; printf 'snip: no filter for "printf", passing through -- you can run "printf" directly\\n' >&2; "$@"; }; `;
    const success = await captureForegroundProcess(bashFixtureExecutable(), {
        args: ["-c", `${fakeSnip}${successCommand}`],
        cwd: getCwd(),
    });
    assertEquals(success.code, 0);
    assertEquals(new TextDecoder().decode(success.stdout), "successchained");
    assertEquals(new TextDecoder().decode(success.stderr), "");

    const stderrCommand = __testing.rewriteCommand("printf visible-error >&2");
    if (!stderrCommand) throw new Error("Expected stderr command to be rewritten.");
    const stderrResult = await captureForegroundProcess(bashFixtureExecutable(), {
        args: ["-c", `${fakeSnip}${stderrCommand}`],
        cwd: getCwd(),
    });
    assertEquals(stderrResult.code, 0);
    assertEquals(new TextDecoder().decode(stderrResult.stdout), "");
    assertEquals(new TextDecoder().decode(stderrResult.stderr), "visible-error");

    const failureCommand = __testing.rewriteCommand("false && printf should-not-run");
    if (!failureCommand) throw new Error("Expected failure command to be rewritten.");
    const failure = await captureForegroundProcess(bashFixtureExecutable(), {
        args: ["-c", `${fakeSnip}${failureCommand}`],
        cwd: getCwd(),
    });
    assertEquals(failure.code, 1);
    assertEquals(new TextDecoder().decode(failure.stdout), "");
    assertEquals(new TextDecoder().decode(failure.stderr), "");
});

test("snip extension stores only filtered Deno failure diagnostics", async () => {
    const command = __testing.rewriteCommand("deno test sample.test.ts");
    if (!command) throw new Error("Expected Deno test command to be rewritten.");
    const fakeSnip = `snip() { printf '%s\\n' 'Check sample.test.ts' 'running 2 tests from ./sample.test.ts' 'passing ... ok (1ms)' 'failure ... FAILED (2ms)' 'AssertionError: expected true' 'FAILED | 1 passed | 1 failed (3ms)'; return 1; }; `;
    const result = await captureForegroundProcess(bashFixtureExecutable(), {
        args: ["-c", `${fakeSnip}${command}`],
        cwd: getCwd(),
    });
    const stderr = new TextDecoder().decode(result.stderr);
    let logPath = stderr.match(/read the failure log here: (.+)\n/)?.[1] || "";
    if (process.platform === "win32" && logPath) {
        const converted = await captureForegroundProcess(bashFixtureExecutable(), {
            args: ["-c", 'cygpath -w "$1"', "snip-log-path", logPath],
            cwd: getCwd(),
        });
        assertEquals(converted.code, 0);
        logPath = new TextDecoder().decode(converted.stdout).trim();
    }
    try {
        assertEquals(result.code, 1);
        assertEquals(new TextDecoder().decode(result.stdout), "");
        assertStringIncludes(stderr, "tests failed, read the failure log here:");
        const failureLog = await fsReadFile(logPath, "utf8");
        assertStringIncludes(failureLog, "failure ... FAILED");
        assertStringIncludes(failureLog, "AssertionError: expected true");
        assertEquals(failureLog.includes("Check sample.test.ts"), false);
        assertEquals(failureLog.includes("passing ... ok"), false);
        assertEquals(failureLog.includes("passed"), false);
    } finally {
        if (logPath) await fsRm(logPath).catch(() => {});
    }
});
