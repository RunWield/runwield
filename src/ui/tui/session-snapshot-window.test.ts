import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { assert, assertEquals, assertNotStrictEquals, assertStrictEquals } from "@std/assert";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime, type SessionRuntime } from "../../shared/session/session-runtime.ts";
import { createSessionSnapshotWindow } from "./session-snapshot-window.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import type { RuntimeInteractionResponse } from "../../shared/session/session-runtime-interactions.js";
import { tuiSessionSidebarProjection } from "./session-sidebar.ts";

async function withSessions(run: (runtime: SessionRuntime, first: string, second: string) => void) {
    await withRuntimeCommandFixture("snapshot-window-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        try {
            const first = await runtime.createInteractiveSession({
                cwd: projectRoot,
                deferManagedActivationUntilAgentReady: true,
            });
            const second = await runtime.createInteractiveSession({
                cwd: projectRoot,
                deferManagedActivationUntilAgentReady: true,
            });
            run(runtime, first.sessionId, second.sessionId);
        } finally {
            await runtime.closeAllSessions();
        }
    });
}

Deno.test("snapshot window reuses one snapshot inside the TTL", async () => {
    await withSessions((runtime, first) => {
        const window = createSessionSnapshotWindow(runtime, () => first, 60_000);
        const snapshot = window.read();
        assert(snapshot);
        assertStrictEquals(window.read(), snapshot);
    });
});

Deno.test("snapshot window refreshes after invalidate", async () => {
    await withSessions((runtime, first) => {
        const window = createSessionSnapshotWindow(runtime, () => first, 60_000);
        const snapshot = window.read();
        window.invalidate();
        assertNotStrictEquals(window.read(), snapshot);
        assertEquals(window.read()?.id, first);
    });
});

Deno.test("snapshot window tracks session switches through the id reader", async () => {
    await withSessions((runtime, first, second) => {
        let id = first;
        const window = createSessionSnapshotWindow(runtime, () => id, 60_000);
        assertEquals(window.read()?.id, first);
        id = second;
        assertEquals(window.read()?.id, second);
    });
});

Deno.test("replacement Session events invalidate a warmed snapshot", async () => {
    await withSessions((runtime, first, second) => {
        let id = first;
        const window = createSessionSnapshotWindow(runtime, () => id, 60_000);
        window.read();
        id = second;
        window.invalidate();
        const warmed = window.read();
        assertEquals(runtime.markPromptReadyAgent(second, { agentName: "guide" }).ok, true);
        assertNotStrictEquals(window.read(), warmed);
        assertEquals(window.read()?.activeAgentInfo?.agentName, "guide");
    });
});

Deno.test("snapshot window expires exactly at the TTL boundary", async () => {
    await withSessions((runtime, first) => {
        const realNow = Date.now;
        let now = realNow();
        Date.now = () => now;
        const window = createSessionSnapshotWindow(runtime, () => first, 500);
        try {
            const snapshot = window.read();
            now += 499;
            assertStrictEquals(window.read(), snapshot);
            now++;
            assertNotStrictEquals(window.read(), snapshot);
        } finally {
            window.dispose();
            Date.now = realNow;
        }
    });
});

Deno.test("snapshot window removes the old Session subscription on rebind", async () => {
    await withSessions((runtime, first, second) => {
        let id = first;
        const window = createSessionSnapshotWindow(runtime, () => id, 60_000);
        try {
            window.read();
            id = second;
            window.rebind();
            const warmed = window.read();
            assertEquals(runtime.markPromptReadyAgent(first, { agentName: "guide" }).ok, true);
            assertStrictEquals(window.read(), warmed);
        } finally {
            window.dispose();
        }
    });
});

Deno.test("snapshot window disposal removes its subscription and does not reattach on read", async () => {
    await withSessions((runtime, first, second) => {
        let id = first;
        const window = createSessionSnapshotWindow(runtime, () => id, 60_000);
        const warmed = window.read();
        window.dispose();
        assertEquals(runtime.markPromptReadyAgent(first, { agentName: "guide" }).ok, true);
        assertStrictEquals(window.read(), warmed);
        id = second;
        window.rebind();
        assertStrictEquals(window.read(), warmed);
        assertEquals(runtime.markPromptReadyAgent(second, { agentName: "guide" }).ok, true);
        assertStrictEquals(window.read(), warmed);
        window.dispose();
    });
});

