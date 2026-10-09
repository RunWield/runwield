import { assertEquals, assertThrows } from "@std/assert";
import { mapRuntimeEventToAcpUpdate } from "../../acp/event-mapper.js";
import { createSessionRuntimeEvent, RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { attachTuiRuntimeAdapter as attachRuntimeAdapter } from "./runtime-adapter.js";

/**
 * @param {Omit<Parameters<typeof attachRuntimeAdapter>[0], "browser" | "notifyRunWieldEvent"> & { notifyRunWieldEvent?: Parameters<typeof attachRuntimeAdapter>[0]["notifyRunWieldEvent"] }} options
 */
function attachTuiRuntimeAdapter(options) {
    const { notifyRunWieldEvent = () => {}, ...adapterOptions } = options;
    return attachRuntimeAdapter({
        ...adapterOptions,
        browser: NO_OPEN_BROWSER_PORT,
        notifyRunWieldEvent,
    });
}

function makeUi() {
    /** @type {string[]} */
    const transcript = [];
    /** @type {Map<string, any>} */
    const tools = new Map();
    /** @type {any[]} */
    const validationProgressUpdates = [];
    const uiAPI = /** @type {import('./types.js').UiAPI} */ ({
        abortActivePrompt: () => {},
        appendUserMessage: (text) => transcript.push(`user:${text}`),
        appendImage: (base64, mimeType) => transcript.push(`image:${mimeType}:${base64}`),
        appendQueuedMessage: (id, text) => transcript.push(`queue:add:${id}:${text}`),
        removeQueuedMessage: (id) => transcript.push(`queue:remove:${id}`),
        appendAgentMessageStart: (agentName) => ({
            appendText: (text) => transcript.push(`assistant:${agentName}:${text}`),
        }),
        appendThinkingStart: () => ({
            appendDelta: (text) => transcript.push(`thinking:${text}`),
            end: () => transcript.push("thinking:end"),
        }),
        appendSystemMessage: (text, isError, header) =>
            transcript.push(`system:${isError ? "error" : "info"}:${header ? `${header}:` : ""}${text}`),
        updateValidationProgress: (progress) => {
            validationProgressUpdates.push(progress);
            transcript.push(`validation:${progress.outcome}:${progress.stage}`);
        },
        updateValidationReport: (role, report) =>
            transcript.push(`report:${role}:${report.agentName}:${report.markdown}`),
        clearValidationPanel: () => transcript.push("validation:clear"),
        showKeyboardHelp: (help) =>
            transcript.push(
                `help:${help.title}:${help.items.map((/** @type {{ key: string }} */ item) => item.key).join(",")}`,
            ),
        startToolExecution: (id, name, title) => {
            const block = {
                bodyText: "",
                startTime: Date.now(),
                /** @param {string} text */
                setOutput(text) {
                    this.bodyText = text;
                    transcript.push(`tool:update:${id}:${text}`);
                },
                /**
                 * @param {string} base64
                 * @param {string} mimeType
                 */
                appendDisplayImage(base64, mimeType) {
                    transcript.push(`tool:image:${id}:${mimeType}:${base64}`);
                },
                /** @param {boolean} isError */
                endExecution(isError) {
                    transcript.push(`tool:end:${id}:${isError ? "error" : "ok"}`);
                },
            };
            tools.set(id, block);
            transcript.push(`tool:start:${id}:${name}:${title}`);
            return block;
        },
        getActiveToolBlock: (id) => tools.get(id),
        setBusy: (busy) => transcript.push(`busy:${busy}`),
        requestRender() {},
        promptSelect: () => Promise.resolve(null),
        promptText: () => Promise.resolve(null),
        showModelSelector() {},
    });
    return { transcript, uiAPI, validationProgressUpdates };
}

/**
 * Runtime consumer contract fixture. It deliberately has no HostedSession;
 * the adapter can only subscribe by id and read public snapshots.
 *
 * @param {string} sessionId
 * @param {import('../../shared/session/session-runtime-events.js').RuntimeQueuedMessage[]} [queuedMessages]
 * @param {{ routingIntent?: string, complexity?: string, planName?: string } | null} [workflowContext]
 * @param {string | null} [activeAgent]
 */
function makeRuntimeHarness(sessionId, queuedMessages = [], workflowContext = null, activeAgent = null) {
    /** @type {((event: any) => void) | null} */
    let listener = null;
    /** @type {any[]} */
    const interactionAdapters = [];
    const runtime = /** @type {any} */ ({
        setInteractionAdapter: (/** @type {string} */ id, /** @type {any} */ adapter) => {
            if (id !== sessionId) throw new Error("wrong session id");
            interactionAdapters.push(adapter);
            return { ok: true };
        },
        subscribeSessionEvents: (/** @type {string} */ id, /** @type {(event: any) => void} */ next) => {
            if (id !== sessionId) throw new Error("wrong session id");
            listener = next;
            return () => {
                if (listener === next) listener = null;
            };
        },
        emitSessionEvent: (/** @type {string} */ id, /** @type {any} */ event) => {
            listener?.(createSessionRuntimeEvent(id, event));
        },
        getSessionSnapshot: (/** @type {string} */ id) => ({
            id,
            cwd: Deno.cwd(),
            name: null,
            queuedMessages,
            workflowContext,
            activeAgent,
        }),
    });
    return { runtime, sessionId, interactionAdapters };
}

Deno.test("TUI adapter does not advertise a Pair form while attached", () => {
    const { runtime, sessionId, interactionAdapters } = makeRuntimeHarness("pair-capability-lifetime");
    const { uiAPI } = makeUi();
    let canceledPrompts = 0;
    uiAPI.abortActivePrompt = () => {
        canceledPrompts++;
    };

    const registration = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    assertEquals(interactionAdapters.length, 1);
    assertEquals(interactionAdapters[0].supportsInteraction("pair_checkpoint"), false);
    assertEquals(interactionAdapters[0].supportsInteraction("select"), false);

    registration.dispose();
    registration.dispose();

    assertEquals(canceledPrompts, 1);
    assertEquals(interactionAdapters, [interactionAdapters[0], null]);
});

Deno.test("attachTuiRuntimeAdapter suppresses local shell user echo and keeps shell tool title", () => {
    const sessionId = "runtime-session";
    const { runtime } = makeRuntimeHarness(sessionId);
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.USER_MESSAGE, text: "!git st", images: [] });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_START,
        toolCallId: "local-shell",
        toolName: "bash",
        title: "! git st",
        kind: "execute",
    });
    adapter.dispose();

    assertEquals(transcript, ["tool:start:local-shell:bash:! git st"]);
});

