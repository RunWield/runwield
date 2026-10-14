import { platform } from "node:process";
import { readdirSync } from "node:fs";
import { openNativeFileLock } from "../native-file-lock.ts";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertFalse, assertThrows } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { classifyRootSessionLocator } from "./root-session.js";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { catalogLockPath, lockPath, manifestPath, sessionDirForRoot } from "./file-session-storage.ts";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** @typedef {import("./file-session-store.ts").FileSessionStore} FileSessionStore */

/**
 * @typedef {Object} TestLineage
 * @property {string} runwieldSessionId
 * @property {string} segmentId
 * @property {string | null} parentSegmentId
 * @property {string | null} parentPiSessionId
 * @property {string | null} lineageGroupKey
 * @property {'planning' | 'execution' | 'semantic_repair'} kind
 */

/** @param {string} sessionDir @param {string} cwd @param {string} id @param {TestLineage | null} [lineage] @param {string} [timestamp] */
async function writeTranscript(sessionDir, cwd, id, lineage = null, timestamp = TIMESTAMP) {
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    const entries = [JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })];
    if (lineage) {
        entries.push(JSON.stringify({ type: "custom", customType: "runwield.segment_lineage", data: lineage }));
    }
    await writeFile(path, `${entries.join("\n")}\n`);
    return path;
}

async function makeFixture() {
    const rootDir = await mkdtemp(join(tmpdir(), "runwield-file-session-store-"));
    const projectRoot = join(rootDir, "project");
    const sessionBaseDir = join(rootDir, "sessions");
    await mkdir(projectRoot);
    const canonicalProjectRoot = await realpath(projectRoot);
    const sessionDir = join(sessionBaseDir, encodeCwdForSessionDir(canonicalProjectRoot));
    return { rootDir, projectRoot, sessionBaseDir, sessionDir };
}

test("Core catalogs every local Session without creating a Workspace database", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "legacy-session");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const first = await store.listProjectSessions(project.projectId);
        assertEquals(first.sessions.length, 1);
        assertEquals(first.sessions[0].piSessionId, "legacy-session");
        assertEquals(first.sessions[0].transcriptPath, transcriptPath);
        assertEquals(
            store.listSessionTranscriptSegments(first.sessions[0].runwieldSessionId).map((item) => item.kind),
            ["planning"],
        );
        assertFalse(await exists(join(fixture.rootDir, "owner-coordination.sqlite3")));
        const stableId = first.sessions[0].runwieldSessionId;
        store.close();

        const reopened = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertEquals((await reopened.listProjectSessions(project.projectId)).sessions[0].runwieldSessionId, stableId);
        reopened.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test(
    "Windows aliases share Session authority and transcript catalog locks",
    { skip: platform !== "win32" },
    async () => {
        const fixture = await makeFixture();
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        try {
            const canonicalRoot = await realpath(fixture.projectRoot);
            const alias = fixture.projectRoot.toUpperCase();
            const project = store.ensureRuntimeProject({ root: alias });
            assertEquals(project.currentRoot, canonicalRoot);
            assertEquals(store.ensureRuntimeProject({ root: canonicalRoot }).projectId, project.projectId);
            assertEquals(store.listSessionProjects().length, 1);
            assertEquals(sessionDirForRoot(fixture.sessionBaseDir, alias), fixture.sessionDir);
            const transcriptPath = await writeTranscript(fixture.sessionDir, alias, "Alias Transcript");
            assertEquals(
                catalogLockPath(fixture.sessionDir, transcriptPath.toUpperCase()),
                catalogLockPath(fixture.sessionDir, await realpath(transcriptPath)),
            );
            const sessions = await store.listProjectSessions(project.projectId);
            assertEquals(
                sessions.sessions.map((session) => session.piSessionId),
                ["Alias Transcript"],
            );
        } finally {
            store.close();
            await rm(fixture.rootDir, { recursive: true });
        }
    },
);

