import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createSessionRuntimeEvent, RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { attachTuiRuntimeAdapter } from "./runtime-adapter.js";

/** @param {string} sessionId */
function makeRuntime(sessionId) {
    /** @type {((event: any) => void) | null} */
    let listener = null;
    const runtime = /** @type {any} */ ({
        setInteractionAdapter: () => {},
        subscribeSessionEvents: (/** @type {string} */ _id, /** @type {(event: any) => void} */ next) => {
            listener = next;
            return () => {
                listener = null;
            };
        },
        getSessionSnapshot: (/** @type {string} */ id) => ({
            id,
            cwd: "/tmp",
            queuedMessages: [],
            workflowContext: null,
        }),
        emit(/** @type {any} */ event) {
            listener?.(createSessionRuntimeEvent(sessionId, event));
        },
    });
    return runtime;
}

function makeUi() {
    /** @type {string[]} */
    const transcript = [];
    const uiAPI = /** @type {import('./types.js').UiAPI} */ ({
        abortActivePrompt: () => {},
        appendUserMessage: (text) => transcript.push(`user:${text}`),
        appendAgentMessageStart: (agentName) => ({
            appendText: (text) => transcript.push(`assistant:${agentName}:${text}`),
        }),
        appendThinkingStart: () => ({ appendDelta: () => {}, end: () => {} }),
        appendSystemMessage: (text) => transcript.push(`system:${text}`),
        startToolExecution: () => ({ startTime: Date.now(), setOutput: () => {}, endExecution: () => {} }),
        getActiveToolBlock: () => undefined,
        setBusy: () => {},
        requestRender: () => {},
        promptSelect: () => Promise.resolve(null),
        promptText: () => Promise.resolve(null),
        showModelSelector: () => {},
    });
    return { transcript, uiAPI };
}

test("TUI appends projectAggregateTranscript events across segment ids without session_replaced", () => {
    const sessionId = "runtime-session";
    const runtime = makeRuntime(sessionId);
    const { transcript, uiAPI } = makeUi();
    /** @type {any[]} */
    const replacements = [];
    const adapter = attachTuiRuntimeAdapter({
        runtime,
        sessionId,
        uiAPI,
        browser: NO_OPEN_BROWSER_PORT,
        notifyRunWieldEvent: () => {},
        onSessionReplaced: (replacement) => replacements.push(replacement),
    });

    runtime.emit({
        type: RuntimeEventTypes.USER_MESSAGE,
        eventId: "segment-a:duplicate:user_message:0",
        text: "first",
        images: [],
    });
    runtime.emit({
        type: RuntimeEventTypes.USER_MESSAGE,
        eventId: "segment-b:duplicate:user_message:0",
        text: "second",
        images: [],
    });
    runtime.emit({
        type: RuntimeEventTypes.USER_MESSAGE,
        eventId: "segment-b:duplicate:user_message:0",
        text: "second",
        images: [],
    });

    adapter.dispose();
    assertEquals(transcript, ["user:first", "user:second"]);
    assertEquals(replacements, []);
});