Deno.test("TUI and ACP adapters consume the same semantic runtime transcript", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-parity");
    const { transcript, uiAPI } = makeUi();
    /** @type {Array<{ reason: string, sessionName: string | undefined, agentName: string | undefined }>} */
    const attentionRequests = [];
    const adapter = attachTuiRuntimeAdapter({
        runtime,
        sessionId,
        uiAPI,
        notifyRunWieldEvent: (reason, options) => {
            attentionRequests.push({
                reason,
                sessionName: options?.sessionName,
                agentName: options?.agentName,
            });
        },
    });
    const fixture =
        /** @type {Array<Partial<import('../../shared/session/session-runtime-events.js').SessionRuntimeEvent> & { type: string }>} */ ([
            { type: RuntimeEventTypes.USER_MESSAGE, text: "hello" },
            {
                type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
                messageId: "answer-1",
                delta: "world",
                agentName: "Guide",
                messageKind: "assistant",
            },
            {
                type: RuntimeEventTypes.TOOL_START,
                toolCallId: "tool-1",
                toolName: "read",
                title: "read README.md",
                kind: "read",
            },
            {
                type: RuntimeEventTypes.TOOL_UPDATE,
                toolCallId: "tool-1",
                toolName: "read",
                title: "read README.md",
                kind: "read",
                content: [{ type: "text", text: "part" }],
                output: "part",
                details: null,
            },
            {
                type: RuntimeEventTypes.TOOL_END,
                toolCallId: "tool-1",
                toolName: "read",
                title: "read README.md",
                kind: "read",
                content: [{ type: "text", text: "partial" }],
                output: "partial",
                details: null,
                isError: false,
                durationMs: 40,
            },
            { type: RuntimeEventTypes.SYSTEM_STATUS, level: "warning", message: "notice" },
            {
                type: RuntimeEventTypes.KEYBOARD_HELP,
                title: "Keyboard shortcuts",
                items: [{ key: "?", description: "show help" }],
            },
            { type: RuntimeEventTypes.BUSY_CHANGED, busy: true },
            { type: RuntimeEventTypes.BUSY_CHANGED, busy: false },
            { type: RuntimeEventTypes.ATTENTION_REQUESTED, reason: "agentStopped", agentName: "Guide" },
        ]);

    for (const event of fixture) runtime.emitSessionEvent(sessionId, event);
    const acpUpdates = fixture.map((event) =>
        mapRuntimeEventToAcpUpdate(createSessionRuntimeEvent(sessionId, /** @type {any} */ (event)))
    ).filter(Boolean);
    adapter.dispose();

    assertEquals(transcript, [
        "user:hello",
        "assistant:Guide:world",
        "tool:start:tool-1:read:read README.md",
        "tool:update:tool-1:part",
        "tool:update:tool-1:partial",
        "tool:end:tool-1:ok",
        "system:info:notice",
        "help:Keyboard shortcuts:?",
        "busy:true",
        "busy:false",
    ]);
    assertEquals(acpUpdates.map((update) => update?.sessionUpdate), [
        "user_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
        "tool_call_update",
        "agent_message_chunk",
    ]);
    assertEquals(attentionRequests, [{ reason: "agentStopped", sessionName: undefined, agentName: "Guide" }]);
});