test("Project Session listing paginates and provides a sorted unpaged snapshot", async () => {
    const fixture = await makeFixture();
    try {
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        for (let index = 0; index < 101; index += 1) {
            await writeTranscript(
                fixture.sessionDir,
                fixture.projectRoot,
                `session-${index}`,
                null,
                new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            );
        }

        const firstPage = await store.listProjectSessions(project.projectId, { page: 0, pageSize: 30 });
        const secondPage = await store.listProjectSessions(project.projectId, { page: 1, pageSize: 30 });
        const snapshot = await store.listProjectSessions(project.projectId, { all: true, catalog: false });

        assertEquals(snapshot.sessions.length, 101);
        assertEquals(snapshot.sessions.slice(0, 30), firstPage.sessions);
        assertEquals(snapshot.sessions.slice(30, 60), secondPage.sessions);
        assertEquals(firstPage.sessions.length, 30);
        assertEquals(secondPage.sessions.length, 30);
        assertEquals(firstPage.total, 101);
        assertEquals(firstPage.hasNext, true);
        assertEquals(secondPage.hasNext, true);
        assertEquals(firstPage.sessions[0].piSessionId, "session-100");
        assertEquals(snapshot.sessions[snapshot.sessions.length - 1].piSessionId, "session-0");
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("real and symlinked Project roots share one file authority", async () => {
    const fixture = await makeFixture();
    const linkedRoot = join(fixture.rootDir, "project-link");
    try {
        await symlink(fixture.projectRoot, linkedRoot);
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const realProject = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const linkedProject = store.ensureRuntimeProject({ root: linkedRoot });
        assertEquals(linkedProject.projectId, realProject.projectId);
        assertEquals(store.listSessionProjects().length, 1);
        const linkedSessionDir = fixture.sessionDir;
        assertEquals(
            (await classifyRootSessionLocator({ cwd: linkedRoot, ownerCoordinationStore: store })).project?.projectId,
            realProject.projectId,
        );
        assertEquals(
            (await classifyRootSessionLocator({ cwd: fixture.projectRoot, ownerCoordinationStore: store })).project
                ?.projectId,
            realProject.projectId,
        );

        const transcriptPath = await writeTranscript(linkedSessionDir, linkedRoot, "linked-session");
        const session = await store.ensureSessionCatalogRecord({
            projectId: linkedProject.projectId,
            piSessionId: "linked-session",
            transcriptPath,
            transcriptCwd: linkedRoot,
            source: "created",
        });
        assertEquals(session.projectId, realProject.projectId);
        assertEquals(session.transcriptPath, transcriptPath);
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("successor segments can live under their transcript cwd", async () => {
    const fixture = await makeFixture();
    const worktreeRoot = join(fixture.rootDir, "worktree-project");
    const linkedWorktreeRoot = join(fixture.rootDir, "worktree-link");
    try {
        await mkdir(worktreeRoot);
        await symlink(worktreeRoot, linkedWorktreeRoot);
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const worktreeSessionDir = sessionDirForRoot(fixture.sessionBaseDir, linkedWorktreeRoot);
        const transcriptPath = await writeTranscript(worktreeSessionDir, linkedWorktreeRoot, "successor-session");

        const safe = await store.validateSuccessorSegmentLocator({
            projectId: project.projectId,
            piSessionId: "successor-session",
            transcriptPath,
            transcriptCwd: linkedWorktreeRoot,
        });

        assertEquals(worktreeSessionDir, sessionDirForRoot(fixture.sessionBaseDir, worktreeRoot));
        assertEquals(safe.piSessionId, "successor-session");
        assertEquals(safe.sessionPath, transcriptPath);
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("new Session catalog publication acquires its writer lock atomically", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "atomic-session");
        const firstStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const secondStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = firstStore.ensureRuntimeProject({ root: fixture.projectRoot });
        const acquired = await firstStore.ensureSessionCatalogRecordAndAcquire({
            locator: {
                projectId: project.projectId,
                piSessionId: "atomic-session",
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
                source: "created",
            },
            activation: {
                ownerInstanceId: "creator",
                ownerProcessKind: "test",
                operationId: "create-operation",
            },
        });
        assertThrows(
            () =>
                secondStore.acquireSessionActivation({
                    runwieldSessionId: acquired.session.runwieldSessionId,
                    projectId: project.projectId,
                    ownerInstanceId: "racer",
                    ownerProcessKind: "test",
                    expectedGeneration: null,
                    expectedCurrentSegmentId: acquired.segment.segmentId,
                }),
            Error,
            "another RunWield surface",
        );
        firstStore.releaseUnchangedActivation(acquired.proof);
        firstStore.close();
        secondStore.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("active Session turns register durable artifact references without changing the writer phase", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "artifact-session");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const acquired = await store.ensureSessionCatalogRecordAndAcquire({
            locator: {
                projectId: project.projectId,
                piSessionId: "artifact-session",
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
                source: "created",
            },
            activation: {
                ownerInstanceId: "artifact-writer",
                ownerProcessKind: "test",
                operationId: "artifact-operation",
            },
        });

        const artifact = store.registerSessionArtifact(acquired.proof, {
            kind: "prd",
            path: "docs/prd/session-sidebar.md",
            title: "Session Sidebar",
            registeredBy: "Ideator",
            idFactory: () => "artifact-1",
            now: () => TIMESTAMP,
        });
        const duplicate = store.registerSessionArtifact(acquired.proof, {
            kind: "prd",
            path: "docs/prd/session-sidebar.md",
            title: "Changed title",
            registeredBy: "Ideator",
            idFactory: () => "artifact-2",
        });

        assertEquals(artifact, {
            artifactId: "artifact-1",
            kind: "prd",
            path: "docs/prd/session-sidebar.md",
            title: "Session Sidebar",
            registeredAt: TIMESTAMP,
            registeredBy: "Ideator",
            sourceSegmentId: acquired.segment.segmentId,
        });
        assertEquals(duplicate, artifact);
        assertEquals(store.listSessionArtifacts(acquired.session.runwieldSessionId), [artifact]);
        assertEquals(store.inspectSessionActivation(acquired.session.runwieldSessionId).activation?.phase, "preparing");

        store.releaseUnchangedActivation(acquired.proof);
        store.close();
        const reopened = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertEquals(reopened.listSessionArtifacts(acquired.session.runwieldSessionId), [artifact]);
        reopened.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("created and loaded Sessions do not scan unrelated Session manifests", async () => {
    const fixture = await makeFixture();
    const siblingRoot = join(fixture.rootDir, "sibling-project");
    try {
        await mkdir(siblingRoot);
        const canonicalSiblingRoot = await realpath(siblingRoot);
        const siblingSessionDir = join(fixture.sessionBaseDir, encodeCwdForSessionDir(canonicalSiblingRoot));
        const siblingTranscript = await writeTranscript(siblingSessionDir, canonicalSiblingRoot, "sibling-session");
        const seedStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const siblingProject = seedStore.ensureRuntimeProject({ root: canonicalSiblingRoot, now: () => TIMESTAMP });
        const sibling = await seedStore.ensureSessionCatalogRecord({
            projectId: siblingProject.projectId,
            piSessionId: "sibling-session",
            transcriptPath: siblingTranscript,
            transcriptCwd: canonicalSiblingRoot,
            source: "created",
            idFactory: () => "sibling-runwield-session",
            now: () => TIMESTAMP,
        });
        seedStore.close();
        const siblingManifest = manifestPath(siblingSessionDir, sibling.runwieldSessionId);
        await rm(siblingManifest);
        assertFalse(await exists(siblingManifest));

        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "current-session");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const current = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "current-session",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
            idFactory: () => "current-runwield-session",
        });
        assertFalse(await exists(siblingManifest));
        assertEquals(store.listSessionArtifacts(current.runwieldSessionId), []);
        assertFalse(await exists(siblingManifest));
        store.close();

        const reopened = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertEquals(reopened.findSessionByLocator({ transcriptPath })?.runwieldSessionId, current.runwieldSessionId);
        assertFalse(await exists(siblingManifest));
        assertEquals(
            reopened.getSessionById(current.runwieldSessionId, project.projectId)?.runwieldSessionId,
            current.runwieldSessionId,
        );
        assertFalse(await exists(siblingManifest));
        reopened.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("cached Session manifests refresh after another surface publishes a change", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "shared-session");
        const reader = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = reader.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await reader.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "shared-session",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const segment = reader.getCurrentSessionSegment(session.runwieldSessionId);
        assert(segment);
        assertEquals(reader.listSessionArtifacts(session.runwieldSessionId), []);

        const writer = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const proof = writer.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "artifact-writer",
            ownerProcessKind: "test",
            expectedGeneration: null,
            expectedCurrentSegmentId: segment.segmentId,
        });
        const artifact = writer.registerSessionArtifact(proof, {
            kind: "report",
            path: "reports/fresh.md",
            title: "Fresh report",
            registeredBy: "Reviewer",
            idFactory: () => "fresh-artifact",
            now: () => TIMESTAMP,
        });
        writer.releaseUnchangedActivation(proof);

        assertEquals(reader.listSessionArtifacts(session.runwieldSessionId), [artifact]);
        writer.close();
        reader.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("concurrent legacy migration converges on one Session identity", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "legacy-race");
        const firstStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const secondStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = firstStore.ensureRuntimeProject({ root: fixture.projectRoot });
        /** @param {FileSessionStore} store @param {string} id */
        const migrate = (store, id) =>
            store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: "legacy-race",
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
                source: "catalog",
                idFactory: () => id,
            });
        const [first, second] = await Promise.all([
            migrate(firstStore, "first-identity"),
            migrate(secondStore, "second-identity"),
        ]);
        assertEquals(first.runwieldSessionId, second.runwieldSessionId);
        assertEquals((await firstStore.listProjectSessions(project.projectId)).sessions.length, 1);
        firstStore.close();
        secondStore.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("the Session file lock permits exactly one writer and is released when its store closes", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "locked-session");
        const firstStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = firstStore.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await firstStore.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "locked-session",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const segment = firstStore.getCurrentSessionSegment(session.runwieldSessionId);
        assert(segment);
        const proof = firstStore.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "first",
            ownerProcessKind: "test",
            expectedGeneration: null,
            expectedCurrentSegmentId: segment.segmentId,
        });

        const secondStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertThrows(
            () =>
                secondStore.acquireSessionActivation({
                    runwieldSessionId: session.runwieldSessionId,
                    projectId: project.projectId,
                    ownerInstanceId: "second",
                    ownerProcessKind: "test",
                    expectedGeneration: null,
                    expectedCurrentSegmentId: segment.segmentId,
                }),
            Error,
            "another RunWield surface",
        );
        firstStore.close();

        const recovered = secondStore.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "second",
            ownerProcessKind: "test",
            expectedGeneration: null,
            expectedCurrentSegmentId: segment.segmentId,
        });
        assertEquals(recovered.fence, proof.fence + 1);
        secondStore.releaseUnchangedActivation(recovered);
        secondStore.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("a missing or damaged manifest is restored from transcript-adjacent recovery evidence", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "recover-session");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "recover-session",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const manifestPath = join(
            fixture.sessionDir,
            ".runwield",
            "session-bundles",
            session.runwieldSessionId,
            "manifest.json",
        );
        await rm(manifestPath);
        assertEquals(store.getSessionById(session.runwieldSessionId)?.runwieldSessionId, session.runwieldSessionId);
        await writeFile(manifestPath, "not json\n");
        assertEquals(store.getSessionById(session.runwieldSessionId)?.runwieldSessionId, session.runwieldSessionId);
        const bundleEntries = [...readdirSync(dirname(manifestPath), { withFileTypes: true })];
        assert(bundleEntries.some((entry) => entry.name.startsWith("manifest.json.damaged-")));
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("recovery descriptor retains the initial writer baseline when the manifest is lost", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "baseline-recovery");
        const firstStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = firstStore.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await firstStore.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "baseline-recovery",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "catalog",
        });
        firstStore.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "interrupted-writer",
            ownerProcessKind: "test",
            expectedGeneration: null,
        });
        await writeFile(transcriptPath, `${JSON.stringify({ type: "message", message: { role: "user" } })}\n`, {
            flag: "a",
        });
        const manifestPath = join(
            fixture.sessionDir,
            ".runwield",
            "session-bundles",
            session.runwieldSessionId,
            "manifest.json",
        );
        await rm(manifestPath);
        firstStore.close();

        const recoveredStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertThrows(
            () =>
                recoveredStore.acquireSessionActivation({
                    runwieldSessionId: session.runwieldSessionId,
                    projectId: project.projectId,
                    ownerInstanceId: "recovery-writer",
                    ownerProcessKind: "test",
                    expectedGeneration: null,
                }),
            Error,
            "requires recovery",
        );
        recoveredStore.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("transcript lineage reconstructs one ordered Session without a database or manifest", async () => {
    const fixture = await makeFixture();
    try {
        const planningPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "planning");
        await writeFile(
            planningPath,
            `${JSON.stringify({
                type: "custom",
                customType: "runwield.plan_association",
                data: {
                    planId: "committed-plan",
                    planName: "committed-plan",
                    purpose: "planning",
                    segmentId: "planning-segment",
                    segmentKind: "planning",
                    recordedAt: TIMESTAMP,
                },
            })}\n`,
            { flag: "a" },
        );
        const executionPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "execution", {
            runwieldSessionId: "stable-session",
            segmentId: "execution-segment",
            parentSegmentId: "planning-segment",
            parentPiSessionId: "planning",
            lineageGroupKey: "planning-segment",
            kind: "execution",
        });
        await writeFile(
            executionPath,
            `${JSON.stringify({
                type: "custom",
                customType: "runwield.plan_association",
                data: {
                    planId: "continuation-boundary-plan",
                    planName: "continuation-boundary-plan",
                    purpose: "planning",
                    segmentId: "execution-segment",
                    segmentKind: "execution",
                    recordedAt: TIMESTAMP,
                },
            })}\n${JSON.stringify({ type: "custom", customType: "runwield.pending_segment_continuation", data: {} })}\n`,
            { flag: "a" },
        );
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const result = await store.listProjectSessions(project.projectId);
        assertEquals(result.diagnostics, []);
        assertEquals(result.sessions.length, 1);
        assertEquals(result.sessions[0].runwieldSessionId, "stable-session");
        assertEquals(
            store.listSessionTranscriptSegments("stable-session").map((item) => ({
                piSessionId: item.piSessionId,
                kind: item.kind,
                ordinal: item.ordinal,
            })),
            [
                { piSessionId: "planning", kind: "planning", ordinal: 0 },
                { piSessionId: "execution", kind: "execution", ordinal: 1 },
            ],
        );
        assertEquals(store.inspectSessionActivation("stable-session").generation?.generation, 1);
        assertEquals(store.listSessionPlanAssociations("stable-session"), [
            {
                planId: "committed-plan",
                planName: "committed-plan",
                purpose: "planning",
                segmentId: "planning-segment",
                segmentKind: "planning",
                recordedAt: TIMESTAMP,
                committedGeneration: 1,
            },
            {
                planId: "continuation-boundary-plan",
                planName: "continuation-boundary-plan",
                purpose: "planning",
                segmentId: "execution-segment",
                segmentKind: "execution",
                recordedAt: TIMESTAMP,
                committedGeneration: 1,
            },
        ]);
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("lineage recovery ignores uncommitted current root transcript associations", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "planning", {
            runwieldSessionId: "root-only-session",
            segmentId: "planning-segment",
            parentSegmentId: null,
            parentPiSessionId: null,
            lineageGroupKey: "planning-segment",
            kind: "planning",
        });
        await writeFile(
            transcriptPath,
            `${JSON.stringify({
                type: "custom",
                customType: "runwield.plan_association",
                data: {
                    planId: "tail-plan",
                    planName: "tail-plan",
                    purpose: "planning",
                    segmentId: "planning-segment",
                    segmentKind: "planning",
                    recordedAt: TIMESTAMP,
                },
            })}\n`,
            { flag: "a" },
        );
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const result = await store.listProjectSessions(project.projectId);
        assertEquals(result.diagnostics, []);
        assertEquals(result.sessions.length, 1);
        assertEquals(result.sessions[0].runwieldSessionId, "root-only-session");
        assertEquals(store.inspectSessionActivation("root-only-session").generation?.generation, 0);
        assertEquals(store.listSessionPlanAssociations("root-only-session"), []);
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("lineage recovery rejects a mismatched parent Pi identity", async () => {
    const fixture = await makeFixture();
    try {
        await writeTranscript(fixture.sessionDir, fixture.projectRoot, "planning", {
            runwieldSessionId: "mismatched-parent",
            segmentId: "planning-segment",
            parentSegmentId: null,
            parentPiSessionId: null,
            lineageGroupKey: "planning-segment",
            kind: "planning",
        });
        await writeTranscript(fixture.sessionDir, fixture.projectRoot, "execution", {
            runwieldSessionId: "mismatched-parent",
            segmentId: "execution-segment",
            parentSegmentId: "planning-segment",
            parentPiSessionId: "different-pi-session",
            lineageGroupKey: "planning-segment",
            kind: "execution",
        });
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const result = await store.listProjectSessions(project.projectId);
        assertEquals(result.sessions, []);
        assert(result.diagnostics.every((item) => item.code === "lineage_recovery_blocked"));
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("malformed lineage is blocked instead of cataloged as a legacy Session", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "malformed-lineage");
        await writeFile(
            transcriptPath,
            `${JSON.stringify({
                type: "custom",
                customType: "runwield.segment_lineage",
                data: { segmentId: "only" },
            })}\n`,
            { flag: "a" },
        );
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const result = await store.listProjectSessions(project.projectId);
        assertEquals(result.sessions, []);
        assertEquals(
            result.diagnostics.map((item) => item.code),
            ["lineage_recovery_blocked"],
        );
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("conflicting lineage entries fail closed", async () => {
    const fixture = await makeFixture();
    try {
        /** @type {TestLineage} */
        const firstLineage = {
            runwieldSessionId: "stable-session",
            segmentId: "planning-segment",
            parentSegmentId: null,
            parentPiSessionId: null,
            lineageGroupKey: "planning-segment",
            kind: "planning",
        };
        const transcriptPath = await writeTranscript(
            fixture.sessionDir,
            fixture.projectRoot,
            "conflicting-lineage",
            firstLineage,
        );
        await writeFile(
            transcriptPath,
            `${JSON.stringify({
                type: "custom",
                customType: "runwield.segment_lineage",
                data: { ...firstLineage, runwieldSessionId: "different-session" },
            })}\n`,
            { flag: "a" },
        );
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const result = await store.listProjectSessions(project.projectId);
        assertEquals(result.sessions, []);
        assertEquals(
            result.diagnostics.map((item) => item.code),
            ["lineage_recovery_blocked"],
        );
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("recovery rejects evidence that omits trailing transcript entries", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "stale-prefix");
        const original = await readFile(transcriptPath);
        const firstStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = firstStore.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await firstStore.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "stale-prefix",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const proof = firstStore.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "abandoned-writer",
            ownerProcessKind: "test",
            expectedGeneration: null,
        });
        firstStore.close();
        await writeFile(
            transcriptPath,
            `${JSON.stringify({ type: "message", message: { role: "user", content: "trailing" } })}\n`,
            { flag: "a" },
        );

        const recoveryStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertThrows(
            () =>
                recoveryStore.recoverSessionControl({
                    runwieldSessionId: session.runwieldSessionId,
                    projectId: project.projectId,
                    expectedFence: proof.fence,
                    expectedGeneration: null,
                    ownerInstanceId: "recovery",
                    ownerProcessKind: "test",
                    transcriptEvidence: {
                        byteLength: original.byteLength,
                        terminalEntryId: null,
                        digestHex: createHash("sha256").update(original).digest("hex"),
                    },
                }),
            Error,
            "transcript changed",
        );
        recoveryStore.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("initial recovery blocks a rewritten transcript prefix", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "prefix-original");
        const interruptedStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = interruptedStore.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await interruptedStore.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "prefix-original",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const proof = interruptedStore.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "interrupted-writer",
            ownerProcessKind: "test",
            expectedGeneration: null,
        });
        interruptedStore.close();

        const rewritten = (await readFile(transcriptPath, "utf8")).replace("prefix-original", "prefix-modified");
        await writeFile(transcriptPath, rewritten);
        const bytes = await readFile(transcriptPath);
        const recoveryStore = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertThrows(
            () =>
                recoveryStore.recoverSessionControl({
                    runwieldSessionId: session.runwieldSessionId,
                    projectId: project.projectId,
                    expectedFence: proof.fence,
                    expectedGeneration: null,
                    ownerInstanceId: "recovery",
                    ownerProcessKind: "test",
                    transcriptEvidence: {
                        byteLength: bytes.byteLength,
                        terminalEntryId: null,
                        digestHex: createHash("sha256").update(bytes).digest("hex"),
                    },
                }),
            Error,
            "baseline changed",
        );
        recoveryStore.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("initial recovery retains the writer baseline after activation becomes uncertain", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "initial-uncertain");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "initial-uncertain",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "initial-writer",
            ownerProcessKind: "test",
            expectedGeneration: null,
        });
        await writeFile(
            transcriptPath,
            `${await readFile(transcriptPath, "utf8")}${JSON.stringify({
                type: "custom",
                customType: "writer-output",
            })}\n`,
        );
        store.markSessionUncertain(proof, { reason: "agent activation failed" });

        const bytes = await readFile(transcriptPath);
        const recovered = store.recoverSessionControl({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            expectedFence: proof.fence,
            expectedGeneration: null,
            ownerInstanceId: "recovery",
            ownerProcessKind: "test",
            transcriptEvidence: {
                byteLength: bytes.byteLength,
                terminalEntryId: null,
                digestHex: createHash("sha256").update(bytes).digest("hex"),
            },
        });
        assertEquals(recovered.activation?.state, "idle");
        assertEquals(recovered.generation?.generation, 0);
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("existing-generation recovery blocks a rewritten committed prefix", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "safe-prefix");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "safe-prefix",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const original = await readFile(transcriptPath);
        let proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "initial-writer",
            ownerProcessKind: "test",
            expectedGeneration: null,
        });
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        store.publishGenerationAndRelease(proof, {
            generation: 0,
            byteLength: original.byteLength,
            terminalEntryId: null,
            digestHex: createHash("sha256").update(original).digest("hex"),
        });
        const interrupted = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "interrupted-writer",
            ownerProcessKind: "test",
            expectedGeneration: 0,
        });
        store.markSessionUncertain(interrupted, { reason: "writer stopped before checkpoint" });

        const rewrittenText = (await readFile(transcriptPath, "utf8")).replace("safe-prefix", "evil-prefix");
        await writeFile(transcriptPath, rewrittenText);
        const rewritten = await readFile(transcriptPath);
        assertThrows(
            () =>
                store.recoverSessionControl({
                    runwieldSessionId: session.runwieldSessionId,
                    projectId: project.projectId,
                    expectedFence: interrupted.fence,
                    expectedGeneration: 0,
                    ownerInstanceId: "recovery",
                    ownerProcessKind: "test",
                    transcriptEvidence: {
                        byteLength: rewritten.byteLength,
                        terminalEntryId: null,
                        digestHex: createHash("sha256").update(rewritten).digest("hex"),
                    },
                }),
            Error,
            "baseline changed",
        );
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

