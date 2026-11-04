import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import stripAnsi from "strip-ansi";
import { initRunWieldTheme } from "../../ui/theme/theme.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { getHomeDir } from "../../constants.js";
import type { SessionContextReport } from "../../shared/session/session-context-report.ts";
import { formatContextReport, runContextCommand } from "./index.ts";

initRunWieldTheme();

function makeUi() {
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

function makeReport(overrides: Partial<SessionContextReport> = {}): SessionContextReport {
    return {
        agentName: "engineer",
        agentDisplayName: "Engineer",
        provider: "anthropic",
        model: "claude-test",
        usageState: "last_known",
        usedTokens: 1000,
        contextWindow: 2000,
        percent: 50,
        freeTokens: 1000,
        staticTokens: 700,
        activeMessageTokens: 200,
        categories: [
            { id: "agent_instructions", label: "Agent instructions", tokens: 300, percent: 30, items: [] },
            {
                id: "conversation_overhead",
                label: "Conversation & provider overhead",
                tokens: 700,
                percent: 70,
                items: [],
            },
        ],
        instructionFiles: [
            {
                label: `${getHomeDir()}/.wld/RUNWIELD.md`,
                path: `${getHomeDir()}/.wld/RUNWIELD.md`,
                source: "local",
                tokens: 10,
            },
        ],
        skills: [
            {
                label: "write-tests",
                name: "write-tests",
                source: "bundled",
                path: "/skills/write-tests/SKILL.md",
                tokens: 20,
            },
            {
                label: "agent-browser-use",
                name: "agent-browser-use",
                source: "bundled",
                path: "/skills/agent-browser-use/SKILL.md",
                tokens: 15,
            },
            {
                label: "local-skill",
                name: "local-skill",
                source: "local",
                path: "/repo/.wld/skills/local/SKILL.md",
                tokens: 5,
            },
        ],
        ...overrides,
    };
}

test("formatContextReport renders active model, categories, files, and source-grouped skills", () => {
    const plain = stripAnsi(formatContextReport(makeReport()));

    for (const expected of [
        "Context Usage",
        "Engineer (engineer)",
        "anthropic/claude-test",
        "1,000/2,000 (last known)",
        "Agent instructions: 300 tokens (30.0%)",
        "~/.wld/RUNWIELD.md [local]: ~10 tokens",
        "50.0%",
        "local:",
        "bundled:",
        "agent-browser-use: ~15 tokens",
        "write-tests: ~20 tokens",
    ]) {
        assertEquals(plain.includes(expected), true, expected);
    }

    assertEquals(plain.indexOf("local:") < plain.indexOf("bundled:"), true);
    assertEquals(plain.indexOf("agent-browser-use") < plain.indexOf("write-tests"), true);
});

test("formatContextReport makes unavailable and unknown states explicit", () => {
    const plain = stripAnsi(
        formatContextReport(
            makeReport({
                usageState: "unknown_after_compaction",
                usedTokens: null,
                contextWindow: 128000,
                percent: null,
                freeTokens: null,
                instructionFiles: [],
                skills: [],
            }),
        ),
    );

    assertEquals(plain.includes("unknown/128,000 (unknown after compaction)"), true);
    assertEquals(plain.includes("Free space: unknown"), true);
    assertEquals(plain.includes("- None loaded."), true);
    assertEquals(plain.includes("- None advertised."), true);
});

test("runContextCommand reports missing active Agent Session", async () => {
    const { uiAPI, messages } = makeUi();
    await runContextCommand([], { uiAPI });
    assertEquals(messages, ["Error: No active Agent Session context is available yet."]);
});

test("context command renders the committed Session model and estimates without inventing resident context", async () => {
    await withRuntimeCommandFixture("context-command-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Context is ready.");
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
        const { uiAPI, messages } = makeUi();
        try {
            assertEquals(
                (await runtime.promptUserTurn(sessionId, { initialRequest: "Explain the project." })).ok,
                true,
            );
            await runContextCommand([], { uiAPI, sessionRuntime: runtime, sessionId });
            const report = stripAnsi(messages.join("\n"));
            for (const expected of [
                "Context Usage",
                "Guide (guide)",
                "runtime-command-fixture/fixture-model",
                "Committed conversation:",
                "(estimated)",
                "None loaded.",
            ]) {
                assertEquals(report.includes(expected), true, report);
            }
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