Deno.test("TUI adapter renders display images from read tool results", () => {
    const { runtime, sessionId } = makeRuntimeHarness("tool-image-display");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_START,
        toolCallId: "tool-1",
        toolName: "read",
        title: "read image.png",
        kind: "read",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_END,
        toolCallId: "tool-1",
        toolName: "read",
        title: "read image.png",
        kind: "read",
        content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "abc", mimeType: "image/png" },
        ],
        output: "Read image file [image/png]",
        details: { runwieldDisplayImages: [{ base64: "abc", mimeType: "image/png" }] },
        isError: false,
        durationMs: 10,
    });
    adapter.dispose();

    assertEquals(transcript, [
        "tool:start:tool-1:read:read image.png",
        "tool:update:tool-1:Read image file [image/png]",
        "tool:image:tool-1:image/png:abc",
        "tool:end:tool-1:ok",
    ]);
});

Deno.test("TUI adapter keeps standalone image fallback when a tool block is hidden", () => {
    const { runtime, sessionId } = makeRuntimeHarness("hidden-tool-image-display");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_START,
        toolCallId: "hidden-1",
        toolName: "task_completed",
        title: "task_completed",
        kind: "execute",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_END,
        toolCallId: "hidden-1",
        toolName: "task_completed",
        title: "task_completed",
        kind: "execute",
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        output: "done",
        details: null,
        isError: false,
        durationMs: 10,
    });
    adapter.dispose();

    assertEquals(transcript, ["image:image/png:abc"]);
});

Deno.test("TUI adapter clears successful validation immediately without waiting for another user message", () => {
    const { runtime, sessionId } = makeRuntimeHarness("validation-panel-lifecycle");
    const { transcript, validationProgressUpdates, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        message: "OPERATION status without validation",
        level: "info",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        message: "Validation complete",
        level: "success",
        validationProgress: {
            kind: "mechanical",
            outcome: "verified",
            stage: "terminal",
            checks: { ci: "passed", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
        },
    });
    runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.USER_MESSAGE, text: "next", images: [] });

    assertEquals(validationProgressUpdates.length, 0);
    assertEquals(transcript, [
        "system:info:OPERATION status without validation",
        "validation:clear",
        "system:info:Validation complete",
        "user:next",
    ]);
    adapter.dispose();
});

