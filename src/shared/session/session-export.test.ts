import { test } from "node:test";
import { deepStrictEqual as equal, ok as assert, rejects } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { SessionHost } from "./session-host.ts";
import { SessionRuntime, createSessionRuntime } from "./session-runtime.ts";
import { createRootSessionManager, openPersistedRootSession, resolveCreatedRootSessionPath } from "./root-session.js";
import { captureTranscriptEvidence } from "./session-transcript-projection.js";
import type { TranscriptEntry } from "./session-transcript-manifest.ts";

async function withExportHome(run: (home: string, cwd: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env.HOME;
        const home = await mkdtemp(join(tmpdir(), "session-export-"));
        const cwd = join(home, "project");
        await mkdir(cwd);
        process.env.HOME = home;
        try {
            await run(home, cwd);
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            await rm(home, { recursive: true, force: true });
        }
    });
}

async function createExportFixture(home: string, cwd: string) {
    const store = openOwnerCoordinationStore({ dbPath: join(home, "owner.sqlite3") });
    const project = store.registerProject({ root: cwd });
    const manager = await createRootSessionManager("new", cwd);
    manager.appendSessionInfo("Complete export");
    manager.appendMessage({ role: "user", timestamp: Date.now(), content: "plan the export" });
    manager.appendMessage(fauxAssistantMessage("planned"));
    manager.appendCustomEntry("runwield.export_fixture", { retained: ["raw", 42, null] });
    const transcriptPath = await resolveCreatedRootSessionPath(cwd, manager);
    const session = await store.ensureSessionCatalogRecord({
        projectId: project.projectId,
        piSessionId: manager.getSessionId(),
        transcriptPath,
        transcriptCwd: cwd,
        source: "created",
    });
    const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
    assert(segment);
    let proof = store.acquireSessionActivation({
        runwieldSessionId: session.runwieldSessionId,
        projectId: project.projectId,
        ownerInstanceId: "export-test",
        ownerProcessKind: "test",
        phase: "preparing",
    });
    proof = store.changeSessionActivationPhase(proof, "hydrated");
    store.registerSessionArtifact(proof, {
        kind: "report",
        path: "report.md",
        title: "Export report",
        registeredBy: "test",
    });
    store.stagePlanAssociation(proof, {
        planId: "export-plan",
        planName: "complete-export",
        purpose: "planning",
        segmentId: segment.segmentId,
        segmentKind: "planning",
        recordedAt: "2026-01-01T00:00:00.000Z",
    });
    proof = store.changeSessionActivationPhase(proof, "checkpointing");
    store.publishGenerationAndRelease(proof, {
        ...(await captureTranscriptEvidence({ transcriptPath, transcriptCwd: cwd })),
        generation: 0,
        currentSegmentId: segment.segmentId,
    });
    const host = new SessionHost();
    const runtime = new SessionRuntime({
        sessionHost: host,
        sessionStore: store,
        ownerProcessKind: "test",
        ownerInstanceId: "export-test",
    });
    const adopted = runtime.adoptManagedSession({ session, generation: 0 });
    const rollover = await runtime.rollManagedSessionSegment(adopted.sessionId, {
        kind: "execution",
        continuation: { next: "engineer" },
    });
    let successorProof = store.acquireSessionActivation({
        runwieldSessionId: session.runwieldSessionId,
        projectId: project.projectId,
        ownerInstanceId: "export-test",
        ownerProcessKind: "test",
        expectedGeneration: rollover.generation,
        expectedCurrentSegmentId: rollover.successorSegmentId,
        phase: "preparing",
    });
    successorProof = store.changeSessionActivationPhase(successorProof, "hydrated");
    const { sessionManager: successor } = await openPersistedRootSession({
        cwd,
        sessionId: rollover.piSessionId,
        sessionPath: rollover.transcriptPath,
    });
    // Exceed the normal projection page size. Export must keep the entire timeline.
    for (let index = 0; index < 205; index++) {
        successor.appendCustomEntry("runwield.backend_status", { backend: "cli", message: `status ${index}` });
    }
    successor.appendMessage(fauxAssistantMessage("implemented"));
    successorProof = store.changeSessionActivationPhase(successorProof, "checkpointing");
    store.publishGenerationAndRelease(successorProof, {
        ...(await captureTranscriptEvidence({ transcriptPath: rollover.transcriptPath, transcriptCwd: cwd })),
        generation: rollover.generation + 1,
        currentSegmentId: rollover.successorSegmentId,
    });
    return { store, runtime, host, sessionId: adopted.sessionId, session, rollover };
}

type ExportFixture = Awaited<ReturnType<typeof createExportFixture>>;

async function closeFixture(fixture: ExportFixture): Promise<void> {
    await fixture.runtime.closeAllSessions();
    fixture.store.close();
}

