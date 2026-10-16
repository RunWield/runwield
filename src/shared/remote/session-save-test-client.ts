/** Real remote subprocess used by the focused Session transport tests. */
import type { RemoteSessionSaveBridge } from "./session-save-bridge.ts";
import {
    createRemoteRootSessionManager,
    createRootSessionManager,
    getRemoteSessionSaveBridge,
    getRunWieldSessionsBaseDir,
} from "../session/root-session.js";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { HostedSession } from "../session/hosted-session.js";
import { recordManualModelSelection } from "../session/active-agent-session.js";
import { configureRemotePersonalResources } from "./personal-resources.ts";
import {
    listPendingWorkflowToolEvents,
    publishWorkflowToolEvent,
    settleWorkflowToolEvent,
    waitForWorkflowToolEvent,
} from "../workflow/workflow-tool-events.ts";
import { MAX_SESSION_BYTES, type RemoteSessionConnection, type SessionWorkerRequest } from "./session-protocol.ts";
import type { RemoteModelConnection } from "./model-bridge.ts";
import { makeSaveAgent } from "./session-save-agent-fixture.ts";
import { persistImageAttachment } from "../session/image-attachments.ts";

interface ClientInput {
    connection: RemoteSessionConnection;
    cwd: string;
    marker: string;
    mount: string;
    mode:
        | "save"
        | "bridge-override"
        | "fault"
        | "manual-fault"
        | "workflow"
        | "lifecycle"
        | "mount"
        | "reload"
        | "worker-fault"
        | "turn"
        | "agent-fault"
        | "attachment"
        | "allocation-fault"
        | "oversized";
    measure?: boolean;
    holdWorkerAppend?: boolean;
    home?: string;
    modelConnection?: RemoteModelConnection;
    faultPoint?: "before-prompt" | "before-tool" | "after-tool" | "tool-hook";
    blockedMethod?: string;
    faultGate?: string;
}

function denied(action: () => void): boolean {
    try {
        action();
        return false;
    } catch {
        return true;
    }
}

