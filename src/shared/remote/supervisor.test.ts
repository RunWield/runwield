import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { BUILD_ID, REMOTE_PROTOCOL_VERSION } from "../build-identity.js";
import { startRemoteControlService } from "./control.ts";
import { getHomeDir } from "../../constants.js";
import { startLaptopSftp } from "./sftp-mount.ts";

// The compiled test entry exercises the production supervisor with a disposable
// TUI process. It does not replace the supervisor, group cleanup, or control service.
const entry = `import { runRemoteSupervisor } from "./src/shared/remote/supervisor.ts";
if (Deno.args[0] === "--remote-supervisor") await runRemoteSupervisor();
else if (Deno.args[0] === "--remote-model-proof") {
    const reader = Deno.stdin.readable.getReader();
    await reader.read();
    await Deno.writeTextFile("proof", String(Deno.pid));
    await new Promise<void>(() => {});
} else if (Deno.args[0] === "--remote-view") {
    const byte = new Uint8Array(1);
    const bytes: number[] = [];
    while ((await Deno.stdin.read(byte)) !== null && byte[0] !== 10) bytes.push(byte[0]);
    await Deno.writeTextFile("view-header", new TextDecoder().decode(new Uint8Array(bytes)));
    Deno.addSignalListener("SIGTERM", () => {});
    const child = new Deno.Command("sh", {
        args: ["-c", "trap '' TERM; sleep 60 & echo $! > descendant; wait"],
        stdout: "null", stderr: "null",
    }).spawn();
    await Deno.writeTextFile("view", String(Deno.pid));
    await child.status;
    await new Promise<void>(() => {});
}
`;

