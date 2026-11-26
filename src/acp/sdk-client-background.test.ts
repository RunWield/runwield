import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { connectAcpClient } from "@runwield/acp/client";
import { PROTOCOL_VERSION } from "@runwield/acp/protocol";
import { startRunWieldAcpServer } from "../cmd/acp/server.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";

test("ACP SDK client receives task output after its prompt ends", async () => {
    await withRuntimeCommandFixture("acp-sdk-background-", async ({ projectRoot, setModelResponseFactories }) => {
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(
                    fauxToolCall("background_task", {
                        action: "start",
                        command: "sleep 0.4; printf 'sdk delayed result\\n'",
                    }),
                ),
            () => fauxAssistantMessage(fauxText("Original prompt finished.")),
            () => fauxAssistantMessage(fauxText("SDK client received the result.")),
        ]);
        const toAgent = new TransformStream<Uint8Array>();
        const toClient = new TransformStream<Uint8Array>();
        const server = startRunWieldAcpServer({ readable: toAgent.readable, writable: toClient.writable });
        let promptEnded = false;
        let afterPromptText = "";
        let resolveResult = () => {};
        const resultArrived = new Promise<void>((resolve) => {
            resolveResult = resolve;
        });
        const connection = connectAcpClient({
            transport: { readable: toClient.readable, writable: toAgent.writable },
            name: "RunWield background task SDK test",
            configure(app) {
                app.onNotification("session/update", ({ params }) => {
                    if (!promptEnded || params.update.sessionUpdate !== "agent_message_chunk") return;
                    if (params.update.content.type === "text") afterPromptText += params.update.content.text;
                    if (afterPromptText.includes("SDK client received the result.")) resolveResult();
                });
            },
        });
        try {
            const initialization = await connection.agent.request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
                clientInfo: { name: "RunWield background task SDK test", version: "test" },
            });
            assertEquals(initialization.protocolVersion, PROTOCOL_VERSION);
            const created = await connection.agent.request("session/new", { cwd: projectRoot, mcpServers: [] });
            assert(created.sessionId);
            const first = await connection.agent.request("session/prompt", {
                sessionId: created.sessionId,
                prompt: [{ type: "text", text: "Start a short background task and finish." }],
            });
            assertEquals(first.stopReason, "end_turn");
            promptEnded = true;
            await Promise.race([
                resultArrived,
                new Promise((_, reject) =>
                    setTimeout(() => reject(Error("SDK client did not receive result")), 10_000),
                ),
            ]);
            assertStringIncludes(afterPromptText, "SDK client received the result.");
            await connection.agent.request("session/close", { sessionId: created.sessionId });
            await toAgent.writable.close();
            await server.closed;
            assert(server.signal.aborted);
        } finally {
            connection.close();
            server.close();
            await Promise.all([connection.closed, server.closed]);
        }
    });
});

test("ACP SDK Stop cancels idle background work without a late result turn", async () => {
    await withRuntimeCommandFixture("acp-sdk-stop-", async ({ projectRoot, setModelResponseFactories }) => {
        let modelCalls = 0;
        setModelResponseFactories([
            () => {
                modelCalls++;
                return fauxAssistantMessage(
                    fauxToolCall("background_task", {
                        action: "start",
                        command: "sleep 1; printf 'stopped result\\n'",
                    }),
                );
            },
            () => {
                modelCalls++;
                return fauxAssistantMessage(fauxText("Original prompt finished."));
            },
            () => {
                modelCalls++;
                return fauxAssistantMessage(fauxText("This result must not reach the client."));
            },
        ]);
        const toAgent = new TransformStream<Uint8Array>();
        const toClient = new TransformStream<Uint8Array>();
        const server = startRunWieldAcpServer({ readable: toAgent.readable, writable: toClient.writable });
        let postStopText = "";
        let stopped = false;
        const connection = connectAcpClient({
            transport: { readable: toClient.readable, writable: toAgent.writable },
            name: "RunWield SDK Stop test",
            configure(app) {
                app.onNotification("session/update", ({ params }) => {
                    if (
                        stopped &&
                        params.update.sessionUpdate === "agent_message_chunk" &&
                        params.update.content.type === "text"
                    ) {
                        postStopText += params.update.content.text;
                    }
                });
            },
        });
        try {
            await connection.agent.request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
                clientInfo: { name: "RunWield SDK Stop test", version: "test" },
            });
            const created = await connection.agent.request("session/new", { cwd: projectRoot, mcpServers: [] });
            const first = await connection.agent.request("session/prompt", {
                sessionId: created.sessionId,
                prompt: [{ type: "text", text: "Start a slow task." }],
            });
            assertEquals(first.stopReason, "end_turn");
            stopped = true;
            await connection.agent.notify("session/cancel", { sessionId: created.sessionId });
            await new Promise((resolve) => setTimeout(resolve, 1_300));
            assertEquals(modelCalls, 2);
            assertEquals(postStopText, "");
            await connection.agent.request("session/close", { sessionId: created.sessionId });
        } finally {
            connection.close();
            server.close();
            await Promise.all([connection.closed, server.closed]);
        }
    });
});
