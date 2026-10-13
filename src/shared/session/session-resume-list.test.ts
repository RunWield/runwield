import { assertEquals } from "../../testing/assertions.ts";
import process from "node:process";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    utimes as fsUtimes,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { getRunWieldSessionDir } from "./root-session.js";
import { captureTranscriptEvidence } from "./session-transcript-projection.js";
import { listRecentResumableSessions, RECENT_SESSION_LIMIT } from "./session-resume-list.ts";

function transcriptText(id: string, cwd: string, timestamp: string, index: number): string {
    return [
        JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }),
        JSON.stringify({
            type: "message",
            id: `message-${index}`,
            parentId: null,
            timestamp,
            message: { role: "user", content: `Session ${index}`, timestamp },
        }),
        "",
    ].join("\n");
}

test("resume listing reads only the 30 newest transcripts and returns them newest first", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await fsMkdtemp(join(tmpdir(), "runwield-recent-session-list-"));
        process.env["HOME"] = home;
        const cwd = join(home, "project");
        await fsMkdir(cwd, { recursive: true });
        const store = openFileSessionStore();
        try {
            store.ensureRuntimeProject({ root: cwd });
            const sessionDir = getRunWieldSessionDir(cwd);
            await fsMkdir(sessionDir, { recursive: true });
            for (let index = 0; index < 64; index++) {
                const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
                const id = `pi-${String(index).padStart(2, "0")}`;
                const filename = `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
                const transcriptPath = join(sessionDir, filename);
                await fsWriteFile(
                    transcriptPath,
                    transcriptText(id, cwd, timestamp, index),
                );
                const modified = new Date(Date.UTC(2026, 1, 1, 0, 0, index));
                await fsUtimes(transcriptPath, modified, modified);
            }

            const listed = await listRecentResumableSessions(cwd, store);

            assertEquals(listed.length, RECENT_SESSION_LIMIT);
            assertEquals(
                listed.map((session) => session.id),
                Array.from({ length: RECENT_SESSION_LIMIT }, (_, offset) => `pi-${63 - offset}`),
            );
            assertEquals(listed[0].firstMessage, "Session 63");
            assertEquals(listed.at(-1)?.firstMessage, "Session 34");
        } finally {
            store.close();
            process.env["HOME"] = previousHome;
            await fsRm(home, { recursive: true });
        }
    });
});

test("resume listing hides a conversation while another TUI holds its lock", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await fsMkdtemp(join(tmpdir(), "runwield-active-session-list-"));
        process.env["HOME"] = home;
        const cwd = join(home, "project");
        await fsMkdir(cwd, { recursive: true });
        const holderStore = openFileSessionStore();
        const listingStore = openFileSessionStore();
        try {
            const project = holderStore.ensureRuntimeProject({ root: cwd });
            const sessionDir = getRunWieldSessionDir(cwd);
            await fsMkdir(sessionDir, { recursive: true });
            const timestamp = "2026-01-01T00:00:00.000Z";
            const piSessionId = "pi-active-tui";
            const transcriptPath = join(
                sessionDir,
                `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`,
            );
            await fsWriteFile(transcriptPath, transcriptText(piSessionId, cwd, timestamp, 1));
            const session = await holderStore.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: cwd,
                source: "created",
            });
            const segment = holderStore.getCurrentSessionSegment(session.runwieldSessionId);
            if (!segment) throw new Error("Fixture Session segment is unavailable");
            const proof = holderStore.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "older-tui",
                ownerProcessKind: "tui",
                expectedGeneration: null,
                expectedCurrentSegmentId: segment.segmentId,
                phase: "turning",
            });

            const whileActive = await listRecentResumableSessions(cwd, listingStore);
            assertEquals(whileActive, []);

            holderStore.releaseUnchangedActivation(proof);
            const afterRelease = await listRecentResumableSessions(cwd, listingStore);
            assertEquals(afterRelease.map((entry) => entry.id), [piSessionId]);
        } finally {
            listingStore.close();
            holderStore.close();
            process.env["HOME"] = previousHome;
            await fsRm(home, { recursive: true });
        }
    });
});

test("resume listing shows the top-level session but not semantic repair segments", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await fsMkdtemp(join(tmpdir(), "runwield-repair-session-list-"));
        process.env["HOME"] = home;
        const cwd = join(home, "project");
        await fsMkdir(cwd, { recursive: true });
        const store = openFileSessionStore();
        try {
            const project = store.ensureRuntimeProject({ root: cwd });
            const sessionDir = getRunWieldSessionDir(cwd);
            await fsMkdir(sessionDir, { recursive: true });
            const parentTimestamp = "2026-08-16T17:00:00.000Z";
            const parentId = "pi-top-level";
            const parentPath = join(
                sessionDir,
                `${parentTimestamp.replace(/[:.]/g, "-")}_${parentId}.jsonl`,
            );
            await fsWriteFile(parentPath, transcriptText(parentId, cwd, parentTimestamp, 1));
            const session = await store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: parentId,
                transcriptPath: parentPath,
                transcriptCwd: cwd,
                source: "created",
            });
            const parentSegment = store.getCurrentSessionSegment(session.runwieldSessionId);
            if (!parentSegment) throw new Error("Top-level Session segment is unavailable");
            const parentEvidence = await captureTranscriptEvidence({
                transcriptPath: parentPath,
                transcriptCwd: cwd,
            });
            store.sealSessionTranscriptSegment({
                runwieldSessionId: session.runwieldSessionId,
                segmentId: parentSegment.segmentId,
                evidence: parentEvidence,
            });

            const repairTimestamp = "2026-08-16T18:00:00.000Z";
            const repairId = "pi-semantic-repair";
            const repairPath = join(
                sessionDir,
                `${repairTimestamp.replace(/[:.]/g, "-")}_${repairId}.jsonl`,
            );
            await fsWriteFile(repairPath, transcriptText(repairId, cwd, repairTimestamp, 2));
            await store.appendSessionTranscriptSegment({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                piSessionId: repairId,
                transcriptPath: repairPath,
                transcriptCwd: cwd,
                kind: "semantic_repair",
                lineageParentSegmentId: parentSegment.segmentId,
                lineageParentPiSessionId: parentId,
            });

            const listed = await listRecentResumableSessions(cwd, store);

            assertEquals(listed.map((entry) => entry.id), [parentId]);
        } finally {
            store.close();
            process.env["HOME"] = previousHome;
            await fsRm(home, { recursive: true });
        }
    });
});

test("resume listing ignores an unrelated parent Project record", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await fsMkdtemp(join(tmpdir(), "runwield-parent-project-resume-list-"));
        process.env["HOME"] = home;
        const parentRoot = join(home, "projects");
        const cwd = join(parentRoot, "brandchef.ai");
        await fsMkdir(cwd, { recursive: true });
        const store = openFileSessionStore();
        try {
            store.ensureRuntimeProject({ root: parentRoot });
            const sessionDir = getRunWieldSessionDir(cwd);
            await fsMkdir(sessionDir, { recursive: true });
            const timestamp = "2026-08-16T17:00:00.000Z";
            const piSessionId = "brandchef-session";
            await fsWriteFile(
                join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`),
                transcriptText(piSessionId, cwd, timestamp, 1),
            );

            const listed = await listRecentResumableSessions(cwd, store);

            assertEquals(listed.map((session) => session.id), [piSessionId]);
        } finally {
            store.close();
            process.env["HOME"] = previousHome;
            await fsRm(home, { recursive: true });
        }
    });
});

