import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { listOwnerProjects } from "../../ui/workspace/server/owner-projects.ts";
import type { RemoteHostIdentity, RemoteTarget } from "../remote/target.ts";
import type { FileSessionManifest } from "./file-session-store-types.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import {
    ensureRemoteProject,
    listProjectsFromDisk,
    manifestPath,
    readJson,
    sessionDirForProject,
    writeManifest,
} from "./file-session-storage.ts";
import { findPlanAssociatedSessions } from "./plan-session-lookup.ts";
import { classifyRootSessionLocator } from "./root-session.js";

const host: RemoteHostIdentity = {
    hostname: "remote.example",
    user: "developer",
    port: 22,
    hostKeyFingerprint: "SHA256:remote",
};

function target(root: string): RemoteTarget {
    return {
        cwd: root,
        home: "/home/developer",
        os: "Linux",
        arch: "x86_64",
        gitRoot: null,
        gitDir: null,
        gitCommonDir: null,
        primaryRoot: null,
        isWorktree: false,
    };
}

async function makeFixture() {
    const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "local-project-visibility-" }));
    const baseDir = join(root, "sessions");
    const store = openFileSessionStore({ baseDir });
    const local = store.ensureRuntimeProject({ root });
    // The same root string on another host must not change local identity.
    const remote = ensureRemoteProject(baseDir, host, target(root));
    const missingRemote = ensureRemoteProject(baseDir, host, target(join(root, "remote-only")));
    const localDir = sessionDirForProject(baseDir, local);
    const transcriptPath = join(localDir, "2026-01-01T00-00-00-000Z_local-pi.jsonl");
    const timestamp = "2026-01-01T00:00:00.000Z";
    await Deno.writeTextFile(
        transcriptPath,
        JSON.stringify({ type: "session", version: 3, id: "local-pi", timestamp, cwd: root }) + "\n",
    );
    const session = await store.ensureSessionCatalogRecord({
        projectId: local.projectId,
        piSessionId: "local-pi",
        transcriptPath,
        transcriptCwd: root,
    });
    // Build persisted remote evidence with the real storage writer. Local runtime
    // catalog APIs deliberately cannot register a remote transcript.
    const remoteDir = sessionDirForProject(baseDir, remote);
    const remoteTranscript = join(remoteDir, "2026-01-01T00-00-00-000Z_remote-pi.jsonl");
    await Deno.writeTextFile(
        remoteTranscript,
        JSON.stringify({ type: "session", version: 3, id: "remote-pi", timestamp, cwd: root }) + "\n",
    );
    const manifest = readJson<FileSessionManifest>(manifestPath(localDir, session.runwieldSessionId));
    manifest.runwieldSessionId = "remote-session";
    manifest.projectId = remote.projectId;
    manifest.currentSegmentId = "remote-segment";
    manifest.segments = manifest.segments.map((segment) => ({
        ...segment,
        segmentId: "remote-segment",
        runwieldSessionId: "remote-session",
        projectId: remote.projectId,
        piSessionId: "remote-pi",
        transcriptPath: remoteTranscript,
    }));
    manifest.planAssociations = [{
        planId: "remote-plan",
        planName: "remote-plan",
        purpose: "planning",
        segmentId: "remote-segment",
        segmentKind: "planning",
        recordedAt: timestamp,
        committedGeneration: 1,
    }];
    writeManifest(manifest, manifestPath(remoteDir, "remote-session"));
    return {
        root,
        baseDir,
        store,
        local,
        remote,
        missingRemote,
        session,
        remoteTranscript,
        async close() {
            store.close();
            await Deno.remove(root, { recursive: true });
        },
    };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function withFixture(test: (fixture: Fixture) => Promise<void> | void) {
    const fixture = await makeFixture();
    try {
        await test(fixture);
    } finally {
        await fixture.close();
    }
}

