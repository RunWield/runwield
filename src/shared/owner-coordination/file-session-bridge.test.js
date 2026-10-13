import { assertEquals } from "../../testing/assertions.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../sqlite.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { encodeCwdForSessionDir } from "../session/root-session.js";
import { openOwnerCoordinationStore } from "./index.js";

/** @param {DatabaseSync} database @param {string} table */
function countRows(database, table) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return Number(row?.count ?? -1);
}

test("Workspace stores receipts but leaves Session authority in files", async () => {
    const rootDir = await fsMkdtemp(join(tmpdir(), "runwield-workspace-file-session-"));
    const projectRoot = join(rootDir, "project");
    const sessionBaseDir = join(rootDir, "sessions");
    const databasePath = join(rootDir, "workspace.sqlite3");
    await fsMkdir(projectRoot);
    const canonicalProjectRoot = await fsRealpath(projectRoot);
    const sessionDir = join(sessionBaseDir, encodeCwdForSessionDir(canonicalProjectRoot));
    await fsMkdir(sessionDir, { recursive: true });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const piSessionId = "workspace-file-session";
    const transcriptPath = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    await fsWriteFile(
        transcriptPath,
        `${JSON.stringify({ type: "session", version: 3, id: piSessionId, timestamp, cwd: projectRoot })}\n`,
    );

    let runwieldSessionId = "";
    const store = openOwnerCoordinationStore({ dbPath: databasePath, sessionBaseDir });
    try {
        const workspaceProject = store.registerProject({ root: projectRoot });
        const sessionProject = store.ensureRuntimeProject({ root: projectRoot });
        const session = await store.ensureSessionCatalogRecord({
            projectId: sessionProject.projectId,
            piSessionId,
            transcriptPath,
            transcriptCwd: projectRoot,
            source: "created",
        });
        runwieldSessionId = session.runwieldSessionId;
        store.createOrGetOperationReceipt({
            requestId: "request-1",
            requestHash: "hash-1",
            runwieldSessionId,
            projectId: workspaceProject.projectId,
            expectedGeneration: null,
            kind: "continuation",
        });

        const database = new DatabaseSync(databasePath);
        try {
            assertEquals(countRows(database, "runwield_sessions"), 0);
            assertEquals(countRows(database, "session_transcript_segments"), 0);
            assertEquals(countRows(database, "session_activation_state"), 0);
            assertEquals(countRows(database, "owner_session_operations"), 1);
        } finally {
            database.close();
        }
    } finally {
        store.close();
    }

    await fsRm(databasePath);
    const coreStore = openFileSessionStore({ baseDir: sessionBaseDir });
    try {
        assertEquals(coreStore.getSessionById(runwieldSessionId)?.piSessionId, piSessionId);
    } finally {
        coreStore.close();
        await fsRm(rootDir, { recursive: true });
    }
});
