import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";
import {
    captureTranscriptEvidence,
    createReplayEvents,
    getCommittedTranscriptAuthorityFacts,
    projectCommittedTranscript,
    selectProjectedEventsAfterCursor,
    summarizeProjectedEntries,
} from "./session-transcript-projection.js";

/** @param {string} path */
async function removeTempDir(path) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await Deno.remove(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return;
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
    throw lastError;
}

/** @param {(home: string) => Promise<void>} callback */
async function withHome(callback) {
    return await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir({ prefix: "runwield-projection-home-" });
        Deno.env.set("HOME", home);
        try {
            return await callback(home);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
}

Deno.test("Session projection reads the last persisted Session rename", () => {
    assertEquals(
        summarizeProjectedEntries([
            { type: "session", name: "Original" },
            { type: "session_info", name: "First rename" },
            { type: "message", message: { role: "user", content: "Not the name" } },
            { type: "session_info", name: "Saved name" },
        ]).name,
        "Saved name",
    );
});

Deno.test("committed projection verifies exact prefix and ignores later tail", async () => {
    await withHome(async (home) => {
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const sessionDir = join(home, ".wld", "sessions", encodeCwdForSessionDir(cwd));
        await Deno.mkdir(sessionDir, { recursive: true });
        const sessionPath = join(sessionDir, "2026-01-01T00-00-00-000Z_pi-1.jsonl");
        const committed = [
            { type: "session", id: "pi-1", cwd, timestamp: "2026-01-01T00:00:00.000Z" },
            {
                type: "message",
                id: "entry-user",
                timestamp: "2026-01-01T00:00:01.000Z",
                message: { role: "user", content: "hello" },
            },
            {
                type: "message",
                id: "entry-assistant",
                timestamp: "2026-01-01T00:00:02.000Z",
                message: { role: "assistant", content: "hi" },
            },
        ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        await Deno.writeTextFile(
            sessionPath,
            committed +
                JSON.stringify({ type: "message", id: "tail", message: { role: "assistant", content: "hidden" } }) +
                "\n",
        );
        const evidence = await captureTranscriptEvidence({
            transcriptPath: sessionPath,
            transcriptCwd: cwd,
            byteLength: new TextEncoder().encode(committed).byteLength,
        });
        const projected = await projectCommittedTranscript({
            cwd,
            sessionDir,
            sessionPath,
            generation: 0,
            byteLength: evidence.byteLength,
            terminalEntryId: evidence.terminalEntryId,
            digestHex: evidence.digestHex,
        });
        assertEquals(projected.events.map((event) => event.eventId), [
            "entry-user:user_message:0",
            "entry-assistant:assistant_text_delta:0",
        ]);
        assertEquals(projected.events.map((event) => event.type), ["user_message", "assistant_text_delta"]);
    });
});

Deno.test("committed projection replays Agy backend status as display-only system status", () => {
    const events = createReplayEvents("projection", [
        {
            type: "custom",
            customType: "runwield.backend_status",
            data: {
                version: 1,
                backend: "agy-cli",
                kind: "non_zero_exit",
                message: "Antigravity CLI exited before completing the turn.",
            },
        },
        {
            type: "custom",
            id: "agy-warning",
            customType: "runwield.backend_status",
            data: {
                version: 1,
                backend: "agy-cli",
                kind: "non_zero_exit",
                afterAcceptedTerminal: true,
                message: "Late Agy host failure after accepted workflow result.",
            },
        },
        {
            type: "custom",
            customType: "runwield.backend_status",
            data: {
                version: 1,
                backend: "claude-cli",
                kind: "canceled",
                message: "Claude Code turn canceled.",
            },
        },
    ], { projectRoot: Deno.cwd() });

    assertEquals(events.map((event) => event.type), ["system_status", "system_status", "system_status"]);
    assertEquals(events.map((event) => event.level), ["error", "warning", "warning"]);
    assertEquals(events[0].messageId.includes("agy-cli-backend-status"), true);
    assertEquals(events[2].messageId.includes("claude-cli-backend-status"), true);
    assertEquals(JSON.stringify(events).includes("workflow_tool_event"), false);
});

Deno.test("committed projection replays CLI backend final messages as ordinary transcript text", async () => {
    await withHome(async (home) => {
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const sessionDir = join(home, ".wld", "sessions", encodeCwdForSessionDir(cwd));
        await Deno.mkdir(sessionDir, { recursive: true });
        const sessionPath = join(sessionDir, "2026-01-01T00-00-00-000Z_claude.jsonl");
        const committed = [
            { type: "session", id: "claude", cwd, timestamp: "2026-01-01T00:00:00.000Z" },
            {
                type: "custom",
                id: "backend-claude",
                customType: "runwield.execution_backend",
                data: { backend: "claude-cli" },
            },
            {
                type: "message",
                id: "user-claude",
                message: { role: "user", content: [{ type: "text", text: "hi claude" }] },
            },
            { type: "model_change", id: "model-claude", provider: "claude-cli", modelId: "sonnet" },
            {
                type: "message",
                id: "assistant-claude",
                message: { role: "assistant", content: [{ type: "text", text: "stream complete" }] },
            },
            {
                type: "custom",
                id: "agent-agy",
                customType: "runwield.active_agent",
                data: { agentName: "planner" },
            },
            {
                type: "custom",
                id: "backend-agy",
                customType: "runwield.execution_backend",
                data: { backend: "agy-cli", model: "gemini-fixture" },
            },
            { type: "message", id: "user-agy", message: { role: "user", content: [{ type: "text", text: "hi agy" }] } },
            { type: "model_change", id: "model-agy", provider: "agy-cli", modelId: "gemini-fixture" },
            {
                type: "message",
                id: "assistant-agy",
                message: { role: "assistant", content: [{ type: "text", text: "agy complete" }] },
            },
        ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        await Deno.writeTextFile(sessionPath, committed);
        const evidence = await captureTranscriptEvidence({
            transcriptPath: sessionPath,
            transcriptCwd: cwd,
            byteLength: new TextEncoder().encode(committed).byteLength,
        });
        const projected = await projectCommittedTranscript({
            cwd,
            sessionDir,
            sessionPath,
            generation: 0,
            byteLength: evidence.byteLength,
            terminalEntryId: evidence.terminalEntryId,
            digestHex: evidence.digestHex,
        });
        const replayedText = projected.events.map((event) =>
            "text" in event ? event.text : "delta" in event ? event.delta : ""
        );
        assertEquals(replayedText.includes("hi claude"), true);
        assertEquals(replayedText.includes("stream complete"), true);
        assertEquals(replayedText.includes("hi agy"), true);
        assertEquals(replayedText.includes("agy complete"), true);
        assertEquals(JSON.stringify(projected.events).includes("runwield-planner-"), false);
    });
});

Deno.test("committed projection rejects mismatched evidence", async () => {
    await withHome(async (home) => {
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const sessionDir = join(home, ".wld", "sessions", encodeCwdForSessionDir(cwd));
        await Deno.mkdir(sessionDir, { recursive: true });
        const sessionPath = join(sessionDir, "2026-01-01T00-00-00-000Z_pi-1.jsonl");
        const content = JSON.stringify({
            type: "session",
            id: "pi-1",
            cwd,
            timestamp: "2026-01-01T00:00:00.000Z",
        }) + "\n";
        await Deno.writeTextFile(sessionPath, content);
        await assertRejects(
            () =>
                projectCommittedTranscript({
                    cwd,
                    sessionDir,
                    sessionPath,
                    generation: 0,
                    byteLength: new TextEncoder().encode(content).byteLength,
                    terminalEntryId: null,
                    digestHex: "0".repeat(64),
                }),
            Error,
            "digest",
        );
    });
});

Deno.test("projection resolves active agent machine names to display names", () => {
    const events = createReplayEvents("projection", [
        { type: "custom", id: "agent", customType: "runwield.active_agent", data: { agentName: "frontend-engineer" } },
        {
            type: "message",
            id: "reply",
            message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        },
    ], { projectRoot: Deno.cwd() });
    assertEquals(events.find((event) => event.type === "assistant_text_delta")?.agentName, "Frontend Engineer");
});

Deno.test("projection emits RunWield notices only for later different active Agents", () => {
    const events = createReplayEvents("projection", [
        {
            type: "custom",
            id: "agent-guide",
            customType: "runwield.active_agent",
            data: { agentName: "guide", displayName: "Guide" },
        },
        {
            type: "message",
            id: "guide-reply",
            message: { role: "assistant", content: [{ type: "text", text: "Plan first." }] },
        },
        {
            type: "custom",
            id: "agent-guide-repeat",
            customType: "runwield.active_agent",
            data: { agentName: "guide", displayName: "Guide" },
        },
        {
            type: "custom",
            id: "agent-operator",
            customType: "runwield.active_agent",
            data: { agentName: "operator", displayName: "Operator" },
        },
        {
            type: "message",
            id: "operator-reply",
            message: { role: "assistant", content: [{ type: "text", text: "Operate." }] },
        },
    ], { projectRoot: Deno.cwd() });

    assertEquals(
        events.map((
            event,
        ) => [
            event.type,
            event.eventId,
            event.message || event.delta || "",
            event.header || "",
            event.agentName || "",
        ]),
        [
            ["assistant_text_delta", "guide-reply:assistant_text_delta:0", "Plan first.", "", "Guide"],
            ["system_status", "agent-operator:agent_switch:0", "Agent switched to Operator", "RunWield", ""],
            ["assistant_text_delta", "operator-reply:assistant_text_delta:0", "Operate.", "", "Operator"],
        ],
    );
});

Deno.test("projection cursor selection returns only later events and advances summary-only generations", () => {
    const events = [
        { type: "user_message", eventId: "one" },
        { type: "assistant_text_delta", eventId: "two" },
        { type: "assistant_text_delta", eventId: "three" },
    ];
    const selected = selectProjectedEventsAfterCursor({ events, cursorEventId: "two" });
    assertEquals(selected.events.map((event) => event.eventId), ["three"]);
    assertEquals(selected.nextCursor, "three");
    const summaryOnly = selectProjectedEventsAfterCursor({ events: [], cursorEventId: null });
    assertEquals(summaryOnly.events, []);
    assertEquals(summaryOnly.nextCursor, null);
});

Deno.test("projection ignores old notification records", () => {
    const summary = summarizeProjectedEntries([
        { type: "custom", id: "agent-entry", customType: "runwield.active_agent", data: { agentName: "Ideator" } },
        { type: "custom", id: "old-alert", customType: "runwield.attention", data: { reason: "agentStopped" } },
    ]);
    assertEquals("attention" in summary, false);
    assertEquals(summary.activeAgent, "ideator");
});

Deno.test("projection summary keeps the latest valid Agy execution backend fact", () => {
    const summary = summarizeProjectedEntries([
        {
            type: "custom",
            customType: "runwield.execution_backend",
            data: { backend: "agy-cli", provider: "agy-cli", model: "gemini-3.8-flash", thinkingLevel: "low" },
        },
        { type: "custom", customType: "runwield.execution_backend", data: { backend: 7, model: {} } },
        {
            type: "custom",
            customType: "runwield.execution_backend",
            data: {
                backend: "agy-cli",
                provider: "agy-cli",
                model: "gemini-3.1-pro",
                thinkingLevel: "medium",
                effort: "high",
                backendModel: "gemini-3.1-pro-high",
            },
        },
        { type: "custom", customType: "runwield.execution_backend", data: { backend: "agy-cli" } },
        {
            type: "custom",
            customType: "runwield.execution_backend",
            data: {
                backend: "agy-cli",
                provider: "agy-cli",
                model: "gemini-unknown",
                thinkingLevel: "medium",
                effort: "high",
                backendModel: "gemini-unknown-high",
            },
        },
        {
            type: "custom",
            customType: "runwield.execution_backend",
            data: {
                backend: "agy-cli",
                provider: "agy-cli",
                model: "gemini-3.1-pro",
                thinkingLevel: "medium",
                effort: "low",
                backendModel: "gemini-3.1-pro-low",
            },
        },
        {
            type: "custom",
            customType: "runwield.execution_backend",
            data: {
                backend: "agy-cli",
                provider: "agy-cli",
                model: "gemini-3.1-pro",
                thinkingLevel: "medium",
                effort: "high",
                backendModel: "gemini-3.1-pro-low",
            },
        },
    ]);

    assertEquals(summary.executionBackend, {
        backend: "agy-cli",
        provider: "agy-cli",
        model: "gemini-3.1-pro",
        thinkingLevel: "medium",
        effort: "high",
        backendModel: "gemini-3.1-pro-high",
    });
});

Deno.test("committed transcript authority facts are explicit projection extracts", () => {
    const facts = getCommittedTranscriptAuthorityFacts({
        snapshot: {
            activeAgent: "Ideator",
            model: "gpt-test",
            provider: "openai",
            thinkingLevel: "high",
            workflowContext: { routingIntent: "FEATURE", complexity: "LOW" },
        },
    });

    assertEquals(facts, {
        activeAgent: "Ideator",
        model: "gpt-test",
        provider: "openai",
        thinkingLevel: "high",
        workflowContext: { routingIntent: "FEATURE", complexity: "LOW" },
        tutorialContext: null,
        planAssociations: [],
    });
    assertEquals(getCommittedTranscriptAuthorityFacts(null), {
        activeAgent: null,
        model: null,
        provider: null,
        thinkingLevel: null,
        workflowContext: null,
        tutorialContext: null,
        planAssociations: [],
    });
});

Deno.test("projection cursor selection fails closed when the prior cursor is absent", () => {
    const events = [{ type: "user_message", eventId: "one" }];
    assertThrows(
        () => selectProjectedEventsAfterCursor({ events, cursorEventId: "missing" }),
        Error,
        "Timeline cursor",
    );
});

Deno.test("projection cursor selection validates prefix ordinal continuity", () => {
    const events = [
        { type: "user_message", eventId: "one" },
        { type: "assistant_text_delta", eventId: "inserted" },
        { type: "assistant_text_delta", eventId: "two" },
    ];
    assertThrows(
        () => selectProjectedEventsAfterCursor({ events, cursorEventId: "two", cursorEventOrdinal: 1 }),
        Error,
        "prefix-continuous",
    );
    const selected = selectProjectedEventsAfterCursor({ events, cursorEventId: "two", cursorEventOrdinal: 2 });
    assertEquals(selected.events, []);
    assertEquals(selected.nextCursorOrdinal, 2);
});

Deno.test("^projection replays Claude backend failure entries as display-only status$", () => {
    const entries = [
        { type: "custom", id: "active", customType: "runwield.active_agent", data: { agentName: "Engineer" } },
        {
            type: "custom",
            id: "backend-failure",
            customType: "runwield.backend_status",
            data: {
                version: 1,
                backend: "claude-cli",
                kind: "auth_failed",
                exitCode: 1,
                message: "Claude Code authentication failed. Sign in to Claude Code, then retry this turn.",
            },
        },
        {
            type: "custom",
            id: "backend-canceled",
            customType: "runwield.backend_status",
            data: {
                version: 1,
                backend: "claude-cli",
                kind: "canceled",
                exitCode: null,
                message: "Claude Code turn canceled.",
            },
        },
    ];
    const events = createReplayEvents("projection", entries);
    assertEquals(events.map((event) => ({ type: event.type, level: event.level, messageId: event.messageId })), [
        { type: "system_status", level: "error", messageId: "backend-failure" },
        { type: "system_status", level: "warning", messageId: "backend-canceled" },
    ]);
    assertEquals(events[0].message, "Claude Code authentication failed. Sign in to Claude Code, then retry this turn.");
    assertEquals(getCommittedTranscriptAuthorityFacts({ snapshot: summarizeProjectedEntries(entries) }), {
        activeAgent: "engineer",
        workflowContext: null,
        model: null,
        provider: null,
        thinkingLevel: null,
        tutorialContext: null,
        planAssociations: [],
    });
});

Deno.test("summarizeProjectedEntries exposes Plan Associations and ignores legacy planName-only context", () => {
    const association = {
        planId: "plan-1",
        planName: "example-plan",
        purpose: "planning",
        segmentId: "segment-1",
        segmentKind: "planning",
        recordedAt: "2026-01-01T00:00:00.000Z",
    };
    const summary = summarizeProjectedEntries([
        { type: "custom", customType: "runwield.workflow_context", data: { planName: "example-plan" } },
        { type: "custom", customType: "runwield.plan_association", data: association },
    ]);

    assertEquals(summary.workflowContext, { planName: "example-plan" });
    assertEquals(summary.planAssociations, [association]);
    assertEquals(
        summarizeProjectedEntries([
            { type: "custom", customType: "runwield.workflow_context", data: { planName: "example-plan" } },
        ]).planAssociations,
        [],
    );
});

Deno.test("projection summary and authority expose only the latest valid tutorial context", () => {
    const first = {
        version: 1,
        guidanceEnabled: true,
        shownExplanationIds: ["welcome", "welcome"],
        recapShown: false,
        planId: null,
    };
    const disabled = { ...first, guidanceEnabled: false, shownExplanationIds: ["welcome", "plans"] };
    const summary = summarizeProjectedEntries([
        { type: "custom", customType: "runwield.tutorial_context", data: first },
        { type: "custom", customType: "runwield.tutorial_context", data: disabled },
    ]);
    assertEquals(summary.tutorialContext, disabled);
    assertEquals(getCommittedTranscriptAuthorityFacts({ snapshot: summary }).tutorialContext, disabled);
    assertEquals(
        summarizeProjectedEntries([
            { type: "custom", customType: "runwield.tutorial_context", data: first },
            { type: "custom", customType: "runwield.tutorial_context", data: { ...first, version: 2 } },
        ]).tutorialContext,
        null,
    );
});

Deno.test("accepted workflow transitions replay their result even when the tool stopped its own turn", () => {
    const entries = [
        {
            type: "message",
            id: "call",
            message: {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "completed-1",
                        name: "task_completed",
                        arguments: { message: "Attempted" },
                    },
                ],
            },
        },
        {
            type: "custom",
            id: "accepted",
            customType: "runwield.workflow_tool_event",
            data: {
                state: "accepted",
                kind: "task_completed",
                toolCallId: "completed-1",
                payload: { outcome: "task_completed", message: "Delivered and verified." },
            },
        },
    ];
    for (const withProviderResult of [false, true]) {
        const events = createReplayEvents(
            "session",
            withProviderResult
                ? [...entries, {
                    type: "message",
                    id: "result",
                    message: {
                        role: "toolResult",
                        toolName: "task_completed",
                        toolCallId: "completed-1",
                        content: [{ type: "text", text: "Delivered and verified." }],
                        details: { outcome: "task_completed", message: "Delivered and verified." },
                    },
                }]
                : entries,
        );
        assertEquals(events.filter((event) => event.type === "tool_end").length, 1);
        assertEquals(events.filter((event) => event.workflowMessage === "task_completed").length, 1);
        assertEquals(events.find((event) => event.workflowMessage === "task_completed")?.toolCallId, "completed-1");
        assertEquals(events.find((event) => event.type === "tool_end")?.isError, false);
    }
    assertEquals(createReplayEvents("session", entries.slice(0, 1)).some((event) => event.type === "tool_end"), false);
    const triage = createReplayEvents("session", [{
        type: "custom",
        id: "triage",
        customType: "runwield.workflow_tool_event",
        data: {
            state: "accepted",
            kind: "triage_report",
            toolCallId: "triage-1",
            payload: { routingIntent: "QUICK_FIX", complexity: "LOW", summary: "Fix the broken image send." },
        },
    }]);
    assertEquals(triage[0].type, "tool_end");
    assertEquals(triage[0].toolName, "triage_report");
    assertEquals(triage[0].details.summary, "Fix the broken image send.");
});

Deno.test("Session replay preserves images and every text block as one user message", () => {
    const events = createReplayEvents("session", [
        {
            type: "message",
            id: "mixed",
            message: {
                role: "user",
                content: [
                    { type: "text", text: "Look at this" },
                    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
                    { type: "text", text: "and explain it." },
                ],
            },
        },
        {
            type: "message",
            id: "image-only",
            message: {
                role: "user",
                content: [
                    { type: "image", data: "b3RoZXI=", mimeType: "image/jpeg" },
                ],
            },
        },
    ]);
    assertEquals(events.map((event) => ({ type: event.type, text: event.text, images: event.images })), [
        {
            type: "user_message",
            text: "Look at this\nand explain it.",
            images: [{ base64: "aW1hZ2U=", mimeType: "image/png" }],
        },
        { type: "user_message", text: "", images: [{ base64: "b3RoZXI=", mimeType: "image/jpeg" }] },
    ]);
});