/** Private one-line stdin also supports the compiled SSH client; credentials are never CLI arguments. */
async function privateInput(): Promise<ClientInput> {
    if (Deno.args[0]) return JSON.parse(Deno.args[0]);
    const bytes: number[] = [];
    const byte = new Uint8Array(1);
    while (await Deno.stdin.read(byte) !== null) {
        if (byte[0] === 10) return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
        bytes.push(byte[0]);
        if (bytes.length > 65536) throw new Error("Private input too large");
    }
    throw new Error("Missing private input");
}
const input = await privateInput();
configureRemotePersonalResources({ globalRoot: input.mount });
interface SaveSample {
    kind: string;
    sequence: number;
    latencyMs: number;
    accepted: boolean;
}
const samples: SaveSample[] = [];
let hydratedContents = "";
// Measure the real bridge at its Worker boundary, without replacing persistence.
const workerClass = globalThis.Worker;
const load = Atomics.load;
let pendingSample: { request: SessionWorkerRequest; start: number } | undefined;
if (input.measure) {
    globalThis.Worker = class extends workerClass {
        override postMessage(request: SessionWorkerRequest) {
            pendingSample = { request, start: performance.now() };
            // Model a stalled Worker, so the main-thread deadline must wake the caller itself.
            if (input.holdWorkerAppend && JSON.parse(request.payload).kind === "append") return;
            super.postMessage(request);
        }
    };
    Atomics.load = new Proxy(load, {
        apply(target, receiver, args) {
            const value = Reflect.apply(target, receiver, args);
            const sample = pendingSample;
            if (sample && args[0].buffer === sample.request.result && args[1] === 0 && value !== 0) {
                const payload = JSON.parse(sample.request.payload);
                const accepted = value === 1;
                samples.push({
                    kind: payload.kind,
                    sequence: payload.sequence,
                    latencyMs: performance.now() - sample.start,
                    accepted,
                });
                if (accepted && payload.kind === "hydrate") {
                    const length = load(new Int32Array(sample.request.result, 0, 2), 1);
                    const text = new TextDecoder().decode(new Uint8Array(sample.request.result, 8, length));
                    hydratedContents = JSON.parse(text).contents;
                }
                pendingSample = undefined;
            }
            return value;
        },
    });
}
let bridgeForCleanup: RemoteSessionSaveBridge | undefined;
try {
    const connection = input.mode === "bridge-override"
        ? {
            ...input.connection,
            request() {
                throw new Error("Caller replaced persistence");
            },
        }
        : input.connection;
    const manager = await createRemoteRootSessionManager(input.cwd, connection);
    const bridge = getRemoteSessionSaveBridge(manager)!;
    bridgeForCleanup = bridge;
    if (input.mode === "bridge-override") {
        if (
            Reflect.set(bridge, "request", () => {
                throw new Error("Replacement save");
            })
        ) {
            throw new Error("Remote persistence bridge is replaceable");
        }
        if (
            Reflect.set(Object.getPrototypeOf(bridge), "request", () => {
                throw new Error("Replacement prototype");
            })
        ) {
            throw new Error("Remote persistence prototype is replaceable");
        }
    }
    const retainedRead = manager.getEntries;
    const retainedWrite = manager.appendSessionInfo;
    if (input.mode === "allocation-fault" || input.mode === "oversized") {
        const allocator = globalThis.SharedArrayBuffer;
        let allocationAttempted = false;
        // Model a genuine memory-allocation refusal in this isolated caller, not Session machinery.
        globalThis.SharedArrayBuffer = new Proxy(allocator, {
            construct() {
                allocationAttempted = true;
                throw new RangeError("Shared memory allocation refused");
            },
        });
        let failed;
        try {
            failed = denied(() =>
                bridge.request(
                    input.mode === "oversized" ? "attachment" : "inspect",
                    input.mode === "oversized" ? "x".repeat(MAX_SESSION_BYTES + 1) : "",
                )
            );
        } finally {
            globalThis.SharedArrayBuffer = allocator;
        }
        console.log(
            JSON.stringify({
                failed,
                allocationAttempted,
                readStopped: denied(() => retainedRead()),
                writeStopped: denied(() => retainedWrite("no progress")),
                checkpointStopped: denied(() => bridge.request("checkpoint")),
            }),
        );
    } else if (input.mode === "turn" || input.mode === "agent-fault") {
        const contexts: string[] = [];
        let effects = 0;
        const fault = () => recordManualModelSelection(manager, "test-provider", "selected-model");
        const session = await makeSaveAgent({
            cwd: input.cwd,
            home: input.home ?? input.mount,
            manager,
            contexts,
            modelConnection: input.modelConnection,
            execute: () => {
                effects++;
                Deno.writeTextFileSync(input.marker, "effect\n", { append: true });
                if (input.mode === "agent-fault" && input.faultPoint === "after-tool") fault();
                return Promise.resolve("remote-effect-complete");
            },
        });
        if (input.mode === "agent-fault" && input.faultPoint === "tool-hook") {
            const beforeTool = session.agent.beforeToolCall;
            session.agent.beforeToolCall = async (context, signal) => {
                const result = await beforeTool?.(context, signal);
                fault();
                return result;
            };
        }
        bridge.bindAgentSession(session);
        try {
            if (input.mode === "agent-fault") {
                if (input.faultPoint === "before-prompt") fault();
                if (input.faultPoint === "before-tool") {
                    session.subscribe((event) => {
                        if (event.type === "message_end" && event.message.role === "assistant") fault();
                    });
                }
                let stopped = false;
                try {
                    await session.prompt("Use remote_effect once.", { expandPromptTemplates: false });
                } catch {
                    stopped = true;
                }
                let nextPromptStopped = false;
                try {
                    await session.prompt("Do not continue.", { expandPromptTemplates: false });
                } catch {
                    nextPromptStopped = true;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
                console.log(
                    JSON.stringify({
                        stopped,
                        nextPromptStopped,
                        disposeFailed: denied(() => session.dispose()),
                        effects,
                        modelRequests: contexts.length,
                        unhealthy: denied(() => bridge.assertHealthy()),
                    }),
                );
            } else {
                await session.prompt("Use remote_effect once. " + "Owned verification context. ".repeat(200), {
                    expandPromptTemplates: false,
                });
                manager.appendCustomEntry("runwield.verification", { effect: "finished" });
                const compaction = await session.compact("Summarize this owned verification turn.");
                const entries = manager.getEntries();
                console.log(
                    JSON.stringify({
                        entries: entries.length,
                        types: entries.map((entry) => entry.type),
                        roles: entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role),
                        effects,
                        summary: compaction.summary,
                        file: manager.getSessionFile() ?? null,
                    }),
                );
                bridge.request("checkpoint");
            }
        } finally {
            if (input.mode !== "agent-fault") session.dispose();
        }
    } else if (input.mode === "attachment") {
        const image = await persistImageAttachment({ base64: "AQIDBA==", mimeType: "image/png" }, manager, input.cwd);
        manager.appendCustomEntry("runwield.image", image);
        bridge.request("checkpoint");
        console.log(JSON.stringify(image));
    } else if (input.mode === "reload") {
        console.log(JSON.stringify({ entries: manager.getEntries().length, file: manager.getSessionFile() ?? null }));
        bridge.request("checkpoint");
    } else if (input.mode === "lifecycle") {
        const stopped = denied(() =>
            Reflect.get(manager, input.blockedMethod ?? "newSession")(`${input.cwd}/must-not-write.jsonl`)
        );
        console.log(JSON.stringify({ stopped, readStopped: denied(() => retainedRead()) }));
    } else if (input.mode === "mount") {
        // A detached mount must not become an alternate local writer root.
        Deno.renameSync(input.mount, `${input.mount}-detached`);
        Deno.mkdirSync(input.mount);
        const storeStopped = denied(() => openFileSessionStore({ baseDir: `${input.mount}/sessions` }));
        const locatorStopped = denied(() => getRunWieldSessionsBaseDir());
        let lifecycleStopped = false;
        try {
            await createRootSessionManager("new", input.cwd);
        } catch {
            lifecycleStopped = true;
        }
        manager.appendCustomEntry("runwield.test", { mount: "detached" });
        bridge.request("checkpoint");
        console.log(
            JSON.stringify({ storeStopped, locatorStopped, lifecycleStopped, file: manager.getSessionFile() ?? null }),
        );
    } else if (input.mode === "manual-fault") {
        const hostedSession = new HostedSession({ id: "remote-manual-fault", cwd: input.cwd, sessionManager: manager });
        const root = { dispose() {} };
        hostedSession.setRootAgentSession(root);
        const event = publishWorkflowToolEvent({
            hostedSession,
            toolCallId: "before-fault",
            kind: "plan_written",
            payload: { outcome: "approved_execute", planName: "remote-plan" },
        });
        // This production recorder deliberately swallows persistence failures.
        recordManualModelSelection(manager, "test-provider", "selected-model");
        const readStopped = denied(() => retainedRead());
        const writeStopped = denied(() => retainedWrite("must not authorize progress"));
        const progressStopped = denied(() =>
            publishWorkflowToolEvent({
                hostedSession,
                toolCallId: "after-fault",
                kind: "plan_written",
                payload: { outcome: "approved_execute", planName: "remote-plan" },
            })
        );
        const pendingStopped = denied(() => listPendingWorkflowToolEvents(hostedSession));
        const settlementStopped = denied(() => settleWorkflowToolEvent(hostedSession, event));
        const checkpointStopped = denied(() => bridge.request("checkpoint"));
        console.log(
            JSON.stringify({
                readStopped,
                writeStopped,
                progressStopped,
                pendingStopped,
                settlementStopped,
                checkpointStopped,
            }),
        );
    } else if (input.mode === "workflow") {
        const hostedSession = new HostedSession({ id: "remote-workflow", cwd: input.cwd, sessionManager: manager });
        const root = { dispose() {} };
        hostedSession.setRootAgentSession(root);
        const waited = waitForWorkflowToolEvent(hostedSession, { kinds: ["plan_written"], owningSession: root });
        publishWorkflowToolEvent({
            hostedSession,
            toolCallId: "remote-plan-call",
            kind: "plan_written",
            payload: { outcome: "approved_execute", planName: "remote-plan" },
        });
        const event = await waited;
        Deno.writeTextFileSync(input.marker, event.eventId);
        settleWorkflowToolEvent(hostedSession, event);
        bridge.request("checkpoint");
        console.log(
            JSON.stringify({
                kind: event.kind,
                pending: listPendingWorkflowToolEvents(hostedSession).length,
                file: manager.getSessionFile() ?? null,
            }),
        );
    } else if (input.mode === "fault" || input.mode === "worker-fault") {
        if (input.mode === "worker-fault") await Deno.permissions.revoke({ name: "net" });
        const failed = denied(() => manager.appendCustomEntry("runwield.test", { effect: "already finished" }));
        const readStopped = denied(() => retainedRead());
        const writeStopped = denied(() => retainedWrite("must not authorize progress"));
        const checkpointStopped = denied(() => bridge.request("checkpoint"));
        if (!failed) Deno.writeTextFileSync(input.marker, "dependent action");
        if (input.faultGate) {
            Deno.writeTextFileSync(
                input.faultGate,
                JSON.stringify({ failed, readStopped, writeStopped, checkpointStopped }),
            );
            // Keep the failed manager alive while the parent releases the late network response.
            await Deno.stdin.read(new Uint8Array(1));
            console.log(
                JSON.stringify({
                    failed,
                    readStopped,
                    writeStopped,
                    checkpointStopped,
                    lateReadStopped: denied(() => retainedRead()),
                    lateWriteStopped: denied(() => retainedWrite("late progress")),
                    lateCheckpointStopped: denied(() => bridge.request("checkpoint")),
                }),
            );
        } else {
            console.log(JSON.stringify({ failed, readStopped, writeStopped, checkpointStopped }));
        }
    } else {
        manager.appendCustomEntry("runwield.test", { immutable: true });
        Deno.writeTextFileSync(input.marker, "dependent action");
        manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
        manager.appendCompaction("summary", manager.getEntries()[1].id, 12);
        console.log(
            JSON.stringify({
                entries: manager.getEntries().length,
                file: manager.getSessionFile() ?? null,
                persisted: manager.isPersisted(),
                cwd: manager.getCwd(),
            }),
        );
        bridge.request("checkpoint");
    }
} finally {
    if (pendingSample) {
        // A deadline ends the request before another Atomics.load observes its terminal slot.
        const payload = JSON.parse(pendingSample.request.payload);
        samples.push({
            kind: payload.kind,
            sequence: payload.sequence,
            latencyMs: performance.now() - pendingSample.start,
            accepted: false,
        });
    }
    bridgeForCleanup?.close();
    globalThis.Worker = workerClass;
    Atomics.load = load;
    if (input.measure) console.log(JSON.stringify({ samples, hydratedContents }));
}
