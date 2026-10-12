import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import type { RemoteHostIdentity, RemoteTarget } from "../remote/target.ts";
import {
    ensureProject,
    ensureRemoteProject,
    listProjectsFromDisk,
    sessionDirForProject,
} from "./file-session-storage.ts";

const host: RemoteHostIdentity = {
    hostname: "first.example",
    user: "developer",
    port: 22,
    hostKeyFingerprint: "SHA256:first",
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

async function withStore(test: (baseDir: string, root: string) => void): Promise<void> {
    const root = await Deno.realPath(await Deno.makeTempDir());
    try {
        test(join(root, "sessions"), root);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
}

Deno.test("remote project registration and lookup never require a laptop directory for the remote root", async () => {
    await withStore((baseDir) => {
        const remote = target(`/remote-only-${crypto.randomUUID()}/project`);
        const project = ensureRemoteProject(baseDir, host, remote);
        assertEquals(project.remote, { host, root: remote.cwd });
        assertEquals(ensureRemoteProject(baseDir, host, remote), project);
        assertEquals(listProjectsFromDisk(baseDir), [project]);
        assertEquals(sessionDirForProject(baseDir, project), join(baseDir, project.projectId));
    });
});

Deno.test("same-named remote folders are scoped by every host identity field", async () => {
    await withStore((baseDir) => {
        const remote = target("/home/developer/project");
        const project = ensureRemoteProject(baseDir, host, remote);
        for (
            const changed of [
                { ...host, hostname: "second.example" },
                { ...host, user: "other" },
                { ...host, port: 2222 },
                { ...host, hostKeyFingerprint: "SHA256:second" },
            ]
        ) assertNotEquals(ensureRemoteProject(baseDir, changed, remote).projectId, project.projectId);
        assertEquals(ensureRemoteProject(baseDir, { ...host }, remote).projectId, project.projectId);
        assertNotEquals(
            ensureRemoteProject(baseDir, host, target("/home/developer/other")).projectId,
            project.projectId,
        );
    });
});

Deno.test("a remote linked worktree shares the primary project identity without changing its execution cwd", async () => {
    await withStore((baseDir) => {
        const primary = target("/home/developer/project");
        primary.gitRoot = primary.cwd;
        primary.primaryRoot = primary.cwd;
        const worktree = {
            ...primary,
            cwd: "/home/developer/worktree",
            gitRoot: "/home/developer/worktree",
            isWorktree: true,
        };
        assertEquals(
            ensureRemoteProject(baseDir, host, worktree).projectId,
            ensureRemoteProject(baseDir, host, primary).projectId,
        );
        assertEquals(worktree.cwd, "/home/developer/worktree");
        const withoutPrimary = { ...worktree, primaryRoot: null };
        assertEquals(ensureRemoteProject(baseDir, host, withoutPrimary).remote?.root, worktree.gitRoot);
    });
});

Deno.test("a remote project cannot adopt a local project with the same root string", async () => {
    await withStore((baseDir, root) => {
        const remote = ensureRemoteProject(baseDir, host, target(root));
        const local = ensureProject(baseDir, root);
        assertNotEquals(local.projectId, remote.projectId);
        assertEquals(local.remote, undefined);
        assertEquals(ensureProject(baseDir, root).projectId, local.projectId);
    });
});
