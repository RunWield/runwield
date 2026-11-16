import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { CloseSessionResponse, PromptResponse } from "@agentclientprotocol/sdk";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { startRunWieldAcpServer } from "./server.js";

for (const ending of ["cancel", "close"] as const) {
    test(`ACP SDK ${ending} settles a pending command form and cancels its client request`, async () => {
        await withRuntimeCommandFixture("acp-sdk-form-settlement-", async ({ projectRoot }) => {
            const toAgent = new TransformStream<Uint8Array>();
            const toClient = new TransformStream<Uint8Array>();
            const server = startRunWieldAcpServer(toAgent.readable, toClient.writable);
            const opened = Promise.withResolvers<void>();
            const canceled = Promise.withResolvers<void>();
            const answer = Promise.withResolvers<{ action: "cancel" }>();
            const app = client({ name: "RunWield form settlement test" });
            let settlementText = "";
            let textAtPromptResponse = "";
            app.onNotification("session/update", ({ params }) => {
                if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
                    settlementText += params.update.content.text;
                }
            });
            app.onRequest("elicitation/create", async (context) => {
                context.signal.addEventListener(
                    "abort",
                    () => {
                        canceled.resolve();
                        answer.resolve({ action: "cancel" });
                    },
                    { once: true },
                );
                opened.resolve();
                return await answer.promise;
            });
            const connection = app.connect(ndJsonStream(toAgent.writable, toClient.readable));
            let prompt: Promise<PromptResponse> | undefined;
            let close: Promise<CloseSessionResponse> | undefined;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await connection.agent.request("initialize", {
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: { elicitation: { form: {} } },
                });
                const created = await connection.agent.request("session/new", { cwd: projectRoot, mcpServers: [] });
                prompt = connection.agent
                    .request("session/prompt", {
                        sessionId: created.sessionId,
                        prompt: [{ type: "text", text: "/agent" }],
                    })
                    .then((response) => {
                        textAtPromptResponse = settlementText;
                        return response;
                    });
                await opened.promise;
                if (ending === "close")
                    close = connection.agent.request("session/close", { sessionId: created.sessionId });
                else await connection.agent.notify("session/cancel", { sessionId: created.sessionId });
                await Promise.race([
                    Promise.all([canceled.promise, prompt, close]),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(Error(`${ending} did not settle the pending form`)), 1500);
                    }),
                ]);
                assertEquals((await prompt).stopReason, "cancelled");
                assertStringIncludes(textAtPromptResponse, "Operation canceled.");
                if (ending === "cancel") {
                    const next = await connection.agent.request("session/prompt", {
                        sessionId: created.sessionId,
                        prompt: [{ type: "text", text: "/version" }],
                    });
                    assertEquals(next.stopReason, "end_turn");
                    await connection.agent.request("session/close", { sessionId: created.sessionId });
                }
            } finally {
                clearTimeout(timer);
                // A failed implementation must not leave the fixture hung on an unanswered client request.
                answer.resolve({ action: "cancel" });
                await Promise.allSettled([prompt, close]);
                connection.close();
                server.close();
                await Promise.all([connection.closed, server.closed]);
            }
        });
    });
}
