import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeLongReplayFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";

test("managed replay includes every page exactly once in saved order without changing the transcript", async () => {
    await withRuntimeCommandFixture("complete-replay-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeLongReplayFixture(homeDir, projectRoot);
        const handle = fixture.openRuntime("tui", "replay-reader");
        try {
            const before = await readTranscriptEvidence(fixture.transcriptPath);
            const text: string[] = [];
            const eventIds: string[] = [];
            handle.runtime.subscribeSessionEvents(handle.adoptedSessionId, (event) => {
                if (event.eventId) eventIds.push(event.eventId);
                if (event.type === "assistant_text_delta") text.push(event.delta);
            });
            const result = await handle.runtime.replaySession(handle.adoptedSessionId);
            assertEquals(result.ok, true);
            assertEquals(text, ["Committed hello.", ...fixture.texts]);
            assertEquals(new Set(eventIds).size, eventIds.length);
            assertEquals(await readTranscriptEvidence(fixture.transcriptPath), before);
        } finally {
            await handle.close();
            await fixture.cleanup();
        }
    });
});

test("canceling a replay stops delivery without affecting a later replay", async () => {
    await withRuntimeCommandFixture("cancel-replay-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeLongReplayFixture(homeDir, projectRoot);
        const handle = fixture.openRuntime("tui", "cancel-reader");
        try {
            const controller = new AbortController();
            const replies: string[] = [];
            const unsubscribe = handle.runtime.subscribeSessionEvents(handle.adoptedSessionId, (event) => {
                if (event.type === "assistant_text_delta") {
                    replies.push(event.delta);
                    controller.abort();
                }
            });
            const canceled = await handle.runtime.replaySession(handle.adoptedSessionId, { signal: controller.signal });
            assertEquals(canceled.ok, false);
            assertEquals(canceled.error, "replay_canceled");
            assertEquals(replies, ["Committed hello."]);
            unsubscribe();
            const replayed: string[] = [];
            handle.runtime.subscribeSessionEvents(handle.adoptedSessionId, (event) => {
                if (event.type === "assistant_text_delta") replayed.push(event.delta);
            });
            assertEquals(
                (await handle.runtime.replaySession(handle.adoptedSessionId, { signal: controller.signal })).replayed,
                0,
            );
            assertEquals((await handle.runtime.replaySession(handle.adoptedSessionId)).ok, true);
            assertEquals(replayed, ["Committed hello.", ...fixture.texts]);
        } finally {
            await handle.close();
            await fixture.cleanup();
        }
    });
});

test("closing a Session during replay does not emit its history into a replacement Project", async () => {
    await withRuntimeCommandFixture("close-replay-", async ({ homeDir, projectRoot, alternateRoot }) => {
        const first = await makeLongReplayFixture(homeDir, projectRoot);
        first.store.registerProject({ root: alternateRoot });
        const second = await makeLongReplayFixture(homeDir, alternateRoot);
        const handle = first.openRuntime("tui", "switch-reader");
        try {
            const oldReplies: string[] = [];
            handle.runtime.subscribeSessionEvents(handle.adoptedSessionId, (event) => {
                if (event.type === "assistant_text_delta") oldReplies.push(event.delta);
            });
            const pending = handle.runtime.replaySession(handle.adoptedSessionId);
            await handle.runtime.closeSession(handle.adoptedSessionId);
            const replacement = handle.runtime.adoptManagedSession({ session: second.session, generation: 0 });
            const newReplies: string[] = [];
            handle.runtime.subscribeSessionEvents(replacement.sessionId, (event) => {
                if (event.type === "assistant_text_delta") newReplies.push(event.delta);
            });
            assertEquals((await pending).ok, false);
            assertEquals(oldReplies, []);
            assertEquals(newReplies, []);
            assertEquals((await handle.runtime.replaySession(replacement.sessionId)).ok, true);
            assertEquals(newReplies, ["Committed hello.", ...second.texts]);
            assertEquals(handle.runtime.getSessionSnapshot(replacement.sessionId)?.cwd, alternateRoot);
        } finally {
            await handle.close();
            await first.cleanup();
            await second.cleanup();
        }
    });
});
