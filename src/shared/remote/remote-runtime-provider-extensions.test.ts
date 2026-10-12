import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type RuntimeFixture, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

async function installExtension(f: RuntimeFixture, body: string) {
    const root = join(f.remoteProject, "fixture-extension");
    await Deno.mkdir(root);
    await Deno.mkdir(join(f.remoteProject, ".wld"), { recursive: true });
    await Deno.writeTextFile(
        join(root, "package.json"),
        JSON.stringify({
            name: "remote-hook-fixture",
            version: "1.0.0",
            type: "module",
            pi: {
                extensions: ["./index.js"],
                wld: { compatible: true, extensionApi: 1, kind: "code-extension" },
            },
        }),
    );
    await Deno.writeTextFile(join(root, "index.js"), `export default (pi) => { ${body} };\n`);
    await Deno.writeTextFile(
        join(f.remoteProject, ".wld", "settings.json"),
        JSON.stringify({ packages: ["../fixture-extension"] }),
    );
}

const providerHooks = [
    ["before_provider_request", "onPayload"],
    ["before_provider_headers", "transformHeaders"],
    ["after_provider_response", "onResponse"],
    ["provider_stream_event", "onProviderStreamEvent"],
] as const;

for (const [event, option] of providerHooks) {
    Deno.test(`remote root fails closed instead of discarding ${event} extension callbacks`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            await installExtension(f, `pi.on("${event}", () => {});`);
            let executed = false;
            f.setModelResponseFactory(() => {
                executed = true;
                return fauxAssistantMessage(fauxText("Provider callback was silently discarded."));
            });
            const child = await f.start();
            await child.read();
            await child.send({ kind: "turn", text: "Run with this installed provider extension." });
            const result = await child.read();
            assertEquals(result.ok, false, JSON.stringify(result));
            assertStringIncludes(result.error || "", `Unsupported remote model option: ${option}`);
            assertEquals(executed, false, "No laptop model request may precede callback validation");
        });
    });
}

Deno.test("remote root keeps core and package tool and Agent lifecycle extensions active", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        await installExtension(
            f,
            `
            let started = false;
            pi.on("session_start", () => { started = true; });
            pi.on("before_agent_start", (event) => ({
                systemPrompt: event.systemPrompt + (started ? "\\nAgent lifecycle proof." : "\\nMissing session start.")
            }));
            pi.on("tool_result", (event) => ({
                content: [...event.content, { type: "text", text: "Tool lifecycle proof." }]
            }));
        `,
        );
        await Deno.writeTextFile(
            join(f.resources, "agents", "remote-runtime.md"),
            "---\nname: Remote Runtime\ndescription: Lifecycle conversation\ntools:\n    - read\n    - memory\n---\nUse project tools when asked.\n",
        );
        const contexts: string[] = [];
        f.setModelResponseFactories([
            (context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxToolCall("read", { path: "sentinel.txt" }));
            },
            (context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Lifecycle hooks are active."));
            },
        ]);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Read the sentinel." });
        const result = await child.read();
        assertEquals(result.ok, true, JSON.stringify(result));
        assertEquals(contexts.length, 2);
        assertStringIncludes(contexts[0], "Agent lifecycle proof.");
        assertStringIncludes(contexts[0], '"name":"memory"');
        assertStringIncludes(contexts[1], "remote initial");
        assertStringIncludes(contexts[1], "Tool lifecycle proof.");
        assert(result.savedId);
        assertStringIncludes((await f.control.list(result.savedId))[0].contents || "", "Lifecycle hooks are active.");
    });
});