test("resume listing excludes archived Sessions and keeps active and legacy Sessions", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await fsMkdtemp(join(tmpdir(), "runwield-archive-resume-"));
        process.env["HOME"] = home;
        const cwd = join(home, "project");
        await fsMkdir(cwd);
        const store = openFileSessionStore();
        try {
            const project = store.ensureRuntimeProject({ root: cwd });
            const sessionDir = getRunWieldSessionDir(cwd);
            await fsMkdir(sessionDir, { recursive: true });
            for (const [index, id] of ["archived", "active", "legacy"].entries()) {
                const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
                const transcriptPath = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
                await fsWriteFile(transcriptPath, transcriptText(id, cwd, timestamp, index));
                if (id !== "legacy") {
                    const session = await store.ensureSessionCatalogRecord({
                        projectId: project.projectId,
                        piSessionId: id,
                        transcriptPath,
                        transcriptCwd: cwd,
                    });
                    if (id === "archived") store.archiveSession(session.runwieldSessionId);
                }
            }
            assertEquals((await listRecentResumableSessions(cwd, store)).map((item) => item.id).sort(), [
                "active",
                "legacy",
            ]);
        } finally {
            store.close();
            process.env["HOME"] = previousHome;
            await fsRm(home, { recursive: true });
        }
    });
});
