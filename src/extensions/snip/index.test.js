import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashFixtureExecutable, bashFixturePath } from "../../../scripts/bash-fixture.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { getCwd } from "../../constants.js";
import { mkdir, mkdtemp, readdir, writeFile, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
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

// This recorded repository command must only be passed to Bash with -n, never executed.
const historicalCommand =
    'for f in .gitignore .wld/settings.json docs/domain-language.md docs/plans/add-expense-report-command.md; do echo "=== $f"; git show "plan/add-expense-report-command:$f" | diff -u --label "untracked:$f" "$f" --label "branch:$f" - || :; done; git show --stat --oneline b80cb84; git show plan/add-expense-report-command:docs/work-records/2026-10-19-filtered-expense-reports.md | head -100';

test("snip leaves the historical for/do/done command valid and unchanged (syntax only)", async () => {
    const original = await captureForegroundProcess(bashFixtureExecutable(), {
        args: ["-n", "-c", historicalCommand],
        cwd: getCwd(),
    });
    assertEquals(original.code, 0);
    const rewritten = __testing.rewriteCommand(historicalCommand);
    const transformed = await captureForegroundProcess(bashFixtureExecutable(), {
        args: ["-n", "-c", rewritten ?? historicalCommand],
        cwd: getCwd(),
    });
    assertEquals(transformed.code, 0, new TextDecoder().decode(transformed.stderr));
    assertEquals(rewritten, null);
});

/** @typedef {{ name: string, command: string, wrap: boolean, syntaxOnly?: boolean, subdirectory?: boolean }} ShellCase */
/** @type {ShellCase[]} */
const shellCases = [
    {
        name: "for loop with pipeline and fallback",
        command: 'for f in a b; do printf "%s\\n" "$f" | grep a || :; done',
        wrap: false,
    },
    { name: "while loop", command: 'x=0; while [ "$x" = 0 ]; do printf a; x=1; done', wrap: false },
    { name: "leading while", command: "while false; do printf no; done", wrap: false },
    { name: "until loop", command: "until true; do printf no; done", wrap: false },
    { name: "select loop", command: "select x in a; do break; done", wrap: false, syntaxOnly: true },
    { name: "conditional", command: "if false; then printf no; else printf yes; fi", wrap: false },
    { name: "case", command: "case x in x) printf yes;; *) printf no;; esac", wrap: false },
    { name: "function definition", command: "f() { printf hi; }; f", wrap: false },
    { name: "function keyword", command: "function g { printf hi; }; g", wrap: false },
    { name: "brace group", command: "{ printf a; }", wrap: false },
    { name: "subshell", command: "(printf a)", wrap: false },
    { name: "negation", command: "! false", wrap: false },
    { name: "conditional expression", command: "[[ -n x ]]", wrap: false },
    { name: "time keyword", command: "time true", wrap: false },
    { name: "assignment substitution", command: 'x=$(printf a); printf "%s" "$x"', wrap: false },
    { name: "backtick substitution", command: "printf `printf a`", wrap: false },
    { name: "process substitution", command: "cat <(printf a)", wrap: false },
    { name: "heredoc", command: "cat <<EOF\na\nEOF", wrap: false },
    { name: "comment", command: "printf a # comment; printf no", wrap: false },
    { name: "line continuation", command: "printf \\\n a", wrap: false },
    { name: "background job", command: "sh -c 'printf a' & wait", wrap: false },
    { name: "stderr merged into pipe", command: "sh -c 'printf o; printf e >&2' 2>&1 | cat", wrap: false },
    { name: "stderr suppressed", command: "sh -c 'printf e >&2' 2>/dev/null", wrap: false },
    { name: "both streams redirected", command: "sh -c 'printf o; printf e >&2' &> out.txt", wrap: false },
    { name: "stderr pipe", command: "sh -c 'printf o; printf e >&2' |& cat", wrap: false },
    { name: "assignment only", command: "x=1", wrap: false },
    { name: "stateful builtin", command: 'declare x=1; printf "%s" "$x"', wrap: false },
    { name: "cd builtin", command: "cd sub && pwd", wrap: false },
    { name: "fd 2 append", command: "sh -c 'printf e >&2' 2>> out.txt", wrap: false },
    {
        name: "fd 2 move with leading zero",
        command: "sh -c 'if : >&2; then printf open; else printf closed; fi' 3<&02-",
        wrap: false,
    },
    { name: "fd 2 close", command: "true 2>&-", wrap: false },
    { name: "fd 2 with leading zero", command: "sh -c 'printf e >&2' 02> out.txt", wrap: false },
    { name: "both streams legacy redirect", command: "sh -c 'printf o; printf e >&2' >& out.txt", wrap: false },
    { name: "parameter assignment", command: 'printf "%s" "${x:=a}"; printf "%s" "$x"', wrap: false },
    { name: "dynamic executable", command: "$SHELL -c true", wrap: false, syntaxOnly: true },
    { name: "arithmetic command", command: "(( 1 + 1 ))", wrap: false },
    { name: "array assignment", command: 'xs=(a b); printf "%s" "${xs[1]}"', wrap: false },
    { name: "leading redirection", command: "> out.txt printf a", wrap: false },
    { name: "plain command", command: "cat in.txt", wrap: true },
    { name: "environment assignment", command: 'FOO=1 sh -c \'printf "%s" "$FOO"\'', wrap: true },
    { name: "failed and-chain", command: "false && printf no", wrap: true },
    { name: "failed or-chain", command: "false || printf yes", wrap: true },
    { name: "pipeline", command: "printf a | wc -c", wrap: true },
    { name: "loop in unchanged rest", command: 'printf a; for x in b; do printf "%s" "$x"; done', wrap: true },
    { name: "quoted separators", command: "printf '%s' 'a;b' \"c|d&&e\"", wrap: true },
    { name: "single quoted backslash", command: "printf '%s' 'a\\'; printf b", wrap: true },
    { name: "escaped trailing space", command: "printf x\\ ", wrap: true },
    { name: "empty quoted argument", command: "printf '<%s>' ''", wrap: true },
    { name: "literal substitution", command: "printf '%s' '$(printf no)'", wrap: true },
    { name: "double quoted escape", command: 'printf \'%s\' "a\\\\b\\\"c"', wrap: true },
    { name: "escaped separator", command: "printf a\\;b", wrap: true },
    { name: "literal trailing carriage return", command: "printf '%s' x\r", wrap: true },
    { name: "stdout file", command: "printf o > out.txt", wrap: true },
    { name: "stdout to stderr", command: "printf 'e\\n' >&2", wrap: true },
    { name: "input file", command: "cat < in.txt", wrap: true },
    { name: "here string", command: "cat <<< word", wrap: true },
    { name: "newline boundary", command: "printf a\nprintf b", wrap: true },
    { name: "working directory", command: "pwd", wrap: true, subdirectory: true },
    { name: "exactly once side effect", command: "sh -c 'printf x >> count; printf done; exit 7'", wrap: true },
];

/** @typedef {Record<string, string>} DirectoryContents */
/** @param {string} path @returns {Promise<DirectoryContents>} */
async function directoryContents(path) {
    /** @type {DirectoryContents} */
    const result = {};
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
            for (const [name, contents] of Object.entries(await directoryContents(child))) {
                result[`${entry.name}/${name}`] = contents;
            }
        } else {
            result[entry.name] = await fsReadFile(child, "utf8");
        }
    }
    return result;
}

