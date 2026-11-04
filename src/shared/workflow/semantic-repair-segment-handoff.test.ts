import { assertEquals } from "../../testing/assertions.ts";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";

async function writeRepairTranscript(
    projectRoot: string,
    piSessionId: string,
    round: number,
    sessionDir: string,
): Promise<string> {
    const timestamp = `2026-01-01T00:04:0${round}.000Z`;
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const header = { type: "session", id: piSessionId, timestamp, cwd: projectRoot, name: `Repair ${round}` };
    const seed = {
        type: "message",
        id: `semantic-repair-seed-${round}`,
        timestamp,
        message: { role: "user", content: "Repair open review issues with current CI state and diff access." },
    };
    await fsWriteFile(path, `${JSON.stringify(header)}\n${JSON.stringify(seed)}\n`);
    return path;
}

test("two committed semantic repair rollovers retain ordered segments and no Reviewer segments", async () => {
    const fixture = await makeManagedSessionFixture();
    const store = fixture.openStore();
    try {
        let expectedGeneration = 0;
        let predecessorId =
            store.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.currentSegmentId ?? "";
        for (const round of [1, 2]) {
            let proof = store.acquireSessionActivation({
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                ownerInstanceId: `repair-owner-${round}`,
                ownerProcessKind: "test",
                operationId: `semantic-repair-${round}`,
                expectedGeneration,
                expectedCurrentSegmentId: predecessorId,
                phase: "preparing",
            });
            proof = store.changeSessionActivationPhase(proof, "hydrated");
            proof = store.changeSessionActivationPhase(proof, "turning");
            proof = store.changeSessionActivationPhase(proof, "checkpointing");
            const repairPath = await writeRepairTranscript(
                fixture.projectRoot,
                `pi-semantic-repair-${round}`,
                round,
                fixture.sessionDir,
            );
            const successorId = `semantic-repair-segment-${round}`;
            const successorSafeLocator = await store.validateSuccessorSegmentLocator({
                projectId: fixture.project.projectId,
                piSessionId: `pi-semantic-repair-${round}`,
                transcriptPath: repairPath,
                transcriptCwd: fixture.projectRoot,
            });
            store.commitSegmentRolloverAndPublish(proof, {
                predecessorSegmentId: predecessorId,
                predecessorEvidence: await readTranscriptEvidence(
                    store.getCurrentSessionSegment(fixture.session.runwieldSessionId)?.transcriptPath ??
                        fixture.transcriptPath,
                ),
                successor: {
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    piSessionId: `pi-semantic-repair-${round}`,
                    transcriptPath: repairPath,
                    transcriptCwd: fixture.projectRoot,
                    kind: "semantic_repair",
                    idFactory: () => successorId,
                },
                successorSafeLocator,
                generationEvidence: {
                    generation: expectedGeneration + 1,
                    currentSegmentId: successorId,
                    ...(await readTranscriptEvidence(repairPath)),
                },
            });
            expectedGeneration += 1;
            predecessorId = successorId;
        }
        const segments = store.listSessionTranscriptSegments(fixture.session.runwieldSessionId);
        assertEquals(
            segments.filter((segment) => segment.kind === "semantic_repair").map((segment) => segment.ordinal),
            [1, 2],
        );
        assertEquals(segments.filter((segment) => segment.kind === "reviewer").length, 0);
        assertEquals(store.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.generation, 2);
    } finally {
        store.close();
        await fixture.cleanup();
    }
});
