import { makeTempFile } from "../../testing/temp-file.ts";
import { readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "./hosted-session.js";
import { attachSessionEventSubscribers } from "./session.js";
import { createSessionRuntimeEvent } from "./session-runtime-events.js";
import { getCwd } from "../../constants.js";

/**
 * @returns {{ session: any, emit: (event: any) => void, unsubscribed: () => boolean }}
 */
function makeSubscribableSession() {
    /** @type {((event: any) => void) | null} */
    let subscriber = null;
    let unsubscribed = false;
    return {
        session: {
            /** @param {(event: any) => void} fn */
            subscribe(fn) {
                subscriber = fn;
                return () => {
                    unsubscribed = true;
                    subscriber = null;
                };
            },
        },
        emit(event) {
            if (!subscriber) throw new Error("no subscriber registered");
            subscriber(event);
        },
        unsubscribed: () => unsubscribed,
    };
}

/** @param {string} id */
function makeRuntimeHarness(id) {
    const hostedSession = new HostedSession({ id, cwd: getCwd() });
    /** @type {any[]} */
    const events = [];
    hostedSession.setEventSink({
        emit: (/** @type {any} */ event) => events.push(createSessionRuntimeEvent(id, event)),
    });
    return { hostedSession, events };
}

const agentDef = /** @type {any} */ ({ name: "tester", displayName: "Tester" });

test("explicit isolated-step cancellation does not erase the validation panel with a terminal error", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("completed-step-cancellation");
    const cancellation = new AbortController();
    const state = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession, cancellation.signal);
    cancellation.abort();
    emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "The signal has been aborted" },
    });
    emit({ type: "turn_end" });
    assertEquals(events.filter((event) => event.type === "terminal_error").length, 0);
    assertEquals(events.filter((event) => event.type === "turn_end").length, 1);
    state.unsubscribe();
});

test("aborted signal assistant errors stay hidden when Esc already reported cancellation", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("agent-cancellation-abort-error");
    const state = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession);

    emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "The signal has been aborted" },
    });
    emit({ type: "turn_end" });

    assertEquals(events.filter((event) => event.type === "terminal_error").length, 0);
    assertEquals(events.filter((event) => event.type === "turn_end").length, 1);
    state.unsubscribe();
});

test("session subscriber emits thinking, message, status, error, usage, and lifecycle events only", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("subscriber-streams");
    const state = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession);

    emit({ type: "turn_start", turnId: "turn-known" });
    emit({ type: "message_start", message: { id: "assistant-known", role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think 1" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think 2" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer 1" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer 2" } });
    emit({
        type: "message_end",
        message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "model exploded",
            usage: { input: 12, output: 4 },
        },
    });
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage: "retry", delayMs: 10 });
    emit({ type: "auto_retry_end", success: false, attempt: 2, finalError: "still failed" });
    emit({ type: "compaction_start", reason: "overflow" });
    emit({ type: "compaction_end", reason: "overflow", result: { tokensBefore: 1000 } });
    emit({ type: "turn_end" });

    const thinking = events.filter((event) => event.type === "assistant_thinking_delta");
    const text = events.filter((event) => event.type === "assistant_text_delta");
    assertEquals(thinking.length, 2);
    assertEquals(thinking[0].messageId, thinking[1].messageId);
    assertStringIncludes(thinking[0].messageId, "turn-known:thinking:");
    assertEquals(events.filter((event) => event.type === "assistant_thinking_end").length, 1);
    assertEquals(text.map((event) => event.delta), ["answer 1", "answer 2"]);
    assertEquals(text.every((event) => event.messageId === "assistant-known"), true);
    assertEquals(text.every((event) => event.agentName === "Tester" && event.messageKind === "assistant"), true);
    assertEquals(events.find((event) => event.type === "usage")?.usage, {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
    });
    assertEquals(events.filter((event) => event.type === "terminal_error").length, 1);
    assertEquals(events.filter((event) => event.type === "system_status").length, 4);
    assertEquals(events.filter((event) => event.type === "turn_start").length, 1);
    assertEquals(events.filter((event) => event.type === "turn_end").length, 1);
    state.endThinking();
    assertEquals(events.filter((event) => event.type === "assistant_thinking_end").length, 1);
});