/** @param {string} path */
async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

test("Plan Association manifest projection commits with the published generation", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "plan-associated");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "plan-associated",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        let proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "owner",
            ownerProcessKind: "test",
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
        assert(segment);
        /** @type {import('./plan-association.ts').PlanAssociation} */
        const association = {
            planId: "plan-1",
            planName: "example-plan",
            purpose: "planning",
            segmentId: segment.segmentId,
            segmentKind: "planning",
            recordedAt: TIMESTAMP,
        };
        assertEquals(store.stagePlanAssociation(proof, association), { ...association, committedGeneration: null });
        assertEquals(store.listSessionPlanAssociations(session.runwieldSessionId), []);
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        const bytes = await readFile(transcriptPath);
        store.publishGenerationAndRelease(proof, {
            generation: 0,
            byteLength: bytes.byteLength,
            terminalEntryId: null,
            digestHex: createHash("sha256").update(bytes).digest("hex"),
        });
        assertEquals(store.listSessionPlanAssociations(session.runwieldSessionId), [
            { ...association, committedGeneration: 0 },
        ]);
        store.close();

        const reopened = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertEquals(reopened.listSessionPlanAssociations(session.runwieldSessionId), [
            { ...association, committedGeneration: 0 },
        ]);
        reopened.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("Plan Association manifest projection drops pending entries on unchanged release", async () => {
    const fixture = await makeFixture();
    try {
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "plan-pending");
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "plan-pending",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        const proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "owner",
            ownerProcessKind: "test",
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
        assert(segment);
        store.stagePlanAssociation(proof, {
            planId: "plan-1",
            planName: "example-plan",
            purpose: "planning",
            segmentId: segment.segmentId,
            segmentKind: "planning",
            recordedAt: TIMESTAMP,
        });
        store.releaseUnchangedActivation(proof);
        assertEquals(store.listSessionPlanAssociations(session.runwieldSessionId), []);
        store.close();
    } finally {
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("Session archive survives reopen and restores transcript segments and Plan associations", async () => {
    const fixture = await makeFixture();
    let store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
    try {
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "archive-root");
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "archive-root",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
        });
        let proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "archive-test",
            ownerProcessKind: "test",
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
        assert(segment);
        store.stagePlanAssociation(proof, {
            planId: "archive-plan",
            planName: "archive-plan",
            purpose: "planning",
            segmentId: segment.segmentId,
            segmentKind: "planning",
            recordedAt: TIMESTAMP,
        });
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        const bytes = await readFile(transcriptPath);
        store.publishGenerationAndRelease(proof, {
            generation: 0,
            byteLength: bytes.length,
            terminalEntryId: null,
            digestHex: createHash("sha256").update(bytes).digest("hex"),
        });
        const segments = store.listSessionTranscriptSegments(session.runwieldSessionId);
        const associations = store.listSessionPlanAssociations(session.runwieldSessionId);
        const generation = store.inspectSessionActivation(session.runwieldSessionId).generation;
        const archived = store.archiveSession(session.runwieldSessionId, project.projectId);
        assert(archived.archivedAt);
        assertEquals(store.archiveSession(session.runwieldSessionId).archivedAt, archived.archivedAt);
        store.close();
        store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertEquals(store.getSessionById(session.runwieldSessionId)?.archivedAt, archived.archivedAt);
        assertEquals((await store.listProjectSessions(project.projectId)).sessions, []);
        assertEquals((await store.listProjectSessions(project.projectId, { archiveState: "archived" })).total, 1);
        assertEquals(store.unarchiveSession(session.runwieldSessionId).archivedAt, null);
        assertEquals(store.unarchiveSession(session.runwieldSessionId).runwieldSessionId, session.runwieldSessionId);
        assertEquals((await store.listProjectSessions(project.projectId)).total, 1);
        assertEquals(store.listSessionTranscriptSegments(session.runwieldSessionId), segments);
        assertEquals(store.listSessionPlanAssociations(session.runwieldSessionId), associations);
        assertEquals(store.inspectSessionActivation(session.runwieldSessionId).generation, generation);
        assertEquals(await readFile(transcriptPath), bytes);
    } finally {
        store.close();
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("Session archive refuses the writer lock and keeps a newer committed generation", async () => {
    const fixture = await makeFixture();
    const writer = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
    const archiver = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
    try {
        const project = writer.ensureRuntimeProject({ root: fixture.projectRoot });
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "locked-archive");
        const session = await writer.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "locked-archive",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
        });
        archiver.getSessionById(session.runwieldSessionId);
        const file = openNativeFileLock(lockPath(fixture.sessionDir, session.runwieldSessionId));
        try {
            assertEquals(file.tryLockSync(true), true);
            assertThrows(() => archiver.archiveSession(session.runwieldSessionId), Error, "another RunWield surface");
            assertEquals(archiver.getSessionById(session.runwieldSessionId)?.archivedAt, null);
        } finally {
            file.unlockSync();
            file.close();
        }

        let proof = writer.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "writer",
            ownerProcessKind: "test",
        });
        assertThrows(() => archiver.archiveSession(session.runwieldSessionId), Error, "another RunWield surface");
        assertThrows(() => writer.archiveSession(session.runwieldSessionId), Error, "another RunWield surface");
        proof = writer.changeSessionActivationPhase(proof, "hydrated");
        proof = writer.changeSessionActivationPhase(proof, "checkpointing");
        const bytes = await readFile(transcriptPath);
        const published = writer.publishGenerationAndRelease(proof, {
            generation: 0,
            byteLength: bytes.length,
            terminalEntryId: null,
            digestHex: createHash("sha256").update(bytes).digest("hex"),
        });
        archiver.archiveSession(session.runwieldSessionId);
        assertEquals(archiver.inspectSessionActivation(session.runwieldSessionId).generation, published.generation);
        assertThrows(() => archiver.unarchiveSession(session.runwieldSessionId, "foreign-project"));
    } finally {
        writer.close();
        archiver.close();
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("Session archive filters apply before pagination and totals", async () => {
    const fixture = await makeFixture();
    const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
    try {
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        for (let index = 0; index < 6; index++) {
            await writeTranscript(
                fixture.sessionDir,
                fixture.projectRoot,
                `archive-page-${index}`,
                null,
                new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            );
        }
        const all = await store.listProjectSessions(project.projectId, { all: true });
        for (const session of all.sessions.filter((_, index) => index % 2 === 0)) {
            store.archiveSession(session.runwieldSessionId);
        }
        for (const archivedView of [false, true]) {
            const archiveState = archivedView ? "archived" : "active";
            const first = await store.listProjectSessions(project.projectId, { archiveState, pageSize: 2 });
            const second = await store.listProjectSessions(project.projectId, { archiveState, pageSize: 2, page: 1 });
            assertEquals(first.total, 3);
            assertEquals(second.total, 3);
            assertEquals(first.sessions.length, 2);
            assertEquals(second.sessions.length, 1);
            assertEquals(first.hasNext, true);
            assertEquals(second.hasNext, false);
            assertEquals(
                [...first.sessions, ...second.sessions].map((item) => Boolean(item.archivedAt)),
                [archiveState === "archived", archiveState === "archived", archiveState === "archived"],
            );
        }
        assertEquals((await store.listProjectSessions(project.projectId, { archiveState: "all", all: true })).total, 6);
    } finally {
        store.close();
        await rm(fixture.rootDir, { recursive: true });
    }
});

test("Session archive is retained when the primary manifest is recovered from its descriptor", async () => {
    const fixture = await makeFixture();
    let store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
    try {
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        await writeTranscript(fixture.sessionDir, fixture.projectRoot, "archive-recovery");
        const session = (await store.listProjectSessions(project.projectId)).sessions[0];
        const archived = store.archiveSession(session.runwieldSessionId);
        store.close();
        await rm(manifestPath(fixture.sessionDir, session.runwieldSessionId));
        store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        assertEquals(store.getSessionById(session.runwieldSessionId)?.archivedAt, archived.archivedAt);
        assertEquals((await store.listProjectSessions(project.projectId)).total, 0);
    } finally {
        store.close();
        await rm(fixture.rootDir, { recursive: true });
    }
});

for (const changed of [false, true]) {
    test(`Session archive recovers abandoned activation with ${changed ? "changed" : "unchanged"} evidence`, async () => {
        const fixture = await makeFixture();
        const writer = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const archiver = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        try {
            const project = writer.ensureRuntimeProject({ root: fixture.projectRoot });
            const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "abandoned-archive");
            const session = await writer.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: "abandoned-archive",
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
            });
            writer.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "abandoned",
                ownerProcessKind: "test",
            });
            if (changed) await writeFile(transcriptPath, "changed evidence\n", { flag: "a" });
            writer.close();
            if (changed) {
                assertThrows(() => archiver.archiveSession(session.runwieldSessionId), Error, "requires recovery");
                assertEquals(archiver.getSessionById(session.runwieldSessionId)?.archivedAt, null);
                assertEquals(
                    archiver.inspectSessionActivation(session.runwieldSessionId).activation?.state,
                    "reconcile_required",
                );
            } else {
                assert(archiver.archiveSession(session.runwieldSessionId).archivedAt);
                assertEquals(
                    archiver.inspectSessionActivation(session.runwieldSessionId).activation?.state,
                    "uninitialized",
                );
            }
        } finally {
            writer.close();
            archiver.close();
            await rm(fixture.rootDir, { recursive: true });
        }
    });
}