Deno.test("snapshot window caches null until invalidation", async () => {
    await withSessionViewFixture(({ runtime, host, projectRoot }) => {
        const id = crypto.randomUUID();
        const window = createSessionSnapshotWindow(runtime, () => id, 60_000);
        try {
            assertEquals(window.read(), null);
            host.createSession({ id, cwd: projectRoot });
            assertEquals(window.read(), null);
            window.invalidate();
            assertEquals(window.read()?.id, id);
        } finally {
            window.dispose();
        }
    });
});

Deno.test("sidebar snapshots follow question lifecycle events before their cache expires", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session }) => {
        session.replaceWorkflowContext({ routingIntent: "PLANNED_CHANGE", complexity: "LOW", planName: "example" });
        const window = createSessionSnapshotWindow(runtime, () => sessionId, 60_000);
        const states: boolean[] = [];
        const actions: string[] = [];
        const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
            if (
                event.type !== RuntimeEventTypes.INTERACTION_REQUESTED &&
                event.type !== RuntimeEventTypes.INTERACTION_RESOLVED &&
                event.type !== RuntimeEventTypes.INTERACTION_CANCELED
            ) return;
            const snapshot = window.read();
            states.push(Boolean(snapshot?.workflowContext?.liveQuestion));
            actions.push(tuiSessionSidebarProjection(snapshot || {}).workflow.action?.kind || "");
        });
        try {
            for (const settlement of ["local", "remote", "canceled", "error", "already-aborted"]) {
                states.length = 0;
                actions.length = 0;
                const response = Promise.withResolvers<RuntimeInteractionResponse>();
                const opened = Promise.withResolvers<void>();
                runtime.setInteractionAdapter(sessionId, {
                    requestInteraction: () => {
                        opened.resolve();
                        return response.promise;
                    },
                });
                const controller = new AbortController();
                if (settlement === "already-aborted") controller.abort();
                window.read();
                const pending = runtime.requestInteraction(sessionId, {
                    id: `question-${settlement}`,
                    type: "text",
                    prompt: "Which command?",
                    _meta: { source: "user_interview" },
                }, controller.signal);
                if (settlement !== "already-aborted") {
                    await Promise.race([
                        opened.promise,
                        pending.then(() => {
                            throw new Error("Interaction settled before opening its prompt");
                        }),
                    ]);
                    assertEquals(states, [true]);
                    assertEquals(actions, [""]);
                    if (settlement === "remote") {
                        assertEquals(
                            runtime.answerInteraction(sessionId, `question-${settlement}`, {
                                outcome: "text",
                                value: "ci",
                            }),
                            true,
                        );
                    } else if (settlement === "canceled") controller.abort();
                    else if (settlement === "error") response.reject(new Error("Prompt unavailable"));
                    else response.resolve({ outcome: "text", value: "ci" });
                }
                await pending;
                assertEquals(states, [true, false], settlement);
                assertEquals(actions[1] === "answer_agent", false, settlement);
                assertEquals(window.read()?.workflowContext?.liveQuestion, false, settlement);
            }
        } finally {
            session.cancelActiveInteractions();
            unsubscribe();
            window.dispose();
        }
    });
});

Deno.test("running shell commands do not become sidebar questions", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session }) => {
        session.replaceWorkflowContext({ routingIntent: "QUICK_FIX", complexity: "LOW" });
        const states: boolean[] = [];
        const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
            if (event.type === RuntimeEventTypes.TOOL_START) {
                states.push(Boolean(runtime.getSessionSnapshot(sessionId)?.workflowContext?.liveQuestion));
            }
        });
        try {
            await runtime.runLocalShellCommand(sessionId, { command: "printf verification", persist: false });
            assertEquals(states, [false]);
        } finally {
            unsubscribe();
        }
    });
});