test("plan_written tool start ends active thinking before waiting for review", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("subscriber-plan-written-thinking");
    attachSessionEventSubscribers(session, agentDef, undefined, hostedSession);

    emit({ type: "turn_start", turnId: "plan-turn" });
    emit({ type: "message_start", message: { id: "assistant-plan", role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reviewing" } });
    emit({ type: "tool_execution_start", toolCallId: "tool-plan", toolName: "plan_written", args: { planName: "p" } });

    assertEquals(events.map((event) => event.type), [
        "turn_start",
        "assistant_thinking_delta",
        "assistant_thinking_end",
        "attention_requested",
        "tool_start",
    ]);
    assertEquals(events[2].messageId, events[1].messageId);
});

test("session subscriber maps one Pi tool lifecycle to one runtime tool lifecycle", () => {
    const { session, emit, unsubscribed } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("subscriber-tools");
    const state = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession);

    emit({ type: "turn_start", turnId: "tool-turn" });
    emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "echo hi" } });
    emit({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        partialResult: { content: [{ text: "hi" }] },
    });
    emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        isError: false,
        result: { content: [{ text: "hi\n" }] },
    });
    emit({ type: "tool_execution_start", toolCallId: "tool-2", toolName: "plan_written", args: { planName: "p" } });
    emit({ type: "tool_execution_start", toolCallId: "tool-3", toolName: "user_interview", args: {} });

    const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
    assertEquals(toolEvents.map((event) => event.type), [
        "tool_start",
        "tool_update",
        "tool_end",
        "tool_start",
        "tool_start",
    ]);
    assertEquals(toolEvents[0].title, "$ echo hi");
    assertEquals(toolEvents[0].kind, "execute");
    assertEquals(toolEvents[1].output, "hi");
    assertEquals(toolEvents[1].content, [{ type: "text", text: "hi" }]);
    assertEquals(toolEvents[1].details, null);
    assertEquals(toolEvents[2].output, "hi\n");
    assertEquals(toolEvents[2].title, "$ echo hi");
    assertEquals(toolEvents[2].kind, "execute");
    assertEquals(typeof toolEvents[2].durationMs, "number");
    assertEquals(
        events.filter((event) => event.type === "attention_requested").map((event) => event.reason),
        ["planWritten", "userInterview"],
    );
    assertEquals(state.drainInvokedToolNames(), ["bash", "plan_written", "user_interview"]);
    state.unsubscribe();
    assertEquals(unsubscribed(), true);
});

test("delegated child messages remain visible on the parent HostedSession event surface", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("subscriber-delegated");
    const delegatedAgent = /** @type {import('./types.js').AgentDefinition} */ ({
        name: "delegated",
        displayName: "Delegated Agent",
        model: "",
        description: "Context-isolated child",
        tools: [],
        systemPrompt: "system",
    });
    const state = attachSessionEventSubscribers(session, delegatedAgent, undefined, hostedSession);

    emit({ type: "turn_start", turnId: "delegated-turn" });
    emit({ type: "message_start", message: { id: "delegated-message", role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "child handoff" } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: {} } });
    emit({ type: "turn_end" });

    const textEvent = events.find((event) => event.type === "assistant_text_delta");
    assertEquals(textEvent?.delta, "child handoff");
    assertEquals(textEvent?.agentName, "Delegated Agent");
    assertEquals(events.some((event) => event.type === "turn_start"), true);
    assertEquals(events.some((event) => event.type === "turn_end"), true);
    state.unsubscribe();
});

test("session subscriber writes debug stream logs without any presentation port", async () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession } = makeRuntimeHarness("subscriber-debug");
    const debugLogPath = await makeTempFile({ prefix: "runwield-subscriber-log-test-", suffix: ".log" });
    try {
        attachSessionEventSubscribers(session, agentDef, debugLogPath, hostedSession);
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking live" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "writing live" } });
        const log = await fsReadFile(debugLogPath, "utf8");
        assertStringIncludes(log, "Event: MESSAGE START");
        assertStringIncludes(log, "thinking live");
        assertStringIncludes(log, "writing live");
    } finally {
        await fsRm(debugLogPath);
    }
});

test("provider notices use shared safe language while retaining diagnostic evidence", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("provider-notices");
    const state = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession);
    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Unexpected EOF" } });
    emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "Network error: Unexpected EOF",
    });
    emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Network error: Unexpected EOF" });
    emit({
        type: "summarization_retry_scheduled",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        errorMessage: "Unexpected EOF",
    });
    emit({ type: "summarization_retry_finished" });
    emit({ type: "compaction_end", reason: "overflow", errorMessage: "503 <html>secret</html>" });
    assertEquals(
        events.filter((event) => event.type === "terminal_error").map((event) => [event.message, event.error]),
        [
            ["The model service stopped responding before the reply was complete.", "Unexpected EOF"],
        ],
    );
    assertEquals(events.filter((event) => event.type === "system_status").map((event) => event.message), [
        "The model service stopped responding before the reply was complete. Retrying in 2 seconds (1 of 3).",
        "The model service stopped responding before the reply was complete. 3 retries were completed. You can try again.",
        "The model service stopped responding before the reply was complete. Retrying summary in 4 seconds (2 of 3).",
        "Auto-compaction failed: The model service is temporarily unavailable.",
    ]);
    state.unsubscribe();
});

test("cancelled retry emits no provider failure or exhaustion notice", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("cancelled-provider-retry");
    const controller = new AbortController();
    const state = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession, controller.signal);
    controller.abort();
    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Unexpected EOF" } });
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "Unexpected EOF" });
    emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
    emit({
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "Unexpected EOF",
    });
    assertEquals(events.filter((event) => event.type === "terminal_error" || event.type === "system_status"), []);
    state.unsubscribe();
});

test("a permanent final error gives its action instead of suggesting another unchanged retry", () => {
    const { session, emit } = makeSubscribableSession();
    const { hostedSession, events } = makeRuntimeHarness("provider-permanent-after-retry");
    const state = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession);
    emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "401 Unauthorized" });
    assertEquals(events.filter((event) => event.type === "system_status").map((event) => event.message), [
        "The model service could not verify your access. Check your sign-in or API credentials. 1 retry was completed.",
    ]);
    state.unsubscribe();
});
