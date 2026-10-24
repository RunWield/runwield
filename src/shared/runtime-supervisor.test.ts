import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resourceExhaustionMessage } from "./resource-exhaustion.ts";
import { Terminal, spawn as spawnPty } from "bun";

const supervisor = fileURLToPath(new URL("./runtime-supervisor.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./testing/runtime-supervisor-child.ts", import.meta.url));

function runtimeEnvironment() {
    // The isolated runner enables Bun's orphan watchdog. These fixtures own
    // their service cleanup and must test the supervisor without that watchdog.
    return { ...process.env, BUN_FEATURE_FLAG_NO_ORPHANS: "0" };
}

function run(mode: string, limited = false) {
    // Intentional aborts must not wait for the host's core-dump collector.
    const posix = process.platform !== "win32";
    const command = posix ? "/bin/sh" : process.execPath;
    const args = posix
        ? ["-c", `ulimit -c 0; ${limited ? "ulimit -n 64; " : ""}exec "$@"`, "sh", process.execPath, fixture, mode]
        : [fixture, mode];
    return spawnSync(
        process.execPath,
        [
            "--eval",
            `
        import { superviseRuntime } from ${JSON.stringify(supervisor)};
        process.exitCode = await superviseRuntime(${JSON.stringify(command)}, ${JSON.stringify(args)});
    `,
        ],
        { input: "protocol input\n", encoding: "utf8", timeout: 15_000, env: runtimeEnvironment() },
    );
}

function stopService(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        /* Service already exited. */
    }
}

test("resource errors explain descriptor and memory limits through nested causes", () => {
    for (const code of ["EMFILE", "ENFILE", "ENOMEM", "EAGAIN"]) {
        const failure = new Error("operation failed", { cause: Object.assign(new Error("OS error"), { code }) });
        assert.match(
            resourceExhaustionMessage(failure) ?? "",
            code === "ENOMEM" ? /memory/ : code === "EAGAIN" ? /process or thread/ : /open-file limit/,
        );
    }
    const cyclic = new Error("ordinary failure");
    cyclic.cause = cyclic;
    assert.equal(resourceExhaustionMessage(cyclic), null);
    assert.equal(resourceExhaustionMessage("missing file"), null);
});

test("supervisor preserves protocol stdout, input, and ordinary stderr", () => {
    const result = run("stdio");
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "protocol input\n");
    assert.equal(result.stderr, "child diagnostic\n");
});

test("supervisor preserves ordinary exit codes without resource advice", () => {
    const result = run("exit");
    assert.equal(result.status, 17);
    assert.equal(result.stderr, "ordinary failure\n");
});

test("source CLI preserves Bun runtime preloads in the working process", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--preload",
            fileURLToPath(new URL("./testing/runtime-supervisor-preload.ts", import.meta.url)),
            fileURLToPath(new URL("../cli.ts", import.meta.url)),
            "--version",
        ],
        { encoding: "utf8", timeout: 15_000, env: runtimeEnvironment() },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^runwield /);
    assert.equal(result.stderr.match(/supervisor preload:/g)?.length, 2);
});

test("supervisor does not blame a recovered resource error for an ordinary failure", () => {
    const result = run("recovered-resource");
    assert.equal(result.status, 17);
    assert.equal(result.stderr, "EMFILE: recovered earlier\nordinary failure\n");
});

test("supervisor flushes forwarded stderr before the launcher exits", () => {
    const result = run("large-stderr");
    assert.equal(result.status, 17);
    assert.equal(result.stderr, "x".repeat(512_000));
});

test("supervisor does not wait for a service that inherited stderr", () => {
    const result = run("service");
    const pid = Number(result.stdout.trim());
    try {
        assert.equal(result.status, 0);
        assert.equal(result.stderr, "");
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.doesNotThrow(() => process.kill(pid, 0), "the service must remain alive after the command returns");
    } finally {
        stopService(pid);
    }
});