const terminal = String.raw`import fcntl, json, os, pty, select, socket, subprocess, sys, termios, time
binary, cwd, header, port = sys.argv[1:]
master, slave = pty.openpty()
def child_terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
child = subprocess.Popen([binary, '--remote-supervisor', port], cwd=cwd, stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_terminal)
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
    child.wait(timeout=27)
    print('EXIT:' + str(child.returncode), flush=True)
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
    const root = await Deno.makeTempDir();
    buildRoot = root;
    const source = toFileUrl(await Deno.realPath("src/shared/remote/supervisor.ts")).href;
    await Deno.writeTextFile(join(root, "entry.ts"), entry.replace("./src/shared/remote/supervisor.ts", source));
    const executable = join(root, "supervisor");
    const result = await new Deno.Command(Deno.execPath(), {
        args: [
            "compile",
            "-A",
            "--no-check",
            "--config",
            new URL("../../../deno.json", import.meta.url).pathname,
            "--output",
            executable,
            join(root, "entry.ts"),
        ],
        stdout: "piped",
        stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    return binary = executable;
}

function sshfsStallTestDisabled(): boolean {
    return Deno.env.get("WLD_TEST_SSHFS_STALL") !== "1";
}

async function running(pid: number): Promise<boolean> {
    try {
        const text = await Deno.readTextFile(`/proc/${pid}/stat`);
        return !["Z", "X"].includes(text.slice(text.lastIndexOf(")") + 2, text.lastIndexOf(")") + 3));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

for (
    const scenario of [
        "blocked",
        "close",
        "kill-launcher",
        "before-header",
        "partial-header",
        "silent-control",
        "model-proof-stall",
    ]
) {
    Deno.test({
        name: `production supervisor cleans up on ${scenario} without stopping unrelated work`,
        // Opt in on a Linux host with working SSHFS and /dev/fuse, as in sftp-mount.test.ts.
        ignore: Deno.build.os !== "linux" || sshfsStallTestDisabled() || Deno.uid() === 0,
        fn: async () => {
            const executable = await compiledSupervisor();
            const root = await Deno.makeTempDir();
            await Deno.mkdir(join(getHomeDir(), ".wld"), { recursive: true });
            const sftp = await startLaptopSftp();
            const service = startRemoteControlService({ buildId: BUILD_ID, protocol: REMOTE_PROTOCOL_VERSION });
            const unrelated = new Deno.Command("sleep", { args: ["60"], stdout: "null", stderr: "null" }).spawn();
            const proxyAbort = new AbortController();
            const proxy = scenario === "silent-control"
                ? Deno.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    signal: proxyAbort.signal,
                    onListen() {},
                }, (request) => {
                    if (new URL(request.url).pathname === "/health") return new Response(new ReadableStream());
                    return fetch(`http://127.0.0.1:${service.port}${new URL(request.url).pathname}`, request);
                })
                : undefined;
            const port = proxy?.addr.transport === "tcp" ? proxy.addr.port : service.port;
            if (scenario === "model-proof-stall") await Deno.writeTextFile(join(root, "sentinel.txt"), "sentinel");
            const header = JSON.stringify({
                ...(scenario === "model-proof-stall"
                    ? { modelProof: { provider: "laptop-test", modelId: "model", sentinelFile: "sentinel.txt" } }
                    : {}),
                credential: service.credential,
                port,
                buildId: BUILD_ID,
                protocol: REMOTE_PROTOCOL_VERSION,
                view: { host: "host", cwd: root, status: "Connected", trust: "Trust", readiness: "No turns" },
                mount: sftp.header,
                remoteHome: await Deno.realPath(getHomeDir()),
                memoryCollection: "fixture@host-1234",
            });
            const driver = new Deno.Command("python3", {
                args: [
                    "-u",
                    "-c",
                    terminal,
                    executable,
                    root,
                    ["before-header", "partial-header"].includes(scenario) ? scenario : header,
                    String(port),
                ],
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
            }).spawn();
            let view = 0;
            let proof = 0;
            let descendant = 0;
            let supervisor = 0;
            try {
                const reader = driver.stdout.getReader();
                const ready = await reader.read();
                assertStringIncludes(new TextDecoder().decode(ready.value), "READY");
                supervisor = Number(await Deno.readTextFile(join(root, "supervisor")));
                if (scenario === "model-proof-stall") {
                    const deadline = Date.now() + 5_000;
                    while (Date.now() < deadline && !proof) {
                        proof = Number(await Deno.readTextFile(join(root, "proof")).catch(() => ""));
                        await new Promise((resolve) => setTimeout(resolve, 30));
                    }
                    assert(proof > 0 && proof !== supervisor, "proof did not run in its own process");
                }
                if (!["before-header", "partial-header", "model-proof-stall"].includes(scenario)) {
                    const deadline = Date.now() + 5_000;
                    while (Date.now() < deadline && !view) {
                        view = Number(await Deno.readTextFile(join(root, "view")).catch(() => ""));
                        await new Promise((resolve) => setTimeout(resolve, 30));
                    }
                    assert(view > 0);
                    assertEquals(await Deno.realPath(`/proc/${view}/cwd`), root);
                    const bootstrap = JSON.parse(await Deno.readTextFile(join(root, "view-header")));
                    assertEquals(bootstrap.connection, { port, credential: service.credential });
                    assertEquals(bootstrap.cwd, root);
                    assertEquals(bootstrap.view.cwd, root);
                    assert(bootstrap.resources.globalRoot.startsWith("/"));
                    assertEquals(bootstrap.resources.globalRoot === join(getHomeDir(), ".wld"), false);
                    assertEquals(bootstrap.HOME, undefined);
                    const descendantDeadline = Date.now() + 5_000;
                    while (Date.now() < descendantDeadline && !descendant) {
                        descendant = Number(await Deno.readTextFile(join(root, "descendant")).catch(() => ""));
                        await new Promise((resolve) => setTimeout(resolve, 30));
                    }
                    assert(descendant > 0);
                }
                // The launcher exits, but the detached SSH peer keeps its PTY open.
                // Closing this service models loss of the launcher's forwarded endpoint.
                if (["before-header", "partial-header"].includes(scenario)) await service.close();
                const writer = driver.stdin.getWriter();
                await writer.write(new TextEncoder().encode(
                    (["before-header", "partial-header", "silent-control"].includes(scenario) ? "wait" : scenario) +
                        "\n",
                ));
                await writer.close();
                const started = Date.now();
                if (["blocked", "model-proof-stall"].includes(scenario)) service.requestShutdown();
                const deadline = Date.now() +
                    (["silent-control", "before-header", "partial-header"].includes(scenario) ? 25_000 : 14_000);
                while (Date.now() < deadline && await running(supervisor)) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                assertEquals(await running(supervisor), false, `supervisor survived ${scenario}`);
                if (scenario === "blocked") {
                    assert(Date.now() - started >= 5_000, "forced exit skipped the grace period");
                }
                if (proof) assertEquals(await running(proof), false, `proof survived ${scenario}`);
                if (view) assertEquals(await running(view), false, `view survived ${scenario}`);
                if (descendant) assertEquals(await running(descendant), false, `grandchild survived ${scenario}`);
                assertEquals(await running(unrelated.pid), true);
                reader.releaseLock();
            } finally {
                if (supervisor && await running(supervisor)) Deno.kill(supervisor, "SIGKILL");
                if (proof && await running(proof)) Deno.kill(proof, "SIGKILL");
                if (view && await running(view)) Deno.kill(view, "SIGKILL");
                if (descendant && await running(descendant)) Deno.kill(descendant, "SIGKILL");
                try {
                    driver.kill("SIGKILL");
                } catch { /* Exited. */ }
                try {
                    unrelated.kill("SIGKILL");
                } catch { /* Exited. */ }
                proxyAbort.abort();
                await Promise.all([driver.status, unrelated.status, service.close(), proxy?.finished]);
                await sftp.close();
                await Deno.remove(root, { recursive: true });
                if (scenario === "silent-control" && buildRoot) {
                    await Deno.remove(buildRoot, { recursive: true });
                    binary = undefined;
                }
            }
        },
    });
}
