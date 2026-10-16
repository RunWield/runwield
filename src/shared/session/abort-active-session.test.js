import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
/**
 * Regression tests for HostedSession-scoped abort behavior. The root
 * AgentSession is long-lived, so abortActiveSession(hostedSession) must abort
 * only streaming roots and transient sub-agents owned by the target HostedSession.
 */

import { abortActiveSession } from "./session.js";
import { HostedSession } from "./hosted-session.js";

/**
 * @param {string} id
 */
function makeHostedSession(id) {
    return new HostedSession({ id, cwd: getCwd() });
}

/**
 * @param {{ isStreaming?: boolean, onAbort?: () => void }} [opts]
 */
function makeFakeSession(opts = {}) {
    const state = { isStreaming: !!opts.isStreaming, abortCalls: 0, clearQueueCalls: 0 };
    return /** @type {any} */ ({
        get isStreaming() {
            return state.isStreaming;
        },
        set isStreaming(value) {
            state.isStreaming = value;
        },
        abort() {
            state.abortCalls++;
            state.isStreaming = false;
            if (opts.onAbort) opts.onAbort();
        },
        clearQueue() {
            state.clearQueueCalls++;
        },
        get _abortCalls() {
            return state.abortCalls;
        },
        get _clearQueueCalls() {
            return state.clearQueueCalls;
        },
    });
}

test("abortActiveSession returns false when target root exists but is idle", () => {
    const hostedSession = makeHostedSession("abort-idle");
    const otherHostedSession = makeHostedSession("abort-idle-other");
    const idleRoot = makeFakeSession({ isStreaming: false });
    const otherRoot = makeFakeSession({ isStreaming: true });
    hostedSession.setRootAgentSession(idleRoot);
    hostedSession.setRootAgentName("router");
    otherHostedSession.setRootAgentSession(otherRoot);
    otherHostedSession.setRootAgentName("router");

    assertEquals(abortActiveSession(hostedSession), false);
    assertEquals(idleRoot._abortCalls, 0, "must not call abort() on an idle root session");
    assertEquals(idleRoot._clearQueueCalls, 1, "target root queue is cleared even when idle");
    assertEquals(otherRoot._abortCalls, 0, "other HostedSession root must not be aborted");
    assertEquals(otherRoot._clearQueueCalls, 0, "other HostedSession queue must not be cleared");
});

test("abortActiveSession aborts only the streaming root in the target HostedSession", () => {
    const hostedSession = makeHostedSession("abort-streaming");
    const otherHostedSession = makeHostedSession("abort-streaming-other");
    const streamingRoot = makeFakeSession({ isStreaming: true });
    const otherStreamingRoot = makeFakeSession({ isStreaming: true });
    hostedSession.setRootAgentSession(streamingRoot);
    otherHostedSession.setRootAgentSession(otherStreamingRoot);

    assertEquals(abortActiveSession(hostedSession), true);
    assertEquals(streamingRoot._abortCalls, 1);
    assertEquals(streamingRoot._clearQueueCalls, 1);
    assertEquals(otherStreamingRoot._abortCalls, 0);
    assertEquals(otherStreamingRoot._clearQueueCalls, 0);
});

test("abortActiveSession scopes transient sub-agents to the target HostedSession", () => {
    const hostedSession = makeHostedSession("abort-sub");
    const otherHostedSession = makeHostedSession("abort-sub-other");
    const idleRoot = makeFakeSession({ isStreaming: false });
    const sub = makeFakeSession({ isStreaming: true });
    const otherSub = makeFakeSession({ isStreaming: true });
    hostedSession.setRootAgentSession(idleRoot);
    hostedSession.addSubAgentSession(sub);
    otherHostedSession.addSubAgentSession(otherSub);

    assertEquals(abortActiveSession(hostedSession), true);
    assertEquals(idleRoot._abortCalls, 0, "idle root must remain untouched even when target sub-agents exist");
    assertEquals(idleRoot._clearQueueCalls, 1);
    assertEquals(sub._abortCalls, 1);
    assertEquals(otherSub._abortCalls, 0, "other HostedSession sub-agent must not be aborted");
});

test("abortActiveSession returns false when target HostedSession has no sessions", () => {
    assertEquals(abortActiveSession(makeHostedSession("abort-empty")), false);
});

test("abortActiveSession swallows errors thrown by abort() and still reports true", () => {
    const hostedSession = makeHostedSession("abort-error");
    const root = makeFakeSession({
        isStreaming: true,
        onAbort: () => {
            throw new Error("boom");
        },
    });
    hostedSession.setRootAgentSession(root);

    assertEquals(abortActiveSession(hostedSession), true);
});

test("^abortActiveSession unwraps claude-cli execution-session wrapper and aborts the inner session$", () => {
    const hostedSession = makeHostedSession("abort-claude-wrapper");
    const inner = makeFakeSession({ isStreaming: true });
    hostedSession.setRootAgentSession(/** @type {any} */ ({ kind: "claude-cli", session: inner }));

    assertEquals(abortActiveSession(hostedSession), true);
    assertEquals(inner._abortCalls, 1);
    assertEquals(inner._clearQueueCalls, 1);
});

test("abortActiveSession unwraps agy-cli execution-session wrapper and aborts the inner session", () => {
    const hostedSession = makeHostedSession("abort-agy-wrapper");
    const inner = makeFakeSession({ isStreaming: true });
    hostedSession.setRootAgentSession(/** @type {any} */ ({ kind: "agy-cli", session: inner }));

    assertEquals(abortActiveSession(hostedSession), true);
    assertEquals(inner._abortCalls, 1);
    assertEquals(inner._clearQueueCalls, 1);
});
