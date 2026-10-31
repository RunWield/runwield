import { createReadStream } from "node:fs";
import { connect as connectSocket } from "node:net";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { compileBun } from "../../../scripts/compile-bun.ts";
import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    mkdir as fsMkdir,
    writeFile as fsWriteFile,
    stat as fsStat,
    chmod as fsChmod,
} from "node:fs/promises";
import { join } from "node:path";
import { spawnNativeProcess } from "../foreground-process.ts";
import { serveHttp } from "../http-server.ts";
import { getCwd } from "../../constants.js";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";

import process from "node:process";

/** Bounded live qualification. Run with: bun run src/shared/remote/verify-remote-session-save.ts */

async function main() {
    // Storage settings precede every Session, model, and settings import.
    const root = await fsMkdtemp(join(tmpdir(), "wld-session-live-"));
    const sourceRoot = getCwd();
    const cache = process.env["DENO_DIR"];
    const path = process.env["PATH"] ?? "/usr/bin:/bin";
    for (const key of Object.keys({ ...process.env })) delete process.env[key];
    process.env["PATH"] = path;
    process.env["HOME"] = `${root}/home`;
    process.env["MNEMOTECA_DB_PATH"] = `${root}/memory.sqlite3`;
    if (cache) process.env["DENO_DIR"] = cache;
    await fsMkdir(`${root}/home`);
    const events: string[] = [];
    async function record<T>(label: string, value: T) {
        const text = JSON.stringify({ label, value });
        events.push(text);
        await fsWriteFile(`${root}/evidence.jsonl`, events.join("\n") + "\n");
        console.log(text);
    }
    await record("owned-local-scratch", root);
    const { createHash } = await import("node:crypto");
    const { makeControlFixture, deferred, within } = await import("./session-save-test-fixture.ts");
    const { makeSaveModelRuntime } = await import("./session-save-agent-fixture.ts");
    const { LocalModelBridge, handleModelRequest } = await import("./model-bridge.ts");
    const { parseRemoteSessionTranscript } = await import("./session-protocol.ts");

    interface LiveReply {
        entries?: number;
        effects?: number;
        file?: string | null;
        roles?: string[];
        summary?: string;
        failed?: boolean;
        readStopped?: boolean;
        writeStopped?: boolean;
        checkpointStopped?: boolean;
        samples?: SaveSample[];
        hydratedContents?: string;
        stopped?: boolean;
        stopMs?: number;
        childPid?: number;
        supervisorPid?: number;
        childCode?: number;
        stdout?: string;
        stderr?: string;
    }
    interface SaveSample {
        kind: string;
        sequence: number;
        latencyMs: number;
        accepted: boolean;
    }
    function replies(text: string): LiveReply[] {
        return text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }
    function quote(text: string) {
        return `'${text.replaceAll("'", "'\\''")}'`;
    }
    async function command(executable: string, args: string[], timeoutMs = 180_000) {
        const child = spawnNativeProcess(executable, {
            cwd: sourceRoot,
            stdout: "piped",
            stderr: "piped",
            args,
            stdin: "null",
        });
        try {
            const output = await within(collectProcessOutput(child), timeoutMs);
            const stdout = new TextDecoder().decode(output.stdout);
            const stderr = new TextDecoder().decode(output.stderr);
            assertEquals(output.code, 0, stderr);
            return { stdout, stderr };
        } finally {
            try {
                child.kill("SIGKILL");
            } catch {
                /* Exited. */
            }
            await child.status;
        }
    }
    async function ssh(shell: string) {
        return await command("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "sct", shell]);
    }
    async function hash(file: string) {
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(file)) hash.update(bytes);
        return hash.digest("hex");
    }
    let remoteRoot = "";
    let remotePort = 0;
    let localPort = 0;
    let nativeControlPort = 0;
    let tunnel: import("../foreground-process.ts").NativeProcess | undefined;
    let tunnelOutput: ReturnType<typeof collectProcessOutput> | undefined;
    let fixture: Awaited<ReturnType<typeof makeControlFixture>> | undefined;
    let server: ReturnType<typeof serveHttp> | undefined;
    let modelBridge: InstanceType<typeof LocalModelBridge> | undefined;
    const release = deferred();
    const stalled = deferred();
    let stall = false;
    const processes: import("../foreground-process.ts").NativeProcess[] = [];
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    let healthInFlight = Promise.resolve();
    async function cleanup() {
        release.resolve();
        clearInterval(healthTimer);
        await healthInFlight;
        for (const child of processes) {
            try {
                child.kill("SIGTERM");
            } catch {
                /* Exited. */
            }
            await child.status;
        }
        try {
            tunnel?.kill("SIGTERM");
        } catch {
            /* Exited. */
        }
        if (tunnelOutput) await within(tunnelOutput, 10_000);
        if (server) await server.shutdown();
        modelBridge?.close();
        if (fixture) await fixture.close();
        for (const port of [localPort, nativeControlPort].filter(Boolean)) {
            try {
                const connection = await new Promise<import("node:net").Socket>((resolve, reject) => {
                    const socket = connectSocket({ host: "127.0.0.1", port });
                    socket.once("connect", () => resolve(socket));
                    socket.once("error", reject);
                });
                connection.destroy();
                throw new Error(`Owned local listener remains: ${port}`);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ECONNREFUSED")) throw error;
            }
        }
        if (remoteRoot) {
            const inspected = await ssh(
                `~/.bun/bin/bun --eval ${quote(
                    `const binary=${JSON.stringify(
                        remoteRoot + "/client",
                    )}; const {readdir,readlink}=await import("node:fs/promises"); const pids=[]; for(const entry of await readdir("/proc",{withFileTypes:true})){if(!/^[0-9]+$/.test(entry.name))continue; try{if(await readlink("/proc/"+entry.name+"/exe")===binary)pids.push(Number(entry.name))}catch{}} if(pids.length)throw new Error("Owned remote processes remain: "+pids); const port=${remotePort}; if(port){try{const {connect}=await import("node:net"); const c=await new Promise((resolve,reject)=>{const socket=connect({host:"127.0.0.1",port});socket.once("connect",()=>resolve(socket));socket.once("error",reject)});c.destroy();throw new Error("Owned forwarded listener remains")}catch(e){if(!(e.code === "ECONNREFUSED"))throw e}} console.log(JSON.stringify({ownedProcesses:pids,forwardedListenerClosed:true}));`,
                )}`,
            );
            await record("cleanup-remote-processes-and-listener", inspected);
            const cleanup = await ssh(
                `~/.bun/bin/bun --eval ${quote(
                    `const root=${JSON.stringify(
                        remoteRoot,
                    )}; const {rm,stat}=await import("node:fs/promises"); await rm(root,{recursive:true}); try{await stat(root); throw new Error("Owned scratch still exists")}catch(e){if(!(e.code === "ENOENT"))throw e} console.log("owned remote scratch removed")`,
                )}`,
            );
            await record("cleanup-remote", cleanup);
        }
        await record("cleanup-local", {
            ownedClientsSettled: processes.length,
            ownerServiceClosed: true,
            evidenceRetained: root,
        });
    }
    try {
        await record("runtimes", {
            local: process.versions,
            remote: (await ssh("uname -sm; ~/.bun/bin/bun --version")).stdout,
        });
        const binary = process.argv.slice(2)[0] ?? `${root}/session-client-linux-x64`;
        const build = process.argv.slice(2)[0]
            ? { stdout: "Reuse recorded compiled verification artifact", stderr: "" }
            : await compileBun(
                  binary,
                  "bun-linux-x64",
                  undefined,
                  undefined,
                  "src/shared/remote/session-save-live-client.ts",
              ).then(() => ({ stdout: "Compiled Bun verification client", stderr: "" }));
        await record("compile", build);
        const artifactHash = await hash(binary);
        await record("artifact", { path: binary, sha256: artifactHash, bytes: (await fsStat(binary)).size });
        remoteRoot = (await ssh("umask 077; mktemp -d /tmp/wld-session-live-XXXXXXXXXX")).stdout.trim();
        assert(/^\/tmp\/wld-session-live-[a-zA-Z0-9]+$/.test(remoteRoot));
        await record("owned-remote-scratch", remoteRoot);
        await fsChmod(binary, 0o700);
        await command("rsync", ["-az", binary, `sct:${remoteRoot}/client`], 300_000);
        const remoteHash = (await ssh(`sha256sum ${quote(`${remoteRoot}/client`)}`)).stdout.split(/\s/)[0];
        assertEquals(remoteHash, artifactHash);
        await record("remote-artifact", { sha256: remoteHash });
        await ssh(
            `~/.bun/bin/bun --eval ${quote(
                `const {mkdir}=await import("node:fs/promises"); for (const name of ["home", "mount", "project", "tmp"]) await mkdir(${JSON.stringify(
                    remoteRoot,
                )} + "/" + name);`,
            )}`,
        );
        fixture = await makeControlFixture();
        const f = fixture;
        await record("owned-laptop-store-scratch", {
            root: f.root,
            baseDir: f.baseDir,
            transcriptPath: f.transcriptPath,
        });
        nativeControlPort = f.control.port;
        await f.ready();
        healthTimer = setInterval(() => {
            healthInFlight = f
                .post("/health", "")
                .then((reply) => reply.text())
                .then(() => undefined);
        }, 1000);
        const contexts: string[] = [];
        modelBridge = new LocalModelBridge(await makeSaveModelRuntime(contexts));
        const models = modelBridge;
        server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            if (request.headers.get("Authorization") !== `Bearer ${f.control.credential}`) {
                return new Response(null, { status: 401 });
            }
            const pathname = new URL(request.url).pathname;
            if (pathname.startsWith("/models/")) return await handleModelRequest(models, request, pathname);
            const body = await request.text();
            const response = await fetch(`${f.baseUrl}${pathname}`, { method: "POST", headers: request.headers, body });
            if (stall && pathname === "/session/request" && JSON.parse(body).kind === "append") {
                const bytes = await response.text();
                assertEquals(response.status, 200);
                stalled.resolve();
                await release.promise;
                return new Response(bytes);
            }
            return response;
        });
        assert(server.addr.transport === "tcp");
        localPort = server.addr.port;
        remotePort = Number(
            (
                await ssh(
                    '~/.bun/bin/bun --eval \'const {createServer}=await import("node:net"); const l=createServer(); await new Promise(resolve=>l.listen(0,"127.0.0.1",resolve)); console.log(l.address().port); l.close()\'',
                )
            ).stdout.trim(),
        );
        assert(Number.isSafeInteger(remotePort) && remotePort > 0);
        await record("owned-listeners", { localPort, nativeControlPort, remotePort });
        const startTunnel = () => {
            tunnel = spawnNativeProcess("ssh", {
                args: [
                    "-N",
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-R",
                    `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
                    "sct",
                ],
                stdout: "piped",
                stderr: "piped",
                cwd: getCwd(),
                stdin: "null",
            });
            tunnelOutput = collectProcessOutput(tunnel);
        };
        const stopTunnel = async () => {
            try {
                tunnel?.kill("SIGTERM");
            } catch {
                /* Exited. */
            }
            if (tunnelOutput) await within(tunnelOutput, 10_000);
            tunnel = undefined;
            tunnelOutput = undefined;
        };
        const tunnelReady = async () => {
            for (let attempt = 0; attempt < 15; attempt++) {
                try {
                    const probe = await ssh(
                        `~/.bun/bin/bun --eval ${quote(
                            `const r=await fetch("http://127.0.0.1:${remotePort}/readiness",{method:"POST"}); console.log(r.status)`,
                        )}`,
                    );
                    if (probe.stdout.trim() === "401") return;
                } catch {
                    /* SSH reverse listener can take a moment. */
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            throw new Error("SSH reverse listener did not become ready");
        };
        const remoteShell = `cd ${quote(`${remoteRoot}/project`)} && exec env -i TMPDIR=${quote(
            `${remoteRoot}/tmp`,
        )} HOME=${quote(`${remoteRoot}/home`)} MNEMOTECA_DB_PATH=${quote(
            `${remoteRoot}/memory.sqlite3`,
        )} PATH=/usr/bin:/bin ${quote(`${remoteRoot}/client`)}`;
        const client = (
            mode: string,
            owner: import("../session/file-session-store.ts").RemoteSessionOwner,
            supervisor = false,
            timeoutMs = 5000,
        ) => {
            const child = spawnNativeProcess("ssh", {
                args: ["-T", "-o", "BatchMode=yes", "sct", remoteShell + (supervisor ? " --supervisor" : "")],
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
                cwd: getCwd(),
            });
            processes.push(child);
            const output = collectProcessOutput(child);
            const writer = child.stdin.getWriter();
            const sent = writer.write(
                new TextEncoder().encode(
                    JSON.stringify({
                        mode,
                        measure: true,
                        connection: {
                            baseUrl: `http://127.0.0.1:${remotePort}`,
                            credential: f.control.credential,
                            operation: owner.operation,
                            timeoutMs,
                        },
                        modelConnection: { port: remotePort, credential: f.control.credential },
                        cwd: `${remoteRoot}/project`,
                        home: `${remoteRoot}/home`,
                        mount: `${remoteRoot}/mount`,
                        marker: `${remoteRoot}/project/effect-marker`,
                    }) + "\n",
                ),
            );
            return {
                child,
                async result() {
                    await sent;
                    await writer.close();
                    writer.releaseLock();
                    const result = await within(output, 60_000);
                    const stdout = new TextDecoder().decode(result.stdout);
                    const stderr = new TextDecoder().decode(result.stderr);
                    assertEquals(result.code, 0, stderr);
                    return { stdout, stderr, parsed: replies(stdout) };
                },
                async stop() {
                    await sent;
                    const start = performance.now();
                    await writer.write(new TextEncoder().encode("stop\n"));
                    await writer.close();
                    writer.releaseLock();
                    const result = await within(output, 10_000);
                    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
                    return {
                        elapsedMs: performance.now() - start,
                        parsed: replies(new TextDecoder().decode(result.stdout)),
                    };
                },
            };
        };
        const nextOwner = () => {
            const state = f.store.inspectSessionActivation(f.session.runwieldSessionId);
            const proof = f.store.acquireSessionActivation({
                runwieldSessionId: f.session.runwieldSessionId,
                projectId: f.session.projectId,
                ownerInstanceId: "live-laptop",
                ownerProcessKind: "test",
                phase: "preparing",
                expectedGeneration: state.generation?.generation ?? null,
            });
            const owner = f.store.createRemoteSessionOwner(proof);
            f.control.registerSessionOperation(owner.operation);
            return owner;
        };
        startTunnel();
        await tunnelReady();
        const full = await client("turn", f.owner).result();
        await record("full-remote-turn", full);
        assertEquals(full.parsed[0].effects, 1);
        assertEquals(full.parsed[0].file, null);
        assertEquals(full.parsed[0].roles, ["system", "user", "assistant", "toolResult", "assistant"]);
        assert(full.parsed[0].summary?.includes("Actual compaction summary"));
        assert(contexts.some((context) => context.includes("remote-effect-complete")));
        const saved = f.owner.inspect().contents;
        await fsWriteFile(`${root}/laptop-full-turn.jsonl`, saved);
        await record("laptop-evidence", {
            digest: createHash("sha256").update(saved).digest("hex"),
            entries: parseRemoteSessionTranscript(saved).length - 1,
        });
        await stopTunnel();
        startTunnel();
        await tunnelReady();
        const fresh = nextOwner();
        const requestsBeforeReload = contexts.length;
        const reload = await client("reload", fresh).result();
        assertEquals(contexts.length, requestsBeforeReload);
        assertEquals(reload.parsed[1].hydratedContents, saved);
        await record("fresh-ssh-rehydrate-no-replay", reload);
        assertEquals((await ssh(`cat ${quote(`${remoteRoot}/project/effect-marker`)}`)).stdout, "effect\n");
        const faultOwner = nextOwner();
        stall = true;
        const blocked = client("fault", faultOwner, false, 1500);
        await within(stalled.promise, 20_000);
        const faultResult = await blocked.result();
        assertEquals(faultResult.parsed[0].failed, true);
        assertEquals(faultResult.parsed[0].checkpointStopped, true);
        assert(
            faultResult.parsed[1].samples?.some(
                (sample) => !sample.accepted && sample.latencyMs >= 1400 && sample.latencyMs < 4000,
            ),
        );
        await record("finite-blocked-save", faultResult);
        faultOwner.markUncertain();
        faultOwner.recoverUncertain();
        const stopOwner = nextOwner();
        const beforeStop = stopOwner.inspect().contents;
        const stopping = client("fault", stopOwner, true, 15000);
        // Inspect current laptop evidence against the immutable pre-launch snapshot.
        for (
            let attempt = 0;
            !stopOwner.inspect().contents.includes('"effect":"already finished"') ||
            stopOwner.inspect().contents === beforeStop;
            attempt++
        ) {
            if (attempt > 1000) throw new Error("Supervised save did not reach laptop");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const stopped = await stopping.stop();
        assert(stopped.parsed.some((reply) => reply.stopped));
        assert(stopped.elapsedMs < 14000);
        assertEquals(
            stopped.parsed.at(-1)?.stdout,
            "",
            "Stop must finish while the save is still blocked, before its deadline",
        );
        await record("independent-process-group-stop", stopped);
        stopOwner.markUncertain();
        stopOwner.recoverUncertain();
        release.resolve();
        stall = false;
        const recovered = nextOwner();
        const exact = recovered.inspect().contents;
        const requestsBeforeRecovery = contexts.length;
        const recoveredResult = await client("reload", recovered).result();
        assertEquals(contexts.length, requestsBeforeRecovery);
        assertEquals(recoveredResult.parsed[1].hydratedContents, exact);
        assertEquals((await ssh(`cat ${quote(`${remoteRoot}/project/effect-marker`)}`)).stdout, "effect\n");
        await record("post-fault-fresh-operation-no-effect-replay", recoveredResult);
        await fsWriteFile(`${root}/laptop-recovered.jsonl`, exact);
        const scan = await ssh(
            `~/.bun/bin/bun --eval ${quote(
                `const root=${JSON.stringify(
                    remoteRoot,
                )}; const {readdir}=await import("node:fs/promises"); const files=[]; async function walk(path){ for(const entry of await readdir(path,{withFileTypes:true})){const p=path+"/"+entry.name; if(entry.isDirectory()) await walk(p); else files.push(p.slice(root.length+1));}} await walk(root); console.log(JSON.stringify(files.sort()));`,
            )}`,
        );
        const files: string[] = JSON.parse(scan.stdout);
        // The compiled Bun client must not persist Session history on the remote host.
        assertEquals(files, ["client", "project/effect-marker"]);
        assert(files.every((file) => !file.endsWith(".jsonl")));
        await record("remote-no-jsonl-no-personal-mount-writes", files);
        await stopTunnel();
        await record("qualification-result", {
            passed: true,
            limits: [
                "Synthetic laptop provider, no paid provider",
                "Native macOS Bun owner, Linux-x64 compiled client",
                "No normal remote TUI/resume or mount implementation qualification",
                "Application sync is not a power-loss claim",
                "Harness maintains control health through authenticated local HTTP",
                "Independent stop uses the existing five-second process-group grace; the blocked save deadline is 15 seconds",
            ],
        });
    } catch (error) {
        await record("failure", {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : "",
        });
        throw error;
    } finally {
        await cleanup();
    }
}

if (import.meta.main) await main();
