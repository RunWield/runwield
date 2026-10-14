import { test } from "node:test";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createInteractiveTuiComposition, type InteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

interface ClaudeTuiFixture {
    composition: InteractiveTuiComposition;
    terminal: VirtualTerminal;
    logPath: string;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt++) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for Claude TUI fixture");
}

async function submit(terminal: VirtualTerminal, text: string): Promise<void> {
    terminal.typeText(text);
    terminal.pressEnter();
    await terminal.flush();
}

async function withClaudeTui(callback: (fixture: ClaudeTuiFixture) => Promise<void>): Promise<void> {
    await withRuntimeCommandFixture("claude-tui-steering-", async ({ projectRoot, settingsPath }) => {
        const binDir = join(projectRoot, "claude-bin");
        const logPath = join(projectRoot, "claude.jsonl");
        await mkdir(binDir);
        await writeRuntimeExecutableFixture(
            join(binDir, "claude"),
            fileURLToPath(
                new URL("../../shared/session/backends/claude-cli/testing/fake-claude-mcp-client.ts", import.meta.url),
            ),
        );
        await writeFile(logPath, "");
        await writeFile(
            settingsPath,
            (await readFile(settingsPath, "utf8"))
                .replace("runtime-command-fixture", "claude-cli")
                .replace("fixture-model", "sonnet"),
        );
        const keys = ["PATH", "RUNWIELD_CLAUDE_FIXTURE_LOG", "RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS"];
        const previous = keys.map((key) => process.env[key]);
        process.env.PATH = `${binDir}${delimiter}${previous[0] || ""}`;
        process.env.RUNWIELD_CLAUDE_FIXTURE_LOG = logPath;
        process.env.RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS = "10000";
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        let composition: InteractiveTuiComposition | null = null;
        try {
            composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                skipModelWelcome: false,
                sessionStartMode: "new",
                initialAgentName: "operator",
            });
            await callback({ composition, terminal, logPath });
        } finally {
            await composition?.dispose();
            for (const [index, key] of keys.entries()) {
                if (previous[index] === undefined) delete process.env[key];
                else process.env[key] = previous[index];
            }
        }
    });
}

test("Claude TUI Up recalls the latest steering without removing earlier steering", async () => {
    await withClaudeTui(async ({ composition, terminal, logPath }) => {
        await submit(terminal, "original request");
        await waitFor(async () => (await readFile(logPath, "utf8")).includes("original request"));
        await submit(terminal, "oldest steering");
        await submit(terminal, "newest steering");
        await waitFor(() => composition.runtime.getQueuedMessages(composition.sessionId).length === 2);
        terminal.input("\x1b[A");
        await terminal.flush();
        await waitFor(() => composition.runtime.getQueuedMessages(composition.sessionId).length === 1);
        assertEquals(
            composition.runtime.getQueuedMessages(composition.sessionId).map((message) => message.text),
            ["oldest steering"],
        );
        assertStringIncludes(terminal.getViewportLines().slice(-8).join("\n"), "newest steering");
        terminal.pressEscape();
        await terminal.flush();
        await composition.waitForIdle(5000);
        const input = terminal.getViewportLines().slice(-8).join("\n");
        assertStringIncludes(input, "oldest steering");
        assertStringIncludes(input, "newest steering");
    });
});

test("Claude TUI Escape keeps recalled steering after the canceled turn settles", async () => {
    await withClaudeTui(async ({ composition, terminal, logPath }) => {
        await submit(terminal, "original request");
        await waitFor(async () => (await readFile(logPath, "utf8")).includes("original request"));
        await submit(terminal, "recalled correction");
        await waitFor(() => composition.runtime.getQueuedMessages(composition.sessionId).length === 1);
        terminal.pressEscape();
        await terminal.flush();
        await composition.waitForIdle(5000);
        assertEquals(composition.runtime.getQueuedMessages(composition.sessionId), []);
        assertStringIncludes(terminal.getViewportLines().slice(-8).join("\n"), "recalled correction");
    });
});
