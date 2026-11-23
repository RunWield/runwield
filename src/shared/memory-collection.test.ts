import { mkdir, mkdtemp, rename, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projects, ProjectIdentityEntryRequired } from "@runwield/projects";
import { assertEquals } from "../testing/assertions.ts";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { inspectMemoryCollection, resolveMemoryCollection } from "./memory-collection.ts";

const fixture = defineCommittedGitFixture();

async function admit(root: string) {
    const result = await projects.checkout.admit(root);
    if (result.kind !== "existing") throw new ProjectIdentityEntryRequired(result);
    return result.identity.projectId;
}

test("Memory uses the admitted Project ID in the primary checkout, worktree, and subfolder", async () => {
    const root = await fixture.checkout();
    const temp = await mkdtemp(join(tmpdir(), "memory-collection-"));
    const worktree = join(temp, "feature-worktree");
    try {
        const projectId = await admit(root);
        await git(root, ["worktree", "add", "-b", "feature", worktree]);
        await admit(worktree);
        const subfolder = join(worktree, "nested");
        await mkdir(subfolder);
        for (const cwd of [root, worktree, subfolder]) assertEquals(await resolveMemoryCollection({ cwd }), projectId);
    } finally {
        await rm(temp, { recursive: true });
        await rm(root, { recursive: true });
    }
});

test("Memory lookup stays passive before admission and follows a moved non-Git Project", async () => {
    const parent = await mkdtemp(join(tmpdir(), "memory-collection-"));
    const root = join(parent, "global");
    const moved = join(parent, "moved");
    try {
        await mkdir(root);
        assertEquals(inspectMemoryCollection(root), null);
        assertEquals(await readdir(root), []);
        const projectId = await resolveMemoryCollection({ cwd: root });
        assertEquals(inspectMemoryCollection(root), projectId);
        await rename(root, moved);
        assertEquals(await resolveMemoryCollection({ cwd: moved }), projectId);
    } finally {
        await rm(parent, { recursive: true });
    }
});

test("Memory uses an explicitly bound legacy collection without inspecting the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-collection-"));
    try {
        assertEquals(
            await resolveMemoryCollection({ cwd: join(root, "missing"), boundCollection: "legacy-project" }),
            "legacy-project",
        );
    } finally {
        await rm(root, { recursive: true });
    }
});
