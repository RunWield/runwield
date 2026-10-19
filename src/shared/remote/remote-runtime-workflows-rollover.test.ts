import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { dirname } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { openNativeFileLock } from "../native-file-lock.ts";
import { findProject, lockPath, sessionDirForProject } from "../session/file-session-storage.ts";
import { listSavedRemoteSessions } from "./laptop-session-control.ts";
import { parseRemoteSessionTranscript, REMOTE_SESSION_IDENTITY_ENTRY } from "./session-protocol.ts";
import { assertRemoteStorageAbsent, latch, within, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

for (const kind of ["execution", "semantic_repair"] as const) {
    test(`remote ${kind} rollover retains the native writer through successor hydration and resumes its lineage`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved remote response.")));
            const client = await f.start();
            assertEquals((await client.read()).kind, "ready");
            await client.send({ kind: "turn", text: "Predecessor request." });
            const first = await client.read();
            assertEquals(first.ok, true, first.error);
            assert(first.savedId);
            const id = first.savedId;
            const originalCount = (await f.control.list(id))[0].messageCount;
            const predecessor = f.store.getCurrentSessionSegment(id)!;
            const committed = latch();
            const returnReceipt = latch();
            f.policy.handle = async (request, _path, response) => {
                if (request.kind === "rollover" && response.ok) {
                    committed.release();
                    await returnReceipt.promise;
                }
                return response;
            };
            await client.send({ kind: "rollover", segmentKind: kind, text: "Continue from saved evidence." });
            try {
                // The real HTTP reply is held after the laptop transaction, before remote hydration.
                await within(committed.promise);
                const successor = f.store.getCurrentSessionSegment(id)!;
                assert(successor.segmentId !== predecessor.segmentId);
                assertEquals(successor.lineageParentSegmentId, predecessor.segmentId);
                assertEquals(successor.kind, kind);
                const project = findProject(f.store.path, successor.projectId)!;
                assertEquals(dirname(successor.transcriptPath), sessionDirForProject(f.store.path, project));
                const contender = openNativeFileLock(lockPath(dirname(successor.transcriptPath), id));
                try {
                    assertEquals(contender.tryLockSync(true), false, "A native writer must not enter the handoff gap");
                } finally {
                    contender.close();
                }
                const rollover = f.saves.findLast((request) => request.kind === "rollover")!;
                assert(rollover);
                for (const stale of [rollover, { ...rollover, kind: "inspect", contents: "" }]) {
                    const response = await fetch(`http://127.0.0.1:${f.connection.port}/session/request`, {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${f.connection.credential}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(stale),
                    });
                    assertEquals(response.status, 409, "Old-operation retries cannot regain the writer");
                }
                const saved = (await f.control.list(id))[0];
                assert(saved.contents?.includes("Predecessor request."));
                assert(
                    !listSavedRemoteSessions(f.store.path)
                        .find((saved) => saved.summary.id === id)
                        ?.currentContents?.includes("Predecessor request."),
                );
                assertEquals(saved.messageCount, originalCount);
            } finally {
                returnReceipt.release();
            }
            const rolled = await client.read();
            assertEquals(rolled.ok, true, rolled.error);
            assertEquals(rolled.rollover?.transcriptPath, "");
            const pending = f.store.inspectSessionActivation(id);
            assertEquals(pending.activation?.state, "active");
            assertEquals(pending.activation?.phase, "hydrated");
            await client.send({ kind: "turn", text: "Successor request." });
            const continued = await client.read();
            assertEquals(continued.ok, true, continued.error);
            assertEquals(continued.savedId, id);
            assertEquals(continued.piSessionId, rolled.rollover?.piSessionId);
            const saved = listSavedRemoteSessions(f.store.path).find((saved) => saved.summary.id === id)!;
            assert(saved.summary.messageCount > originalCount);
            assert(saved.contents.includes("Predecessor request."));
            assert(saved.contents.includes("Successor request."));
            const entries = parseRemoteSessionTranscript(saved.currentContents!);
            assertEquals(
                saved.summary.messageCount,
                originalCount + entries.filter((entry) => entry.type === "message").length,
            );
            const identity = entries.find(
                (entry) => entry.type === "custom" && entry.customType === REMOTE_SESSION_IDENTITY_ENTRY,
            );
            assert(identity?.type === "custom");
            assertEquals(identity.data, {
                projectId: rolled.rollover?.projectId,
                currentSegmentId: rolled.rollover?.successorSegmentId,
                piSessionId: rolled.rollover?.piSessionId,
            });
            assertEquals(entries[0].type === "session" && entries[0].id, rolled.rollover?.piSessionId);
            await client.send({
                kind: "rollover",
                segmentKind: kind === "execution" ? "semantic_repair" : "execution",
            });
            const secondRoll = await client.read();
            assertEquals(secondRoll.ok, true, secondRoll.error);
            assertEquals(secondRoll.rollover?.predecessorSegmentId, rolled.rollover?.successorSegmentId);
            assertEquals(f.store.listSessionTranscriptSegments(id).length, 3);
            const chained = (await f.control.list(id))[0];
            assertEquals(chained.messageCount, saved.summary.messageCount);
            assert(chained.contents?.includes("Predecessor request."));
            assert(chained.contents?.includes("Successor request."));
            // Closing an unused successor settles its retained pending writer.
            await client.close();
            assertEquals(f.store.inspectSessionActivation(id).activation?.state, "uncertain");
            const resumed = await f.start();
            await resumed.read();
            await resumed.send({ kind: "resume-command", sessionId: id });
            const loaded = await resumed.read();
            assertEquals(loaded.ok, true, loaded.error);
            assertEquals(loaded.savedId, id);
            await resumed.send({ kind: "turn", text: "Resumed successor request." });
            const result = await resumed.read();
            assertEquals(result.ok, true, result.error);
            assertEquals(result.savedId, id);
            assertEquals(result.piSessionId, secondRoll.rollover?.piSessionId);
            await resumed.close();
            assert((await f.control.list(id))[0].messageCount > saved.summary.messageCount);
            await assertRemoteStorageAbsent(f);
        });
    });
}

