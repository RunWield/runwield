import { assertEquals } from "@std/assert";
import stripAnsi from "strip-ansi";
import { getSettingsManager } from "../../shared/settings.js";
import { createChatFooterController } from "./chat-footer.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";

const modelCases = [
    {
        name: "uses current defaults when both selected fields are missing",
        model: "",
        provider: "",
        expected: "current-provider/current-model",
    },
    {
        name: "uses the current default provider when only the selected model is present",
        model: "selected-model",
        provider: "",
        expected: "current-provider/selected-model",
    },
    {
        name: "uses the current default model when only the selected provider is present",
        model: "",
        provider: "selected-provider",
        expected: "selected-provider/current-model",
    },
    {
        name: "uses the slash-qualified provider ahead of the separate selected provider",
        model: "qualified-provider/selected-model/variant",
        provider: "separate-provider",
        expected: "qualified-provider/selected-model/variant",
    },
];

for (const modelCase of modelCases) {
    Deno.test(`live footer ${modelCase.name}`, async () => {
        await withSessionViewFixture(async ({ runtime, sessionId, session, projectRoot }) => {
            session.resetAgentInfoStack("Router", modelCase.model, modelCase.provider, "router");
            session.setThinkingLevel("off");
            const controller = createChatFooterController({
                runtime,
                getSessionId: () => sessionId,
                requestRender: () => {},
            });
            try {
                controller.component.render(120);
                // Real settings writes after the snapshot exists must still
                // supply any missing fields on the next frame.
                const settings = getSettingsManager(projectRoot);
                await settings.setDefaultModel("current-model");
                await settings.setDefaultProvider("current-provider");
                assertEquals(stripAnsi(controller.component.render(120)[1]).trim(), modelCase.expected);
            } finally {
                controller.dispose();
            }
        });
    });
}