Deno.test("TUI adapter clears active validation panel on terminal runtime errors", () => {
    const { runtime, sessionId } = makeRuntimeHarness("validation-panel-terminal-error");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        message: "Validation running",
        level: "info",
        validationProgress: {
            kind: "workflow",
            outcome: "running",
            stage: "semantic_review",
            cycle: 1,
            maxCycles: 3,
            totalCycle: 1,
            checks: { ci: "passed", semanticReview: "running", humanReview: "pending", merge: "pending" },
        },
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TERMINAL_ERROR,
        message: "Runtime crashed",
        error: "boom",
    });
    runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.USER_MESSAGE, text: "next", images: [] });

    assertEquals(transcript, [
        "validation:running:semantic_review",
        "system:info:Validation running",
        "validation:clear",
        "system:error:Runtime crashed",
        "user:next",
    ]);
    adapter.dispose();
});

Deno.test("TUI adapter uses reviewer ledger report updates only for the validation panel", () => {
    const { runtime, sessionId } = makeRuntimeHarness("review-ledger-report", [], {
        routingIntent: "FEATURE",
        complexity: "LOW",
    });
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        messageId: "review-ledger-report",
        delta: "Semantic review rejected — 1 issue open:\nR1-1 — Missing guard",
        agentName: "Reviewer",
        messageKind: "workflow",
        workflowMessage: "review_report_update",
        approved: false,
    });

    assertEquals(transcript, [
        "report:reviewer:Reviewer:Semantic review rejected — 1 issue open:\nR1-1 — Missing guard",
    ]);
    adapter.dispose();
});

Deno.test("TUI adapter excludes OPERATION task_completed reports from later validation panels", () => {
    const { runtime, sessionId } = makeRuntimeHarness("operation-report-exclusion", [], {
        routingIntent: "OPERATION",
        complexity: "LOW",
    });
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        messageId: "operation-task-completed",
        delta: "operation done",
        agentName: "Operator",
        messageKind: "workflow",
        workflowMessage: "task_completed",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        message: "Validation started",
        level: "info",
        validationProgress: {
            kind: "mechanical",
            outcome: "running",
            stage: "ci",
            checks: { ci: "running", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
        },
    });

    assertEquals(transcript.includes("report:engineer:Operator:operation done"), false);
    assertEquals(transcript.includes("validation:running:ci"), true);
    adapter.dispose();
});

Deno.test("TUI adapter preserves workflow routing intent across model and thinking updates", () => {
    const { runtime, sessionId } = makeRuntimeHarness("workflow-context-preserved", [], {
        routingIntent: "FEATURE",
        complexity: "LOW",
    });
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.MODEL_CHANGED, model: "test/model" });
    runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.THINKING_LEVEL_CHANGED, thinkingLevel: "medium" });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        messageId: "feature-task-completed-after-model-change",
        delta: "feature done",
        agentName: "Engineer",
        messageKind: "workflow",
        workflowMessage: "task_completed",
    });

    assertEquals(transcript.includes("report:engineer:Engineer:feature done"), true);
    adapter.dispose();
});

Deno.test("TUI adapter clears hidden pre-validation reports on next user message", () => {
    const { runtime, sessionId } = makeRuntimeHarness("hidden-report-clear", [], {
        routingIntent: "FEATURE",
        complexity: "LOW",
    });
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        messageId: "feature-task-completed",
        delta: "feature done",
        agentName: "Engineer",
        messageKind: "workflow",
        workflowMessage: "task_completed",
    });
    runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.USER_MESSAGE, text: "new request", images: [] });

    assertEquals(transcript, [
        "report:engineer:Engineer:feature done",
        "assistant:Engineer:feature done",
        "validation:clear",
        "user:new request",
    ]);
    adapter.dispose();
});

Deno.test("TUI renders Runtime cancellation events instead of key handlers rendering directly", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-cancellation");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.CANCELLATION,
        aborted: true,
        reason: "session_cancel",
        scope: "agent",
        message: "Agent run canceled.",
    });
    adapter.dispose();

    assertEquals(transcript, ["system:info:RunWield:Agent run canceled."]);
});

