import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    appendTranscriptEntry,
    makeManagedSessionFixture,
    readTranscriptEvidence,
} from "../../testing/managed-session-fixture.ts";
import { projectAggregateTranscript } from "./session-transcript-manifest.ts";
import { projectCommittedTranscript } from "./session-transcript-projection.js";

async function writeSuccessorTranscript(
    projectRoot: string,
    piSessionId: string,
    sessionDir: string,
): Promise<string> {
    const timestamp = "2026-01-01T00:02:00.000Z";
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const header = { type: "session", id: piSessionId, timestamp, cwd: projectRoot, name: "Successor" };
    await fsWriteFile(path, `${JSON.stringify(header)}\n`);
    return path;
}

test("writable restart hydrates the committed current segment instead of the predecessor", async () => {
    const fixture = await makeManagedSessionFixture();
    const workspace = fixture.openStore();
    const laterWriter = fixture.openStore();
    try {
        const firstGeneration = workspace.inspectSessionActivation(fixture.session.runwieldSessionId).generation;
        const predecessorId = firstGeneration?.currentSegmentId ?? "";
        let proof = workspace.acquireSessionActivation({
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            ownerInstanceId: "workspace-owner",
            ownerProcessKind: "workspace",
            operationId: "workspace-rollover",
            expectedGeneration: 0,
            expectedCurrentSegmentId: predecessorId,
            phase: "preparing",
            now: () => "2026-01-01T00:02:01.000Z",
        });
        proof = workspace.changeSessionActivationPhase(proof, "hydrated", {
            now: () => "2026-01-01T00:02:02.000Z",
        });
        proof = workspace.changeSessionActivationPhase(proof, "turning", {
            now: () => "2026-01-01T00:02:03.000Z",
        });
        proof = workspace.changeSessionActivationPhase(proof, "checkpointing", {
            now: () => "2026-01-01T00:02:04.000Z",
        });
        const successorPath = await writeSuccessorTranscript(fixture.projectRoot, "pi-successor", fixture.sessionDir);
        const successorSafeLocator = await workspace.validateSuccessorSegmentLocator({
            projectId: fixture.project.projectId,
            piSessionId: "pi-successor",
            transcriptPath: successorPath,
            transcriptCwd: fixture.projectRoot,
        });
        const committed = workspace.commitSegmentRolloverAndPublish(proof, {
            predecessorSegmentId: predecessorId,
            predecessorEvidence: await readTranscriptEvidence(fixture.transcriptPath),
            successor: {
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                piSessionId: "pi-successor",
                transcriptPath: successorPath,
                transcriptCwd: fixture.projectRoot,
                kind: "execution",
                idFactory: () => "successor-segment",
                now: () => "t-successor",
            },
            successorSafeLocator,
            generationEvidence: {
                generation: 1,
                currentSegmentId: "successor-segment",
                ...(await readTranscriptEvidence(successorPath)),
            },
            now: () => "2026-01-01T00:02:05.000Z",
        });

        assertEquals(committed.generation?.currentSegmentId, "successor-segment");
        assertThrows(
            () =>
                laterWriter.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "tui-owner",
                    ownerProcessKind: "tui",
                    operationId: "wrong-segment",
                    expectedGeneration: 1,
                    expectedCurrentSegmentId: predecessorId,
                    phase: "preparing",
                }),
            Error,
            "segment changed",
        );
        const nextProof = laterWriter.acquireSessionActivation({
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            ownerInstanceId: "tui-owner",
            ownerProcessKind: "tui",
            operationId: "right-segment",
            expectedGeneration: 1,
            expectedCurrentSegmentId: "successor-segment",
            phase: "preparing",
        });
        assertEquals(nextProof.expectedCurrentSegmentId, "successor-segment");
    } finally {
        workspace.close();
        laterWriter.close();
        await fixture.cleanup();
    }
});

test("aggregate readers fail closed with sanitized damaged-evidence diagnostics", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const generation = fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation;
        if (!generation) throw new Error("fixture generation missing");
        const originalText = await fsReadFile(fixture.transcriptPath, "utf8");
        await fsWriteFile(fixture.transcriptPath, originalText.replace("Committed hello.", "Damaged hello..."));
        const projection = await projectAggregateTranscript({
            cwd: fixture.projectRoot,
            sessionDir: fixture.sessionDir,
            runwieldSessionId: fixture.session.runwieldSessionId,
            generation,
            segments: fixture.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId),
            limit: 20,
        });
        if (projection.ok) throw new Error("damaged evidence should not project events");
        assertEquals(projection.events, []);
        assertEquals(projection.message.includes(fixture.projectRoot), false);
        assertEquals(projection.message.includes("raw transcript content"), false);
        assertEquals(["evidence_mismatch", "terminal_mismatch"].includes(projection.code), true);
    } finally {
        await fixture.cleanup();
    }
});

test("committed projection ignores transcript tail after the published byte length", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const generation = fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation;
        if (!generation) throw new Error("fixture generation missing");
        await appendTranscriptEntry(fixture.transcriptPath, "uncommitted-tail", "This must stay invisible.");
        const projection = await projectCommittedTranscript({
            sessionPath: fixture.transcriptPath,
            sessionDir: fixture.sessionDir,
            cwd: fixture.projectRoot,
            generation: generation.generation,
            byteLength: generation.byteLength,
            digestHex: generation.digestHex,
            terminalEntryId: generation.terminalEntryId,
            limit: 20,
        });
        assertEquals(projection.events.length > 0, true);
        assertEquals(projection.events.some((event) => event.text?.includes("invisible")), false);
    } finally {
        await fixture.cleanup();
    }
});
