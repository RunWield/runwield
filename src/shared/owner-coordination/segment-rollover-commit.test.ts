import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { getRunWieldSessionDir } from "../session/root-session.js";
import { captureTranscriptEvidence } from "../session/session-transcript-projection.js";
import { openOwnerCoordinationDatabase } from "./database.js";
import { registerProject } from "./projects.js";
import {
    acquireSessionActivation,
    changeSessionActivationPhase,
    commitSegmentRolloverAndPublish,
    inspectSessionActivation,
    publishGenerationAndRelease,
} from "./session-activations.js";
import {
    ensureSessionCatalogRecord,
    getCurrentSessionSegment,
    listSessionTranscriptSegments,
    validateSuccessorSegmentLocator,
} from "./sessions.js";

interface TranscriptUserMessage {
    role: "user";
    content: string;
}

interface TranscriptMessageEntry {
    type: "message";
    id: string;
    message: TranscriptUserMessage;
}

type CommittedFixture = Awaited<ReturnType<typeof createCommittedFixture>>;

function idFactory(prefix = "id") {
    let next = 0;
    return () => `${prefix}-${++next}`;
}

async function writeTranscript(
    cwd: string,
    piSessionId: string,
    timestamp: string,
    bodyEntries: TranscriptMessageEntry[] = [],
) {
    const sessionDir = getRunWieldSessionDir(cwd);
    await fsMkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const entries = [{ type: "session", id: piSessionId, cwd, timestamp }, ...bodyEntries];
    await fsWriteFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return path;
}

async function createCommittedFixture() {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-rollover-commit-"));
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    const root = `${dir}/repo`;
    await fsMkdir(root);
    const project = registerProject(database, { root, idFactory: idFactory("project"), now: () => "t0" });
    const firstPath = await writeTranscript(root, "pi-one", "2026-01-01T00:00:00.000Z", [
        {
            type: "message",
            id: "entry-one",
            message: { role: "user", content: "one" },
        },
    ]);
    const session = await ensureSessionCatalogRecord(database, {
        projectId: project.projectId,
        piSessionId: "pi-one",
        transcriptPath: firstPath,
        transcriptCwd: root,
        idFactory: idFactory("session"),
        now: () => "t1",
    });
    const firstSegment = getCurrentSessionSegment(database, session.runwieldSessionId);
    assert(firstSegment);
    let proof = acquireSessionActivation(database, {
        runwieldSessionId: session.runwieldSessionId,
        projectId: project.projectId,
        ownerInstanceId: "owner-1",
        ownerProcessKind: "test",
        operationId: "bootstrap",
        expectedGeneration: null,
        expectedCurrentSegmentId: firstSegment.segmentId,
        phase: "preparing",
    });
    proof = changeSessionActivationPhase(database, proof, "hydrated");
    proof = changeSessionActivationPhase(database, proof, "checkpointing");
    const firstEvidence = await captureTranscriptEvidence({ transcriptPath: firstPath, transcriptCwd: root });
    publishGenerationAndRelease(database, proof, {
        generation: 0,
        byteLength: firstEvidence.byteLength,
        terminalEntryId: firstEvidence.terminalEntryId,
        digestHex: firstEvidence.digestHex,
        currentSegmentId: firstSegment.segmentId,
    });
    return { dir, database, root, project, session, firstSegment, firstEvidence };
}

async function cleanupFixture(fixture: CommittedFixture) {
    fixture.database.close();
    await fsRm(fixture.dir, { recursive: true });
}

async function successorOptions(fixture: CommittedFixture, piSessionId = "pi-two") {
    const path = await writeTranscript(fixture.root, piSessionId, "2026-01-01T00:00:01.000Z", []);
    const safeLocator = await validateSuccessorSegmentLocator(fixture.database, {
        projectId: fixture.project.projectId,
        piSessionId,
        transcriptPath: path,
        transcriptCwd: fixture.root,
    });
    const evidence = await captureTranscriptEvidence({ transcriptPath: path, transcriptCwd: fixture.root });
    return { path, safeLocator, evidence, piSessionId };
}

test("commitSegmentRolloverAndPublish seals, appends, moves activation, publishes, and releases atomically", async () => {
    const fixture = await createCommittedFixture();
    try {
        let proof = acquireSessionActivation(fixture.database, {
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            ownerInstanceId: "owner-1",
            ownerProcessKind: "test",
            operationId: "rollover",
            expectedGeneration: 0,
            expectedCurrentSegmentId: fixture.firstSegment.segmentId,
            phase: "preparing",
        });
        proof = changeSessionActivationPhase(fixture.database, proof, "hydrated");
        proof = changeSessionActivationPhase(fixture.database, proof, "checkpointing");
        const successor = await successorOptions(fixture);
        const result = commitSegmentRolloverAndPublish(fixture.database, proof, {
            predecessorSegmentId: fixture.firstSegment.segmentId,
            predecessorEvidence: fixture.firstEvidence,
            successor: {
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                piSessionId: successor.piSessionId,
                transcriptPath: successor.path,
                transcriptCwd: fixture.root,
                kind: "execution",
                lineageParentSegmentId: fixture.firstSegment.segmentId,
                idFactory: () => "successor-segment",
            },
            successorSafeLocator: successor.safeLocator,
            generationEvidence: {
                generation: 1,
                byteLength: successor.evidence.byteLength,
                terminalEntryId: successor.evidence.terminalEntryId,
                digestHex: successor.evidence.digestHex,
                currentSegmentId: "successor-segment",
            },
        });
        assertEquals(result.successor.segmentId, "successor-segment");
        const inspected = inspectSessionActivation(fixture.database, fixture.session.runwieldSessionId);
        assertEquals(inspected.activation?.state, "idle");
        assertEquals(inspected.activation?.currentSegmentId, "successor-segment");
        assertEquals(inspected.generation?.generation, 1);
        assertEquals(inspected.generation?.currentSegmentId, "successor-segment");
        const segments = listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId);
        assertEquals(
            segments.map((segment) => segment.sealedAt !== null),
            [true, false],
        );
    } finally {
        await cleanupFixture(fixture);
    }
});

