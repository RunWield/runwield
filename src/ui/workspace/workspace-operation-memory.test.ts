import { serveHttp } from "../../shared/http-server.ts";
import { test } from "node:test";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import type { RuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import type { ManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { ownerSessionOperationStreamApi } from "./routes/owner-session-api.js";
import { createOwnerConnectionRegistry, type OwnerConnectionRegistry } from "./server/owner-connections.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

type Workspace = {
    fixture: ManagedSessionFixture;
    service: WorkspaceSessionContinuationService;
    connections: OwnerConnectionRegistry;
    environment: RuntimeCommandFixture;
};

type OperationFrame = { status: string; events: Array<{ type: string; reason?: string; delta?: string }> };

async function withWorkspace(run: (workspace: Workspace) => Promise<void>) {
    await withRuntimeCommandFixture("workspace-operation-memory-", async (environment) => {
        const fixture = await makeManagedSessionFixture({
            home: environment.homeDir,
            projectRoot: environment.projectRoot,
        });
        const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
        const connections = createOwnerConnectionRegistry();
        try {
            await run({ fixture, service, connections, environment });
        } finally {
            connections.closeAll();
            await service.close();
            service.store.close();
            await fixture.cleanup();
        }
    });
}

async function completed(service: WorkspaceSessionContinuationService, operationId: string) {
    for (let index = 0; index < 500; index++) {
        const result = service.getOperation(operationId);
        if (result.status !== "running" && result.status !== "accepted") return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Operation did not settle: ${operationId}`);
}

function stream(
    service: WorkspaceSessionContinuationService,
    connections: OwnerConnectionRegistry,
    operationId: string,
    signal?: AbortSignal,
    deviceId = "owner-device",
) {
    return ownerSessionOperationStreamApi({
        req: new Request("http://workspace.local/stream", { signal }),
        params: { operationId },
        state: { sessionContinuation: service, ownerConnections: connections, ownerDevice: { deviceId } },
    });
}

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<OperationFrame> {
    const next = await reader.read();
    assertEquals(next.done, false);
    const text = new TextDecoder().decode(next.value);
    assert(text.startsWith("data: "));
    return JSON.parse(text.slice(6)) as OperationFrame;
}

test("completed create and continuation operations discard live payloads but keep retries", async () => {
    await withWorkspace(async ({ fixture, service, environment }) => {
        let turn = 0;
        environment.setModelResponseFactory(() =>
            fauxAssistantMessage(
                fauxText(`payload-${turn++}-` + "x".repeat(turn <= 20 ? 1024 : 10240)),
            )
        );
        const createdOptions = { projectId: fixture.project.projectId, requestId: "create-memory", text: "Start." };
        const created = await service.createSession(createdOptions);
        const first = await completed(service, created.operationId);
        assertEquals(first.status, "completed");
        const sessionId = first.runwieldSessionId;
        assert(sessionId);
        assertEquals((await service.createSession(createdOptions)).operationId, created.operationId);
        const ids = [created.operationId];
        for (let index = 0; index < 99; index++) {
            const generation = service.store.inspectSessionActivation(sessionId).generation?.generation;
            assert(typeof generation === "number");
            const options = {
                projectId: fixture.project.projectId,
                runwieldSessionId: sessionId,
                expectedGeneration: generation,
                requestId: `continue-memory-${index}`,
                text: `Continue ${index}.`,
            };
            const started = await service.startContinuation(options);
            const tag = `transient-tool-image-${index}`;
            service.appendOperationEvent(started.operationId, {
                type: "tool_update",
                sessionId: "fixture",
                timestamp: new Date().toISOString(),
                toolCallId: `fixture-${index}`,
                toolName: "read",
                title: "Fixture output",
                kind: "read",
                content: [{ type: "text", text: tag }, { type: "image", data: btoa(tag), mimeType: "image/png" }],
                output: tag,
                details: null,
            });
            const result = await completed(service, started.operationId);
            assertEquals(result.status, "completed", JSON.stringify(result));
            assertEquals((await service.startContinuation(options)).operationId, started.operationId);
            ids.push(started.operationId);
            assertEquals(JSON.stringify(service.operations.get(started.operationId)).includes(tag), false);
            if (index === 18) assertEquals(ids.length, 20);
        }
        assertEquals(ids.length, 100);
        for (const id of ids) {
            const record = service.operations.get(id);
            assert(record);
            assertEquals(record.status, "completed");
            assertEquals(record.events.length, 0);
            assertEquals(record.runtimeSessionId, undefined);
            assertEquals(record.liveInteraction, undefined);
            assertEquals(service.getOperation(id).status, "completed");
        }
        assertEquals(service.operationListeners.size, 0);
        assertEquals(service.operationChanges.size, 0);
        assertEquals(service.pendingCreateRequests.size, 0);
    });
});

test("unread operation stream coalesces 500 KiB of updates and delivers the final state before EOF", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        let entered!: () => void;
        const inModel = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        environment.setModelResponseFactory(async () => {
            entered();
            await gate;
            return fauxAssistantMessage(fauxText("finished"));
        });
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "stream-memory",
            text: "Start.",
        });
        const reader = stream(service, connections, started.operationId).body!.getReader();
        try {
            await inModel;
            const initial = await frame(reader);
            assertEquals(initial.status, "running");
            const candidate: (() => void) | undefined = Reflect.get(globalThis, "gc");
            const gc = typeof candidate === "function" ? candidate : null;
            gc?.();
            const baseline = gc ? process.memoryUsage().external : 0;
            // A real create owner remains active. Feed its live event path while the reader does not pull.
            for (let index = 0; index < 500; index++) {
                service.appendOperationEvent(started.operationId, {
                    type: "assistant_text_delta",
                    sessionId: "fixture",
                    timestamp: new Date().toISOString(),
                    agentName: "fixture",
                    messageKind: "assistant",
                    messageId: `message-${index}`,
                    delta: "z".repeat(1024),
                });
            }
            assertEquals(service.operations.get(started.operationId)!.events.length >= 500, true);
            gc?.();
            const observedExternal = gc ? process.memoryUsage().external - baseline : 0;
            release();
            const final = await completed(service, started.operationId);
            assertEquals(final.status, "completed");
            assertEquals(service.operations.get(started.operationId)!.events.length, 0);
            // One earlier running frame can already be queued by ReadableStream's pull.
            let next = await frame(reader);
            if (next.status === "running") {
                assert(next.events.length < 500, "unread stream retained the entire live payload");
                next = await frame(reader);
            }
            assertEquals(next.status, "completed");
            assertEquals(next.events.length, 0);
            assertEquals((await reader.read()).done, true);
            if (gc) {
                const sessionId = final.runwieldSessionId!;
                const generation = service.store.inspectSessionActivation(sessionId).generation!.generation;
                const control = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: sessionId,
                    expectedGeneration: generation,
                    requestId: "no-subscriber-control",
                    text: "Control.",
                });
                gc();
                const controlBaseline = process.memoryUsage().external;
                for (let index = 0; index < 500; index++) {
                    service.appendOperationEvent(control.operationId, {
                        type: "assistant_text_delta",
                        sessionId: "fixture",
                        timestamp: new Date().toISOString(),
                        agentName: "fixture",
                        messageKind: "assistant",
                        messageId: `control-${index}`,
                        delta: "z".repeat(1024),
                    });
                }
                gc();
                const controlExternal = process.memoryUsage().external - controlBaseline;
                assert(
                    observedExternal - controlExternal < 4 * 1024 * 1024,
                    `Unread observer added ${
                        observedExternal - controlExternal
                    } external bytes over the warmed control`,
                );
                assertEquals((await completed(service, control.operationId)).status, "completed");
            }
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
            assertEquals(connections.closeDevice("owner-device"), 0);
        } finally {
            release();
            await reader.cancel().catch(() => {});
        }
    });
});

test("abort, cancel and owner revocation release streams; late events do not reopen finished operations", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        let entered!: () => void;
        const inModel = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        environment.setModelResponseFactory(async () => {
            entered();
            await gate;
            return fauxAssistantMessage(fauxText("finished"));
        });
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "disconnect-memory",
            text: "Start.",
        });
        const abort = new AbortController();
        const abortedReader = stream(service, connections, started.operationId, abort.signal, "abort-owner").body!
            .getReader();
        const canceledReader = stream(service, connections, started.operationId, undefined, "cancel-owner").body!
            .getReader();
        const revokedReader = stream(service, connections, started.operationId, undefined, "revoke-owner").body!
            .getReader();
        try {
            await inModel;
            assertEquals(service.operationChanges.get(started.operationId)?.size, 3);
            abort.abort();
            await canceledReader.cancel();
            assertEquals(connections.closeDevice("revoke-owner"), 1);
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
            assertEquals(connections.closeDevice("abort-owner"), 0);
            assertEquals(connections.closeDevice("cancel-owner"), 0);
            release();
            assertEquals((await completed(service, started.operationId)).status, "completed");
            service.appendOperationEvent(started.operationId, {
                type: "assistant_text_delta",
                sessionId: "fixture",
                timestamp: new Date().toISOString(),
                agentName: "fixture",
                messageKind: "assistant",
                messageId: "late",
                delta: "z".repeat(1024),
            });
            assertEquals(service.operations.get(started.operationId)!.events.length, 0);
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
            for (const reader of [abortedReader, revokedReader]) {
                let count = 0;
                while (!(await reader.read()).done) {
                    count++;
                    assert(count <= 2, "closed stream retained an unbounded queue");
                }
            }
        } finally {
            release();
            await abortedReader.cancel().catch(() => {});
            await revokedReader.cancel().catch(() => {});
        }
    });
});

test("a loopback client disconnect releases the owner stream while its operation continues", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        let entered!: () => void;
        const inModel = new Promise<void>((resolve) => entered = resolve);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => release = resolve);
        environment.setModelResponseFactory(async () => {
            entered();
            await gate;
            return fauxAssistantMessage(fauxText("finished"));
        });
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "loopback-disconnect",
            text: "Start.",
        });
        const server = serveHttp(
            { hostname: "127.0.0.1", port: 0, onListen() {} },
            (req) =>
                ownerSessionOperationStreamApi({
                    req,
                    params: { operationId: started.operationId },
                    state: {
                        sessionContinuation: service,
                        ownerConnections: connections,
                        ownerDevice: { deviceId: "loopback" },
                    },
                }),
        );
        const controller = new AbortController();
        const port = server.addr.transport === "tcp" ? server.addr.port : 0;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/stream`, {
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
            });
            assertEquals(response.status, 200);
            reader = response.body!.getReader();
            await inModel;
            assertEquals((await frame(reader)).status, "running");
            assertEquals(service.operationChanges.get(started.operationId)?.size, 1);
            controller.abort();
            await reader.cancel().catch(() => {});
            // The model is still blocked: cleanup must come from the network disconnect, not completion.
            for (let index = 0; index < 200 && service.operationChanges.size !== 0; index++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
            assertEquals(connections.closeDevice("loopback"), 0);
            release();
            assertEquals((await completed(service, started.operationId)).status, "completed");
        } finally {
            release();
            controller.abort();
            await reader?.cancel().catch(() => {});
            await server.shutdown();
        }
    });
});

