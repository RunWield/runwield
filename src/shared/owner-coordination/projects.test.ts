import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { env, execPath } from "node:process";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    realpath as fsRealpath,
    rename as fsRename,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { openOwnerCoordinationDatabase } from "./database.ts";
import { openOwnerCoordinationStore } from "./index.ts";
import { DirectoryConfirmationRequired, parseProjectId, projects, type ProjectLaunchContext } from "@runwield/projects";
import { bindProjectRegistry } from "@runwield/projects/owner-coordination";
import { manifestPath } from "@runwield/session-files";
import { classifyRootSessionLocator } from "../session/root-session.ts";
import { getOwnerCoordinationDatabasePath } from "@runwield/resources/owner-database";
import { DatabaseSync } from "@runwield/resources/sqlite";

test("legacy registrations converge on their admitted Project ID and preserve dependent data", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-identity-migration-"));
    const dbPath = join(dir, "owner.sqlite3");
    const root = join(dir, "primary");
    const alias = join(dir, "alias");
    await fsMkdir(root);
    await fsSymlink(root, alias, "junction");
    try {
        const admitted = await projects.checkout.admit(root);
        if (admitted.kind !== "existing") throw new Error(`Unexpected checkout identity: ${admitted.kind}`);
        const canonicalId = admitted.identity.projectId;
        const oldId = crypto.randomUUID();
        const oldAliasId = parseProjectId(crypto.randomUUID())!;
        const canonicalRoot = await fsRealpath(root);
        const database = openOwnerCoordinationDatabase({ dbPath });
        try {
            const db = database.handle;
            db.exec(`
                DROP INDEX idx_projects_canonical_project_id;
                ALTER TABLE projects DROP COLUMN canonical_project_id;
                ALTER TABLE project_roots DROP COLUMN display_name;
                DELETE FROM schema_migrations WHERE version >= 11;
            `);
            const addProject = db.prepare(
                `INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at, disabled_at)
                 VALUES (?, ?, ?, ?, 'disabled', ?, 't2', 't2')`,
            );
            addProject.run(oldId, "Migration fixture", root, canonicalRoot, "t0");
            addProject.run(oldAliasId, "Alias fixture", alias, canonicalRoot, "t1");
            const addRoot = db.prepare(
                `INSERT INTO project_roots(id, project_id, entered_root, canonical_root, root_state, created_at)
                 VALUES (?, ?, ?, ?, 'current', 't0')`,
            );
            addRoot.run("primary", oldId, root, canonicalRoot);
            addRoot.run("alias", oldAliasId, alias, canonicalRoot);
            db.prepare(
                "INSERT INTO runwield_sessions(id, project_id, created_at, updated_at) VALUES ('session', ?, 't1', 't1')",
            ).run(oldAliasId);
            db.prepare(
                `INSERT INTO owner_session_operations(id, request_id, request_hash, runwield_session_id, project_id,
                                                      kind, status, operation_id, started_at, updated_at)
                 VALUES ('receipt', 'request', 'hash', 'session', ?, 'continuation', 'completed', 'operation', 't1', 't2')`,
            ).run(oldAliasId);
        } finally {
            database.close();
        }
        const owner = openOwnerCoordinationStore({ dbPath });
        const observer = new DatabaseSync(dbPath, { readOnly: true });
        const bindings = () =>
            observer
                .prepare("SELECT canonical_project_id FROM projects ORDER BY id")
                .all()
                .map((row) => row.canonical_project_id);
        try {
            assertEquals(bindings(), [null, null]);
            const { projects: registry } = owner;
            assertEquals(
                registry.list().map((item) => [item.projectId, item.displayName, item.status, item.inactiveAt]),
                [[canonicalId, "Migration fixture", "inactive", "t2"]],
            );
            assertEquals(registry.get(oldId), null);
            assertEquals(registry.get(oldAliasId), null);
            assertThrows(() => registry.setStatus(oldAliasId, "active"), Error, "not found");
            assertEquals(registry.get(canonicalId)?.currentRoot, canonicalRoot);
            assertEquals(registry.getHealth(canonicalId).status, "available");
            assertThrows(() => registry.requireActiveRoot(canonicalId), Error, "inactive");
            assertEquals(
                registry
                    .listRootEvidence(canonicalId)
                    .map(({ enteredRoot, displayName }) => [enteredRoot, displayName])
                    .sort(),
                [
                    [root, "Migration fixture"],
                    [alias, "Alias fixture"],
                ].sort(),
            );
            assertEquals(owner.getOperationReceipt("operation")?.projectId, canonicalId);
            assertEquals(
                owner.findOperationReceiptByRequest({
                    projectId: canonicalId,
                    requestHash: "hash",
                    requestId: "request",
                })?.operationId,
                "operation",
            );
            assertEquals(
                owner.findOperationReceiptByRequest({
                    projectId: oldAliasId,
                    requestHash: "hash",
                    requestId: "request",
                }),
                null,
            );
            assertEquals(bindings(), [null, null]);
            assertEquals(registry.register({ root: alias }).projectId, canonicalId);
            assertEquals(bindings(), [canonicalId, canonicalId]);
            assertEquals(registry.setStatus(canonicalId, "active").status, "active");
            registry.remove(canonicalId);
            assertEquals(registry.list(), []);
            assertEquals(owner.getOperationReceipt("operation"), null);
        } finally {
            observer.close();
            owner.close();
        }
        assertEquals((await fsStat(root)).isDirectory(), true);
        const reopened = openOwnerCoordinationDatabase({ dbPath });
        try {
            assertEquals(reopened.handle.prepare("PRAGMA foreign_key_check").all(), []);
            assertEquals(reopened.handle.prepare("SELECT COUNT(*) AS count FROM runwield_sessions").get()?.count, 0);
        } finally {
            reopened.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("the public registry shares the owner database and preserves a Plan-less registration across relink", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-public-registry-"));
    const originalRoot = join(dir, "first");
    const newRoot = join(dir, "second");
    await fsMkdir(originalRoot);
    const owner = openOwnerCoordinationStore();
    const registry = projects.registrations.open();
    try {
        const pairing = owner.createPairingRequest();
        const registration = owner.projects.register({ root: originalRoot });
        const admitted = projects.checkout.inspect(originalRoot);
        assertEquals(
            admitted.kind === "existing" ? admitted.identity.projectId : admitted.kind,
            registration.projectId,
        );
        assertEquals(registry.get(registration.projectId), registration);
        assertEquals(registry.list(), [registration]);
        assertEquals(await fsReaddir(originalRoot), [".wld-project.json"]);

        await fsRename(originalRoot, newRoot);
        const relinked = registry.relink({ projectId: registration.projectId, newRoot });
        assertEquals(relinked.projectId, registration.projectId);
        const newIdentity = projects.checkout.inspect(newRoot);
        assertEquals(
            newIdentity.kind === "existing" ? newIdentity.identity.projectId : newIdentity.kind,
            registration.projectId,
        );
        assertEquals(owner.projects.list(), [relinked]);
        assertEquals(owner.projects.get(registration.projectId), relinked);
        assertEquals(owner.getPairingRequestByProof(pairing.proof)?.state, "pending");
        assertEquals(await fsReaddir(newRoot), [".wld-project.json"]);
    } finally {
        registry.close();
        owner.close();
        await fsRm(dir, { recursive: true });
    }
});

test("a scoped registry and Workspace open the same account database and isolate its existing and new registrations", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-account-registry-"));
    const account = join(dir, "account");
    const alias = join(dir, "account-alias");
    const otherAccount = join(dir, "other-account");
    const processRoot = join(dir, "process-root");
    const existingRoot = join(dir, "scoped-existing-root");
    const newRoot = join(dir, "scoped-new-root");
    for (const path of [account, otherAccount, processRoot, existingRoot, newRoot]) await fsMkdir(path);
    await fsSymlink(account, alias, "junction");
    const physical = await fsRealpath(account);
    const directory = await fsStat(physical);
    const context: ProjectLaunchContext = {
        executionAccountHome: physical,
        configuredExecutionAccountHome: alias,
        accountHomeDirectory: { device: directory.dev, inode: directory.ino },
        personalOwner: { kind: "managed-remote", identity: "trusted-scoped-owner" },
    };
    const dbPath = getOwnerCoordinationDatabasePath({ home: physical });
    const olderDb = openOwnerCoordinationDatabase({ dbPath });
    const outsideRegistry = projects.registrations.open();
    try {
        const olderRegistration = bindProjectRegistry(olderDb).register({ root: existingRoot });
        const outsideRegistration = outsideRegistry.register({ root: processRoot });
        const scopedRegistry = await projects.launch.withContext(context, () =>
            Promise.resolve(projects.registrations.open()),
        );
        let scopedId: string;
        try {
            assertEquals(scopedRegistry.list(), [olderRegistration]);
            assertEquals(scopedRegistry.get(outsideRegistration.projectId), null);
            assertThrows(() => scopedRegistry.register({ root: physical }), DirectoryConfirmationRequired);

            const registered = scopedRegistry.register({ root: newRoot });
            scopedId = registered.projectId;
            assertEquals(await fsReaddir(newRoot), [".wld-project.json"]);

            await projects.launch.withContext(context, async () => {
                const workspace = openOwnerCoordinationStore();
                try {
                    assertEquals(workspace.path, dbPath);
                    assertEquals(workspace.projects.get(registered.projectId), registered);
                    assertEquals(workspace.projects.get(olderRegistration.projectId), olderRegistration);

                    await fsRm(alias);
                    await fsSymlink(otherAccount, alias, "junction");
                    assertThrows(() => scopedRegistry.list(), Error, "execution account home changed");
                    assertThrows(() => projects.registrations.open(), Error, "execution account home changed");
                    assertThrows(() => openOwnerCoordinationStore(), Error, "execution account home changed");
                } finally {
                    workspace.close();
                }
            });
        } finally {
            scopedRegistry.close();
        }

        assertEquals(outsideRegistry.get(outsideRegistration.projectId), outsideRegistration);
        assertEquals(outsideRegistry.get(olderRegistration.projectId), null);
        assertEquals(outsideRegistry.get(scopedId), null);
        assertEquals(bindProjectRegistry(olderDb).list().length, 2);
        assertEquals(await fsReaddir(otherAccount), []);
    } finally {
        olderDb.close();
        outsideRegistry.close();
        await fsRm(dir, { recursive: true });
    }
});

test("a retargeted HOME ancestor blocks registry writes and leaves Session files in the original account", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-account-retarget-"));
    const accountsDir = join(dir, ".wld", "sessions-backup");
    const firstParent = join(accountsDir, "first");
    const secondParent = join(accountsDir, "second");
    const alias = join(accountsDir, "parent-alias");
    const scopedHome = join(alias, "home");
    const root = join(dir, "project");
    await fsMkdir(join(firstParent, "home"), { recursive: true });
    await fsMkdir(join(secondParent, "home"), { recursive: true });
    await fsMkdir(root);
    await fsSymlink(firstParent, alias, "junction");
    try {
        const workspace = await projects.launch.withContext(
            {
                executionAccountHome: scopedHome,
                personalOwner: { kind: "execution-account", identity: scopedHome },
            },
            () => Promise.resolve(openOwnerCoordinationStore()),
        );
        const registry = workspace.projects;
        try {
            const registered = registry.register({ root });
            assertEquals(registry.list(), [registered]);
            const sessionProject = workspace.ensureRuntimeProject({ root });
            const piSessionId = "legacy-home-alias";
            const sessionDir = join(
                scopedHome,
                ".wld",
                "sessions",
                projects.directory.sessionKey(await fsRealpath(root)),
            );
            const transcriptPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`);
            await fsMkdir(sessionDir, { recursive: true });
            await fsWriteFile(transcriptPath, `${JSON.stringify({ type: "session", id: piSessionId, cwd: root })}\n`);
            const session = await workspace.ensureSessionCatalogRecord({
                projectId: sessionProject.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: root,
            });
            assertEquals(session.transcriptPath, transcriptPath);
            const physicalTranscript = await fsRealpath(transcriptPath);
            await fsRm(manifestPath(dirname(physicalTranscript), session.runwieldSessionId));
            for (const path of [physicalTranscript, transcriptPath]) {
                const found = workspace.findSessionByLocator({ transcriptPath: path });
                assertEquals(found?.runwieldSessionId, session.runwieldSessionId);
                assertEquals(found?.transcriptPath, transcriptPath);
                const classified = await classifyRootSessionLocator({
                    cwd: root,
                    sessionPath: path,
                    ownerCoordinationStore: workspace,
                });
                assertEquals(classified.kind, "managed", classified.reason);
                assertEquals(classified.session?.transcriptPath, transcriptPath);
            }
            const proof = workspace.acquireSessionActivation({
                projectId: sessionProject.projectId,
                runwieldSessionId: session.runwieldSessionId,
                ownerInstanceId: "legacy-home-alias",
                ownerProcessKind: "test",
                phase: "turning",
                expectedGeneration: null,
            });
            const before = workspace.readActiveSessionTranscript(proof);
            const next = `${before}${JSON.stringify({ type: "model_change", id: "model" })}\n`;
            const expectedDigest = createHash("sha256").update(before).digest("hex");
            const { digestHex } = workspace.writeActiveSessionTranscript(proof, next, expectedDigest);
            assertEquals(workspace.readActiveSessionTranscript(proof), next);
            await fsRm(alias);
            await fsSymlink(secondParent, alias, "junction");
            assertThrows(() => registry.get(registered.projectId), Error, "execution account home changed");
            assertThrows(() => registry.register({ root }), Error, "execution account home changed");
            assertThrows(
                () => workspace.writeActiveSessionTranscript(proof, next, digestHex),
                Error,
                "different execution account home",
            );
            assertEquals(workspace.ensureRuntimeProject({ root }).projectId, sessionProject.projectId);
            assertEquals(
                workspace.listSessionProjects().map((project) => project.projectId),
                [sessionProject.projectId],
            );
            assertEquals(await fsReaddir(join(secondParent, "home")), []);
        } finally {
            workspace.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("raw database keeps the unset HOME fallback while Workspace and Session stores require a valid account", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-no-home-"));
    const script = `
        import assert from "node:assert/strict";
        import { openOwnerCoordinationDatabase } from ${JSON.stringify(import.meta.resolve("@runwield/resources/owner-database"))};
        import { openFileSessionStore } from ${JSON.stringify(new URL("../session/file-session-store.ts", import.meta.url).href)};
        import { projects } from ${JSON.stringify(import.meta.resolve("@runwield/projects"))};
        import { openOwnerCoordinationStore } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
        const required = /Explicit Project owner and execution account home are required/;
        openOwnerCoordinationDatabase().close();
        assert.throws(() => openOwnerCoordinationStore(), required);
        assert.throws(() => openFileSessionStore(), required);
        assert.throws(() => openFileSessionStore({ baseDir: "explicit" }), required);
        assert.throws(() => projects.registrations.open(), required);
        await assert.rejects(projects.launch.withContext({
            executionAccountHome: "",
            personalOwner: { kind: "managed-remote", identity: "malformed" },
        }, () => Promise.resolve(openOwnerCoordinationStore())), required);
    `;
    try {
        const child = spawn(execPath, ["-e", script], {
            cwd: dir,
            env: { ...env, HOME: "", USERPROFILE: "", HOMEDRIVE: "", HOMEPATH: "", LOCALAPPDATA: "" },
            stdio: "inherit",
        });
        assertEquals(await once(child, "exit"), [0, null]);
        assertEquals((await fsStat(join(dir, "~", ".wld", "owner-coordination.sqlite3"))).isFile(), true);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