test("a lost rollover acknowledgement releases the transferred writer as uncertain and resume uses saved evidence", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved once.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Do not replay this predecessor." });
        const first = await client.read();
        assertEquals(first.ok, true, first.error);
        assert(first.savedId);
        const id = first.savedId;
        const predecessor = f.store.getCurrentSessionSegment(id)!;
        f.policy.handle = async (request, _path, response) =>
            request.kind === "rollover" && response.ok ? new Response("lost receipt", { status: 503 }) : response;
        await client.send({ kind: "rollover", segmentKind: "execution" });
        const failed = await client.read();
        assertEquals(failed.ok, false);
        const successor = f.store.getCurrentSessionSegment(id)!;
        assert(successor.segmentId !== predecessor.segmentId);
        assertEquals(f.store.inspectSessionActivation(id).activation?.state, "uncertain");
        const contender = openNativeFileLock(lockPath(dirname(successor.transcriptPath), id));
        try {
            assertEquals(contender.tryLockSync(true), true, "Uncertainty must release the actual successor writer");
            contender.unlockSync();
        } finally {
            contender.close();
        }
        await client.close();
        f.policy.handle = undefined;
        const resumed = await f.start();
        await resumed.read();
        await resumed.send({ kind: "resume-command", sessionId: id });
        const loaded = await resumed.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.savedId, id);
        const saved = (await f.control.list(id))[0];
        assertEquals((saved.contents?.match(/Do not replay this predecessor\./g) || []).length, 1);
        assertEquals(f.modelRequests.length, 1, "Recovery cannot repeat the predecessor model turn");
        await resumed.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("remote rollover restores workflow and tutorial metadata and execution ownership on the next operation", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Context saved.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Create the predecessor." });
        const first = await client.read();
        assertEquals(first.ok, true, first.error);
        assert(first.savedId);
        await client.send({ kind: "seed-rollover-context" });
        const seeded = await client.read();
        assertEquals(seeded.ok, true, seeded.error);
        await client.send({ kind: "rollover", segmentKind: "semantic_repair" });
        const rolled = await client.read();
        assertEquals(rolled.ok, true, rolled.error);
        assertEquals(rolled.workflowContext?.planName, "remote-rollover");
        assertEquals(rolled.tutorialContext?.shownExplanationIds, ["rollover"]);
        await client.send({ kind: "turn", text: "Continue with the saved workflow." });
        const continued = await client.read();
        assertEquals(continued.ok, true, continued.error);
        assertEquals(continued.activeWorkflow?.planName, "remote-rollover");
        assertEquals(continued.tutorialContext?.shownExplanationIds, ["rollover"]);
        await client.close();
        const resumed = await f.start();
        await resumed.read();
        await resumed.send({ kind: "load", sessionId: first.savedId });
        const loaded = await resumed.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.workflowContext?.planName, "remote-rollover");
        assertEquals(loaded.tutorialContext?.shownExplanationIds, ["rollover"]);
        await resumed.send({ kind: "turn", text: "Recover saved execution ownership." });
        const recovered = await resumed.read();
        assertEquals(recovered.ok, true, recovered.error);
        assertEquals(recovered.activeWorkflow?.planName, "remote-rollover");
        await resumed.close();
        await assertRemoteStorageAbsent(f);
    });
});

for (const closeInFlight of [false, true]) {
    test(`the committed rollover gap retains the same native writer in a competing process (${closeInFlight ? "connection closes in flight" : "successor starts"})`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved predecessor.")));
            const client = await f.start();
            await client.read();
            await client.send({ kind: "turn", text: "A predecessor for native contention." });
            const first = await client.read();
            assert(first.savedId);
            const id = first.savedId;
            await client.close();
            const predecessor = f.store.getCurrentSessionSegment(id)!;
            const { withPausedRollover } = await import("./remote-rollover-debug-fixture.ts");
            await withPausedRollover(f, id, async (debug) => {
                const successor = f.store.getCurrentSessionSegment(id)!;
                assert(
                    successor.segmentId !== predecessor.segmentId,
                    "The predecessor commit must be complete at the barrier",
                );
                assertEquals(successor.lineageParentSegmentId, predecessor.segmentId);
                assertEquals(
                    f.store.inspectSessionActivation(id).activation?.phase,
                    "preparing",
                    "The successor operation has not hydrated at the barrier",
                );
                const gap = await debug.inspect();
                assertEquals(
                    gap.entered,
                    false,
                    "A separate process cannot acquire the writer before successor admission",
                );
                assertEquals(gap.sameFile, true);
                assertEquals(gap.identity, debug.identity, "The native lock identity cannot change during transfer");
                if (closeInFlight) await debug.closeConnection();
                const report = await debug.resume();
                assertEquals(report.ok, !closeInFlight, report.error);
                if (!closeInFlight) {
                    const admitted = await debug.inspect();
                    assertEquals(admitted.entered, false);
                    assertEquals(admitted.identity, debug.identity);
                } else {
                    const released = await debug.inspect();
                    assertEquals(
                        released.entered,
                        true,
                        "Connection close must release the transferred successor writer",
                    );
                    assertEquals(f.store.inspectSessionActivation(id).activation?.state, "uncertain");
                }
            });
            await assertRemoteStorageAbsent(f);
        });
    });
}