test("a slow loopback client receives completion and EOF after the owner turn", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        let entered!: () => void;
        const inModel = new Promise<void>((resolve) => entered = resolve);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => release = resolve);
        environment.setModelResponseFactory(async () => {
            entered();
            await gate;
            return fauxAssistantMessage(fauxText("finished"));
        });
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "loopback-slow",
            text: "Start.",
        });
        const server = serveHttp(
            { hostname: "127.0.0.1", port: 0, onListen() {} },
            (req) =>
                ownerSessionOperationStreamApi({
                    req,
                    params: { operationId: started.operationId },
                    state: {
                        sessionContinuation: service,
                        ownerConnections: connections,
                        ownerDevice: { deviceId: "slow-loopback" },
                    },
                }),
        );
        const controller = new AbortController();
        const port = server.addr.transport === "tcp" ? server.addr.port : 0;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/stream`, {
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
            });
            assertEquals(response.status, 200);
            reader = response.body!.getReader();
            await inModel;
            assertEquals((await frame(reader)).status, "running");
            release();
            assertEquals((await completed(service, started.operationId)).status, "completed");
            // Do not pull until the model and the operation have both finished.
            await new Promise((resolve) => setTimeout(resolve, 30));
            let remaining = "";
            let ended = false;
            for (let index = 0; index < 100; index++) {
                const next = await reader.read();
                if (next.done) {
                    ended = true;
                    break;
                }
                remaining += new TextDecoder().decode(next.value);
            }
            assert(ended, "the connected client did not reach EOF");
            const frames = remaining.split("\n\n").filter(Boolean).map((line) =>
                JSON.parse(line.slice(6)) as OperationFrame
            );
            assertEquals(frames.at(-1)?.status, "completed");
            assertEquals(frames.at(-1)?.events.length, 0);
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
            assertEquals(connections.closeDevice("slow-loopback"), 0);
        } finally {
            release();
            controller.abort();
            await reader?.cancel().catch(() => {});
            await server.shutdown();
        }
    });
});

test("a subscribed operation stream reports a new owner turn without a polling delay", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        let entered!: () => void;
        const inModel = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        environment.setModelResponseFactory(async () => {
            entered();
            await gate;
            return fauxAssistantMessage(fauxText("finished"));
        });
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "fast-memory",
            text: "Start.",
        });
        const reader = stream(service, connections, started.operationId).body!.getReader();
        try {
            await inModel;
            await frame(reader);
            // Drain any frame already queued before asking for the next live update.
            service.appendOperationEvent(started.operationId, {
                type: "assistant_text_delta",
                sessionId: "fixture",
                timestamp: new Date().toISOString(),
                agentName: "fixture",
                messageKind: "assistant",
                messageId: "fast",
                delta: "live update",
            });
            let found = false;
            for (let index = 0; index < 2 && !found; index++) {
                const next = await Promise.race([
                    frame(reader),
                    new Promise<OperationFrame>((_, reject) =>
                        setTimeout(() => reject(new Error("Stream did not notify promptly")), 200)
                    ),
                ]);
                assertEquals(next.status, "running");
                found = JSON.stringify(next.events).includes("live update");
            }
            assert(found, "the active owner update was not delivered");
        } finally {
            release();
            await reader.cancel().catch(() => {});
        }
    });
});

test("a completed owner subscription sends its final frame and detaches synchronously", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        environment.setModelResponseFactory(() => fauxAssistantMessage(fauxText("done")));
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "already-finished",
            text: "Start.",
        });
        assertEquals((await completed(service, started.operationId)).status, "completed");
        const reader = stream(service, connections, started.operationId).body!.getReader();
        try {
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
            assertEquals(connections.closeDevice("owner-device"), 0);
            const final = await frame(reader);
            assertEquals(final.status, "completed");
            assertEquals(final.events.length, 0);
            assertEquals((await reader.read()).done, true);
        } finally {
            await reader.cancel().catch(() => {});
        }
    });
});

test("a stopped agent retains one compact attention event after the owner turn", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        let entered!: () => void;
        const inModel = new Promise<void>((resolve) => entered = resolve);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => release = resolve);
        environment.setModelResponseFactory(async () => {
            entered();
            await gate;
            return fauxAssistantMessage(fauxText("done"));
        });
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "stop-memory",
            text: "Start.",
        });
        const reader = stream(service, connections, started.operationId).body!.getReader();
        try {
            await inModel;
            service.appendOperationEvent(started.operationId, {
                type: "attention_requested",
                reason: "agentStopped",
                agentName: "fixture",
                sessionName: "Stopped session",
                sessionId: "fixture",
                timestamp: new Date().toISOString(),
            });
            release();
            assertEquals((await completed(service, started.operationId)).status, "completed");
            let final = await frame(reader);
            for (let index = 0; index < 3 && final.status === "running"; index++) final = await frame(reader);
            assertEquals(final.status, "completed");
            assertEquals(final.events.map((event) => ({ type: event.type, reason: event.reason })), [
                { type: "attention_requested", reason: "agentStopped" },
            ]);
            assertEquals((await reader.read()).done, true);
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
        } finally {
            release();
            await reader.cancel().catch(() => {});
        }
    });
});

test("three differently paced owner readers see bounded updates and the same final state", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        let entered!: () => void;
        const inModel = new Promise<void>((resolve) => entered = resolve);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => release = resolve);
        environment.setModelResponseFactory(async () => {
            entered();
            await gate;
            return fauxAssistantMessage(fauxText("done"));
        });
        const started = await service.createSession({
            projectId: fixture.project.projectId,
            requestId: "three-readers",
            text: "Start.",
        });
        const readers = ["fast", "throttled", "unread"].map((device) =>
            stream(service, connections, started.operationId, undefined, device).body!.getReader()
        );
        try {
            await inModel;
            for (const reader of readers) assertEquals((await frame(reader)).status, "running");
            // Compare with a warmed, idle control. External memory is sampled only when GC is exposed.
            const candidate: (() => void) | undefined = Reflect.get(globalThis, "gc");
            const gc = typeof candidate === "function" ? candidate : null;
            gc?.();
            const baseline = gc ? process.memoryUsage().external : 0;
            for (let index = 0; index < 500; index++) {
                service.appendOperationEvent(started.operationId, {
                    type: "assistant_text_delta",
                    sessionId: "fixture",
                    timestamp: new Date().toISOString(),
                    agentName: "fixture",
                    messageKind: "assistant",
                    messageId: `distinct-${index}`,
                    delta: `${index.toString().padStart(4, "0")}${"z".repeat(1020)}`,
                });
                // Fast reader drains on every turn; throttled reader pulls only once per 25 turns.
                const fast = await frame(readers[0]);
                assertEquals(fast.status, "running");
                if (index % 25 === 0) assertEquals((await frame(readers[1])).status, "running");
            }
            gc?.();
            if (gc) {
                assert(
                    process.memoryUsage().external - baseline < 8 * 1024 * 1024,
                    `Three-reader external buffers grew by ${process.memoryUsage().external - baseline} bytes`,
                );
            }
            release();
            assertEquals((await completed(service, started.operationId)).status, "completed");
            for (const reader of readers) {
                let next = await frame(reader);
                for (let index = 0; index < 3 && next.status === "running"; index++) {
                    next = await frame(reader);
                }
                assertEquals(next.status, "completed");
                assertEquals((await reader.read()).done, true);
            }
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
        } finally {
            release();
            await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
        }
    });
});

test("a request rejected before Session creation does not retain a stream or reuse a changed request id", async () => {
    await withWorkspace(async ({ fixture, service, connections, environment }) => {
        environment.setModelResponseFactory(() => fauxAssistantMessage(fauxText("done")));
        const options = { projectId: fixture.project.projectId, requestId: "create-id", text: "Start." };
        const started = await service.createSession(options);
        assertEquals((await completed(service, started.operationId)).status, "completed");
        assertEquals((await service.createSession(options)).operationId, started.operationId);
        await assertRejects(
            () => service.createSession({ ...options, text: "Different input." }),
            Error,
            "Operation request id was reused with different input",
        );
        await assertRejects(() =>
            service.createSession({
                projectId: "project-not-registered",
                requestId: "rejected-before-session",
                text: "Start.",
            })
        );
        assertEquals(service.pendingCreateRequests.size, 0);
        const reader = stream(service, connections, "operation-never-created").body!.getReader();
        try {
            assertEquals((await frame(reader)).status, "unknown");
            assertEquals((await reader.read()).done, true);
            assertEquals(service.operationListeners.size, 0);
            assertEquals(service.operationChanges.size, 0);
            assertEquals(connections.closeDevice("owner-device"), 0);
        } finally {
            await reader.cancel().catch(() => {});
        }
    });
});
