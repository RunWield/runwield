import process from "node:process";
import { getCwd } from "../../constants.js";
import { type NativeProcess, spawnNativeProcess } from "../../shared/foreground-process.ts";
import { readableStdin } from "../../shared/stdin-stream.ts";
import { readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
/* CLI-only remote connection. SSH supplies authentication, host verification and
 * terminal transport. No project or personal context is opened on the laptop. */
import { dirname, join } from "node:path";
import { linuxTarget, prepareRemoteRuntime } from "../../shared/remote/runtime.js";
import { fixedPythonCommand, resolveRemoteTarget } from "../../shared/remote/target.ts";
import { type MountHeader, startLaptopSftp } from "../../shared/remote/sftp-mount.ts";
import { VERSION } from "../../shared/version.js";
import { downloadReleaseRuntime } from "../../shared/remote/release-artifact.ts";
import { parseRemoteModelProof, type RemoteModelProof } from "../../shared/remote/model-proof-config.ts";

export const REMOTE_USAGE =
    "Usage: wld remote <ssh-host>[:<remote-directory>]\n" +
    "Open an existing remote Linux directory (defaults to the remote home). Laptop ~/.wld is mounted at remote ~/.wld.\n" +
    "Released launchers use their exact VERSION-tagged GNU/Linux asset; development builds require a matching local artifact.\n" +
    "This connection cannot accept a user turn or open a saved Session.";

export function parseRemoteDestination(value: string): { host: string; path: string | null } {
    if (!value || value.startsWith("-") || value.includes("\0")) {
        throw new Error("Invalid SSH destination");
    }
    // Bracketed IPv6 and ordinary OpenSSH aliases remain intact. The first
    // colon outside brackets separates only the remote path.
    let bracket = false;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === "[") bracket = true;
        else if (value[i] === "]") bracket = false;
        else if (value[i] === ":" && !bracket) {
            const host = value.slice(0, i);
            // deno-lint-ignore no-control-regex -- SSH destinations must not contain control or whitespace characters.
            if (!host || host.startsWith("-") || /[\x00-\x20\x7f]/.test(host)) {
                throw new Error("Invalid SSH destination");
            }
            return { host, path: value.slice(i + 1) || null };
        }
    }
    if (bracket) throw new Error("Invalid SSH destination");
    // deno-lint-ignore no-control-regex -- SSH destinations must not contain control or whitespace characters.
    if (/[\x00-\x20\x7f]/.test(value)) throw new Error("Invalid SSH destination");
    return { host: value, path: null };
}

/** Never join or resolve a remote locator through laptop path functions. */
function remoteExecutable(buildId: string, target: string, checksum: string): string {
    if (
        !/^[a-f0-9]{64}$/.test(buildId) ||
        !/^[a-f0-9]{64}$/.test(checksum) ||
        !["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"].includes(target)
    ) {
        throw new Error("Invalid remote runtime identity");
    }
    return `"$HOME/.cache/runwield/runtime/${buildId}/${target}/${checksum}/wld"`;
}

async function writeTerminal(bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
}

async function stopOwnedSsh(child: NativeProcess, settled: () => boolean): Promise<void> {
    if (settled()) return;
    const graceful = await Promise.race([
        child.status.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!graceful && !settled()) {
        // Only our detached SSH group is eligible; its remote peer also has
        // independent health and terminal-closure monitoring.
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            try {
                child.kill("SIGKILL");
            } catch {
                /* Exited. */
            }
        }
    }
    await child.status;
}

// This fixed program accepts private data only through SSH stdin. Its remote
// shell command contains no user-supplied text, socket locator, or credential.
const DELIVER_HEADER = fixedPythonCommand(String.raw`import json, os, socket, stat, sys
request = json.loads(sys.stdin.buffer.readline())
path = request['socket']
folder = os.path.dirname(path)
info = os.lstat(folder)
entry = os.lstat(path)
if not os.path.isabs(path) or os.path.basename(path) != 'control.sock' or not os.path.basename(folder).startswith('wld-remote-') or not stat.S_ISDIR(info.st_mode) or (info.st_mode & 0o077) or info.st_uid != os.getuid() or not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.getuid():
    raise ValueError('Unsafe connection control socket')
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
    channel.settimeout(15)
    channel.connect(path)
    channel.sendall(json.dumps(request['header']).encode() + b'\n')
`);

/** Wait for the non-secret socket locator; never send a credential to the tty. */
async function waitForReady(
    reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ socket: string; remainder: Uint8Array }> {
    const marker = "REMOTE_SUPERVISOR_READY:";
    let accumulated = new Uint8Array();
    while (accumulated.length < 32_768) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Remote supervisor ended before readiness");
        const next = new Uint8Array(accumulated.length + value.length);
        next.set(accumulated);
        next.set(value, accumulated.length);
        accumulated = next;
        const text = new TextDecoder().decode(accumulated);
        const index = text.indexOf(marker);
        if (index >= 0) {
            const lineEnd = text.indexOf("\n", index);
            if (lineEnd >= 0) {
                const socket = text.slice(index + marker.length, lineEnd).trim();
                if (!/^\/[\w./-]*\/wld-remote-[\w-]+\/control\.sock$/.test(socket)) {
                    throw new Error("Invalid remote control socket locator");
                }
                const offset = new TextEncoder().encode(text.slice(0, lineEnd + 1)).length;
                return { socket, remainder: accumulated.subarray(offset) };
            }
        }
    }
    throw new Error("Remote supervisor did not reach readiness");
}

