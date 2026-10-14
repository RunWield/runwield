import { assertEquals } from "../../testing/assertions.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openFileSessionStore } from "./file-session-store.ts";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";
import { manifestPath } from "./file-session-storage.ts";

async function evidence(path: string) {
    const bytes = await fsReadFile(path);
    return {
        byteLength: bytes.byteLength,
        digestHex: createHash("sha256").update(bytes).digest("hex"),
        terminalEntryId: null,
    };
}

test("the latest Plan review reference survives segment rollover and descriptor reconstruction", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "review-rollover-"));
    const projectRoot = join(root, "project");
    const baseDir = join(root, "sessions");
    await fsMkdir(projectRoot);
    const sessionDir = join(baseDir, encodeCwdForSessionDir(await fsRealpath(projectRoot)));
    await fsMkdir(sessionDir, { recursive: true });
    const firstPath = join(sessionDir, "2026-01-01T00-00-00-000Z_first.jsonl");
    const nextPath = join(sessionDir, "2026-01-01T00-01-00-000Z_second.jsonl");
    await fsWriteFile(
        firstPath,
        `${JSON.stringify({
            type: "session",
            version: 3,
            id: "first",
            timestamp: "2026-01-01T00:00:00.000Z",
            cwd: projectRoot,
        })}\n`,
    );
    const store = openFileSessionStore({ baseDir });
    try {
        const project = store.ensureRuntimeProject({ root: projectRoot });
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "first",
            transcriptPath: firstPath,
            transcriptCwd: projectRoot,
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
        assert(segment);
        let proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "writer",
            ownerProcessKind: "test",
            expectedCurrentSegmentId: segment.segmentId,
        });
        const reference = store.recordLastPlanReview(proof, {
            planId: "reviewed-plan-id",
            planName: "reviewed-plan",
            planningAgentName: "architect",
        });
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        await fsWriteFile(
            nextPath,
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: "second",
                timestamp: "2026-01-01T00:01:00.000Z",
                cwd: projectRoot,
            })}\n`,
        );
        const safe = await store.validateSuccessorSegmentLocator({
            projectId: project.projectId,
            piSessionId: "second",
            transcriptPath: nextPath,
            transcriptCwd: projectRoot,
        });
        const rollover = store.commitSegmentRolloverAndPublish(proof, {
            predecessorSegmentId: segment.segmentId,
            predecessorEvidence: await evidence(firstPath),
            successor: {
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                piSessionId: "second",
                transcriptPath: nextPath,
                transcriptCwd: projectRoot,
                kind: "execution",
                idFactory: () => "next-segment",
            },
            successorSafeLocator: safe,
            generationEvidence: { generation: 0, currentSegmentId: "next-segment", ...(await evidence(nextPath)) },
        });
        assertEquals(rollover.successor.segmentId, "next-segment");
        assertEquals(store.getLastPlanReview(session.runwieldSessionId, project.projectId), reference);
        store.close();
        const resumed = openFileSessionStore({ baseDir });
        try {
            assertEquals(resumed.getCurrentSessionSegment(session.runwieldSessionId)?.segmentId, "next-segment");
            assertEquals(resumed.getLastPlanReview(session.runwieldSessionId, project.projectId), reference);
        } finally {
            resumed.close();
        }
        await fsRm(manifestPath(sessionDir, session.runwieldSessionId));
        const recovered = openFileSessionStore({ baseDir });
        try {
            assertEquals(recovered.getCurrentSessionSegment(session.runwieldSessionId)?.segmentId, "next-segment");
            assertEquals(recovered.getLastPlanReview(session.runwieldSessionId, project.projectId), reference);
        } finally {
            recovered.close();
        }
    } finally {
        store.close();
        await fsRm(root, { recursive: true });
    }
});
