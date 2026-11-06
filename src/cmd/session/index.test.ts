import { test } from "node:test";
import { readFile, rename, writeFile } from "node:fs/promises";
import stripAnsi from "strip-ansi";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { getRunWieldSessionDir } from "../../shared/session/root-session.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runSessionCommand } from "./index.ts";

function outputSurface() {
    const messages: string[] = [];
    return {
        messages,
        uiAPI: {
            appendSystemMessage: (message: string) => {
                messages.push(message);
            },
            appendAgentMessageStart: () => ({ appendText: () => {} }),
            requestRender: () => {},
            promptSelect: () => Promise.resolve(null),
            promptText: () => Promise.resolve(null),
            showModelSelector: () => {},
            abortActivePrompt: () => {},
        },
    };
}

test("session command reads saved messages and keeps compaction usage separate from assistant totals", async () => {
    await withRuntimeCommandFixture("session-command-recorded-", async ({ projectRoot }) => {
        const manager = SessionManager.create(projectRoot, getRunWieldSessionDir(projectRoot));
        manager.appendModelChange("runtime-command-fixture", "fixture-model");
        const first = manager.appendMessage({ role: "user", content: "Keep this decision.", timestamp: Date.now() });
        manager.appendMessage({
            ...fauxAssistantMessage(fauxText("Decision recorded.")),
            usage: {
                input: 1000,
                output: 250,
                cacheRead: 500,
                cacheWrite: 25,
                totalTokens: 1775,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
        });
        manager.appendMessage({ role: "user", content: "Summarize it.", timestamp: Date.now() });
        manager.appendCompaction("Decision summary.", first, 96000, undefined, false, {
            input: 90,
            output: 7,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 97,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });
        manager.appendSessionInfo("Deep Work");
        const path = manager.getSessionFile();
        if (!path) throw new Error("Fixture transcript must be persisted");
        // Partial provider evidence must stay unavailable, never become measured zero.
        const records = (await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        for (const record of records)
            if (record.type === "compaction") {
                delete record.usage.cacheWrite;
                delete record.usage.cost;
            }
        await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.loadSession({
                cwd: projectRoot,
                sessionId: manager.getSessionId(),
                sessionPath: path,
            });
            const { uiAPI, messages } = outputSurface();
            await runSessionCommand([], { uiAPI, sessionRuntime: runtime, sessionId });
            const report = stripAnsi(messages.join("\n"));
            for (const expected of [
                "Deep Work",
                "Session compacted 1 time",
                "User: 2",
                "Assistant: 1",
                "Total: 1,775",
                "Compaction Usage (separate from assistant tokens)",
                "Input: 90",
                "Output: 7",
                "Cache Write: unavailable",
                "Cost (USD): unavailable",
            ]) {
                assertStringIncludes(report, expected);
            }
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("session command reports missing committed evidence without displaying invented usage", async () => {
    await withRuntimeCommandFixture("session-command-missing-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Saved response.");
        const store = openFileSessionStore();
        const runtime = createSessionRuntime({ sessionStore: store });
        const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
        let transcript = "";
        try {
            assertEquals(
                (await runtime.promptUserTurn(sessionId, { initialRequest: "Save this conversation." })).ok,
                true,
            );
            const id = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId || "";
            transcript = store.getCurrentSessionSegment(id)?.transcriptPath || "";
            if (!transcript) throw new Error("A committed transcript is required");
            await rename(transcript, `${transcript}.held`);
            const { uiAPI, messages } = outputSurface();
            await runSessionCommand([], { uiAPI, sessionRuntime: runtime, sessionId });
            assertStringIncludes(messages.join("\n"), "Session info is unavailable");
            assertEquals(messages.join("\n").includes("Assistant Tokens"), false);
        } finally {
            if (transcript) await rename(`${transcript}.held`, transcript);
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});

test("session command reports a missing active Session", async () => {
    const { uiAPI, messages } = outputSurface();
    await runSessionCommand([], { uiAPI });
    assertEquals(messages, ["Error: No active session."]);
});
