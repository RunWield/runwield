import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes, assertThrows } from "../testing/assertions.ts";
import { isMissingExecutableError, spawnForegroundProcess, spawnForegroundShell } from "./foreground-process.ts";
import { getCwd } from "../constants.js";

import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath, kill, platform } from "node:process";

const IS_WINDOWS = platform === "win32";
async function makeTempFile(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}${crypto.randomUUID()}`);
    await writeFile(path, "", { flag: "wx" });
    return path;
}

test("spawnForegroundProcess exposes interactive stdin until its owner closes it", async () => {
    const process = spawnForegroundProcess({
        command: execPath,
        args: ["--eval", 'import { stdin, stdout } from "node:process"; stdin.pipe(stdout);'],
        cwd: getCwd(),
        stdin: "piped",
    });
    const writer = process.stdin!.getWriter();
    let output = Promise.resolve("");
    const errors = readAll(process.stderr);
    try {
        const reader = process.stdout.getReader();
        let first = "";
        const deadline = setTimeout(() => process.kill(), 5_000);
        try {
            await writer.write(new TextEncoder().encode("first\n"));
            while (first.length < "first\n".length) {
                const next = await reader.read();
                assert(!next.done, "the first response must arrive while stdin remains open");
                first += new TextDecoder().decode(next.value);
            }
            assertEquals(first, "first\n");
        } finally {
            clearTimeout(deadline);
            reader.releaseLock();
        }
        output = readAll(process.stdout);
        await writer.write(new TextEncoder().encode("second\n"));
        await writer.close();
        assertEquals(await process.done, { exitCode: 0, terminatedBy: null });
        assertEquals(await output, "second\n");
        assertEquals(await errors, "");
    } finally {
        process.kill();
        await Promise.allSettled([process.done, output, errors]);
        writer.releaseLock();
    }
});

test("spawnForegroundProcess rejects two stdin owners before spawning", () => {
    assertThrows(
        () =>
            spawnForegroundProcess({
                command: "must-not-spawn",
                cwd: getCwd(),
                stdin: "piped",
                stdinText: "conflicting owner",
            }),
        Error,
        "stdin",
    );
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    let text = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
        }
    } finally {
        reader.releaseLock();
    }
    return text;
}

/** True while the OS still has a process with this pid. */
function processAlive(pid: number): boolean {
    if (IS_WINDOWS) {
        const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
        return new TextDecoder().decode(result.stdout).includes(`\"${pid}\"`);
    }
    try {
        kill(pid, 0);
        if (platform === "linux") {
            const status = readFileSync(`/proc/${pid}/stat`, "utf8");
            const state = status.slice(status.lastIndexOf(")") + 2, status.lastIndexOf(")") + 3);
            return state !== "Z" && state !== "X";
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Poll until the OS no longer reports a process with this pid. The wrapper
 * shell's exit settles before its SIGKILLed descendants are reaped, so a
 * single immediate probe can still observe them — and under CI load the
 * window is wide enough to fail a one-shot check.
 */
async function waitForProcessDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !processAlive(pid);
}

/**
 * Spawn a command whose descendant outlives a wrapper-only kill: the wrapper
 * records the descendant's pid, then waits on it.
 *
 * The wait is for *observed* aliveness, not just the pid file: a short
 * command timeout can fire and kill the tree before the test ever confirms
 * the descendant existed, flaking the pre-kill probe. If the wrapper settles
 * before the descendant is observed, the tree is already gone — fail fast
 * with a clear setup error instead of hanging or flaking.
 */
async function spawnTreeWithDescendant(options: {
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<{ shell: ReturnType<typeof spawnForegroundShell>; descendantPid: number; cleanup: () => Promise<void> }> {
    const pidFile = await makeTempFile("runwield-fg-descendant-");
    const shell = spawnForegroundShell({
        command: `sleep 30 & echo $! > ${pidFile}; wait`,
        cwd: getCwd(),
        ...options,
    });
    let settled = false;
    shell.done
        .finally(() => {
            settled = true;
        })
        .catch(() => {});
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const pid = Number((await readFile(pidFile, "utf8")).trim()) || 0;
        if (pid && processAlive(pid)) {
            return {
                shell,
                descendantPid: pid,
                cleanup: async () => {
                    if (processAlive(pid)) kill(pid, "SIGKILL");
                    await rm(pidFile).catch(() => {});
                },
            };
        }
        if (settled) {
            throw new Error(
                "foreground-process test setup: the wrapper settled before its descendant was observed running",
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("foreground-process test setup: descendant process never appeared within 10s");
}

test(
    "spawnForegroundProcess passes literal arguments and reports the real exit status",
    { skip: IS_WINDOWS },
    async () => {
        const cwd = await mkdtemp(join(tmpdir(), "runwield-fg-direct-cwd-"));
        const marker = `${cwd}/shell-metacharacter-marker`;
        const script = `${cwd}/args.ts`;
        await writeFile(
            script,
            'import { argv, exit } from "node:process"; console.log(argv[2]); console.error("err"); exit(3);\n',
        );
        try {
            const process = spawnForegroundProcess({
                command: execPath,
                args: [...[], script, `literal; touch ${marker}`],
                cwd,
            });
            const [outcome, stdout, stderr] = await Promise.all([
                process.done,
                readAll(process.stdout),
                readAll(process.stderr),
            ]);
            assertEquals(outcome, { exitCode: 3, terminatedBy: null });
            assertEquals(stdout.trim(), `literal; touch ${marker}`);
            assertEquals(stderr, "err\n");
            assertEquals(
                await stat(marker).then(
                    () => true,
                    () => false,
                ),
                false,
            );
        } finally {
            await rm(cwd, { recursive: true });
        }
    },
);

test(
    "spawnForegroundProcess skips the spawn entirely for an already-aborted signal",
    { skip: IS_WINDOWS },
    async () => {
        const marker = await makeTempFile("runwield-fg-direct-preabort-");
        await rm(marker);
        const abortController = new AbortController();
        abortController.abort();
        const process = spawnForegroundProcess({
            command: "sh",
            args: ["-c", `touch ${marker}`],
            cwd: getCwd(),
            signal: abortController.signal,
        });
        const [outcome, stdout, stderr] = await Promise.all([
            process.done,
            readAll(process.stdout),
            readAll(process.stderr),
        ]);
        assertEquals(process.pid, null);
        assertEquals(outcome, { exitCode: null, terminatedBy: "abort" });
        assertEquals(stdout, "");
        assertEquals(stderr, "");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assertEquals(
            await stat(marker).then(
                () => true,
                () => false,
            ),
            false,
        );
    },
);

test("spawnForegroundProcess writes optional stdin and closes it", { skip: IS_WINDOWS }, async () => {
    const process = spawnForegroundProcess({
        command: "cat",
        cwd: getCwd(),
        stdinText: "stdin marker",
    });
    const [outcome, stdout, stderr] = await Promise.all([
        process.done,
        readAll(process.stdout),
        readAll(process.stderr),
    ]);
    assertEquals(outcome, { exitCode: 0, terminatedBy: null });
    assertEquals(stdout, "stdin marker");
    assertEquals(stderr, "");
});

test("spawnForegroundProcess reports a missing executable as a spawn error", { skip: IS_WINDOWS }, () => {
    const error = assertThrows(() =>
        spawnForegroundProcess({
            command: `runwield-missing-${crypto.randomUUID()}`,
            args: [],
            cwd: getCwd(),
        }),
    );
    assert(error instanceof Error);
    assert(isMissingExecutableError(error));
});

test(
    "spawnForegroundProcess kill after natural exit terminates lingering descendants",
    { skip: IS_WINDOWS },
    async () => {
        const pidFile = await makeTempFile("runwield-fg-direct-natural-descendant-");
        const process = spawnForegroundProcess({
            command: "sh",
            args: ["-c", `sleep 30 & echo $! > ${pidFile}; exit 4`],
            cwd: getCwd(),
        });
        let descendantPid = 0;
        try {
            const outcome = await process.done;
            descendantPid = Number((await readFile(pidFile, "utf8")).trim()) || 0;
            assert(descendantPid && processAlive(descendantPid), "descendant should survive parent natural exit setup");
            assertEquals(outcome, { exitCode: 4, terminatedBy: null });
            process.kill();
            assertEquals(await waitForProcessDeath(descendantPid), true);
        } finally {
            if (descendantPid && processAlive(descendantPid)) kill(descendantPid, "SIGKILL");
            await rm(pidFile).catch(() => {});
        }
    },
);

test("spawnForegroundProcess timeout kills the whole descendant tree", { skip: IS_WINDOWS }, async () => {
    const pidFile = await makeTempFile("runwield-fg-direct-descendant-");
    const process = spawnForegroundProcess({
        command: "sh",
        args: ["-c", `sleep 30 & echo $! > ${pidFile}; wait`],
        cwd: getCwd(),
        timeoutMs: 2000,
    });
    let descendantPid = 0;
    try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            descendantPid = Number((await readFile(pidFile, "utf8")).trim()) || 0;
            if (descendantPid && processAlive(descendantPid)) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(descendantPid && processAlive(descendantPid), "descendant should be running before timeout");
        const outcome = await process.done;
        assertEquals(outcome, { exitCode: null, terminatedBy: "timeout" });
        assertEquals(await waitForProcessDeath(descendantPid), true);
    } finally {
        if (descendantPid && processAlive(descendantPid)) kill(descendantPid, "SIGKILL");
        await rm(pidFile).catch(() => {});
    }
});

test("spawnForegroundShell reports the real exit status and separate streams", { skip: IS_WINDOWS }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runwield-fg-cwd-"));
    try {
        const shell = spawnForegroundShell({ command: "printf out; printf err >&2; exit 3", cwd });
        const [outcome, stdout, stderr] = await Promise.all([shell.done, readAll(shell.stdout), readAll(shell.stderr)]);
        assertEquals(outcome, { exitCode: 3, terminatedBy: null });
        assertEquals(stdout, "out");
        assertEquals(stderr, "err");
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("spawnForegroundShell abort kills the whole descendant tree", { skip: IS_WINDOWS }, async () => {
    const abortController = new AbortController();
    const { shell, descendantPid, cleanup } = await spawnTreeWithDescendant({ signal: abortController.signal });
    try {
        assert(processAlive(descendantPid), "descendant should be running before abort");
        abortController.abort();
        const outcome = await shell.done;
        assertEquals(outcome, { exitCode: null, terminatedBy: "abort" });
        assertEquals(
            await waitForProcessDeath(descendantPid),
            true,
            "abort must kill the descendant, not only the wrapper",
        );
    } finally {
        await cleanup();
    }
});

test("spawnForegroundShell observes an abort immediately after spawn returns", { skip: IS_WINDOWS }, async () => {
    const abortController = new AbortController();
    const shell = spawnForegroundShell({
        command: "sleep 30",
        cwd: getCwd(),
        signal: abortController.signal,
    });
    // No await or readiness polling between obtaining the child and aborting.
    abortController.abort();
    const output = readAll(shell.stdout);
    const errors = readAll(shell.stderr);
    try {
        assert(shell.pid);
        assertEquals(await shell.done, { exitCode: null, terminatedBy: "abort" });
        assertEquals(await waitForProcessDeath(shell.pid), true);
        await Promise.all([output, errors]);
    } finally {
        shell.kill();
        await Promise.allSettled([shell.done, output, errors]);
    }
});

test(
    "macOS Stop closes inherited pipes when cancellation races a shell fork",
    { skip: platform !== "darwin", timeout: 60_000 },
    async () => {
        for (let attempt = 0; attempt < 400; attempt++) {
            const controller = new AbortController();
            const shell = spawnForegroundShell({
                command: "sleep 5; printf late",
                cwd: getCwd(),
                signal: controller.signal,
            });
            const drained = Promise.all([shell.done, readAll(shell.stdout), readAll(shell.stderr)]);
            // Cover the shell's fork/exec window, not only an established descendant.
            await new Promise((resolve) => setTimeout(resolve, attempt % 10));
            controller.abort();
            let deadline: ReturnType<typeof setTimeout> | undefined;
            let closed = false;
            try {
                const result = await Promise.race([
                    drained,
                    new Promise<never>((_resolve, reject) => {
                        deadline = setTimeout(
                            () => reject(new Error(`Stop left a descendant holding a pipe on attempt ${attempt}`)),
                            3_000,
                        );
                    }),
                ]);
                closed = true;
                assertEquals(result, [{ exitCode: null, terminatedBy: "abort" }, "", ""]);
            } finally {
                clearTimeout(deadline);
                if (!closed && shell.pid) {
                    // Independent cleanup also works when the implementation left a stopped descendant.
                    try {
                        kill(-shell.pid, "SIGKILL");
                    } catch {
                        /* The group already exited. */
                    }
                }
                try {
                    await Promise.race([
                        drained,
                        new Promise<void>((resolve) => {
                            deadline = setTimeout(resolve, 2_000);
                        }),
                    ]);
                } finally {
                    clearTimeout(deadline);
                }
            }
        }
    },
);

test(
    "spawnForegroundShell timeout kills the whole descendant tree and stays distinguishable from abort",
    {
        skip: IS_WINDOWS,
    },
    async () => {
        // The timeout must be long enough that the pre-kill probe can observe
        // the descendant running before it fires: a 50ms budget raced spawn +
        // pid-file write + read under parallel CI load, flaking the assertion.
        const { shell, descendantPid, cleanup } = await spawnTreeWithDescendant({ timeoutMs: 2000 });
        try {
            assert(processAlive(descendantPid), "descendant should be running before the timeout");
            const outcome = await shell.done;
            assertEquals(outcome, { exitCode: null, terminatedBy: "timeout" });
            assertEquals(
                await waitForProcessDeath(descendantPid),
                true,
                "timeout must kill the descendant, not only the wrapper",
            );
        } finally {
            await cleanup();
        }
    },
);

test("spawnForegroundShell skips the spawn entirely for an already-aborted signal", { skip: IS_WINDOWS }, async () => {
    const marker = await makeTempFile("runwield-fg-preabort-");
    await rm(marker);
    const abortController = new AbortController();
    abortController.abort();
    const shell = spawnForegroundShell({
        command: `touch ${marker}`,
        cwd: getCwd(),
        signal: abortController.signal,
    });
    const [outcome, stdout, stderr] = await Promise.all([shell.done, readAll(shell.stdout), readAll(shell.stderr)]);
    assertEquals(shell.pid, null);
    assertEquals(outcome, { exitCode: null, terminatedBy: "abort" });
    assertEquals(stdout, "");
    assertEquals(stderr, "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const markerExists = await stat(marker).then(
        () => true,
        () => false,
    );
    assertEquals(markerExists, false, "a pre-aborted signal must prevent the command from starting");
});

test("spawnForegroundShell tolerates an abort that arrives after natural exit", { skip: IS_WINDOWS }, async () => {
    const abortController = new AbortController();
    const shell = spawnForegroundShell({
        command: "printf done; exit 7",
        cwd: getCwd(),
        signal: abortController.signal,
    });
    const outcome = await shell.done;
    abortController.abort();
    assertEquals(outcome, { exitCode: 7, terminatedBy: null });
    assertEquals(await shell.done, outcome, "done settles exactly once");
});

test("spawnForegroundShell on Windows abort kills a real descendant tree", { skip: !IS_WINDOWS }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-fg-windows-descendant-"));
    const pidFile = join(root, "descendant.pid");
    const wrapper = join(root, "spawn descendant.js");
    await writeFile(pidFile, "");
    await writeFile(
        wrapper,
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code || 0; });
`,
    );
    const abortController = new AbortController();
    const command = `"${execPath}" ${"run"} "${wrapper}"`;
    const shell = spawnForegroundShell({
        command,
        cwd: getCwd(),
        signal: abortController.signal,
        // This test must prove RunWield cleanup without Bun's orphan guardian.
        env: { BUN_FEATURE_FLAG_NO_ORPHANS: "0" },
    });
    const stderr = readAll(shell.stderr);
    const stdout = readAll(shell.stdout);
    let descendantPid = 0;
    try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            descendantPid = Number((await readFile(pidFile, "utf8")).trim()) || 0;
            if (descendantPid && processAlive(descendantPid)) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!descendantPid || !processAlive(descendantPid)) {
            abortController.abort();
            await shell.done;
            const probe = spawnSync("tasklist", ["/FI", `PID eq ${descendantPid}`, "/FO", "CSV", "/NH"], {
                encoding: "utf8",
            });
            throw new Error(
                `Descendant did not start: pid=${descendantPid}; file=${await readFile(pidFile, "utf8")}; stderr=${await stderr}; stdout=${await stdout}; probe=${JSON.stringify({ status: probe.status, stdout: probe.stdout, stderr: probe.stderr, error: probe.error?.message })}`,
            );
        }
        abortController.abort();
        const outcome = await shell.done;
        assertEquals(outcome, { exitCode: null, terminatedBy: "abort" });
        assertEquals(await waitForProcessDeath(descendantPid), true);
    } finally {
        abortController.abort();
        await shell.done;
        if (descendantPid && processAlive(descendantPid)) {
            spawnSync("taskkill", ["/F", "/T", "/PID", String(descendantPid)]);
        }
        await Promise.all([stdout, stderr]);
        await rm(root, { recursive: true, force: true });
    }
});

test("spawnForegroundShell on Windows uses cmd and reports real shell status", { skip: !IS_WINDOWS }, async () => {
    const shell = spawnForegroundShell({ command: "echo out && echo err 1>&2 && exit /b 3", cwd: getCwd() });
    const [outcome, stdout, stderr] = await Promise.all([shell.done, readAll(shell.stdout), readAll(shell.stderr)]);
    assertEquals(outcome, { exitCode: 3, terminatedBy: null });
    assertStringIncludes(stdout, "out");
    assertStringIncludes(stderr, "err");
});

test("foreground stdin preserves a large payload across pipe backpressure and EOF", async () => {
    const payload = "input π\n".repeat(262144);
    const child = spawnForegroundProcess({
        command: execPath,
        args: ["--eval", 'import { stdin, stdout } from "node:process"; setTimeout(() => stdin.pipe(stdout), 50);'],
        cwd: getCwd(),
        stdinText: payload,
        timeoutMs: 10_000,
    });
    const [outcome, output, errors] = await Promise.all([
        child.done,
        new Response(child.stdout).text(),
        readAll(child.stderr),
    ]);
    assertEquals(outcome, { exitCode: 0, terminatedBy: null });
    assertEquals(output, payload);
    assertEquals(errors, "");
});

test("foreground command receives its explicit cwd and environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runwield-fg-env-"));
    try {
        const child = spawnForegroundProcess({
            command: execPath,
            args: [
                "--eval",
                'import {cwd,env} from "node:process"; console.log(JSON.stringify({cwd:cwd(),marker:env.WLD_FG_MARKER,inherited:env.HOME}));',
            ],
            cwd,
            env: { WLD_FG_MARKER: "literal environment value" },
        });
        const [outcome, output, errors] = await Promise.all([child.done, readAll(child.stdout), readAll(child.stderr)]);
        assertEquals(outcome.exitCode, 0);
        const value = JSON.parse(output);
        assertEquals(value.cwd, await import("node:fs/promises").then((fs) => fs.realpath(cwd)));
        assertEquals(value.marker, "literal environment value");
        assertEquals(value.inherited, (await import("node:process")).env.HOME);
        assertEquals(errors, "");
    } finally {
        await rm(cwd, { recursive: true });
    }
});