Deno.test("TUI adapter ignores replayed thinking because it is not active work", () => {
    const { runtime, sessionId } = makeRuntimeHarness("replayed-thinking");
    const { uiAPI, transcript } = makeUi();

    const registration = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_THINKING_DELTA,
        messageId: "thinking-1",
        delta: "old thought",
        agentName: "Engineer",
        _meta: { replay: true },
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_THINKING_END,
        messageId: "thinking-1",
        agentName: "Engineer",
        _meta: { replay: true },
    });
    registration.dispose();

    assertEquals(transcript, []);
});

Deno.test("TUI adapter renders Agent switch notices only for marked root handoffs", () => {
    const { runtime, sessionId } = makeRuntimeHarness("agent-switch-notice", [], null, "guide");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.AGENT_CHANGED,
        agentName: "temporary-profile",
        displayName: "Temporary Profile",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.AGENT_CHANGED,
        agentName: "guide",
        displayName: "Guide",
        rootHandoff: true,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.AGENT_CHANGED,
        agentName: "operator",
        displayName: "Operator",
        rootHandoff: true,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.AGENT_CHANGED,
        agentName: "operator",
        displayName: "Operator",
        rootHandoff: true,
    });
    adapter.dispose();

    assertEquals(transcript, ["system:info:RunWield:Agent switched to Operator"]);
});

Deno.test("TUI adapter suppresses triage report tool blocks", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-triage-report");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_START,
        toolCallId: "tool-triage",
        toolName: "triage_report",
        title: "triage_report",
        kind: "other",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_END,
        toolCallId: "tool-triage",
        toolName: "triage_report",
        title: "triage_report",
        kind: "other",
        content: [{ type: "text", text: "Triage complete." }],
        output: "Triage complete.",
        details: null,
        isError: false,
        durationMs: 10,
    });
    adapter.dispose();

    assertEquals(transcript, []);
});

Deno.test("TUI adapter renders normalized thinking deltas and one tool start", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-coalesce");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_THINKING_DELTA,
        messageId: "thinking-1",
        delta: "Planning",
        agentName: "Guide",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_THINKING_DELTA,
        messageId: "thinking-1",
        delta: " more",
        agentName: "Guide",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_START,
        toolCallId: "tool-1",
        toolName: "code_search",
        title: "code_search createAgentJobHandler",
        kind: "search",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_UPDATE,
        toolCallId: "tool-1",
        toolName: "code_search",
        title: "code_search createAgentJobHandler",
        kind: "search",
        content: [{ type: "text", text: "result" }],
        output: "result",
        details: null,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_END,
        toolCallId: "tool-1",
        toolName: "code_search",
        title: "code_search createAgentJobHandler",
        kind: "search",
        content: [{ type: "text", text: "result" }],
        output: "result",
        details: null,
        isError: false,
        durationMs: 10,
    });
    adapter.dispose();

    assertEquals(transcript, [
        "thinking:Planning",
        "thinking: more",
        "tool:start:tool-1:code_search:code_search createAgentJobHandler",
        "tool:update:tool-1:result",
        "tool:update:tool-1:result",
        "tool:end:tool-1:ok",
        "thinking:end",
    ]);
});

Deno.test("TUI adapter projects core queued, consumed, and dequeued message transitions", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-queue");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });
    const firstMessage = /** @type {import('../../shared/session/session-runtime-events.js').RuntimeQueuedMessage} */ ({
        id: "queued-1",
        text: "revise this",
        images: [{ base64: "abc", mimeType: "image/png", ref: "attachment:abc" }],
        delivery: "steer",
        queuedAt: "2026-07-14T00:00:00.000Z",
    });
    const secondMessage =
        /** @type {import('../../shared/session/session-runtime-events.js').RuntimeQueuedMessage} */ ({
            id: "queued-2",
            text: "remove this",
            images: [],
            delivery: "steer",
            queuedAt: "2026-07-14T00:00:01.000Z",
        });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED,
        status: "queued",
        message: firstMessage,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED,
        status: "consumed",
        message: firstMessage,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.USER_MESSAGE,
        messageId: firstMessage.id,
        text: firstMessage.text,
        images: firstMessage.images,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED,
        status: "queued",
        message: secondMessage,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED,
        status: "dequeued",
        message: secondMessage,
    });
    adapter.dispose();

    assertEquals(transcript, [
        "queue:add:queued-1:revise this\n\n[Image attached: attachment:abc image/png]",
        "queue:remove:queued-1",
        "user:revise this",
        "image:image/png:abc",
        "queue:add:queued-2:remove this",
        "queue:remove:queued-2",
    ]);
});

