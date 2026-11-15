import assert from "node:assert/strict";
import process from "node:process";
import { rename } from "node:fs/promises";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { admitProjectIdentity } from "../project-identity.ts";
import {
    createRootSessionManager,
    resolveCreatedRootSessionPath,
    openPersistedRootSession,
} from "../session/root-session.js";
import { listRecentResumableSessions } from "../session/session-resume-list.ts";
import { captureTranscriptEvidence } from "../session/session-transcript-projection.js";
import { sessionBelongsToOwnerProject } from "../../ui/workspace/server/owner-projects.ts";
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
import { encodeCwdForSessionDir } from "../project-directory-key.ts";
import { openOwnerCoordinationStore } from "./index.js";

function countRows(database: DatabaseSync, table: string) {
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

test("Workspace relink preserves registration and history; removing SQLite leaves Core continuation usable", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await fsRealpath(await fsMkdtemp(join(tmpdir(), "workspace-project-continuity-")));
        const root = join(home, "original"),
            moved = join(home, "moved");
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            await fsMkdir(root);
            const dbPath = join(home, "workspace.sqlite3");
            const store = openOwnerCoordinationStore({ dbPath });
            const registered = store.registerProject({ root });
            const project = store.ensureRuntimeProject({ root });
            const manager = await createRootSessionManager("new", root);
            manager.appendMessage({
                role: "user",
                timestamp: Date.now(),
                content: [{ type: "text", text: "Workspace history" }],
            });
            const path = await resolveCreatedRootSessionPath(root, manager);
            const session = await store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: manager.getSessionId(),
                transcriptPath: path,
                transcriptCwd: root,
            });
            let proof = store.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "workspace",
                ownerProcessKind: "test",
                phase: "bootstrap",
            });
            const evidence = await captureTranscriptEvidence({ transcriptPath: path, transcriptCwd: root });
            store.publishGenerationAndRelease(store.changeSessionActivationPhase(proof, "checkpointing"), {
                generation: 0,
                byteLength: evidence.byteLength,
                digestHex: evidence.digestHex,
                terminalEntryId: evidence.terminalEntryId,
            });
            assertEquals((await admitProjectIdentity(root)).kind, "existing");
            await rename(root, moved);
            assertEquals((await admitProjectIdentity(moved)).kind, "existing");
            const relinked = store.relinkProject({ projectId: registered.projectId, newRoot: moved });
            assertEquals(relinked.projectId, registered.projectId);
            assertEquals(
                (await store.listProjectSessions(registered.projectId)).sessions.map((item) => item.runwieldSessionId),
                [session.runwieldSessionId],
            );
            assertEquals(sessionBelongsToOwnerProject(store, session, registered.projectId), true);
            store.setProjectEnabled(registered.projectId, false);
            assert.throws(() => store.requireEnabledProjectRoot(registered.projectId), /not enabled/);
            store.setProjectEnabled(registered.projectId, true);
            store.removeProject(registered.projectId);
            assertEquals(sessionBelongsToOwnerProject(store, session, registered.projectId), false);
            assertEquals(store.getSessionById(session.runwieldSessionId, registered.projectId), null);
            store.close();
            await fsRm(dbPath);
            const core = openFileSessionStore();
            assertEquals((await listRecentResumableSessions(moved, core)).length, 1);
            proof = core.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "core",
                ownerProcessKind: "test",
                expectedGeneration: 0,
                phase: "preparing",
            });
            const reopened = await openPersistedRootSession({
                cwd: moved,
                sessionId: session.piSessionId,
                sessionPath: path,
            });
            reopened.sessionManager.appendMessage({
                role: "user",
                timestamp: Date.now(),
                content: [{ type: "text", text: "Core after SQLite removal" }],
            });
            const continued = await captureTranscriptEvidence({ transcriptPath: path, transcriptCwd: root });
            core.publishGenerationAndRelease(
                core.changeSessionActivationPhase(
                    core.changeSessionActivationPhase(proof, "hydrated"),
                    "checkpointing",
                ),
                {
                    generation: 1,
                    byteLength: continued.byteLength,
                    digestHex: continued.digestHex,
                    terminalEntryId: continued.terminalEntryId,
                },
            );
            core.close();
            const registeredAgain = openOwnerCoordinationStore({ dbPath });
            const registration = registeredAgain.registerProject({ root: moved });
            assertEquals(
                (await registeredAgain.listProjectSessions(registration.projectId)).sessions.map(
                    (item) => item.runwieldSessionId,
                ),
                [session.runwieldSessionId],
            );
            registeredAgain.close();
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            await fsRm(home, { recursive: true, force: true });
        }
    });
});
