import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Socket } from "node:net";
import { getCwd } from "../../constants.js";
import { isStandaloneExecutable } from "../runtime-identity.ts";
import { listenSocket, readStreamInto, type SocketListener } from "../socket-listener.ts";
import { type NativeProcess, spawnNativeProcess } from "../foreground-process.ts";
import { realpath as fsRealpath, rm as fsRm } from "node:fs/promises";
/* Runs in the remote executable, independently of the TUI process. The
 * launcher delivers the private header through a separate non-terminal SSH
 * channel into an owned Unix socket, never through the terminal or a file. */

import type { RemoteConnectionViewConfig } from "../../ui/tui/remote-connection-view.ts";
import { terminateOwnedLinuxGroup } from "../foreground-process.ts";
import { type MountHeader, mountLaptopHome, type RemoteMount, validateMountHeader } from "./sftp-mount.ts";
import { parseRemoteModelProof, type RemoteModelProof } from "./model-proof-config.ts";

export interface RemoteSupervisorHeader {
    credential: string;
    port: number;
    buildId: string;
    protocol: number;
    view: RemoteConnectionViewConfig;
    mount: MountHeader;
    remoteHome: string;
    modelProof?: RemoteModelProof;
}

const encoder = new TextEncoder();
const PERIOD_MS = 5_000;

async function stty(...args: string[]): Promise<string> {
    const child = spawnNativeProcess("stty", {
        cwd: getCwd(),
        args,
        stdin: "inherit",
        stdout: "piped",
        stderr: "null",
    });
    const [result, stdout] = await Promise.all([child.status, new Response(child.stdout).text()]);
    if (!result.success) throw new Error("Remote supervisor requires a private SSH terminal");
    return stdout.trim();
}

async function readHeader(connection: Socket): Promise<RemoteSupervisorHeader> {
    const bytes: number[] = [];
    const buffer = new Uint8Array(1);
    while (bytes.length < 16 * 1024) {
        if (await readStreamInto(connection, buffer) === null) throw new Error("Missing remote supervisor header");
        if (buffer[0] === 10) {
            let header: RemoteSupervisorHeader;
            try {
                header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)));
            } catch {
                throw new Error("Invalid remote supervisor header");
            }
            if (
                !header || !/^[a-f0-9]{64}$/.test(header.credential) ||
                !/^[a-f0-9]{64}$/.test(header.buildId) ||
                !Number.isInteger(header.protocol) ||
                !Number.isInteger(header.port) || header.port < 1 || header.port > 65535 ||
                !header.view ||
                !["host", "cwd", "status", "trust", "readiness"].every((key) =>
                    typeof header.view[key as keyof RemoteConnectionViewConfig] === "string"
                )
            ) throw new Error("Invalid remote supervisor header");
            validateMountHeader(header.mount);
            if (header.modelProof !== undefined) {
                // The private header remains untrusted until identity and control handshake succeed.
                header.modelProof = parseRemoteModelProof(JSON.stringify(header.modelProof));
            }
            if (
                typeof header.remoteHome !== "string" || !header.remoteHome.startsWith("/") ||
                header.remoteHome.includes("\0")
            ) throw new Error("Invalid remote home");
            return header;
        }
        bytes.push(buffer[0]);
    }
    throw new Error("Remote supervisor header is too large");
}

