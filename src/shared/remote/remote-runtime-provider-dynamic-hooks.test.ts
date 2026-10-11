import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

Deno.test("remote root rejects a provider hook registered during Agent startup before a laptop request", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const root = join(f.remoteProject, "dynamic-hook-extension");
        await Deno.mkdir(root);
        await Deno.mkdir(join(f.remoteProject, ".wld"), { recursive: true });
        await Deno.writeTextFile(
            join(root, "package.json"),
            JSON.stringify({
                name: "remote-dynamic-hook-fixture",
                version: "1.0.0",
                type: "module",
                pi: {
                    extensions: ["./index.js"],
                    wld: { compatible: true, extensionApi: 1, kind: "code-extension" },
                },
            }),
        );
        await Deno.writeTextFile(
            join(root, "index.js"),
            `export default (pi) => {
            pi.on("before_agent_start", () => {
                pi.on("before_provider_headers", () => {});
            });
        };\n`,
        );
        await Deno.writeTextFile(
            join(f.remoteProject, ".wld", "settings.json"),
            JSON.stringify({ packages: ["../dynamic-hook-extension"] }),
        );
        let executed = false;
        f.setModelResponseFactory(() => {
            executed = true;
            return fauxAssistantMessage(fauxText("Dynamic provider callback was silently discarded."));
        });
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Use the dynamically registered extension." });
        const result = await child.read();
        assertEquals(executed, false, "Startup callbacks must not bypass provider hook validation");
        const transcript = result.savedId ? (await f.control.list(result.savedId))[0].contents || "" : "";
        assertStringIncludes(
            `${result.error || ""}\n${transcript}`,
            "Unsupported remote model option: transformHeaders",
        );
    });
});
