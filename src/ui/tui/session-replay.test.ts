import process from "node:process";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeLongReplayFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

test("TUI resume startup renders the final saved reply after multiple history pages", async () => {
    await withRuntimeCommandFixture("tui-complete-replay-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeLongReplayFixture(homeDir, projectRoot);
        process.chdir(projectRoot);
        const terminal = new VirtualTerminal({ columns: 120, rows: 35 });
        const before = await readTranscriptEvidence(fixture.transcriptPath);
        const replies: string[] = [];
        try {
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                skipModelWelcome: true,
                sessionStartMode: "continue",
                resumeSessionId: fixture.session.piSessionId,
                onSessionReady: (id, runtime) => {
                    runtime.subscribeSessionEvents(id, (event) => {
                        if (event.type === "assistant_text_delta") replies.push(event.delta);
                    });
                },
            });
            try {
                await composition.waitForIdle();
                await terminal.flush();
                assertEquals(replies, ["Committed hello.", ...fixture.texts]);
                assertStringIncludes(terminal.getScreenText(), "Saved reply 450.");
                assertEquals(await readTranscriptEvidence(fixture.transcriptPath), before);
            } finally {
                await composition.dispose();
            }
        } finally {
            await fixture.cleanup();
        }
    });
});