for (const fixture of shellCases) {
    test(`snip ${fixture.wrap ? "wraps" : "bypasses"} ${fixture.name} without changing shell behavior`, async () => {
        const rewritten = __testing.rewriteCommand(fixture.command);
        if (fixture.wrap) {
            if (!rewritten) throw new Error("Expected a Snip invocation");
            assertStringIncludes(rewritten, "snip run -- ");
        } else {
            assertEquals(rewritten, null);
        }
        const { getHandler } = setup();
        const handler = getHandler("tool_call");
        if (!handler) throw new Error("Missing handler");
        const requested = fixture.wrap ? fixture.command : `  ${fixture.command}  `;
        const event = { toolName: "bash", input: { command: requested } };
        await handler(event, {});
        assertEquals(event.input.command, rewritten ?? requested);
        // macOS /bin/bash is 3.2. Prefer a PATH Bash for the Bash 4 |& construct.
        const bash = fixture.name === "stderr pipe" ? "bash" : bashFixtureExecutable();
        const originalSyntax = await captureForegroundProcess(bash, {
            args: ["-n", "-c", fixture.command],
            cwd: getCwd(),
        });
        const syntax = await captureForegroundProcess(bash, {
            args: ["-n", "-c", rewritten ?? fixture.command],
            cwd: getCwd(),
        });
        assertEquals(syntax.code, originalSyntax.code, new TextDecoder().decode(syntax.stderr));
        // A Bash 3 host must still leave |& untouched, even though that shell cannot execute it.
        if (fixture.name === "stderr pipe" && originalSyntax.code === 2) return;
        assertEquals(originalSyntax.code, 0, new TextDecoder().decode(originalSyntax.stderr));
        if (fixture.syntaxOnly) return;
        const root = await mkdtemp(join(tmpdir(), "snip-shell-"));
        try {
            const observations = [];
            for (const [index, command] of [fixture.command, rewritten ?? fixture.command].entries()) {
                const cwd = join(root, `run-${index}`);
                await mkdir(join(cwd, "sub"), { recursive: true });
                await writeFile(join(cwd, "in.txt"), "input\n");
                const fakeSnip =
                    'snip() { [ "$1" = run ] && [ "$2" = -- ] || return 99; shift 2; printf "call\\n" >> "$snip_calls"; "$@"; }; ';
                const run = await captureForegroundProcess(bash, {
                    args: [
                        "-c",
                        `TIMEFORMAT=; snip_calls=$1; ${fakeSnip}${command}`,
                        "snip-fixture",
                        bashFixturePath(join(root, "calls")),
                    ],
                    cwd: fixture.subdirectory ? join(cwd, "sub") : cwd,
                    timeoutMs: 5000,
                });
                // Normalize only the fixture root in pwd output; both shells must observe their own cwd.
                const stdout = new TextDecoder()
                    .decode(run.stdout)
                    .replaceAll(cwd, "<cwd>")
                    .replaceAll(bashFixturePath(cwd), "<cwd>");
                observations.push({
                    code: run.code,
                    stdout,
                    stderr: new TextDecoder().decode(run.stderr),
                    files: await directoryContents(cwd),
                });
            }
            assertEquals(observations[1], observations[0]);
            const log = join(root, "calls");
            assertEquals(
                await fsReadFile(log, "utf8").catch((error) => {
                    if (error.code === "ENOENT") return "";
                    throw error;
                }),
                fixture.wrap ? "call\n" : "",
            );
        } finally {
            await fsRm(root, { recursive: true, force: true });
        }
    });
}

test("snip Deno success respects the user's stdout redirection", async () => {
    const root = await mkdtemp(join(tmpdir(), "snip-deno-"));
    try {
        const command = __testing.rewriteCommand("deno test > out.txt");
        if (!command) throw new Error("Expected Deno wrapping");
        const result = await captureForegroundProcess(bashFixtureExecutable(), {
            args: [
                "-c",
                `snip() { [ "$1 $2 $3 $4" = 'run -- deno test' ] || return 99; printf 'passed\\n'; }; ${command}`,
            ],
            cwd: root,
        });
        assertEquals(result.code, 0);
        assertEquals(new TextDecoder().decode(result.stdout), "");
        assertEquals(new TextDecoder().decode(result.stderr), "");
        assertEquals(await fsReadFile(join(root, "out.txt"), "utf8"), "passed\n");
    } finally {
        await fsRm(root, { recursive: true, force: true });
    }
});
