import { test } from "node:test";
import { ok as assert, equal } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

for (const sessionId of ["bridge-owned", undefined]) {
    test(
        sessionId
            ? "closing the model bridge releases cached Codex connections without closing unrelated Sessions"
            : "closing a model bridge without a provider Session leaves unrelated Codex connections open",
        async () => {
            const connections: string[] = [];
            const provider = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request, server) {
                    if (server.upgrade(request)) {
                        connections.push(request.headers.get("session-id") ?? "");
                        return;
                    }
                    return new Response("WebSocket required", { status: 400 });
                },
                websocket: {
                    message(socket) {
                        const item = {
                            type: "message",
                            id: "msg_fixture",
                            role: "assistant",
                            status: "completed",
                            content: [{ type: "output_text", text: "hello", annotations: [] }],
                        };
                        for (const event of [
                            {
                                type: "response.output_item.added",
                                output_index: 0,
                                item: { ...item, status: "in_progress", content: [] },
                            },
                            {
                                type: "response.output_text.delta",
                                output_index: 0,
                                content_index: 0,
                                delta: "hello",
                            },
                            {
                                type: "response.completed",
                                response: {
                                    id: "resp_fixture",
                                    status: "completed",
                                    output: [item],
                                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                                },
                            },
                        ])
                            socket.send(JSON.stringify(event));
                    },
                },
            });
            const script = `
                import { ModelRuntime } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
                import { InMemoryCredentialStore, cleanupSessionResources } from ${JSON.stringify(
                    import.meta.resolve("@earendil-works/pi-ai"),
                )};
                import { LocalModelBridge } from ${JSON.stringify(new URL("./model-bridge.ts", import.meta.url).href)};
                const runtime = await ModelRuntime.create({
                    credentials: new InMemoryCredentialStore(), modelsPath: null,
                    allowModelNetwork: false, refreshOnCreate: false,
                });
                const token = "e30." + Buffer.from(JSON.stringify({
                    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
                })).toString("base64url") + ".fixture";
                runtime.registerProvider("codex-lifecycle", {
                    api: "openai-codex-responses", baseUrl: ${JSON.stringify(provider.url.href)}, apiKey: token,
                    models: [{
                        id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 1000, maxTokens: 100,
                    }],
                });
                await runtime.refresh({ allowNetwork: false });
                const model = runtime.getModel("codex-lifecycle", "fixture");
                if (!model) throw new Error("Fixture model unavailable");
                const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
                const options = { sessionId: "unrelated-session", transport: "websocket" };
                await runtime.completeSimple(model, context, options);
                const bridge = new LocalModelBridge(runtime);
                try {
                    const body = await bridge.stream({
                        id: "request", provider: model.provider, model: model.id, simple: true, context,
                        options: { sessionId: ${JSON.stringify(sessionId)}, transport: "websocket" },
                    }).text();
                    if (!body.includes('"type":"done"')) throw new Error(body);
                    bridge.close();
                    await runtime.completeSimple(model, context, options);
                } finally {
                    bridge.close();
                    cleanupSessionResources("unrelated-session");
                }
                console.log("BRIDGE_CLOSED");
            `;
            const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
            let output = "";
            child.stdout.on("data", (bytes) => (output += bytes));
            child.stderr.on("data", (bytes) => (output += bytes));
            let finished = false;
            const exited = once(child, "exit").then(([code, signal]) => {
                finished = true;
                return { code, signal };
            });
            try {
                const startupDeadline = Date.now() + 15_000;
                while (!output.includes("BRIDGE_CLOSED") && !finished && Date.now() < startupDeadline) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(output.includes("BRIDGE_CLOSED"), output);
                const shutdownDeadline = Date.now() + 1_500;
                while (!finished && Date.now() < shutdownDeadline) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(finished, "Owned Codex connection kept the laptop runtime alive after bridge closure");
                equal((await exited).code, 0, output);
                equal(
                    connections.filter((id) => id === "unrelated-session").length,
                    1,
                    "The unrelated provider Session must reuse its original connection after bridge closure",
                );
            } finally {
                if (!finished) {
                    child.kill("SIGKILL");
                    await exited;
                }
                await provider.stop(true);
            }
        },
    );
}
