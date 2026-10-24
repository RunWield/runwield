import { randomBytes } from "node:crypto";
import { spawnNativeProcess } from "../foreground-process.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { serveHttp } from "../http-server.ts";
import { getCwd } from "../../constants.js";
import process from "node:process";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
    stat as fsStat,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";

import { BUILD_ID, REMOTE_PROTOCOL_VERSION } from "../build-identity.js";
import { startRemoteControlService } from "./control.ts";
import { getHomeDir } from "../../constants.js";
import { startLaptopSftp } from "./sftp-mount.ts";

// The compiled test entry exercises the production supervisor with a disposable
// TUI process. It does not replace the supervisor, group cleanup, or control service.
const entry = `import process from "node:process";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { runRemoteSupervisor } from "./src/shared/remote/supervisor.ts";
if (process.argv.slice(2)[0] === "--remote-supervisor") await runRemoteSupervisor();
else if (process.argv.slice(2)[0] === "--remote-model-proof") {
    const reader = Readable.toWeb(process.stdin).getReader();
    await reader.read();
    await fsWriteFile("proof", String(process.pid));
    await new Promise<void>(() => {});
} else if (process.argv.slice(2)[0] === "--remote-view") {
    const reader = Readable.toWeb(process.stdin).getReader();
    const bytes: number[] = [];
    let finished = false;
    while (!finished) {
        const next = await reader.read();
        if (next.done) break;
        for (const byte of next.value) {
            if (byte === 10) { finished = true; break; }
            bytes.push(byte);
        }
    }
    await fsWriteFile("view-header", new TextDecoder().decode(new Uint8Array(bytes)));
    reader.releaseLock();
    process.on("SIGTERM", () => {});
    process.on("SIGUSR1", () => process.exit(0));
    spawn("sh", ["-c", "trap '' TERM; echo $$ > detached; exec sleep 120"], { detached: true, stdio: "ignore" });
    spawn("python3", ["-c", "import os;\\nif os.fork(): os._exit(0)\\nos.setsid()\\nif os.fork(): os._exit(0)\\nopen('orphan', 'w').write(str(os.getpid()))\\nos.execlp('nohup', 'nohup', 'sleep', '120')"], { stdio: "ignore" });
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 60 & echo $! > descendant; wait"], { stdio: "ignore" });
    await fsWriteFile("view", String(process.pid));
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>(() => {});
}
`;

const terminal = String.raw`import fcntl, json, os, pty, select, socket, subprocess, sys, termios, time
binary, cwd, header, port, directory = sys.argv[1:]
master, slave = pty.openpty()
def child_terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
child = subprocess.Popen([binary, '--remote-supervisor', port, directory], cwd=cwd, stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_terminal)
os.close(slave)
with open(os.path.join(cwd, 'supervisor'), 'w') as pidfile: pidfile.write(str(child.pid))
output = b''
deadline = time.monotonic() + 12
try:
    while b'REMOTE_SUPERVISOR_READY:' not in output or b'control.sock' not in output:
        if time.monotonic() > deadline: raise RuntimeError('supervisor not ready: ' + repr(output))
        if select.select([master], [], [], .2)[0]: output += os.read(master, 65536)
    locator = output.split(b'REMOTE_SUPERVISOR_READY:', 1)[1].split(b'control.sock', 1)[0] + b'control.sock'
    if header != 'before-header':
        channel = socket.socket(socket.AF_UNIX)
        channel.connect(locator.decode())
        channel.sendall(b'{' if header == 'partial-header' else header.encode() + b'\n')
    print('READY', flush=True)
    command = sys.stdin.readline().strip()
    if command == 'blocked':
        os.set_blocking(master, False)
        for _ in range(1024):
            try: os.write(master, b'x' * 65536)
            except BlockingIOError: break
        os.set_blocking(master, True)
    elif command == 'close': os.close(master)
    elif command == 'kill-launcher': os._exit(0)
    elif command in ('kill-view', 'normal-exit'):
        with open(os.path.join(cwd, 'view')) as pidfile: view = int(pidfile.read())
        os.kill(view, 9 if command == 'kill-view' else 10)
    deadline = time.monotonic() + 45
    while child.poll() is None:
        if time.monotonic() > deadline: raise RuntimeError('supervisor cleanup timed out')
        if command == 'close': time.sleep(.1)
        elif select.select([master], [], [], .1)[0]:
            try: output += os.read(master, 65536)
            except OSError: pass
    if command != 'close':
        while select.select([master], [], [], 0)[0]:
            try:
                chunk = os.read(master, 65536)
                if not chunk: break
                output += chunk
            except OSError: break
    with open(os.path.join(cwd, 'supervisor-output'), 'wb') as logfile: logfile.write(output)
    print('EXIT:' + str(child.returncode), flush=True)
    sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
finally:
    if header != 'before-header': channel.close()
    if child.poll() is None:
        child.kill()
        child.wait()
    try: os.close(master)
    except OSError: pass`;

