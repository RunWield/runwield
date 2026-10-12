import { test } from "node:test";
import { readdir as fsReaddir } from "node:fs/promises";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import {
    appendTranscriptEntry,
    makeManagedSessionFixture,
    readTranscriptEvidence,
} from "../../testing/managed-session-fixture.ts";

test("competing Workspace and TUI processes allow exactly one managed Session writer", async () => {
    const fixture = await makeManagedSessionFixture();
    const workspace = fixture.openStore();
    const tui = fixture.openStore();
    try {
        const before = workspace.inspectSessionActivation(fixture.session.runwieldSessionId);
        const currentSegmentId = before.generation?.currentSegmentId ?? null;
        const beforeTranscriptEvidence = await readTranscriptEvidence(fixture.transcriptPath);
        const beforeProjectEntries = await Array.fromAsync(
            await fsReaddir(fixture.projectRoot, { withFileTypes: true }),
        );
        const workspaceProof = workspace.acquireSessionActivation({
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            ownerInstanceId: "workspace-owner",
            ownerProcessKind: "workspace",
            operationId: "workspace-op",
            expectedGeneration: 0,
            expectedCurrentSegmentId: currentSegmentId,
            phase: "preparing",
            now: () => "2026-01-01T00:01:00.000Z",
        });

        assertThrows(
            () =>
                tui.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "tui-owner",
                    ownerProcessKind: "tui",
                    operationId: "tui-op",
                    expectedGeneration: 0,
                    expectedCurrentSegmentId: currentSegmentId,
                    phase: "preparing",
                    now: () => "2026-01-01T00:01:01.000Z",
                }),
            Error,
            "open in another RunWield surface",
        );
        assertEquals(await readTranscriptEvidence(fixture.transcriptPath), beforeTranscriptEvidence);
        assertEquals(
            tui.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.generation,
            before.generation?.generation,
        );
        assertEquals(tui.listSessionTranscriptSegments(fixture.session.runwieldSessionId).length, 1);
        assertEquals(
            (await tui.findOrphanRolloverCandidates({
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                transcriptCwd: fixture.projectRoot,
            })).length,
            0,
        );
        assertEquals(
            (await fsReaddir(fixture.projectRoot, { withFileTypes: true })).map((entry) => entry.name).sort(),
            beforeProjectEntries.map((entry) => entry.name).sort(),
        );

        let checkpoint = workspace.changeSessionActivationPhase(workspaceProof, "hydrated", {
            now: () => "2026-01-01T00:01:02.000Z",
        });
        checkpoint = workspace.changeSessionActivationPhase(checkpoint, "turning", {
            now: () => "2026-01-01T00:01:03.000Z",
        });
        checkpoint = workspace.changeSessionActivationPhase(checkpoint, "checkpointing", {
            now: () => "2026-01-01T00:01:04.000Z",
        });
        await appendTranscriptEntry(fixture.transcriptPath, "workspace-entry", "Workspace committed.");
        workspace.publishGenerationAndRelease(checkpoint, {
            generation: 1,
            currentSegmentId,
            ...(await readTranscriptEvidence(fixture.transcriptPath)),
        }, { now: () => "2026-01-01T00:01:05.000Z" });
        assertThrows(
            () =>
                workspace.publishGenerationAndRelease(checkpoint, {
                    generation: 1,
                    currentSegmentId,
                    byteLength: before.generation?.byteLength ?? 0,
                    digestHex: before.generation?.digestHex ?? "",
                    terminalEntryId: before.generation?.terminalEntryId ?? null,
                }, { now: () => "2026-01-01T00:01:05.500Z" }),
            Error,
        );

        const after = tui.inspectSessionActivation(fixture.session.runwieldSessionId);
        assertEquals(after.activation?.state, "idle");
        assertEquals(after.generation?.generation, 1);
        assertEquals(tui.listSessionTranscriptSegments(fixture.session.runwieldSessionId).length, 1);
        assertThrows(
            () =>
                tui.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "tui-owner",
                    ownerProcessKind: "tui",
                    operationId: "stale-tui-op",
                    expectedGeneration: 0,
                    expectedCurrentSegmentId: currentSegmentId,
                    phase: "preparing",
                    now: () => "2026-01-01T00:01:06.000Z",
                }),
            Error,
            "generation changed",
        );
        const longRunning = workspace.acquireSessionActivation({
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            ownerInstanceId: "workspace-owner",
            ownerProcessKind: "workspace",
            operationId: "workspace-long-running",
            expectedGeneration: 1,
            expectedCurrentSegmentId: currentSegmentId,
            phase: "preparing",
            now: () => "2026-01-01T00:02:00.000Z",
        });
        assertThrows(
            () =>
                tui.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "tui-owner",
                    ownerProcessKind: "tui",
                    operationId: "tui-heartbeat-age-op",
                    expectedGeneration: 1,
                    expectedCurrentSegmentId: currentSegmentId,
                    phase: "preparing",
                    now: () => "2026-01-02T00:02:00.000Z",
                }),
            Error,
            "open in another RunWield surface",
        );
        workspace.releaseUnchangedActivation(longRunning, { now: () => "2026-01-01T00:02:01.000Z" });
    } finally {
        workspace.close();
        tui.close();
        await fixture.cleanup();
    }
});
