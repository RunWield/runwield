import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { spawnNativeProcess } from "../foreground-process.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { processLines } from "./remote-runtime-lines.ts";
import type { RuntimeFixture } from "./remote-runtime-test-fixture.ts";
import { within } from "./remote-runtime-test-fixture.ts";
import { lockPath } from "../session/file-session-storage.ts";

interface InspectorLocation {
    scriptId: string;
    lineNumber: number;
    columnNumber?: number;
}
interface InspectorResult {
    breakpointId?: string;
    locations?: InspectorLocation[];
    scriptSource?: string;
}
interface InspectorParams {
    url?: string;
    lineNumber?: number;
    expression?: string;
    scriptId?: string;
    active?: boolean;
    breakpointId?: string;
}
interface InspectorFrame {
    location: InspectorLocation;
}
interface InspectorEventParams {
    url?: string;
    scriptId?: string;
    callFrames?: InspectorFrame[];
}
interface InspectorMessage {
    id?: number;
    method?: string;
    result?: InspectorResult;
    params?: InspectorEventParams;
    error?: { message: string };
}

/** Stop exactly after the predecessor/successor manifest commit, before the transferred owner starts. */
export async function withPausedRollover(
    f: RuntimeFixture,
    id: string,
    run: (debug: RolloverDebugger) => Promise<void>,
) {
    const child = spawnNativeProcess(process.execPath, {
        args: [
            "--inspect=127.0.0.1:0",
            ...runtimeSourceArgs([
                "run",
                "-A",
                "--quiet",
                new URL("./remote-rollover-debug-owner.ts", import.meta.url).pathname,
            ]),
        ],
        cwd: f.projectRoot,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = child.stdin.getWriter();
    const stdout = processLines(child.stdout);
    const stderr = processLines(child.stderr);
    let inspectorUrl = "";
    while (!inspectorUrl) {
        const next = await within(stderr.read());
        if (next.done) throw new Error("Laptop debugger exited before admission");
        inspectorUrl = next.value.match(/ws:\/\/\S+/)?.[0] || "";
    }
    const drainErrors = (async () => {
        while (!(await stderr.read()).done) {
            /* Drain diagnostics. */
        }
    })();
    const socket = new WebSocket(inspectorUrl);
    await within(
        new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.onerror = () => reject(new Error("Inspector connection failed"));
        }),
    );
    let sequence = 0;
    const pending = new Map<number, (message: InspectorMessage) => void>();
    let paused = (_message: InspectorMessage) => {};
    const pause = new Promise<InspectorMessage>((resolve) => (paused = resolve));
    let controlScriptId = "";
    let lockScriptId = "";
    socket.onmessage = (event) => {
        const message: InspectorMessage = JSON.parse(String(event.data));
        if (message.method === "Debugger.scriptParsed" && message.params?.url?.endsWith("/file-session-control.ts"))
            controlScriptId = message.params.scriptId || "";
        if (message.method === "Debugger.scriptParsed" && message.params?.url?.endsWith("/native-file-lock.ts"))
            lockScriptId = message.params.scriptId || "";
        if (message.id) {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
        }
        if (message.method === "Debugger.paused") paused(message);
    };
    async function command(method: string, params: InspectorParams = {}) {
        const id = ++sequence;
        const response = new Promise<InspectorMessage>((resolve) => pending.set(id, resolve));
        socket.send(JSON.stringify({ id, method, params }));
        const result = await within(response);
        if (result.error) throw new Error(result.error.message);
        return result.result;
    }
    const target = {
        baseDir: f.store.path,
        targetLabel: `fixture:${f.remoteProject}`,
        target: {
            host: {
                hostname: "remote-runtime.example",
                user: "tester",
                port: 22,
                hostKeyFingerprint: "SHA256:runtime",
            },
            cwd: f.remoteProject,
            home: f.remoteHome,
            os: "Linux",
            arch: "x86_64",
            gitRoot: f.remoteProject,
            gitDir: join(f.remoteProject, ".git"),
            gitCommonDir: join(f.remoteProject, ".git"),
            primaryRoot: f.remoteProject,
            isWorktree: false,
        },
    };
    async function send(text: string) {
        await writer.write(new TextEncoder().encode(text + "\n"));
    }
    try {
        await command("Debugger.enable");
        await command("Debugger.setBreakpointsActive", { active: true });
        await send(JSON.stringify({ target, sessionId: id }));
        const admitted = await within(stdout.read());
        if (admitted.done) throw new Error("Laptop owner exited before admission");
        if (!controlScriptId) throw new Error("Rollover source was not loaded by the laptop process");
        const source = await command("Debugger.getScriptSource", { scriptId: controlScriptId });
        const lineNumber = source?.scriptSource
            ?.split("\n")
            .findIndex((line) => line.includes("locks.set(successorProof.operationId, held)"));
        if (lineNumber === undefined || lineNumber < 0)
            throw new Error("Rollover transfer barrier location is unavailable");
        await command("Debugger.setBreakpointByUrl", {
            url: new URL("../session/file-session-control.ts", import.meta.url).pathname,
            lineNumber,
        });
        const lockSource = await command("Debugger.getScriptSource", { scriptId: lockScriptId });
        const releaseBreakpoints: string[] = [];
        for (const statement of ["flock(8)", "const closing = fd"]) {
            const releaseLine = lockSource?.scriptSource?.split("\n").findIndex((line) => line.includes(statement));
            if (releaseLine === undefined || releaseLine < 0) throw new Error("Native release monitor is unavailable");
            const result = await command("Debugger.setBreakpointByUrl", {
                url: new URL("../native-file-lock.ts", import.meta.url).pathname,
                lineNumber: releaseLine,
            });
            if (!result?.breakpointId) throw new Error("Native release monitor did not attach");
            releaseBreakpoints.push(result.breakpointId);
        }
        const segment = f.store.getCurrentSessionSegment(id)!;
        const path = lockPath(dirname(segment.transcriptPath), id);
        const before = await stat(path);
        const identity = await readFile(path, "utf8");
        await send("rollover");
        const settlement = stdout.read();
        const stopped = await within(
            Promise.race([
                pause,
                settlement.then((result) => {
                    throw new Error(`Rollover settled before the barrier: ${result.value}`);
                }),
            ]),
        );
        if (stopped.params?.callFrames?.[0]?.location.scriptId !== controlScriptId)
            throw new Error("Native writer was released before the committed rollover barrier");
        const releaseDuringAdmission = new Promise<InspectorMessage>((resolve) => (paused = resolve));
        await run({
            identity,
            async inspect() {
                const current = await stat(path);
                const output = await captureForegroundProcess(process.execPath, {
                    args: [
                        "-e",
                        `import {openNativeFileLock} from ${JSON.stringify(new URL("../native-file-lock.ts", import.meta.url).pathname)}; const lock=openNativeFileLock(${JSON.stringify(path)}); console.log(JSON.stringify({entered:lock.tryLockSync(true), identity:lock.readSnapshotSync().text}));lock.close();`,
                    ],
                    cwd: f.projectRoot,
                });
                if (output.code !== 0) throw new Error(new TextDecoder().decode(output.stderr));
                const result: ContenderResult = JSON.parse(new TextDecoder().decode(output.stdout));
                return { ...result, sameFile: current.dev === before.dev && current.ino === before.ino };
            },
            async closeConnection() {
                // Cancellation must release the writer. Only normal successor admission forbids release.
                for (const breakpointId of releaseBreakpoints)
                    await command("Debugger.removeBreakpoint", { breakpointId });
                await command("Runtime.evaluate", { expression: "globalThis.rolloverControl.close()" });
            },
            async resume() {
                await command("Debugger.resume");
                const result = await within(
                    Promise.race([
                        settlement,
                        releaseDuringAdmission.then(() => {
                            throw new Error("Native writer was released before the rollover receipt");
                        }),
                    ]),
                );
                if (result.done) throw new Error("Laptop owner exited before rollover settlement");
                const report: RolloverDebugReport = JSON.parse(result.value);
                return report;
            },
        });
    } finally {
        await command("Debugger.setBreakpointsActive", { active: false }).catch(() => {});
        await command("Debugger.resume").catch(() => {});
        socket.close();
        await send("close").catch(() => {});
        await writer.close().catch(() => {});
        writer.releaseLock();
        try {
            await within(child.status, 5000);
        } finally {
            try {
                child.kill("SIGKILL");
            } catch {
                /* Already exited. */
            }
            await child.status;
            await stdout.cancel().catch(() => {});
            stdout.releaseLock();
            await drainErrors;
            stderr.releaseLock();
        }
    }
}
interface ContenderResult {
    entered: boolean;
    identity: string;
}
interface ContenderInspection extends ContenderResult {
    sameFile: boolean;
}
interface RolloverDebugReport {
    ok: boolean;
    error?: string;
}
export interface RolloverDebugger {
    identity: string;
    inspect(): Promise<ContenderInspection>;
    closeConnection(): Promise<void>;
    resume(): Promise<RolloverDebugReport>;
}
