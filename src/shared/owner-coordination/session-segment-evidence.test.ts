import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { getRunWieldSessionDir } from "../session/root-session.js";
import { captureTranscriptEvidence } from "../session/session-transcript-projection.js";
import { openOwnerCoordinationDatabase } from "./database.js";
import { registerProject } from "./projects.js";
import {
    ensureSessionCatalogRecord,
    getCurrentSessionSegment,
    listSessionTranscriptSegments,
    sealSessionTranscriptSegment,
} from "./sessions.js";

function idFactory(prefix = "id") {
    let next = 0;
    return () => `${prefix}-${++next}`;
}

async function writeTranscript(cwd: string, piSessionId: string) {
    const sessionDir = getRunWieldSessionDir(cwd);
    await fsMkdir(sessionDir, { recursive: true });
    const path = `${sessionDir}/2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`;
    await fsWriteFile(
        path,
        [
            { type: "session", id: piSessionId, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
            { type: "message", id: "entry", message: { role: "user", content: "hello" } },
        ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
    );
    return path;
}

test("seal captures byte length digest and terminal entry evidence through a real migrated database", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-evidence-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            const root = `${dir}/repo`;
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory("project"), now: () => "t0" });
            const transcriptPath = await writeTranscript(root, "pi-1");
            const session = await ensureSessionCatalogRecord(database, {
                projectId: project.projectId,
                piSessionId: "pi-1",
                transcriptPath,
                transcriptCwd: root,
                idFactory: idFactory("session"),
                now: () => "t1",
            });
            const segment = getCurrentSessionSegment(database, session.runwieldSessionId);
            assert(segment);
            const evidence = await captureTranscriptEvidence({ transcriptPath, transcriptCwd: root });
            const sealed = await sealSessionTranscriptSegment(database, {
                runwieldSessionId: session.runwieldSessionId,
                segmentId: segment.segmentId,
                evidence,
                now: () => "t2",
            });
            assertEquals(sealed.sealedByteLength, evidence.byteLength);
            assertEquals(sealed.sealedDigestHex, evidence.digestHex);
            assertEquals(sealed.sealedTerminalEntryId, evidence.terminalEntryId);
            assertEquals(
                listSessionTranscriptSegments(database, session.runwieldSessionId)[0].sealedDigestHex,
                evidence.digestHex,
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("seal rejects absent or mismatched evidence and leaves the segment unsealed", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-evidence-reject-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            const root = `${dir}/repo`;
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory("project"), now: () => "t0" });
            const transcriptPath = await writeTranscript(root, "pi-1");
            const session = await ensureSessionCatalogRecord(database, {
                projectId: project.projectId,
                piSessionId: "pi-1",
                transcriptPath,
                transcriptCwd: root,
                idFactory: idFactory("session"),
                now: () => "t1",
            });
            const segment = getCurrentSessionSegment(database, session.runwieldSessionId);
            assert(segment);
            assertThrows(
                () =>
                    sealSessionTranscriptSegment(database, {
                        runwieldSessionId: session.runwieldSessionId,
                        segmentId: segment.segmentId,
                    }),
                Error,
                "evidence is required",
            );
            const evidence = await captureTranscriptEvidence({ transcriptPath, transcriptCwd: root });
            assertThrows(
                () =>
                    sealSessionTranscriptSegment(database, {
                        runwieldSessionId: session.runwieldSessionId,
                        segmentId: segment.segmentId,
                        evidence: { ...evidence, digestHex: "0".repeat(64) },
                    }),
                Error,
                "does not match",
            );
            assertEquals(getCurrentSessionSegment(database, session.runwieldSessionId)?.sealedAt, null);
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
