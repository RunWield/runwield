import { assertEquals } from "../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { startRunWieldAcpServer } from "./server.js";

/** @typedef {{ id?: string, method?: string, params?: { sessionId?: string, update?: { sessionUpdate?: string, content?: { text?: string } } }, result?: { sessionId?: string, stopReason?: string, protocolVersion?: number } }} WireFrame */
/** @typedef {{ cwd?: string, mcpServers?: string[], sessionId?: string, prompt?: Array<{type: string, text: string}>, protocolVersion?: number, clientCapabilities?: { elicitation?: { form?: Record<string, string> } }, clientInfo?: { name: string, version: string } }} WireParams */

test("ACP sends an automatic task result after the original end_turn response", async () => {
    await withRuntimeCommandFixture("acp-background-wire-", async ({ projectRoot, setModelResponseFactories }) => {
        let generatedInput = "";
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("background_task", {
                    action: "start",
                    command: "sleep 0.5; printf 'ACP result data\\n'",
                })),
            () => fauxAssistantMessage(fauxText("I started independent work.")),
            (context) => {
                generatedInput = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxToolCall("user_interview", {
                    question: {
                        type: "multiple_choice",
                        prompt: "Pick a color for the result",
                        choices: [{ value: "blue", label: "Blue" }, { value: "green", label: "Green" }],
                    },
                }));
            },
            () => fauxAssistantMessage(fauxText("I received the ACP task result.")),
        ]);
        const input = new TransformStream();
        const output = new TransformStream();
        const connection = startRunWieldAcpServer(input.readable, output.writable);
        const writer = input.writable.getWriter();
        const reader = output.readable.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = "";
        /** @type {WireFrame[]} */
        const pending = [];
        async function nextFrame() {
            while (!pending.length) {
                const { value, done } = await reader.read();
                if (done) throw Error("ACP connection closed before the result arrived");
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                pending.push(...lines.filter(Boolean).map((line) => /** @type {WireFrame} */ (JSON.parse(line))));
            }
            const frame = pending.shift();
            if (!frame) throw Error("ACP frame was missing");
            return frame;
        }
        /** @param {string} id @param {string} method @param {WireParams} params */
        async function send(id, method, params) {
            await writer.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
            while (true) {
                const frame = await nextFrame();
                if (frame.id === id) return frame;
            }
        }
        try {
            const initialized = await send("init", "initialize", {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: "wire-fixture", version: "1.0" },
            });
            assertEquals(initialized.result?.protocolVersion, 1);
            const created = await send("new", "session/new", { cwd: projectRoot, mcpServers: [] });
            assert(created.result?.sessionId, JSON.stringify(created));
            const sessionId = created.result.sessionId;
            await send("select-agent", "session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "/agent ideator" }],
            });
            const prompt = await send("prompt", "session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "Start a background command and finish your turn." }],
            });
            assertEquals(prompt.result?.stopReason, "end_turn");
            let resultText = "";
            let extraResponses = 0;
            for (let index = 0; index < 200 && !resultText.includes("Pick a color for the result"); index++) {
                const frame = await nextFrame();
                if (frame.id === "prompt") extraResponses++;
                if (
                    frame.method === "session/update" && frame.params?.sessionId === sessionId &&
                    frame.params.update?.sessionUpdate === "agent_message_chunk"
                ) {
                    resultText += frame.params.update.content?.text || "";
                }
            }
            assert(resultText.includes("Pick a color for the result"));
            assert(generatedInput.includes("ACP result data"));
            assertEquals(extraResponses, 0);
            const answered = await send("answer", "session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "1" }],
            });
            assertEquals(answered.result?.stopReason, "end_turn");
        } finally {
            await writer.close();
            connection.close();
            await connection.closed;
            reader.releaseLock();
        }
    });
});