test("failed rollover transaction leaves no successor row, no seal, no pointer move, and no generation", async () => {
    const fixture = await createCommittedFixture();
    try {
        let proof = acquireSessionActivation(fixture.database, {
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            ownerInstanceId: "owner-1",
            ownerProcessKind: "test",
            operationId: "rollover-fail",
            expectedGeneration: 0,
            expectedCurrentSegmentId: fixture.firstSegment.segmentId,
            phase: "preparing",
        });
        proof = changeSessionActivationPhase(fixture.database, proof, "hydrated");
        proof = changeSessionActivationPhase(fixture.database, proof, "checkpointing");
        const successor = await successorOptions(fixture);
        assertThrows(() =>
            commitSegmentRolloverAndPublish(fixture.database, proof, {
                predecessorSegmentId: fixture.firstSegment.segmentId,
                predecessorEvidence: fixture.firstEvidence,
                successor: {
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    piSessionId: successor.piSessionId,
                    transcriptPath: successor.path,
                    transcriptCwd: fixture.root,
                    kind: "execution",
                    lineageParentSegmentId: fixture.firstSegment.segmentId,
                    idFactory: () => "rolled-back-segment",
                },
                successorSafeLocator: successor.safeLocator,
                generationEvidence: {
                    generation: 0,
                    byteLength: successor.evidence.byteLength,
                    terminalEntryId: successor.evidence.terminalEntryId,
                    digestHex: successor.evidence.digestHex,
                    currentSegmentId: "rolled-back-segment",
                },
            }),
        );
        const segments = listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId);
        assertEquals(segments.length, 1);
        assertEquals(segments[0].sealedAt, null);
        assertEquals(
            getCurrentSessionSegment(fixture.database, fixture.session.runwieldSessionId)?.segmentId,
            fixture.firstSegment.segmentId,
        );
        assertEquals(
            inspectSessionActivation(fixture.database, fixture.session.runwieldSessionId).generation?.generation,
            0,
        );
    } finally {
        await cleanupFixture(fixture);
    }
});

test("rollover commit rejects stale fences, wrong predecessors, non-advancing generations, and held activations", async () => {
    const fixture = await createCommittedFixture();
    try {
        let proof = acquireSessionActivation(fixture.database, {
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            ownerInstanceId: "owner-1",
            ownerProcessKind: "test",
            operationId: "rollover-reject",
            expectedGeneration: 0,
            expectedCurrentSegmentId: fixture.firstSegment.segmentId,
            phase: "preparing",
        });
        assertThrows(() =>
            acquireSessionActivation(fixture.database, {
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                ownerInstanceId: "owner-2",
                ownerProcessKind: "test",
                expectedGeneration: 0,
                expectedCurrentSegmentId: fixture.firstSegment.segmentId,
            }),
        );
        proof = changeSessionActivationPhase(fixture.database, proof, "hydrated");
        proof = changeSessionActivationPhase(fixture.database, proof, "checkpointing");
        const successor = await successorOptions(fixture, "pi-two");
        assertThrows(
            () =>
                commitSegmentRolloverAndPublish(
                    fixture.database,
                    { ...proof, fence: proof.fence + 1 },
                    {
                        predecessorSegmentId: fixture.firstSegment.segmentId,
                        predecessorEvidence: fixture.firstEvidence,
                        successor: {
                            runwieldSessionId: fixture.session.runwieldSessionId,
                            projectId: fixture.project.projectId,
                            piSessionId: successor.piSessionId,
                            transcriptPath: successor.path,
                            transcriptCwd: fixture.root,
                            kind: "execution",
                            idFactory: () => "never",
                        },
                        successorSafeLocator: successor.safeLocator,
                        generationEvidence: {
                            generation: 1,
                            byteLength: successor.evidence.byteLength,
                            terminalEntryId: successor.evidence.terminalEntryId,
                            digestHex: successor.evidence.digestHex,
                            currentSegmentId: "never",
                        },
                    },
                ),
            Error,
            "proof",
        );
        assertThrows(
            () =>
                commitSegmentRolloverAndPublish(fixture.database, proof, {
                    predecessorSegmentId: "wrong",
                    predecessorEvidence: fixture.firstEvidence,
                    successor: {
                        runwieldSessionId: fixture.session.runwieldSessionId,
                        projectId: fixture.project.projectId,
                        piSessionId: successor.piSessionId,
                        transcriptPath: successor.path,
                        transcriptCwd: fixture.root,
                        kind: "execution",
                        idFactory: () => "never",
                    },
                    successorSafeLocator: successor.safeLocator,
                    generationEvidence: {
                        generation: 1,
                        byteLength: successor.evidence.byteLength,
                        terminalEntryId: successor.evidence.terminalEntryId,
                        digestHex: successor.evidence.digestHex,
                        currentSegmentId: "never",
                    },
                }),
            Error,
            "predecessor",
        );
    } finally {
        await cleanupFixture(fixture);
    }
});