test("supervisor preserves failed runtime output while a service keeps stderr open", () => {
    const directory = mkdtempSync(join(tmpdir(), "supervisor-drain-"));
    const release = join(directory, "release");
    const result = spawnSync(
        process.execPath,
        [
            "--eval",
            `
        import { Writable } from "node:stream";
        import { writeFileSync } from "node:fs";
        import { superviseRuntime } from ${JSON.stringify(supervisor)};
        const destination = process.stderr;
        let released = false;
        Object.defineProperty(process, "stderr", {
            value: new Writable({
                highWaterMark: 1,
                write(chunk, encoding, callback) {
                    if (!released) {
                        released = true;
                        writeFileSync(${JSON.stringify(release)}, "release");
                    }
                    destination.write(chunk, encoding, () => setTimeout(callback, 500));
                },
            }),
        });
        process.exitCode = await superviseRuntime(process.execPath, [${JSON.stringify(fixture)}, "service-resource-error", ${JSON.stringify(release)}]);
    `,
        ],
        { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", env: runtimeEnvironment() },
    );
    const pid = Number(result.stdout.trim());
    try {
        assert.equal(result.error, undefined);
        assert.equal(result.status, 17, result.stderr);
        assert.ok(result.stderr.startsWith("x".repeat(64_000) + "\nfatal error: EMFILE: too many open files\n"));
        assert.match(result.stderr, /reached the open-file limit/);
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.doesNotThrow(() => process.kill(pid, 0), "the service must survive failed runtime shutdown");
    } finally {
        stopService(pid);
        rmSync(directory, { recursive: true, force: true });
    }
});

test(
    "supervisor restores a real terminal after an image-worker descriptor abort",
    {
        skip: process.platform === "win32" ? "POSIX PTY fixture" : false,
        timeout: 10_000,
    },
    async () => {
        let output = "";
        let sawGuidance = () => {};
        const guidance = new Promise<void>((resolve) => {
            sawGuidance = resolve;
        });
        const terminal = new Terminal({
            data(_terminal, bytes) {
                output += Buffer.from(bytes).toString();
                if (output.includes("SUPERVISOR_READY")) sawGuidance();
            },
        });
        const before = {
            input: terminal.inputFlags,
            output: terminal.outputFlags,
            control: terminal.controlFlags,
            local: terminal.localFlags,
        };
        const child = spawnPty(
            [
                process.execPath,
                "--eval",
                `
        import { superviseRuntime } from ${JSON.stringify(supervisor)};
        const code = await superviseRuntime("/bin/sh", ${JSON.stringify(["-c", 'ulimit -c 0; ulimit -n 64; exec "$@"', "sh", process.execPath, fixture, "tty-image-exhaustion"])});
        const hold = setInterval(() => {}, 1000);
        const released = new Promise((resolve) => process.once("SIGTERM", resolve));
        console.log("SUPERVISOR_READY");
        await released;
        clearInterval(hold);
        process.exitCode = code;
    `,
            ],
            { terminal, env: runtimeEnvironment() },
        );
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                guidance,
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error(`Supervisor did not settle:\n${output}`)), 8_000);
                }),
            ]);
            assert.equal(terminal.inputFlags, before.input);
            assert.equal(terminal.outputFlags, before.output);
            assert.equal(terminal.controlFlags, before.control);
            // Restoring cooked input can set the transient POSIX PENDIN flag.
            const pendingInput = process.platform === "darwin" ? 0x20000000 : 0x4000;
            assert.equal(terminal.localFlags & ~pendingInput, before.local & ~pendingInput);
            assert.ok(output.includes("\x1b[?2004l\x1b[?1049l\x1b[?25h"));
            assert.match(output, /RunWield reached the open-file limit/);
            child.kill("SIGTERM");
            assert.equal(await child.exited, 134);
        } finally {
            clearTimeout(deadline);
            child.kill("SIGKILL");
            terminal.close();
        }
    },
);

test("supervisor explains catchable resource failures without replaying a command", () => {
    const result = run("resource-error");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RunWield reached the open-file limit/);
    assert.match(result.stderr, /not replayed/);
    assert.equal(result.stdout, "attempt\n");
});

test(
    "supervisor survives a real Pi image-worker descriptor abort and explains recovery",
    {
        skip: process.platform === "win32" ? "POSIX descriptor limit fixture" : false,
    },
    () => {
        const result = run("image-exhaustion", true);
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.signal, null, "the supervisor itself must not abort");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /failed to create the event loop/);
        assert.match(result.stderr, /RunWield reached the open-file limit/);
        assert.match(result.stderr, /wld --continue/);
        assert.equal(result.stdout, "");
    },
);

test(
    "supervisor explains native aborts even without a resource diagnostic",
    {
        skip: process.platform === "win32" ? "POSIX SIGABRT fixture" : false,
    },
    () => {
        const result = run("abort");
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.signal, null);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /RunWield runtime stopped unexpectedly/);
    },
);

test(
    "supervisor reports exhaustion even when its own child cannot be launched",
    {
        skip: process.platform === "win32" ? "POSIX descriptor limit fixture" : false,
    },
    () => {
        const result = run("supervisor-exhaustion", true);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /RunWield reached the open-file limit/);
        assert.doesNotMatch(result.stderr, /TypeError|Unhandled|throw er/);
    },
);

for (const signalTarget of ["parent", "group"] as const) {
    test(
        `supervisor preserves termination delivered to its ${signalTarget}`,
        {
            skip: process.platform === "win32" ? "POSIX signal fixture" : false,
            timeout: 10_000,
        },
        async () => {
            const child = spawn(
                process.execPath,
                [
                    "--eval",
                    `
        import { superviseRuntime } from ${JSON.stringify(supervisor)};
        process.exitCode = await superviseRuntime(process.execPath, ${JSON.stringify([fixture, "signal"])});
    `,
                ],
                { stdio: ["ignore", "pipe", "pipe"], detached: true, env: runtimeEnvironment() },
            );
            let output = "";
            let errors = "";
            child.stderr.on("data", (chunk: Buffer) => {
                errors += chunk.toString();
            });
            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString();
                if (output.includes("READY")) {
                    if (signalTarget === "group" && child.pid) process.kill(-child.pid, "SIGTERM");
                    else child.kill("SIGTERM");
                }
            });
            try {
                const code = await new Promise<number | null>((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", resolve);
                });
                assert.equal(code, 23);
                assert.equal(output, "READY\n");
                assert.equal(errors, "");
            } finally {
                if (child.exitCode === null) child.kill("SIGKILL");
            }
        },
    );
}