for (const method of ["listSessionProjects", "listProjects"] as const) {
    Deno.test(`${method} exposes only local Projects and preserves raw remote records`, async () => {
        await withFixture(({ store, baseDir, local, remote, missingRemote }) => {
            assertEquals(store[method](), [local]);
            assertEquals(
                new Set(listProjectsFromDisk(baseDir).map((project) => project.projectId)),
                new Set([local.projectId, remote.projectId, missingRemote.projectId]),
            );
        });
    });
}

Deno.test("local project lookup and root evidence hide a remote locator", async () => {
    await withFixture(({ store, local, remote }) => {
        assertEquals(store.getProjectById(local.projectId), local);
        assertEquals(store.getProjectById(remote.projectId), null);
        assertEquals(store.listProjectRootEvidence(remote.projectId), []);
    });
});

for (const key of ["remote", "missingRemote"] as const) {
    Deno.test(`local root access rejects ${key} before laptop filesystem lookup`, async () => {
        await withFixture((fixture) => {
            assertThrows(
                () => fixture.store.requireSessionProjectRoot(fixture[key].projectId),
                Error,
                "Session project is unavailable",
            );
            assertEquals(fixture.store.requireSessionProjectRoot(fixture.local.projectId), fixture.root);
        });
    });
}

for (const catalog of [true, false]) {
    Deno.test(`local Session listing hides remote manifests with catalog=${catalog}`, async () => {
        await withFixture(async ({ store, local, remote, missingRemote }) => {
            assertEquals((await store.listProjectSessions(local.projectId, { catalog })).total, 1);
            for (const project of [remote, missingRemote]) {
                const listed = await store.listProjectSessions(project.projectId, { catalog });
                assertEquals(listed.sessions, []);
                assertEquals(listed.total, 0);
                assertEquals(listed.diagnostics, []);
            }
        });
    });
}

Deno.test("local Session ID lookup hides remote Sessions", async () => {
    await withFixture(({ store, local, remote, session }) => {
        assertEquals(store.getSessionById(session.runwieldSessionId)?.projectId, local.projectId);
        assertEquals(store.getSessionById("remote-session"), null);
        assertEquals(store.getSessionById("remote-session", remote.projectId), null);
    });
});

Deno.test("local Pi Session locator lookup hides remote Sessions", async () => {
    await withFixture(({ store, local, remote }) => {
        assertEquals(store.findSessionByLocator({ piSessionId: "local-pi" })?.projectId, local.projectId);
        assertEquals(store.findSessionByLocator({ piSessionId: "remote-pi" }), null);
        assertEquals(store.findSessionByLocator({ piSessionId: "remote-pi", projectId: remote.projectId }), null);
    });
});

Deno.test("local transcript locator lookup hides remote Sessions", async () => {
    await withFixture(({ store, session, remoteTranscript }) => {
        assertEquals(
            store.findSessionByLocator({ transcriptPath: session.transcriptPath })?.projectId,
            session.projectId,
        );
        assertEquals(store.findSessionByLocator({ transcriptPath: remoteTranscript }), null);
    });
});

Deno.test("local resume classification ignores a remote Project with the same root", async () => {
    await withFixture(async ({ store, root, local }) => {
        assertEquals(
            (await classifyRootSessionLocator({ cwd: root, ownerCoordinationStore: store })).project?.projectId,
            local.projectId,
        );
    });
});

Deno.test("load-plan association lookup excludes remote planning evidence", async () => {
    await withFixture(async ({ store, root }) => {
        assertEquals(await findPlanAssociatedSessions(store, { cwd: root, planId: "remote-plan" }), []);
    });
});

Deno.test("Workspace project scans do not discover remote file Session Projects", async () => {
    await withFixture(({ root, baseDir, remote }) => {
        const owner = openOwnerCoordinationStore({ dbPath: join(root, "owner.sqlite3"), sessionBaseDir: baseDir });
        try {
            assertEquals(listOwnerProjects(owner), []);
            assertEquals(owner.listSessionProjects().some((project) => project.projectId === remote.projectId), false);
            assertEquals(owner.getProjectById(remote.projectId), null);
        } finally {
            owner.close();
        }
    });
});
