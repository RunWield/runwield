import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { admitProjectIdentity, inspectProjectStorage } from "../project-identity.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { createRootSessionManager, resolveCreatedRootSessionPath, openPersistedRootSession } from "./root-session.js";
import { captureTranscriptEvidence } from "./session-transcript-projection.js";
import { listRecentResumableSessions } from "./session-resume-list.ts";
import { lockPath, manifestPath } from "./file-session-storage.ts";

const repository = defineCommittedGitFixture();
const storeModule = new URL("./file-session-store.ts", import.meta.url).href;
const rootModule = new URL("./root-session.js", import.meta.url).href;
const identityModule = new URL("../project-identity.ts", import.meta.url).href;
const resumeModule = new URL("./session-resume-list.ts", import.meta.url).href;
const projectionModule = new URL("./session-transcript-projection.js", import.meta.url).href;

async function withHome(body: (home: string) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "session-continuity-")));
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            await body(home);
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            await rm(home, { recursive: true, force: true });
        }
    });
}

async function seed(root: string, text = "Original history") {
    const store = openFileSessionStore();
    const project = store.ensureRuntimeProject({ root });
    const manager = await createRootSessionManager("new", root);
    manager.appendMessage({ role: "user", timestamp: Date.now(), content: [{ type: "text", text }] });
    manager.appendModelChange("anthropic", "preserved-model");
    const path = await resolveCreatedRootSessionPath(root, manager);
    const session = await store.ensureSessionCatalogRecord({
        projectId: project.projectId,
        piSessionId: manager.getSessionId(),
        transcriptCwd: root,
        transcriptPath: path,
    });
    const proof = store.acquireSessionActivation({
        runwieldSessionId: session.runwieldSessionId,
        projectId: session.projectId,
        ownerInstanceId: "seed",
        ownerProcessKind: "test",
        expectedGeneration: null,
        phase: "bootstrap",
    });
    const segment = store.getCurrentSessionSegment(session.runwieldSessionId)!;
    store.stagePlanAssociation(proof, {
        planId: "continuity-plan",
        planName: "continuity",
        purpose: "planning",
        segmentId: segment.segmentId,
        segmentKind: "planning",
        recordedAt: new Date().toISOString(),
    });
    const evidence = await captureTranscriptEvidence({ transcriptPath: path, transcriptCwd: root });
    store.publishGenerationAndRelease(store.changeSessionActivationPhase(proof, "checkpointing"), {
        generation: 0,
        byteLength: evidence.byteLength,
        digestHex: evidence.digestHex,
        terminalEntryId: evidence.terminalEntryId,
    });
    store.close();
    return { session, path, project, segment };
}