async function readRawEntries(path: string): Promise<TranscriptEntry[]> {
    return (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
}

async function snapshotFile(path: string) {
    return { bytes: await readFile(path, "utf8"), mtimeMs: (await stat(path)).mtimeMs };
}

test("exports every committed segment, raw entry, Manifest fact, and timeline page", async () => {
    await withExportHome(async (home, cwd) => {
        const fixture = await createExportFixture(home, cwd);
        try {
            const exported = await fixture.runtime.readSessionExport(fixture.sessionId);
            const { document, timeline } = exported;
            equal(document.format, "runwield.session-export");
            equal(document.version, 1);
            assert(Number.isFinite(Date.parse(document.exportedAt)));
            equal(
                document.segments.map(({ ordinal, kind, sealed, current }) => ({ ordinal, kind, sealed, current })),
                [
                    { ordinal: 0, kind: "planning", sealed: true, current: false },
                    { ordinal: 1, kind: "execution", sealed: false, current: true },
                ],
            );
            equal(
                document.segments.map((segment) => segment.label),
                ["Planning segment 1", "Execution segment 2"],
            );
            const stored = fixture.store.getSessionById(fixture.session.runwieldSessionId);
            assert(stored);
            equal(document.session, {
                runwieldSessionId: stored.runwieldSessionId,
                name: stored.displayName || "Complete export",
                cwd: stored.transcriptCwd,
                createdAt: stored.firstCatalogedAt,
                updatedAt: stored.lastCatalogedAt,
            });
            equal(document.session.name, "Complete export");
            equal(document.artifacts, fixture.store.listSessionArtifacts(stored.runwieldSessionId));
            equal(document.artifacts.length, 1);
            equal(document.planAssociations, fixture.store.listSessionPlanAssociations(stored.runwieldSessionId));
            equal(document.planAssociations.length, 1);
            const segments = fixture.store.listSessionTranscriptSegments(stored.runwieldSessionId);
            for (let index = 0; index < segments.length; index++) {
                equal(document.segments[index].entries, await readRawEntries(segments[index].transcriptPath));
                equal(document.segments[index].piSessionId, segments[index].piSessionId);
                equal(document.segments[index].entries[0].type, "session");
            }
            assert(JSON.stringify(document.segments[0].entries).includes("plan the export"));
            assert(JSON.stringify(document.segments[0].entries).includes("runwield.export_fixture"));
            assert(JSON.stringify(document.segments[1].entries).includes("implemented"));
            assert(timeline.length > 200);
            assert(
                timeline.some(
                    (event) =>
                        event.type === "user_message" && event.text === "plan the export" && event.segmentOrdinal === 0,
                ),
            );
            assert(
                timeline.some(
                    (event) =>
                        event.type === "assistant_text_delta" &&
                        event.delta === "implemented" &&
                        event.segmentOrdinal === 1,
                ),
            );
        } finally {
            await closeFixture(fixture);
        }
    });
});

async function snapshotSessionFiles(home: string) {
    const root = join(home, ".wld", "sessions");
    const paths = (await readdir(root, { recursive: true })).sort();
    const files = await Promise.all(
        paths.map(async (path) => {
            const absolutePath = join(root, path);
            if (!(await stat(absolutePath)).isFile()) return null;
            return { path, ...(await snapshotFile(absolutePath)) };
        }),
    );
    return files.filter((file) => file !== null);
}

for (const target of ["sealed", "current"] as const) {
    test(`rejects ${target} segment digest tampering without changing the bundle`, async () => {
        await withExportHome(async (home, cwd) => {
            const fixture = await createExportFixture(home, cwd);
            try {
                const path = target === "sealed" ? fixture.session.transcriptPath : fixture.rollover.transcriptPath;
                const original = await readFile(path, "utf8");
                const tampered =
                    target === "sealed"
                        ? original.replace("planned", "changed")
                        : original.replace("implemented", "tampered!!!");
                equal(tampered.length, original.length);
                await writeFile(path, tampered);
                const before = await snapshotSessionFiles(home);
                const catalogBefore = fixture.store.getSessionById(fixture.session.runwieldSessionId);
                await rejects(
                    fixture.runtime.readSessionExport(fixture.sessionId),
                    /Committed transcript projection is unavailable/,
                );
                equal(await snapshotSessionFiles(home), before);
                equal(fixture.store.getSessionById(fixture.session.runwieldSessionId), catalogBefore);
            } finally {
                await closeFixture(fixture);
            }
        });
    });
}

test("a live managed Session exports committed history, not its writable branch", async () => {
    await withExportHome(async (home, cwd) => {
        const fixture = await createExportFixture(home, cwd);
        const liveHost = new SessionHost();
        const liveRuntime = new SessionRuntime({
            sessionHost: liveHost,
            sessionStore: fixture.store,
            ownerProcessKind: "test",
            ownerInstanceId: "live-export",
        });
        const managed = fixture.host.requireSession(fixture.sessionId).getManagedMetadata();
        assert(managed);
        const proof = fixture.store.acquireSessionActivation({
            runwieldSessionId: managed.runwieldSessionId,
            projectId: managed.projectId,
            ownerInstanceId: "live-export",
            ownerProcessKind: "test",
            phase: "preparing",
        });
        try {
            const expected = await fixture.runtime.readSessionExport(fixture.sessionId);
            const { sessionManager } = await openPersistedRootSession({
                cwd,
                sessionPath: fixture.rollover.transcriptPath,
                sessionId: fixture.rollover.piSessionId,
            });
            sessionManager.appendMessage({ role: "user", timestamp: Date.now(), content: "uncommitted live text" });
            const live = liveHost.createSession({ cwd, sessionManager, managed });
            const before = await snapshotFile(fixture.rollover.transcriptPath);
            const exported = await liveRuntime.readSessionExport(live.id);
            equal(exported.document.segments, expected.document.segments);
            assert(!JSON.stringify(exported).includes("uncommitted live text"));
            equal(await snapshotFile(fixture.rollover.transcriptPath), before);
        } finally {
            fixture.store.markSessionUncertain(proof, { reason: "Discard active test writer" });
            await liveRuntime.closeAllSessions();
            await closeFixture(fixture);
        }
    });
});

test("a fresh interactive shell exports a Session header without creating persistence", async () => {
    await withExportHome(async (home, cwd) => {
        const runtime = createSessionRuntime({ sessionStore: null });
        try {
            const created = await runtime.createInteractiveSession({
                cwd,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            const before = await readdir(home);
            const exported = await runtime.readSessionExport(created.sessionId);
            equal(exported.document.session.runwieldSessionId, null);
            equal(exported.document.session.cwd, cwd);
            equal(exported.document.segments.length, 1);
            const segment = exported.document.segments[0];
            equal(segment.kind, "session");
            equal(segment.entries.length, 1);
            const header = segment.entries[0];
            assert(header.type === "session");
            equal(header.id, segment.piSessionId);
            equal(header.cwd, cwd);
            assert(Number.isFinite(Date.parse(header.timestamp)));
            equal(exported.timeline, []);
            equal(await readdir(home), before);
            equal(runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, null);
        } finally {
            await runtime.closeAllSessions();
        }
    });
});

test("an unmanaged Pi Session exports its original header and live branch", async () => {
    await withExportHome(async (_home, cwd) => {
        const host = new SessionHost();
        const runtime = new SessionRuntime({
            sessionHost: host,
            sessionStore: null,
            ownerProcessKind: "test",
            ownerInstanceId: "unmanaged-export",
        });
        const manager = SessionManager.inMemory(cwd);
        manager.appendMessage({ role: "user", timestamp: Date.now(), content: "unsaved branch" });
        const hosted = host.createSession({ cwd, sessionManager: manager });
        try {
            const exported = await runtime.readSessionExport(hosted.id);
            equal(exported.document.segments[0].entries, [manager.getHeader(), ...manager.getBranch()]);
            assert(exported.timeline.some((event) => event.type === "user_message" && event.text === "unsaved branch"));
        } finally {
            await runtime.closeAllSessions();
        }
    });
});

for (const tampered of [false, true]) {
    test(`export ${tampered ? "failure" : "success"} does not recover an abandoned writer or change bundle files`, async () => {
        await withExportHome(async (home, cwd) => {
            const fixture = await createExportFixture(home, cwd);
            try {
                fixture.store.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.session.projectId,
                    ownerInstanceId: "abandoned-export",
                    ownerProcessKind: "test",
                    phase: "preparing",
                });
                fixture.store.close(); // Process exit releases the lock, not the saved activation.
                if (tampered) {
                    const path = fixture.session.transcriptPath;
                    await writeFile(path, (await readFile(path, "utf8")).replace("planned", "changed"));
                }
                const before = await snapshotSessionFiles(home);
                if (tampered) await rejects(fixture.runtime.readSessionExport(fixture.sessionId));
                else equal((await fixture.runtime.readSessionExport(fixture.sessionId)).document.segments.length, 2);
                equal(await snapshotSessionFiles(home), before);
                equal(
                    fixture.store.readSessionManifest(fixture.session.runwieldSessionId, fixture.session.projectId)
                        ?.activation.state,
                    "active",
                );
            } finally {
                await closeFixture(fixture);
            }
        });
    });
}

test("export does not restore a missing primary Manifest from its recovery descriptors", async () => {
    await withExportHome(async (home, cwd) => {
        const fixture = await createExportFixture(home, cwd);
        const root = join(home, ".wld", "sessions");
        const files = await snapshotSessionFiles(home);
        const manifest = files.find((file) => file.path.endsWith("/manifest.json"));
        assert(manifest);
        const path = join(root, manifest.path);
        await rename(path, `${path}.removed`);
        try {
            const before = await snapshotSessionFiles(home);
            await rejects(fixture.runtime.readSessionExport(fixture.sessionId));
            equal(await snapshotSessionFiles(home), before);
        } finally {
            await rename(`${path}.removed`, path);
            await closeFixture(fixture);
        }
    });
});