Deno.test("TUI adapter hydrates queued messages from the core session snapshot", () => {
    const queued = /** @type {import('../../shared/session/session-runtime-events.js').RuntimeQueuedMessage} */ ({
        id: "already-queued",
        text: "already queued",
        images: [],
        delivery: "steer",
        queuedAt: "2026-07-14T00:00:00.000Z",
    });
    const { runtime, sessionId } = makeRuntimeHarness("adapter-queue-snapshot", [queued]);
    const { transcript, uiAPI } = makeUi();

    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });
    adapter.dispose();

    assertEquals(transcript, [`queue:add:${queued.id}:already queued`]);
});

Deno.test("TUI adapter rerenders when Runtime agent or workflow footer state changes", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-workflow-context");
    const { uiAPI } = makeUi();
    let renders = 0;
    uiAPI.requestRender = () => {
        renders++;
    };
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.AGENT_CHANGED,
        agentName: "Engineer",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED,
        workflowContext: { routingIntent: "PROJECT", complexity: "HIGH", planName: "large-change" },
    });
    adapter.dispose();

    assertEquals(renders, 2);
});

Deno.test("TUI adapter does not repaint for invisible idle managed sync", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-idle-managed-sync");
    const { uiAPI } = makeUi();
    let renders = 0;
    uiAPI.requestRender = () => {
        renders++;
    };
    uiAPI.setManagedSyncStatus = () => {};
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
        status: "current",
        localGeneration: 3,
        latestGeneration: 3,
    });
    adapter.dispose();

    assertEquals(renders, 0);
});

Deno.test("a second TUI adapter for one Runtime session fails instead of duplicating output", () => {
    const { runtime, sessionId } = makeRuntimeHarness("adapter-replacement");
    const { transcript, uiAPI } = makeUi();

    const previousAdapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });
    assertThrows(
        () => attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI }),
        Error,
        "already attached",
    );

    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        messageId: "answer-1",
        delta: "once",
        agentName: "Engineer",
        messageKind: "assistant",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_THINKING_DELTA,
        messageId: "thinking-1",
        delta: "once",
        agentName: "Engineer",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_START,
        toolCallId: "tool-1",
        toolName: "read",
        title: "read README.md",
        kind: "read",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TOOL_START,
        toolCallId: "tool-2",
        toolName: "code_structure",
        title: "code_structure",
        kind: "search",
    });

    previousAdapter.dispose();
    const activeAdapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        messageId: "answer-2",
        delta: "still active",
        agentName: "Engineer",
        messageKind: "assistant",
    });
    activeAdapter.dispose();

    assertEquals(transcript, [
        "assistant:Engineer:once",
        "thinking:once",
        "tool:start:tool-1:read:read README.md",
        "tool:start:tool-2:code_structure:code_structure",
        "thinking:end",
        "assistant:Engineer:still active",
    ]);
});

Deno.test("TUI displays an already reported backend error once while preserving other failures", () => {
    const { runtime, sessionId } = makeRuntimeHarness("backend-error-once");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        level: "error",
        message: "Blocked: read_file",
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TERMINAL_ERROR,
        message: "Blocked: read_file",
        messageAlreadyReported: true,
    });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TERMINAL_ERROR,
        message: "A different failure",
    });
    assertEquals(transcript, ["system:error:Blocked: read_file", "system:error:A different failure"]);
    adapter.dispose();
});