async function child(root: string, code: string, signal?: AbortSignal) {
    const result = await captureForegroundProcess(process.execPath, {
        cwd: root,
        args: ["-e", code],
        env: { HOME: process.env.HOME! },
        timeoutMs: 30000,
        signal,
    });
    equal(result.code, 0, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

for (const kind of ["Git", "non-Git"] as const) {
    test(`${kind} move discovers and appends the same Session in a fresh process without rewriting history`, async () => {
        await withHome(async (home) => {
            const root = kind === "Git" ? await repository.checkout() : join(home, "original");
            if (kind === "non-Git") await mkdir(root);
            const canonicalRoot = await realpath(root);
            const moved = `${canonicalRoot}-moved`;
            try {
                const saved = await seed(canonicalRoot);
                const prefix = await readFile(saved.path);
                equal((await admitProjectIdentity(root)).kind, "existing");
                const manifest = manifestPath(dirname(saved.path), saved.session.runwieldSessionId);
                const lock = lockPath(dirname(saved.path), saved.session.runwieldSessionId);
                const lockInode = (await stat(lock)).ino;
                await rename(canonicalRoot, moved);
                const output = await child(
                    moved,
                    `
                    import { admitProjectIdentity } from ${JSON.stringify(identityModule)};
                    import { openFileSessionStore } from ${JSON.stringify(storeModule)};
                    import { listRecentResumableSessions } from ${JSON.stringify(resumeModule)};
                    import { openPersistedRootSession } from ${JSON.stringify(rootModule)};
                    import { captureTranscriptEvidence } from ${JSON.stringify(projectionModule)};
                    const root = ${JSON.stringify(moved)};
                    const admission = await admitProjectIdentity(root);
                    if (admission.kind !== 'existing') throw Error(JSON.stringify(admission));
                    const store = openFileSessionStore();
                    const listed = await listRecentResumableSessions(root, store);
                    if (listed.length !== 1) throw Error('Expected one Session: ' + JSON.stringify(listed));
                    const session = store.findSessionByLocator({ transcriptPath: listed[0].path });
                    const proof = store.acquireSessionActivation({ runwieldSessionId: session.runwieldSessionId, projectId: session.projectId, ownerInstanceId: 'child', ownerProcessKind: 'test', expectedGeneration: 0, phase: 'preparing' });
                    const { sessionManager, resolved } = await openPersistedRootSession({ cwd: root, sessionId: session.piSessionId, sessionPath: session.transcriptPath });
                    if (resolved.cwd !== root || sessionManager.getCwd() !== root) throw Error('Tool cwd did not move');
                    sessionManager.appendMessage({ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: 'Continued after move' }] });
                    const evidence = await captureTranscriptEvidence({ transcriptPath: session.transcriptPath, transcriptCwd: session.transcriptCwd });
                    store.publishGenerationAndRelease(store.changeSessionActivationPhase(store.changeSessionActivationPhase(proof, 'hydrated'), 'checkpointing'), { generation: 1, byteLength: evidence.byteLength, digestHex: evidence.digestHex, terminalEntryId: evidence.terminalEntryId });
                    console.log(JSON.stringify({ id: session.runwieldSessionId, path: session.transcriptPath, projectId: session.projectId, associations: store.listSessionPlanAssociations(session.runwieldSessionId).length }));
                    store.close();
                `,
                );
                deepEqual(JSON.parse(output), {
                    id: saved.session.runwieldSessionId,
                    path: saved.path,
                    projectId: saved.project.projectId,
                    associations: 1,
                });
                const after = await readFile(saved.path);
                ok(after.subarray(0, prefix.length).equals(prefix));
                equal(after.toString().split("Continued after move").length - 1, 1);
                equal((await stat(lock)).ino, lockInode);
                const store = openFileSessionStore();
                equal(
                    store.readSessionManifest(saved.session.runwieldSessionId, saved.project.projectId)?.generation
                        ?.generation,
                    1,
                );
                ok(await stat(manifest));
                throws(
                    () =>
                        store.acquireSessionActivation({
                            runwieldSessionId: saved.session.runwieldSessionId,
                            projectId: saved.project.projectId,
                            expectedGeneration: 0,
                            ownerInstanceId: "stale",
                            ownerProcessKind: "test",
                        }),
                    /generation changed/,
                );
                store.close();
            } finally {
                await rm(root, { recursive: true, force: true });
                await rm(moved, { recursive: true, force: true });
            }
        });
    });
}

test("accepted clones share both original stores while pending and declined clones remain isolated", async () => {
    await withHome(async (home) => {
        const source = await repository.checkout();
        const one = join(home, "one"),
            two = join(home, "two"),
            three = join(home, "three");
        try {
            for (const root of [one, two, three]) await git(source, ["clone", source, root]);
            const first = await seed(one, "First clone");
            const second = await seed(two, "Second clone");
            const identity = await admitProjectIdentity(one);
            ok(identity.kind === "existing");
            const pending = await admitProjectIdentity(two);
            ok(pending.kind === "pending");
            const store = openFileSessionStore();
            equal((await listRecentResumableSessions(two, store)).length, 1);
            equal(
                (await admitProjectIdentity(three, { choice: { kind: "new", candidates: pending.candidates } })).kind,
                "existing",
            );
            equal((await listRecentResumableSessions(three, store)).length, 0);
            const refreshed = await admitProjectIdentity(two);
            ok(refreshed.kind === "pending");
            equal(
                (
                    await admitProjectIdentity(two, {
                        choice: {
                            kind: "link",
                            projectId: identity.identity.projectId,
                            candidates: refreshed.candidates,
                        },
                    })
                ).kind,
                "existing",
            );
            deepEqual(
                (await listRecentResumableSessions(two, store)).map((item) => item.path).sort(),
                [first.path, second.path].sort(),
            );
            deepEqual(
                (await store.listProjectSessions(second.project.projectId, { catalog: false })).sessions
                    .map((item) => item.runwieldSessionId)
                    .sort(),
                [first.session.runwieldSessionId, second.session.runwieldSessionId].sort(),
            );
            equal(
                store.getSessionById(first.session.runwieldSessionId, second.project.projectId)?.projectId,
                first.project.projectId,
            );
            const opened = await openPersistedRootSession({
                cwd: two,
                sessionId: first.session.piSessionId,
                sessionPath: first.path,
            });
            equal(opened.sessionManager.getCwd(), two);
            const foreign = store.ensureRuntimeProject({ root: three });
            equal(store.getSessionById(first.session.runwieldSessionId, foreign.projectId), null);
            store.close();
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });
});

test("move admission waits on the original process writer; restart and alias activation retain one lock", async () => {
    await withHome(async (home) => {
        const root = await realpath(await repository.checkout());
        const moved = `${root}-moved`;
        const alias = join(home, "alias");
        const ready = join(home, "writer-ready"),
            release = join(home, "writer-release");
        try {
            const saved = await seed(root);
            const admission = await admitProjectIdentity(root);
            ok(admission.kind === "existing");
            const recordFile = join(home, ".wld", "projects", admission.identity.projectId, "project.wld.json");
            const before = await readFile(recordFile, "utf8");
            const originalLock = lockPath(dirname(saved.path), saved.session.runwieldSessionId);
            const inode = (await stat(originalLock)).ino;
            const holder = child(
                root,
                `
                import { openFileSessionStore } from ${JSON.stringify(storeModule)};
                import { existsSync, writeFileSync } from 'node:fs';
                const store = openFileSessionStore();
                const proof = store.acquireSessionActivation({ runwieldSessionId: ${JSON.stringify(saved.session.runwieldSessionId)}, projectId: ${JSON.stringify(saved.project.projectId)}, ownerInstanceId: 'holder', ownerProcessKind: 'test', expectedGeneration: 0 });
                writeFileSync(${JSON.stringify(ready)}, 'ready');
                while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
                store.releaseUnchangedActivation(proof); store.close();
            `,
            );
            await waitForFile(ready);
            await rename(root, moved);
            const interruptedReady = join(home, "interrupted-entry-ready");
            const controller = new AbortController();
            const interrupted = child(
                moved,
                `
                import { admitProjectIdentity } from ${JSON.stringify(identityModule)};
                import { writeFileSync } from 'node:fs';
                writeFileSync(${JSON.stringify(interruptedReady)}, 'ready');
                await admitProjectIdentity(${JSON.stringify(moved)});
            `,
                controller.signal,
            );
            await waitForFile(interruptedReady);
            controller.abort();
            await rejects(interrupted, /abort|terminated/i);
            equal(await readFile(recordFile, "utf8"), before);
            let admitted = false;
            const entrant = child(
                moved,
                `import { admitProjectIdentity } from ${JSON.stringify(identityModule)}; const result = await admitProjectIdentity(${JSON.stringify(moved)}); if(result.kind !== 'existing') throw Error(JSON.stringify(result));`,
            ).then(() => {
                admitted = true;
            });
            // The writer remains held while admission has enough time to reach its native lock.
            await new Promise((resolve) => setTimeout(resolve, 150));
            equal(admitted, false);
            equal(await readFile(recordFile, "utf8"), before);
            await writeFile(release, "settle");
            await Promise.all([holder, entrant]);
            equal((await stat(originalLock)).ino, inode);
            await symlink(moved, alias, "dir");
            const store = openFileSessionStore();
            const proof = store.acquireSessionActivation({
                runwieldSessionId: saved.session.runwieldSessionId,
                projectId: saved.project.projectId,
                ownerInstanceId: "parent",
                ownerProcessKind: "test",
                expectedGeneration: 0,
            });
            const race = await child(
                alias,
                `
                import { openFileSessionStore } from ${JSON.stringify(storeModule)};
                const store = openFileSessionStore();
                const project = store.ensureRuntimeProject({root:${JSON.stringify(alias)}});
                try { store.acquireSessionActivation({ runwieldSessionId:${JSON.stringify(saved.session.runwieldSessionId)}, projectId:project.projectId, ownerInstanceId:'race',ownerProcessKind:'test',expectedGeneration:0 }); throw Error('second writer acquired'); }
                catch(error) { if(!String(error).includes('another RunWield surface')) throw error; console.log('one writer'); }
                finally { store.close(); }
            `,
            );
            equal(race, "one writer");
            store.releaseUnchangedActivation(proof);
            store.close();
        } finally {
            await writeFile(release, "settle");
            await rm(root, { recursive: true, force: true });
            await rm(moved, { recursive: true, force: true });
        }
    });
});

async function waitForFile(path: string) {
    for (let attempt = 0; attempt < 500; attempt++) {
        try {
            await stat(path);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw new Error(`Subprocess did not reach its synchronization point: ${path}`);
}

test("first-child identity metadata adopts old-root storage after a move and recovers the original manifest", async () => {
    await withHome(async (home) => {
        const root = await realpath(await repository.checkout()),
            moved = `${root}-moved`;
        try {
            const saved = await seed(root);
            const admitted = await admitProjectIdentity(root);
            ok(admitted.kind === "existing");
            const recordFile = join(home, ".wld", "projects", admitted.identity.projectId, "project.wld.json");
            const record = JSON.parse(await readFile(recordFile, "utf8"));
            delete record.storageLocators; // Exact first-child record format, before locator adoption.
            record.displayName = "Retained personal label";
            await writeFile(recordFile, JSON.stringify(record));
            await rename(root, moved);
            equal((await admitProjectIdentity(moved)).kind, "existing");
            const path = manifestPath(dirname(saved.path), saved.session.runwieldSessionId);
            await writeFile(path, "damaged manifest");
            const output = await child(
                moved,
                `import { openFileSessionStore } from ${JSON.stringify(storeModule)}; const store=openFileSessionStore(); const p=store.ensureRuntimeProject({root:${JSON.stringify(moved)}}); const s=store.getSessionById(${JSON.stringify(saved.session.runwieldSessionId)},p.projectId); console.log(s.transcriptPath); store.close();`,
            );
            equal(output, saved.path);
            equal(JSON.parse(await readFile(recordFile, "utf8")).displayName, "Retained personal label");
            equal(JSON.parse(await readFile(path, "utf8")).runwieldSessionId, saved.session.runwieldSessionId);
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(moved, { recursive: true, force: true });
        }
    });
});

test("missing established storage and a reused old root cannot create replacement or foreign history", async () => {
    await withHome(async () => {
        const root = await realpath(await repository.checkout()),
            moved = `${root}-moved`;
        try {
            const saved = await seed(root);
            equal((await admitProjectIdentity(root)).kind, "existing");
            await rename(root, moved);
            equal((await admitProjectIdentity(moved)).kind, "existing");
            await mkdir(root);
            const store = openFileSessionStore();
            throws(() => store.ensureRuntimeProject({ root }), /another Project identity/);
            await rejects(listRecentResumableSessions(root, store), /another Project identity/);
            const directory = dirname(saved.path);
            const detached = `${directory}-detached`;
            await rename(directory, detached);
            throws(() => store.ensureRuntimeProject({ root: moved }), /unavailable/);
            await rejects(stat(directory), /ENOENT/);
            store.close();
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(moved, { recursive: true, force: true });
        }
    });
});

test("runtime loading keeps tools in the selected checkout and settles into the same moved Session", async () => {
    await withHome(async () => {
        const root = await realpath(await repository.checkout()),
            moved = `${root}-moved`;
        try {
            const saved = await seed(root);
            equal((await admitProjectIdentity(root)).kind, "existing");
            await rename(root, moved);
            const runtimeModule = new URL("./session-runtime.ts", import.meta.url).href;
            const output = await child(
                moved,
                `
                import { admitProjectIdentity } from ${JSON.stringify(identityModule)};
                import { createSessionRuntime } from ${JSON.stringify(runtimeModule)};
                import { openFileSessionStore } from ${JSON.stringify(storeModule)};
                await admitProjectIdentity(${JSON.stringify(moved)});
                const store = openFileSessionStore();
                const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: 'test' });
                const loaded = await runtime.loadSession({ cwd: ${JSON.stringify(moved)}, sessionId: ${JSON.stringify(saved.session.piSessionId)}, sessionPath: ${JSON.stringify(saved.path)} });
                if (loaded.cwd !== ${JSON.stringify(moved)}) throw Error('Runtime uses historical cwd: '+loaded.cwd);
                const renamed = await runtime.renameSession(loaded.sessionId, 'Continued runtime');
                if (!renamed.ok) throw Error(JSON.stringify(renamed));
                console.log(store.inspectSessionActivation(${JSON.stringify(saved.session.runwieldSessionId)}).generation.generation);
                await runtime.closeSession(loaded.sessionId); store.close();
            `,
            );
            equal(output.split("\n").at(-1), "1");
            ok((await readFile(saved.path, "utf8")).includes("Continued runtime"));
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(moved, { recursive: true, force: true });
        }
    });
});

test("multi-segment history, archive state, Plan association and sealed bytes survive move and Core-ID lookup", async () => {
    await withHome(async () => {
        const root = await realpath(await repository.checkout()),
            moved = `${root}-moved`;
        try {
            const saved = await seed(root);
            const store = openFileSessionStore();
            const successor = await createRootSessionManager("new", root);
            successor.appendMessage({
                role: "user",
                timestamp: Date.now(),
                content: [{ type: "text", text: "Second segment" }],
            });
            const path = await resolveCreatedRootSessionPath(root, successor);
            const locator = {
                runwieldSessionId: saved.session.runwieldSessionId,
                projectId: saved.project.projectId,
                piSessionId: successor.getSessionId(),
                transcriptPath: path,
                transcriptCwd: root,
                kind: "planning" as const,
                lineageParentSegmentId: saved.segment.segmentId,
                lineageParentPiSessionId: saved.session.piSessionId,
            };
            const safe = await store.validateSuccessorSegmentLocator(locator);
            const predecessorEvidence = await captureTranscriptEvidence({
                transcriptPath: saved.path,
                transcriptCwd: root,
            });
            const generationEvidence = await captureTranscriptEvidence({ transcriptPath: path, transcriptCwd: root });
            const proof = store.acquireSessionActivation({
                runwieldSessionId: saved.session.runwieldSessionId,
                projectId: saved.project.projectId,
                ownerInstanceId: "rollover",
                ownerProcessKind: "test",
                expectedGeneration: 0,
                phase: "preparing",
            });
            store.commitSegmentRolloverAndPublish(
                store.changeSessionActivationPhase(
                    store.changeSessionActivationPhase(proof, "hydrated"),
                    "checkpointing",
                ),
                {
                    predecessorSegmentId: saved.segment.segmentId,
                    predecessorEvidence,
                    successor: locator,
                    successorSafeLocator: safe,
                    generationEvidence: { ...generationEvidence, generation: 1 },
                },
            );
            store.archiveSession(saved.session.runwieldSessionId, saved.project.projectId);
            const before = store.readSessionManifest(saved.session.runwieldSessionId, saved.project.projectId)!;
            const bytes = await readFile(saved.path);
            const admitted = await admitProjectIdentity(root);
            ok(admitted.kind === "existing");
            await rename(root, moved);
            equal((await admitProjectIdentity(moved)).kind, "existing");
            equal((await listRecentResumableSessions(moved, store)).length, 0);
            const byCore = store.getSessionById(saved.session.runwieldSessionId, admitted.identity.projectId);
            equal(byCore?.projectId, saved.project.projectId);
            deepEqual(store.readSessionManifest(saved.session.runwieldSessionId, saved.project.projectId), before);
            equal(
                (await store.listProjectSessions(admitted.identity.projectId, { archiveState: "all", catalog: false }))
                    .sessions.length,
                1,
            );
            store.unarchiveSession(saved.session.runwieldSessionId, admitted.identity.projectId);
            equal((await listRecentResumableSessions(moved, store)).length, 1);
            deepEqual(store.listSessionTranscriptSegments(saved.session.runwieldSessionId), before.segments);
            equal(store.listSessionPlanAssociations(saved.session.runwieldSessionId).length, 1);
            ok((await readFile(saved.path)).equals(bytes));
            store.close();
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(moved, { recursive: true, force: true });
        }
    });
});

test("committed binding reads are passive and corrupt locators cannot redirect history", async () => {
    await withHome(async (home) => {
        const root = await realpath(await repository.checkout());
        try {
            const saved = await seed(root);
            const admitted = await admitProjectIdentity(root);
            ok(admitted.kind === "existing");
            const recordFile = join(home, ".wld", "projects", admitted.identity.projectId, "project.wld.json");
            const record = await readFile(recordFile, "utf8");
            const before = await snapshot(join(home, ".wld"));
            const store = openFileSessionStore();
            equal(inspectProjectStorage(root).length, 1);
            equal(
                store.readSessionManifest(saved.session.runwieldSessionId, saved.project.projectId)?.runwieldSessionId,
                saved.session.runwieldSessionId,
            );
            equal((await listRecentResumableSessions(root, store)).length, 1);
            deepEqual(await snapshot(join(home, ".wld")), before);
            const damaged = JSON.parse(record);
            damaged.storageLocators[0].sessionDirectory = join(home, "unrelated-similar-name");
            await writeFile(recordFile, JSON.stringify(damaged));
            await rejects(listRecentResumableSessions(root, store), /Invalid Project storage locator/);
            equal(await readFile(recordFile, "utf8"), JSON.stringify(damaged));
            store.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

async function snapshot(root: string): Promise<string[]> {
    const entries: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) entries.push(...(await snapshot(path)));
        else {
            const info = await stat(path);
            entries.push(`${path}:${info.mtimeMs}:${(await readFile(path)).toString("base64")}`);
        }
    }
    return entries.sort();
}

test("a cached Session refuses conflicting stable-ID claims in another linked store", async () => {
    await withHome(async (home) => {
        const source = await repository.checkout(),
            one = join(home, "one"),
            two = join(home, "two");
        try {
            for (const root of [one, two]) await git(source, ["clone", source, root]);
            const first = await seed(one),
                second = await seed(two);
            const admitted = await admitProjectIdentity(one);
            ok(admitted.kind === "existing");
            const pending = await admitProjectIdentity(two);
            ok(pending.kind === "pending");
            equal(
                (
                    await admitProjectIdentity(two, {
                        choice: {
                            kind: "link",
                            candidates: pending.candidates,
                            projectId: admitted.identity.projectId,
                        },
                    })
                ).kind,
                "existing",
            );
            const store = openFileSessionStore();
            ok(store.getSessionById(first.session.runwieldSessionId, first.project.projectId));
            const duplicate = JSON.parse(
                await readFile(manifestPath(dirname(first.path), first.session.runwieldSessionId), "utf8"),
            );
            duplicate.projectId = second.project.projectId;
            const path = manifestPath(dirname(second.path), first.session.runwieldSessionId);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, JSON.stringify(duplicate));
            throws(
                () => store.getSessionById(first.session.runwieldSessionId, second.project.projectId),
                /Conflicting Session identity/,
            );
            const listed = await store.listProjectSessions(second.project.projectId, { catalog: false });
            ok(listed.diagnostics.some((item) => item.code === "locator_conflict"));
            ok(!listed.sessions.some((item) => item.runwieldSessionId === first.session.runwieldSessionId));
            store.close();
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });
});

test("linked worktrees share history once, while a retargeted alias and another owner cannot inherit it", async () => {
    await withHome(async (home) => {
        const root = await realpath(await repository.checkout()),
            linked = `${root}-linked`;
        const foreign = await repository.checkout(),
            alias = join(home, "alias"),
            otherHome = join(home, "other-owner");
        try {
            await git(root, ["worktree", "add", "-b", "continuity-linked", linked]);
            const first = await seed(root),
                second = await seed(linked);
            equal((await admitProjectIdentity(root)).kind, "existing");
            equal((await admitProjectIdentity(linked)).kind, "existing");
            await symlink(root, alias, "dir");
            const store = openFileSessionStore();
            deepEqual(
                (await listRecentResumableSessions(alias, store)).map((item) => item.path).sort(),
                [first.path, second.path].sort(),
            );
            equal((await admitProjectIdentity(alias)).kind, "existing");
            equal((await store.listProjectSessions(first.project.projectId, { catalog: false })).sessions.length, 2);
            await rm(alias);
            await symlink(foreign, alias, "dir");
            equal((await listRecentResumableSessions(alias, store)).length, 0);
            await mkdir(otherHome);
            deepEqual(
                inspectProjectStorage(root, {
                    context: {
                        executionAccountHome: otherHome,
                        personalOwner: { kind: "execution-account", identity: otherHome },
                    },
                }),
                [],
            );
            store.close();
        } finally {
            await rm(linked, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
            await rm(foreign, { recursive: true, force: true });
        }
    });
});
