import { assertEquals } from "../../testing/assertions.ts";
import process from "node:process";
import { test } from "node:test";
import stripAnsi from "strip-ansi";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.js";
import type { UiAPI } from "../../ui/tui/types.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { SessionContextReport } from "../../shared/session/session-context-report.ts";
import { abbreviateHomePath, formatContextReport, renderUsageBar, runContextCommand } from "./index.ts";

type ContextReportReader = (() => SessionContextReport) | SessionRuntime["getSessionContextReport"];

initRunWieldTheme();

function makeUi() {
    const messages: string[] = [];
    return {
        messages,
        uiAPI: {
            appendSystemMessage: ((message: string) => messages.push(message)) as UiAPI["appendSystemMessage"],
        } as UiAPI,
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
        instructionFiles: [{ label: "/tmp/RUNWIELD.md", path: "/tmp/RUNWIELD.md", source: "local", tokens: 10 }],
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

test("renderUsageBar shows known and unknown context state", () => {
    assertEquals(renderUsageBar(50, 4), "■■□□ 50.0%");
    assertEquals(renderUsageBar(null, 4), "□□□□ unknown");
});

test("abbreviateHomePath shortens files under HOME", async () => {
    await withProcessGlobalTestLock(async () => {
        const previous = process.env["HOME"];
        try {
            process.env["HOME"] = "/home/tester";
            assertEquals(abbreviateHomePath("/home/tester/.wld/RUNWIELD.md"), "~/.wld/RUNWIELD.md");
            assertEquals(abbreviateHomePath("/other/file"), "/other/file");
            await Promise.resolve();
        } finally {
            if (previous === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previous;
        }
    });
});

test("formatContextReport renders active model, categories, files, and source-grouped skills", () => {
    const plain = stripAnsi(formatContextReport(makeReport()));

    for (const expected of [
        "Context Usage",
        "Engineer (engineer)",
        "anthropic/claude-test",
        "1,000/2,000 (last known)",
        "Agent instructions: 300 tokens (30.0%)",
        "/tmp/RUNWIELD.md [local]: ~10 tokens",
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

test("runContextCommand renders Runtime context report", async () => {
    const { uiAPI, messages } = makeUi();
    await runContextCommand([], {
        uiAPI,
        sessionId: "runtime-id",
        sessionRuntime: {
            getSessionContextReport: (() => makeReport()) as ContextReportReader,
        } as SessionRuntime,
    });

    assertEquals(stripAnsi(messages[0]).includes("Context Usage"), true);
});