async function sendPrivateHeader(
    host: string,
    socket: string,
    signal: AbortSignal,
    header: {
        credential: string;
        port: number;
        buildId: string;
        protocol: number;
        view: { host: string; cwd: string; status: string; trust: string; readiness: string };
        mount: MountHeader;
        remoteHome: string;
        modelProof?: RemoteModelProof;
    },
): Promise<void> {
    const child = spawnNativeProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", host, DELIVER_HEADER],
        signal,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const output = Promise.all([child.status, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    try {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(JSON.stringify({ socket, header }) + "\n"));
        await writer.close();
        const [status, , stderr] = await output;
        if (!status.success) {
            throw new Error(
                `Private SSH control channel failed: ${
                    stderr.trim().replaceAll(header.credential, "[redacted]") || status.code
                }`,
            );
        }
    } catch (error) {
        try {
            child.kill();
        } catch {
            /* Already exited. */
        }
        await output.catch(() => undefined);
        throw error;
    }
}

/** @param {string[]} args */
export async function runRemoteCommand(args: string[]): Promise<void> {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
        console.log(REMOTE_USAGE);
        return;
    }
    if (args.length !== 1) throw new Error(REMOTE_USAGE);
    const { host, path } = parseRemoteDestination(args[0]);
    const proofEnv = process.env.WLD_REMOTE_MODEL_PROOF;
    const modelProof = proofEnv === undefined ? undefined : parseRemoteModelProof(proofEnv);
    let identity: { BUILD_ID: string; REMOTE_PROTOCOL_VERSION: number };
    try {
        identity = await import("../../shared/build-identity.js");
    } catch (error) {
        const missingIdentity =
            error instanceof Error &&
            error.message.includes("build-identity.js") &&
            (error instanceof TypeError ||
                ("code" in error && ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(String(error.code))));
        if (!missingIdentity) throw error;
        throw new Error(
            "No launcher build identity. Build the launcher and matching Linux artifact explicitly with bun run compile --output bin/wld.",
        );
    }
    const { BUILD_ID, REMOTE_PROTOCOL_VERSION } = identity;
    const setupAbort = new AbortController();
    const cancelSetup = () => setupAbort.abort();
    process.on("SIGINT", cancelSetup);
    process.on("SIGTERM", cancelSetup);
    let target: Awaited<ReturnType<typeof resolveRemoteTarget>>;
    let triple: string;
    let executable: string;
    let metadata: { sha256: string };
    try {
        target = await resolveRemoteTarget(host, path, "ssh", setupAbort.signal);
        triple = linuxTarget(target);
        const suffix = triple === "x86_64-unknown-linux-gnu" ? "linux-x64" : "linux-arm64";
        // Released launchers never substitute a development or latest asset.
        const release = VERSION.startsWith("v")
            ? await downloadReleaseRuntime(
                  VERSION,
                  suffix,
                  {
                      buildId: BUILD_ID,
                      protocol: REMOTE_PROTOCOL_VERSION,
                      version: VERSION,
                  },
                  setupAbort.signal,
              )
            : null;
        const artifact = release?.artifact ?? join(dirname(process.execPath), `wld-${triple}`);
        try {
            ({ path: executable } = await prepareRemoteRuntime(host, target, artifact, "ssh", setupAbort.signal));
            metadata = JSON.parse(await fsReadFile(`${artifact}.build.json`, "utf8"));
        } finally {
            if (release) await fsRm(release.directory, { recursive: true });
        }
        if (setupAbort.signal.aborted) throw new Error("Remote connection canceled");
    } finally {
        process.off("SIGINT", cancelSetup);
        process.off("SIGTERM", cancelSetup);
    }
    // An untrusted SSH reply is never executed. Compare the exact private cache
    // path generated from the known identity and the local verified checksum.
    const expected = `${target.home}/.cache/runwield/runtime/${BUILD_ID}/${triple}/${metadata.sha256}/wld`;
    if (executable !== expected) throw new Error("Remote runtime returned an unexpected cache path");
    const { startRemoteControlService } = await import("../../shared/remote/control.ts");
    const sftp = await startLaptopSftp();
    let service: ReturnType<typeof startRemoteControlService>;
    try {
        service = startRemoteControlService({ buildId: BUILD_ID, protocol: REMOTE_PROTOCOL_VERSION });
    } catch (error) {
        await sftp.close();
        throw error;
    }
    let child: NativeProcess | undefined;
    let exited = false;
    let raw = false;
    let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let interrupted = false;
    const connectionAbort = new AbortController();
    const onInterrupt = () => {
        interrupted = true;
        connectionAbort.abort();
        service.requestShutdown();
        try {
            child?.kill("SIGTERM");
        } catch {
            /* Already exited. */
        }
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    try {
        const command = `exec ${remoteExecutable(
            BUILD_ID,
            triple,
            metadata.sha256,
        )} --remote-supervisor ${service.port}`;
        child = spawnNativeProcess("ssh", {
            cwd: getCwd(),
            args: [
                "-tt",
                "-o",
                "ExitOnForwardFailure=yes",
                "-R",
                `127.0.0.1:${service.port}:127.0.0.1:${service.port}`,
                "-R",
                `127.0.0.1:${sftp.header.sftpPort}:127.0.0.1:${sftp.header.sftpPort}`,
                "--",
                host,
                command,
            ],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
            ...(process.platform === "win32" ? {} : { detached: true }),
        });
        const ssh = child;
        const status = ssh.status.then((result) => {
            exited = true;
            return result;
        });
        const stderr = new Response(ssh.stderr).text();
        const output = ssh.stdout.getReader();
        // OpenSSH may need a real host-key or authentication prompt. Do not
        // impose a short startup deadline on the user's configured SSH flow.
        const ready = await Promise.race([
            waitForReady(output),
            status.then(() => {
                throw new Error("SSH ended before remote startup");
            }),
        ]);
        await sendPrivateHeader(host, ready.socket, connectionAbort.signal, {
            credential: service.credential,
            port: service.port,
            buildId: BUILD_ID,
            protocol: REMOTE_PROTOCOL_VERSION,
            mount: sftp.header,
            remoteHome: target.home,
            ...(modelProof ? { modelProof } : {}),
            view: {
                host,
                cwd: target.cwd,
                status: "Connected; laptop personal files mounted",
                trust: "OpenSSH SFTP exposes laptop-account files, not a sandbox. No Session access is open.",
                readiness: "Personal files available; no user turns or saved Sessions in this connection.",
            },
        });
        const writer = ssh.stdin.getWriter();
        while (!exited && !interrupted && !service.status().ready && !service.status().shutdown) {
            await Promise.race([status, new Promise((resolve) => setTimeout(resolve, 100))]);
        }
        if (!service.status().ready) {
            await stopOwnedSsh(ssh, () => exited);
            let outputDetail = new TextDecoder().decode(ready.remainder);
            while (outputDetail.length < 8192) {
                const { done, value } = await output.read();
                if (done) break;
                outputDetail += new TextDecoder().decode(value);
            }
            output.releaseLock();
            const detail = `${outputDetail}\n${await stderr}`
                .trim()
                .replaceAll(service.credential, "[redacted]")
                .replaceAll(sftp.header.sftpSecret, "[redacted]");
            throw new Error(`Remote connection did not become ready: ${detail || "remote supervisor exited"}`);
        }
        // Only terminal bytes ever enter the interactive SSH channel.
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            raw = true;
        }
        const terminalInput = readableStdin().getReader();
        inputReader = terminalInput;
        const input = (async () => {
            try {
                while (!exited && !interrupted) {
                    const { done, value } = await terminalInput.read();
                    if (done) break;
                    await writer.write(value);
                }
            } catch {
                /* Terminal or SSH closed. */
            }
            if (!exited) {
                interrupted = true;
                service.requestShutdown();
            }
        })();
        void input.catch(() => undefined);
        const terminalOutput = (async () => {
            try {
                if (ready.remainder.length) await writeTerminal(ready.remainder);
                while (true) {
                    const { done, value } = await output.read();
                    if (done) break;
                    await writeTerminal(value);
                }
            } finally {
                output.releaseLock();
            }
        })();
        while (!exited && !interrupted && !service.status().shutdown) {
            await Promise.race([status, new Promise((resolve) => setTimeout(resolve, 1_000))]);
        }
        service.requestShutdown();
        await stopOwnedSsh(ssh, () => exited);
        await terminalOutput;
        const result = await status;
        const errors = await stderr;
        if (!result.success && !interrupted) {
            throw new Error(`Remote connection ended: ${errors.trim() || result.code}`);
        }
        if (service.status().shutdown && !exited) throw new Error("Remote control lost; termination uncertain");
    } finally {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onInterrupt);
        service.requestShutdown();
        if (child) {
            await stopOwnedSsh(child, () => exited).catch(() =>
                console.error("Remote SSH exit could not be confirmed"),
            );
        }
        await service.close();
        await sftp.close();
        if (raw) process.stdin.setRawMode(false);
        // A pending terminal read otherwise keeps the launcher alive after
        // SSH and the remote TUI have both exited.
        if (inputReader) {
            await inputReader.cancel().catch(() => {});
            inputReader.releaseLock();
        }
    }
}