let binary: string | undefined;
let buildRoot: string | undefined;
async function compiledSupervisor(): Promise<string> {
    if (binary) return binary;
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    buildRoot = root;
    const sourcePath = await fsRealpath("src/shared/remote/supervisor.ts");
    const source = sourcePath;
    await fsWriteFile(
        join(root, "entry.ts"),
        entry.replace('"./src/shared/remote/supervisor.ts"', JSON.stringify(source)),
    );
    const executable = join(root, "supervisor");
    const result = await captureForegroundProcess(process.execPath, {
        cwd: getCwd(),
        args: ["build", "--compile", "--outfile", executable, join(root, "entry.ts")],
    });
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    return (binary = executable);
}

function sshfsStallTestDisabled(): boolean {
    return process.env["WLD_TEST_SSHFS_STALL"] !== "1";
}

async function running(pid: number): Promise<boolean> {
    try {
        const text = await fsReadFile(`/proc/${pid}/stat`, "utf8");
        return !["Z", "X"].includes(text.slice(text.lastIndexOf(")") + 2, text.lastIndexOf(")") + 3));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

for (const scenario of [
    "blocked",
    "kill-view",
    "normal-exit",
    "close",
    "kill-launcher",
    "before-header",
    "partial-header",
    "silent-control",
    "model-proof-stall",
]) {
    test(
        `production supervisor cleans up on ${scenario} without stopping unrelated work`,
        {
            // Opt in on a Linux host with working SSHFS and /dev/fuse, as in sftp-mount.test.ts.
            skip: process.platform !== "linux" || sshfsStallTestDisabled() || process.getuid?.() === 0,
        },
        async () => {
            const executable = await compiledSupervisor();
            const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
            const socketDirectory = `/tmp/wld-remote-${randomBytes(16).toString("hex")}`;
            await fsMkdir(join(getHomeDir(), ".wld"), { recursive: true });
            const sftp = await startLaptopSftp();
            const service = startRemoteControlService({ buildId: BUILD_ID, protocol: REMOTE_PROTOCOL_VERSION });
            const unrelated = spawnNativeProcess("sleep", {
                cwd: getCwd(),
                args: ["60"],
                stdin: "null",
                stdout: "null",
                stderr: "null",
            });
            const proxyAbort = new AbortController();
            const proxy =
                scenario === "silent-control"
                    ? serveHttp(
                          {
                              hostname: "127.0.0.1",
                              port: 0,
                              signal: proxyAbort.signal,
                              onListen() {},
                          },
                          (request) => {
                              if (new URL(request.url).pathname === "/health")
                                  return new Response(new ReadableStream());
                              return fetch(`http://127.0.0.1:${service.port}${new URL(request.url).pathname}`, request);
                          },
                      )
                    : undefined;
            const port = proxy?.addr.transport === "tcp" ? proxy.addr.port : service.port;
            if (scenario === "model-proof-stall") await fsWriteFile(join(root, "sentinel.txt"), "sentinel");
            const header = JSON.stringify({
                ...(scenario === "model-proof-stall"
                    ? { modelProof: { provider: "laptop-test", modelId: "model", sentinelFile: "sentinel.txt" } }
                    : {}),
                credential: service.credential,
                port,
                reviewPort: 43127,
                buildId: BUILD_ID,
                protocol: REMOTE_PROTOCOL_VERSION,
                view: { host: "host", cwd: root, status: "Connected", trust: "Trust", readiness: "No turns" },
                mount: sftp.header,
                remoteHome: await fsRealpath(getHomeDir()),
                memoryCollection: "fixture@host-1234",
            });
            const driver = spawnNativeProcess("python3", {
                cwd: getCwd(),
                // The supervisor must survive launcher death to perform its own cleanup.
                // Bun's test-runner guardian would otherwise kill it before its handlers run.
                // This fixture retains explicit PID cleanup and asserts all descendants exit.
                env: { BUN_FEATURE_FLAG_NO_ORPHANS: "0" },
                args: [
                    "-u",
                    "-c",
                    terminal,
                    executable,
                    root,
                    ["before-header", "partial-header"].includes(scenario) ? scenario : header,
                    String(port),
                    socketDirectory,
                ],
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
            });
            let view = 0;
            let proof = 0;
            let descendant = 0;
            let supervisor = 0;
            const extraDescendants: number[] = [];
            let mountDirectory = "";
            try {
                const reader = driver.stdout.getReader();
                const ready = await reader.read();
                assertStringIncludes(new TextDecoder().decode(ready.value), "READY");
                supervisor = Number(await fsReadFile(join(root, "supervisor"), "utf8"));
                if (scenario === "model-proof-stall") {
                    const deadline = Date.now() + 5_000;
                    while (Date.now() < deadline && !proof) {
                        proof = Number(await fsReadFile(join(root, "proof"), "utf8").catch(() => ""));
                        await new Promise((resolve) => setTimeout(resolve, 30));
                    }
                    assert(proof > 0 && proof !== supervisor, "proof did not run in its own process");
                }
                if (!["before-header", "partial-header", "model-proof-stall"].includes(scenario)) {
                    const deadline = Date.now() + 5_000;
                    while (Date.now() < deadline && !view) {
                        view = Number(await fsReadFile(join(root, "view"), "utf8").catch(() => ""));
                        await new Promise((resolve) => setTimeout(resolve, 30));
                    }
                    assert(view > 0);
                    assertEquals(await fsRealpath(`/proc/${view}/cwd`), root);
                    const bootstrap = JSON.parse(await fsReadFile(join(root, "view-header"), "utf8"));
                    assertEquals(bootstrap.connection, { port, credential: service.credential });
                    assertEquals(bootstrap.cwd, root);
                    assertEquals(bootstrap.review, {
                        socketPath: `${socketDirectory}/review.sock`,
                        origin: "http://127.0.0.1:43127",
                    });
                    assertEquals((await fsStat(socketDirectory)).mode & 0o777, 0o700);
                    await fsStat(`${socketDirectory}/control.sock`).then(
                        () => {
                            throw new Error("private header socket survived admission");
                        },
                        (error) => assertEquals(error.code, "ENOENT"),
                    );
                    assertEquals(bootstrap.view.cwd, root);
                    assert(bootstrap.resources.globalRoot.startsWith("/"));
                    mountDirectory = dirname(bootstrap.resources.globalRoot);
                    assertEquals(bootstrap.resources.globalRoot === join(getHomeDir(), ".wld"), false);
                    assertEquals(bootstrap.HOME, undefined);
                    const descendantDeadline = Date.now() + 5_000;
                    while (Date.now() < descendantDeadline && !descendant) {
                        descendant = Number(await fsReadFile(join(root, "descendant"), "utf8").catch(() => ""));
                        await new Promise((resolve) => setTimeout(resolve, 30));
                    }
                    assert(descendant > 0);
                    for (const name of ["detached", "orphan"]) {
                        let pid = 0;
                        const until = Date.now() + 5_000;
                        while (!pid && Date.now() < until) {
                            pid = Number(await fsReadFile(join(root, name), "utf8").catch(() => ""));
                            if (!pid) await new Promise((resolve) => setTimeout(resolve, 30));
                        }
                        assert(pid > 0, `${name} did not start`);
                        assert(await running(pid), `${name} exited before disconnect`);
                        extraDescendants.push(pid);
                    }
                }
                // The launcher exits, but the detached SSH peer keeps its PTY open.
                // Closing this service models loss of the launcher's forwarded endpoint.
                if (["before-header", "partial-header"].includes(scenario)) await service.close();
                const writer = driver.stdin.getWriter();
                await writer.write(
                    new TextEncoder().encode(
                        (["before-header", "partial-header", "silent-control"].includes(scenario) ? "wait" : scenario) +
                            "\n",
                    ),
                );
                await writer.close();
                const started = Date.now();
                if (scenario === "kill-view") {
                    // A second terminal signal must not cut short either cleanup phase.
                    await new Promise((resolve) => setTimeout(resolve, 1_200));
                    assert(await running(supervisor), "supervisor skipped descendant grace");
                    process.kill(supervisor, "SIGHUP");
                    process.kill(supervisor, "SIGTERM");
                }
                if (["blocked", "model-proof-stall"].includes(scenario)) service.requestShutdown();
                const deadline =
                    Date.now() +
                    (["silent-control", "before-header", "partial-header"].includes(scenario) ? 40_000 : 30_000);
                while (Date.now() < deadline && (await running(supervisor))) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                assertEquals(await running(supervisor), false, `supervisor survived ${scenario}`);
                await fsStat(socketDirectory).then(
                    () => {
                        throw new Error("private socket directory survived cleanup");
                    },
                    (error) => assertEquals(error.code, "ENOENT"),
                );
                if (scenario === "blocked") {
                    assert(Date.now() - started >= 5_000, "forced exit skipped the grace period");
                }
                if (proof) assertEquals(await running(proof), false, `proof survived ${scenario}`);
                if (view) assertEquals(await running(view), false, `view survived ${scenario}`);
                if (descendant) assertEquals(await running(descendant), false, `grandchild survived ${scenario}`);
                for (const pid of extraDescendants)
                    assertEquals(await running(pid), false, `detached/orphan survived ${scenario}`);
                assertEquals(await running(unrelated.pid), true);
                if (["kill-view", "normal-exit"].includes(scenario)) {
                    assertEquals((await driver.status).success, true);
                    const output = await fsReadFile(join(root, "supervisor-output"), "utf8");
                    assert(!output.includes("Remote mount cleanup failed"), output);
                    assert(!output.includes("SSHFS cleanup uncertain"), output);
                    assert(!output.includes("Remote owned process termination is unconfirmed"), output);
                    assert(mountDirectory.includes("wld-sftp-"));
                    await fsStat(mountDirectory).then(
                        () => {
                            throw new Error("private mount directory survived cleanup");
                        },
                        (error) => assertEquals(error.code, "ENOENT"),
                    );
                }
                reader.releaseLock();
            } finally {
                // Let the supervisor unmount and sweep even after an assertion failure.
                if (supervisor && (await running(supervisor))) {
                    process.kill(supervisor, "SIGTERM");
                    const until = Date.now() + 20_000;
                    while (Date.now() < until && (await running(supervisor)))
                        await new Promise((resolve) => setTimeout(resolve, 50));
                }
                for (const name of ["proof", "view", "descendant", "detached", "orphan", "supervisor"]) {
                    const pid = Number(await fsReadFile(join(root, name), "utf8").catch(() => ""));
                    if (!pid || !(await running(pid))) continue;
                    // Every fixture process stays in this private cwd; a reused pid does not.
                    if ((await fsRealpath(`/proc/${pid}/cwd`).catch(() => "")) !== root) continue;
                    try {
                        process.kill(pid, "SIGKILL");
                    } catch (error) {
                        assert(error instanceof Error && "code" in error && error.code === "ESRCH", String(error));
                    }
                }
                try {
                    driver.kill("SIGKILL");
                } catch {
                    /* Exited. */
                }
                try {
                    unrelated.kill("SIGKILL");
                } catch {
                    /* Exited. */
                }
                proxyAbort.abort();
                await Promise.all([driver.status, unrelated.status, service.close(), proxy?.finished]);
                await sftp.close();
                await fsRm(root, { recursive: true });
                await fsRm(socketDirectory, { recursive: true, force: true });
                if (scenario === "silent-control" && buildRoot) {
                    await fsRm(buildRoot, { recursive: true });
                    binary = undefined;
                }
            }
        },
    );
}

test(
    "supervisor refuses a pre-existing launcher directory without changing its contents",
    { skip: process.platform !== "linux" },
    async () => {
        const executable = await compiledSupervisor();
        const directory = `/tmp/wld-remote-${randomBytes(16).toString("hex")}`;
        await fsMkdir(directory, { mode: 0o700 });
        await fsWriteFile(join(directory, "sentinel"), "not owned");
        try {
            const result = await captureForegroundProcess(executable, {
                cwd: getCwd(),
                args: ["--remote-supervisor", "43127", directory],
            });
            assertEquals(result.success, false);
            assertStringIncludes(new TextDecoder().decode(result.stderr), "EEXIST");
            assertEquals(await fsReadFile(join(directory, "sentinel"), "utf8"), "not owned");
        } finally {
            await fsRm(directory, { recursive: true, force: true });
        }
    },
);

test(
    "supervisor owns the private launcher directory until the setup terminal closes",
    { skip: process.platform !== "linux" },
    async () => {
        const executable = await compiledSupervisor();
        const directory = `/tmp/wld-remote-${randomBytes(16).toString("hex")}`;
        const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const service = startRemoteControlService({ buildId: BUILD_ID, protocol: REMOTE_PROTOCOL_VERSION });
        const driver = spawnNativeProcess("python3", {
            cwd: getCwd(),
            args: ["-u", "-c", terminal, executable, root, "before-header", String(service.port), directory],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });
        try {
            const reader = driver.stdout.getReader();
            const ready = await reader.read();
            assertStringIncludes(new TextDecoder().decode(ready.value), "READY");
            reader.releaseLock();
            assertEquals((await fsStat(directory)).mode & 0o777, 0o700);
            assertEquals((await fsStat(join(directory, "control.sock"))).isSocket(), true);
            const writer = driver.stdin.getWriter();
            await writer.write(new TextEncoder().encode("close\n"));
            await writer.close();
            await driver.status;
            await fsStat(directory).then(
                () => {
                    throw new Error("private socket directory survived setup closure");
                },
                (error) => assertEquals(error.code, "ENOENT"),
            );
        } finally {
            try {
                driver.kill("SIGKILL");
            } catch {
                /* Exited. */
            }
            await driver.status;
            await service.close();
            await fsRm(directory, { recursive: true, force: true });
            await fsRm(root, { recursive: true, force: true });
        }
    },
);

test(
    "supervisor removes its private directory when terminal setup fails",
    { skip: process.platform !== "linux" },
    async () => {
        const executable = await compiledSupervisor();
        const directory = `/tmp/wld-remote-${randomBytes(16).toString("hex")}`;
        try {
            const result = await captureForegroundProcess(executable, {
                cwd: getCwd(),
                args: ["--remote-supervisor", "43127", directory],
            });
            assertEquals(result.success, false);
            assertStringIncludes(new TextDecoder().decode(result.stderr), "requires a private SSH terminal");
            await fsStat(directory).then(
                () => {
                    throw new Error("private directory survived terminal setup failure");
                },
                (error) => assertEquals(error.code, "ENOENT"),
            );
        } finally {
            await fsRm(directory, { recursive: true, force: true });
        }
    },
);
