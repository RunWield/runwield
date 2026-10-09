import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { createBoundedRemoteModelSession } from "./bounded-model-session.ts";
import { startRemoteControlService } from "./control.ts";

interface HttpToolCallDelta {
    index: number;
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

interface HttpDelta {
    role?: string;
    content?: string;
    tool_calls?: HttpToolCallDelta[];
}

Deno.test("remote Pi tool result reaches a laptop-authenticated HTTP model provider", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await Deno.makeTempDir();
        const previousHome = Deno.env.get("HOME");
        Deno.env.set("HOME", root);
        const project = join(root, "project");
        const globalRoot = join(root, "laptop-global");
        await Deno.mkdir(join(project, ".wld"), { recursive: true });
        await Deno.mkdir(globalRoot);
        const remoteSecret = `remote-account-only-${crypto.randomUUID()}`;
        await Deno.writeTextFile(
            join(globalRoot, "auth.json"),
            JSON.stringify({
                "laptop-http": { type: "api_key", key: remoteSecret },
            }),
        );
        const sentinel = `project-only-${crypto.randomUUID()}`;
        await Deno.writeTextFile(join(project, "sentinel.txt"), sentinel);
        const secret = `laptop-only-${crypto.randomUUID()}`;
        const requests: string[] = [];
        const provider = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            assertEquals(request.headers.get("Authorization"), `Bearer ${secret}`);
            assert(!request.headers.get("Authorization")?.includes(remoteSecret));
            assert(!request.headers.get("Authorization")?.includes(control.credential));
            const body = await request.text();
            assert(!body.includes(remoteSecret));
            assert(!body.includes(control.credential));
            requests.push(body);
            const chunk = (delta: HttpDelta, finish: string | null) =>
                `data: ${
                    JSON.stringify({
                        id: "chatcmpl-test",
                        object: "chat.completion.chunk",
                        created: 1,
                        model: "test",
                        choices: [{ index: 0, delta, finish_reason: finish }],
                    })
                }\n\n`;
            const first = requests.length === 1;
            const content = first
                ? chunk({
                    role: "assistant",
                    tool_calls: [{
                        index: 0,
                        id: "call-1",
                        type: "function",
                        function: { name: "read_remote_sentinel", arguments: "{}" },
                    }],
                }, null) + chunk({}, "tool_calls")
                : chunk({ role: "assistant", content: `Received ${sentinel}` }, null) + chunk({}, "stop");
            return new Response(`${content}data: [DONE]\n\n`, {
                headers: { "Content-Type": "text/event-stream" },
            });
        });
        const providerPort = provider.addr.transport === "tcp" ? provider.addr.port : 0;
        await Deno.mkdir(join(root, ".wld"));
        await Deno.writeTextFile(
            join(root, ".wld", "models.json"),
            JSON.stringify({
                providers: {
                    "laptop-http": {
                        api: "openai-completions",
                        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
                        models: [{ id: "test", name: "Test", contextWindow: 128000, maxTokens: 1000 }],
                    },
                },
            }),
        );
        await Deno.writeTextFile(
            join(root, ".wld", "auth.json"),
            JSON.stringify({
                "laptop-http": { type: "api_key", key: secret },
            }),
        );
        const control = startRemoteControlService({ buildId: "b".repeat(64), protocol: 1 });
        try {
            const endpoint = `http://127.0.0.1:${control.port}`;
            const headers = { Authorization: `Bearer ${control.credential}` };
            assertEquals((await fetch(`${endpoint}/models/catalog`, { headers })).status, 403);
            assertEquals((await fetch(`${endpoint}/models/catalog`)).status, 401);
            assertEquals(
                (await fetch(`${endpoint}/handshake`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        buildId: "b".repeat(64),
                        protocol: 1,
                    }),
                })).status,
                200,
            );
            assertEquals((await fetch(`${endpoint}/readiness`, { method: "POST", headers })).status, 200);
            const catalog = await (await fetch(`${endpoint}/models/catalog`, { headers })).json();
            assert(
                catalog.models.some((model: { provider: string; id: string }) =>
                    model.provider === "laptop-http" && model.id === "test"
                ),
                JSON.stringify(catalog),
            );
            const { session, registry } = await createBoundedRemoteModelSession({
                mount: { globalRoot, lost: new Promise<void>(() => {}), close: () => Promise.resolve() },
                connection: { port: control.port, credential: control.credential },
                cwd: project,
                provider: "laptop-http",
                modelId: "test",
                customTools: [{
                    name: "read_remote_sentinel",
                    label: "Read remote sentinel",
                    description: "Read remote project sentinel",
                    parameters: { type: "object", properties: {}, additionalProperties: false },
                    execute: async () => ({
                        content: [{
                            type: "text" as const,
                            text: await Deno.readTextFile(join(project, "sentinel.txt")),
                        }],
                        details: null,
                    }),
                }],
            });
            try {
                assert(!JSON.stringify(registry.getAll()).includes(secret));
                assert(!JSON.stringify(registry.getAll()).includes(String(providerPort)));
                await session.prompt("Read the project sentinel using the tool, then repeat it.");
                assertEquals(requests.length, 2);
                assert(!requests[0].includes(sentinel));
                assertStringIncludes(requests[1], sentinel);
                assert(session.messages.some((message) =>
                    message.role === "assistant" &&
                    message.content.some((part) => part.type === "text" && part.text.includes(sentinel))
                ));
            } finally {
                session.dispose();
            }
        } finally {
            await control.close();
            await provider.shutdown();
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await Deno.remove(root, { recursive: true });
        }
    });
});
