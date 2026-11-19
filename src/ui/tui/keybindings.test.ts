import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";

// Queue recall/cancellation, clipboard failures, image previews, thinking changes and
// Ctrl+C cleanup are covered by composed input/clipboard and Golden journeys.
test("real editor distinguishes keyboard help from typed punctuation and submits modified newlines", async () => {
    await withRuntimeCommandFixture("tui-keyboard-", async ({ setModelResponse }) => {
        setModelResponse("Keyboard request received.");
        const terminal = new VirtualTerminal({ columns: 120, rows: 45 });
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            initialAgentName: "operator",
        });
        const requests: string[] = [];
        composition.runtime.subscribeSessionEvents(composition.sessionId, (event) => {
            if (event.type === "user_message") requests.push(event.text);
        });
        async function screen() {
            await new Promise((resolve) => setTimeout(resolve, 30));
            await terminal.flush();
            return terminal.getScreenText();
        }
        try {
            await composition.waitForIdle();
            if (!composition.uiAPI.startToolExecution) throw new Error("Missing tool rendering API");
            const tool = composition.uiAPI.startToolExecution("keyboard-tool", "read", "Inspect README");
            tool.setOutput("Deep inspection evidence for the keyboard toggle");
            tool.endExecution(false, 1);
            terminal.input("\x0f");
            assertEquals((await screen()).includes("Deep inspection evidence for the keyboard toggle"), false);
            terminal.input("\x0f");
            assertStringIncludes(await screen(), "Deep inspection evidence for the keyboard toggle");
            terminal.typeText("?");
            assertStringIncludes(await screen(), "Keyboard shortcuts");
            terminal.pressEscape();
            assertEquals((await screen()).includes("Keyboard shortcuts"), false);
            terminal.typeText("literal?");
            assertEquals((await screen()).includes("Keyboard shortcuts"), false);
            terminal.input("\x1b[13;2u");
            terminal.typeText("second line");
            terminal.input("\x1b[13;3u");
            terminal.typeText("third line");
            terminal.pressEnter();
            await composition.waitForIdle();
            assertEquals(requests, ["literal?\nsecond line\nthird line"]);
            assertStringIncludes(await screen(), "Keyboard request received.");
        } finally {
            await composition.dispose();
        }
    });
});
