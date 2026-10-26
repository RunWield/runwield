import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import {
    createSessionRuntimeEvent,
    RuntimeEventTypes,
    type RuntimeUserMessageEvent,
} from "../../shared/session/session-runtime-events.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "./types.js";
import { attachTuiRuntimeAdapter, type TuiRuntimeAdapterOptions } from "./runtime-adapter.js";

type SessionEventListener = Parameters<SessionRuntime["subscribeSessionEvents"]>[1];
type FixtureUserMessage = Omit<RuntimeUserMessageEvent, "sessionId" | "timestamp" | "messageId">;
type SessionReplacement = Parameters<NonNullable<TuiRuntimeAdapterOptions["onSessionReplaced"]>>[0];

interface FixtureRuntimeAdapterOptions extends Omit<TuiRuntimeAdapterOptions, "runtime"> {
    runtime: ReturnType<typeof makeRuntime> | SessionRuntime;
}

type FixtureRuntimeAdapter = (options: FixtureRuntimeAdapterOptions) => ReturnType<typeof attachTuiRuntimeAdapter>;

interface FixtureUiApi extends UiAPI {
    abortActivePrompt: () => void;
}

function makeRuntime(sessionId: string) {
    let listener: SessionEventListener | null = null;
    const runtime = {
        setInteractionAdapter: () => {},
        subscribeSessionEvents: (_id: string, next: SessionEventListener) => {
            listener = next;
            return () => {
                listener = null;
            };
        },
        getSessionSnapshot: (id: string) => ({
            id,
            cwd: "/tmp",
            queuedMessages: [],
            workflowContext: null,
        }),
        emit(event: FixtureUserMessage) {
            listener?.(createSessionRuntimeEvent(sessionId, event));
        },
    };
    return runtime;
}

function makeUi() {
    const transcript: string[] = [];
    const uiAPI: FixtureUiApi = {
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
    };
    return { transcript, uiAPI };
}

test("TUI appends projectAggregateTranscript events across segment ids without session_replaced", () => {
    const sessionId = "runtime-session";
    const runtime = makeRuntime(sessionId);
    const { transcript, uiAPI } = makeUi();
    const replacements: SessionReplacement[] = [];
    const adapter = (attachTuiRuntimeAdapter as FixtureRuntimeAdapter)({
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