async function control(
    header: RemoteSupervisorHeader,
    operation: string,
    body?: string,
    signal?: AbortSignal,
): Promise<boolean> {
    const response = await fetch(`http://127.0.0.1:${header.port}/${operation}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${header.credential}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4_000)]) : AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error("Remote control refused connection");
    const answer: { shutdown: boolean } = await response.json();
    if (typeof answer.shutdown !== "boolean") throw new Error("Invalid remote control reply");
    return answer.shutdown;
}

async function stopChild(child: NativeProcess, label: string): Promise<void> {
    try {
        if (!await terminateOwnedLinuxGroup(child)) {
            console.error(`Remote ${label} termination is unconfirmed; no stale group was signalled.`);
        }
    } catch (error) {
        console.error(`Remote ${label} cleanup could not be confirmed:`, error);
    }
}

async function runOwnedModelProof(
    header: RemoteSupervisorHeader,
    mount: RemoteMount,
    signal: AbortSignal,
): Promise<void> {
    const child = spawnNativeProcess(process.execPath, {
        args: ["--remote-model-proof"],
        cwd: header.view.cwd,
        stdin: "piped",
        stdout: "null",
        stderr: "null",
        detached: true,
    });
    let resolveAbort = () => {};
    const aborted = new Promise<undefined>((resolve) => {
        resolveAbort = () => resolve(undefined);
    });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= stopChild(child, "model proof");
    const onAbort = () => {
        resolveAbort();
        void stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const writer = child.stdin.getWriter();
    try {
        if (signal.aborted) onAbort();
        await writer.write(encoder.encode(
            JSON.stringify({
                proof: header.modelProof,
                connection: { port: header.port, credential: header.credential },
                cwd: header.view.cwd,
                mount: {
                    globalRoot: mount.globalRoot,
                    agentsRoot: mount.agentsRoot,
                    packageRoots: mount.packageRoots,
                },
            }) + "\n",
        ));
        // Keep stdin open as a parent-lifetime signal. A crashed supervisor
        // closes the pipe, and the proof process aborts its model request.
        const status = await Promise.race([child.status, aborted]);
        if (!signal.aborted && !status?.success) throw new Error("Remote model proof process failed");
    } catch (error) {
        await stop();
        throw error;
    } finally {
        signal.removeEventListener("abort", onAbort);
        void writer.abort().catch(() => undefined);
        if (signal.aborted) await stop();
    }
}

/**
 * Private --remote-supervisor entry. The launcher requests an SSH tty for
 * terminal data and uses a separate -T SSH channel for the private header.
 * Neither SSH command includes the credential. The tunnel uses -R
 * 127.0.0.1:<header.port>:127.0.0.1:<service.port>.
 */
export async function runRemoteSupervisor(): Promise<void> {
    if (
        !isStandaloneExecutable() || process.argv.slice(2).length !== 2 ||
        process.argv.slice(2)[0] !== "--remote-supervisor"
    ) {
        throw new Error("Remote supervisor requires its own compiled executable");
    }
    const setupPort = Number(process.argv.slice(2)[1]);
    if (!/^[1-9]\d*$/.test(process.argv.slice(2)[1]) || setupPort > 65535) {
        throw new Error("Invalid remote supervisor control port");
    }
    if (process.platform !== "linux") throw new Error("Remote supervisor requires Linux");
    const originalMode = await stty("-g");
    await stty("-echo");
    const socketDirectory = await mkdtemp(join(tmpdir(), "wld-remote-"));
    const socketPath = `${socketDirectory}/control.sock`;
    let listener: SocketListener;
    try {
        listener = await listenSocket({ path: socketPath });
    } catch (error) {
        await fsRm(socketDirectory, { recursive: true });
        await stty(originalMode).catch(() => undefined);
        throw error;
    }
    let child: NativeProcess | undefined;
    let personalMount: RemoteMount | undefined;
    let mountLost = false;
    let inputPump: NativeProcess | undefined;
    let inputPumpStopped = false;
    let childStopped = false;
    let stopActive: (() => void) | undefined;
    let childExited = false;
    let connection: Socket | undefined;
    const setupHealthAbort = new AbortController();
    // Owned by this connection, including the bootstrap proof before the view exists.
    const proofAbort = new AbortController();
    let setupHealthTimer: ReturnType<typeof setInterval> | undefined;
    let interrupted = false;
    const onEarlyClosure = () => {
        interrupted = true;
        proofAbort.abort();
        try {
            connection?.destroy();
        } catch { /* Read already settled. */ }
        try {
            listener.close();
        } catch { /* Already closed. */ }
        stopActive?.();
    };
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
        process.on(signal, onEarlyClosure);
    }
    try {
        // The marker contains only a locator in a mode-0700 temporary folder.
        // A banner cannot cause the terminal to echo a credential: the header
        // travels exclusively over the separate non-terminal SSH channel.
        console.log(`REMOTE_SUPERVISOR_READY:${socketPath}`);
        // Monitor the SSH terminal before waiting on the separate header channel.
        // A dead launcher cannot strand the supervisor in accept/readHeader.
        inputPump = spawnNativeProcess("cat", {
            cwd: getCwd(),
            args: [],
            stdin: "inherit",
            stdout: "piped",
            stderr: "null",
            detached: true,
        });
        const pump = inputPump;
        // The detached SSH peer can keep the PTY open after its laptop launcher
        // dies. Probe the forwarded laptop service before the private header
        // arrives; an unauthenticated health request must be refused with 401.
        // The port is a locator, not a credential, and the regular authenticated
        // health checks take over after header admission.
        let misses = 0;
        let checking = false;
        setupHealthTimer = setInterval(async () => {
            if (checking || interrupted) return;
            checking = true;
            try {
                const response = await fetch(`http://127.0.0.1:${setupPort}/health`, {
                    method: "POST",
                    signal: AbortSignal.any([setupHealthAbort.signal, AbortSignal.timeout(4_000)]),
                });
                if (response.status !== 401) throw new Error("Remote launcher control unavailable");
                misses = 0;
            } catch {
                if (!setupHealthAbort.signal.aborted && ++misses >= 3) onEarlyClosure();
            } finally {
                checking = false;
            }
        }, PERIOD_MS);
        const inputReader = pump.stdout.getReader();
        // deno-lint-ignore prefer-const -- The input monitor starts before the view exists.
        let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
        const input = (async () => {
            try {
                while (true) {
                    const { done, value } = await inputReader.read();
                    if (done) break;
                    if (writer) await writer.write(value);
                }
            } catch {
                /* TUI or terminal closed. */
            } finally {
                inputReader.releaseLock();
                onEarlyClosure();
            }
        })();
        let header: RemoteSupervisorHeader;
        try {
            connection = await listener.accept();
            header = await readHeader(connection);
        } finally {
            setupHealthAbort.abort();
            if (setupHealthTimer !== undefined) clearInterval(setupHealthTimer);
            try {
                connection?.destroy();
            } catch { /* Already closed. */ }
            try {
                listener.close();
            } catch { /* Already closed. */ }
            await fsRm(socketDirectory, { recursive: true });
        }
        if (interrupted) return;
        const { BUILD_ID, REMOTE_PROTOCOL_VERSION } = await import("../build-identity.js");
        if (header.buildId !== BUILD_ID || header.protocol !== REMOTE_PROTOCOL_VERSION) {
            throw new Error("Remote supervisor build identity mismatch");
        }
        if (
            await control(
                header,
                "handshake",
                JSON.stringify({ buildId: BUILD_ID, protocol: REMOTE_PROTOCOL_VERSION }),
            ) || interrupted
        ) {
            return;
        }
        // A missing mount or failed fresh read/write must never reach readiness.
        const accountHome = await fsRealpath((await import("../../constants.js")).getHomeDir());
        if (accountHome !== header.remoteHome) throw new Error("Remote account home changed before mount");
        personalMount = await mountLaptopHome(header.remoteHome, header.mount);
        // personalMount.globalRoot and personalMount.agentsRoot are private to this
        // connection. The connection-only view does not read personal resources;
        // do not replace HOME or send mount paths to that view.
        void personalMount.lost.then(() => {
            mountLost = true;
            proofAbort.abort();
            stopActive?.();
        });
        if (mountLost) throw new Error("Laptop personal mount lost; remote work stopped");
        if (interrupted) return;
        if (header.modelProof) {
            // The model bridge admits requests only after mount-backed readiness.
            try {
                if (await control(header, "readiness", undefined, proofAbort.signal)) {
                    proofAbort.abort();
                    return;
                }
            } catch (error) {
                if (mountLost) throw new Error("Laptop personal mount lost; remote work stopped");
                if (proofAbort.signal.aborted) return;
                throw error;
            }
            if (mountLost) throw new Error("Laptop personal mount lost; remote work stopped");
            if (proofAbort.signal.aborted) return;
            // The view health monitor does not exist yet. Keep launcher shutdown
            // and a lost forwarding channel observable during the live proof.
            let proofMisses = 0;
            let proofChecking = false;
            const proofHealthTimer = setInterval(async () => {
                if (proofChecking || proofAbort.signal.aborted) return;
                proofChecking = true;
                try {
                    if (await control(header, "health", undefined, proofAbort.signal)) proofAbort.abort();
                    else proofMisses = 0;
                } catch {
                    if (!proofAbort.signal.aborted && ++proofMisses >= 3) proofAbort.abort();
                } finally {
                    proofChecking = false;
                }
            }, PERIOD_MS);
            try {
                await runOwnedModelProof(header, personalMount, proofAbort.signal);
            } catch {
                if (mountLost) throw new Error("Laptop personal mount lost; remote work stopped");
                if (proofAbort.signal.aborted) return;
                // Neither a provider failure nor a local read error may expose private data on the tty.
                throw new Error("Remote model proof failed");
            } finally {
                clearInterval(proofHealthTimer);
            }
            if (mountLost) throw new Error("Laptop personal mount lost; remote work stopped");
            if (proofAbort.signal.aborted) return;
            console.log("REMOTE_MODEL_PROOF_OK");
        }
        if (mountLost) throw new Error("Laptop personal mount lost; remote work stopped");
        if (interrupted) return;
        // The tty supplies terminal bytes, while the child's stdin pipe supplies
        // one configuration line followed by live input. This preserves a
        // separate bootstrap channel and leaves the TUI free to consume input.
        await stty("raw", "-echo");
        child = spawnNativeProcess(process.execPath, {
            args: ["--remote-view"],
            cwd: header.view.cwd,
            stdin: "piped",
            stdout: "inherit",
            stderr: "inherit",
            detached: true,
        });
        const view = child;
        void view.status.then(() => {
            childExited = true;
        });
        writer = view.stdin.getWriter();
        await writer.write(encoder.encode(JSON.stringify(header.view) + "\n"));
        let stopped = false;
        const healthAbort = new AbortController();
        let wake: (() => void) | undefined;
        const ending = new Promise<void>((resolve) => {
            wake = resolve;
        });
        const stop = () => {
            stopped = true;
            proofAbort.abort();
            healthAbort.abort();
            wake?.();
        };
        stopActive = stop;
        if (mountLost) stop();
        const onSignal = () => stop();
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        process.on("SIGHUP", onSignal);
        // Admit terminal input only after the pump is running. The launcher
        // waits for readiness before showing the view or forwarding input.
        if (
            await control(header, "readiness", undefined, proofAbort.signal).catch((error) => {
                if (proofAbort.signal.aborted) return true;
                throw error;
            }) || interrupted || mountLost
        ) stop();
        const monitor = (async () => {
            let misses = 0;
            let nextCheck = Date.now() + PERIOD_MS;
            while (!stopped) {
                let checkTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        new Promise<void>((resolve) => {
                            checkTimer = setTimeout(resolve, Math.max(0, nextCheck - Date.now()));
                        }),
                        ending,
                    ]);
                } finally {
                    if (checkTimer !== undefined) clearTimeout(checkTimer);
                }
                if (stopped) break;
                nextCheck += PERIOD_MS;
                try {
                    if (await control(header, "health", undefined, healthAbort.signal)) {
                        stop();
                        break;
                    }
                    misses = 0;
                } catch {
                    if (stopped) break;
                    if (++misses >= 3) {
                        stop();
                        break;
                    }
                }
            }
        })();
        try {
            await Promise.race([view.status, ending]);
        } finally {
            stop();
            await monitor;
            // Neither a blocked input write nor pump cleanup can delay the
            // view's own five-second graceful/forced shutdown deadline.
            await Promise.all([
                childExited ? Promise.resolve() : stopChild(view, "TUI"),
                stopChild(pump, "terminal input"),
            ]);
            childStopped = true;
            inputPumpStopped = true;
            void writer.abort().catch(() => undefined);
            void input;
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            process.off("SIGHUP", onSignal);
            await control(header, "shutdown").catch(() => undefined);
        }
        if (mountLost) throw new Error("Laptop personal mount lost; remote work stopped");
    } finally {
        proofAbort.abort();
        setupHealthAbort.abort();
        if (setupHealthTimer !== undefined) clearInterval(setupHealthTimer);
        if (child && !childStopped && !childExited) await stopChild(child, "TUI").catch(() => undefined);
        if (inputPump && !inputPumpStopped) await stopChild(inputPump, "terminal input").catch(() => undefined);
        for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
            process.off(signal, onEarlyClosure);
        }
        try {
            listener.close();
        } catch { /* Already closed after admission. */ }
        await fsRm(socketDirectory, { recursive: true }).catch(() => undefined);
        if (personalMount) {
            await personalMount.close().catch((error) => console.error("Remote mount cleanup failed:", error));
        }
        await stty(originalMode).catch(() => undefined);
    }
}