Deno.test("TUI does not alert for Workspace- or ACP-owned attention", () => {
    const { runtime, sessionId } = makeRuntimeHarness("notification-owner");
    const { uiAPI } = makeUi();
    /** @type {string[]} */
    const notifications = [];
    const adapter = attachTuiRuntimeAdapter({
        runtime,
        sessionId,
        uiAPI,
        notifyRunWieldEvent: (reason) => notifications.push(reason),
    });
    for (const notificationSurface of /** @type {const} */ (["workspace", "acp", "tui"])) {
        runtime.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.ATTENTION_REQUESTED,
            reason: "agentStopped",
            notificationSurface,
        });
    }
    assertEquals(notifications, ["agentStopped"]);
    adapter.dispose();
});

Deno.test("TUI adapter shows shared provider notices without displaying diagnostic bodies", () => {
    const { runtime, sessionId } = makeRuntimeHarness("provider-friendly-notice");
    const { transcript, uiAPI } = makeUi();
    const adapter = attachTuiRuntimeAdapter({ runtime, sessionId, uiAPI });
    runtime.emitSessionEvent(sessionId, {
        type: RuntimeEventTypes.TERMINAL_ERROR,
        message: "The model service stopped responding before the reply was complete.",
        error: "Network error: Unexpected EOF",
    });
    assertEquals(transcript.some((text) => text.includes("The model service stopped responding")), true);
    assertEquals(transcript.some((text) => text.includes("Network error: Unexpected EOF")), false);
    adapter.dispose();
});

Deno.test("TUI completion waits for settlement, occurs once, and ignores failures and replay", async () => {
    for (const outcome of ["verified", "failed", "paused"]) {
        for (const replay of [false, true]) {
            const { runtime, sessionId } = makeRuntimeHarness(`completion-${outcome}-${replay}`);
            const { uiAPI } = makeUi();
            /** @type {string[]} */
            const completions = [];
            const adapter = attachTuiRuntimeAdapter({
                runtime,
                sessionId,
                uiAPI,
                onSessionComplete: (id) => completions.push(id),
            });
            // This idle event may still be waiting in the presentation queue
            // when publication succeeds; only a subsequent settlement qualifies.
            runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.BUSY_CHANGED, busy: false });
            runtime.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.SYSTEM_STATUS,
                message: "Workflow settled",
                validationProgress: {
                    kind: "workflow",
                    cycle: 1,
                    maxCycles: 3,
                    totalCycle: 1,
                    stage: "terminal",
                    outcome,
                    checks: {
                        ci: "passed",
                        semanticReview: "passed",
                        humanReview: "skipped",
                        merge: outcome === "verified" ? "passed" : "failed",
                    },
                },
                _meta: { replay },
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            assertEquals(completions, []);
            runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.BUSY_CHANGED, busy: false });
            runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.BUSY_CHANGED, busy: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            assertEquals(completions, outcome === "verified" && !replay ? [sessionId] : []);
            adapter.dispose();
        }
    }
});

Deno.test("TUI completion does not interrupt replacement Sessions or a new user turn", async () => {
    for (const replace of [false, true]) {
        const { runtime, sessionId } = makeRuntimeHarness(`completion-replaced-${replace}`);
        const { uiAPI } = makeUi();
        /** @type {string[]} */
        const completions = [];
        const adapter = attachTuiRuntimeAdapter({
            runtime,
            sessionId,
            uiAPI,
            onSessionComplete: (id) => completions.push(id),
        });
        runtime.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.SYSTEM_STATUS,
            message: "Published",
            validationProgress: {
                kind: "workflow",
                cycle: 1,
                maxCycles: 3,
                totalCycle: 1,
                stage: "terminal",
                outcome: "verified",
                checks: { ci: "passed", semanticReview: "passed", humanReview: "skipped", merge: "passed" },
            },
        });
        if (replace) {
            adapter.dispose();
        } else {
            runtime.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.USER_MESSAGE,
                text: "follow up",
                images: [],
            });
        }
        runtime.emitSessionEvent(sessionId, { type: RuntimeEventTypes.BUSY_CHANGED, busy: false });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertEquals(completions, []);
        adapter.dispose();
    }
});
