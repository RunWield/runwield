import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

Deno.test("remote image submission uses the temporary model selected by preflight, not the saved default", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const contexts: string[] = [];
        f.setModelResponseFactory((context) => {
            contexts.push(JSON.stringify(context));
            return fauxAssistantMessage(fauxText("The temporary vision model saw the image."));
        });
        const child = await f.start();
        await child.read();
        await child.send({
            kind: "image-preflight-turn",
            text: "Describe this image using the temporary vision selection.",
            modelOverride: "runtime-command-fixture/vision-selection",
        });
        const preflight = await child.read();
        assertEquals(preflight.kind, "image-preflight");
        assertEquals(preflight.ok, true, preflight.error);
        assertEquals(preflight.preparedModelOverride, "runtime-command-fixture/vision-selection");
        const submitted = await child.read();
        assertEquals(submitted.ok, true, submitted.error);
        assertEquals(f.modelRequests.map((request) => `${request.provider}/${request.model}`), [
            "runtime-command-fixture/vision-selection",
        ]);
        assert(contexts[0].includes('"type":"image"'), contexts[0]);
        assertEquals(JSON.parse(await Deno.readTextFile(f.settingsPath)).defaultModel, "fixture-model");
    }, { additionalModels: [{ id: "vision-selection", name: "Temporary Vision Selection" }] });
});
