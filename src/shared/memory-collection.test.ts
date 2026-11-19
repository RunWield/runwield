import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { assertEquals } from "../testing/assertions.ts";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { resolveMemoryCollection } from "./memory-collection.ts";

const fixture = defineCommittedGitFixture();

test("Memory keeps the main checkout collection name", async () => {
    const root = await fixture.checkout();
    try {
        assertEquals(await resolveMemoryCollection({ cwd: root }), basename(root));
    } finally {
        await rm(root, { recursive: true });
    }
});

test("Memory uses the main checkout collection from a worktree or subfolder", async () => {
    const root = await fixture.checkout();
    const temp = await mkdtemp(join(tmpdir(), "memory-collection-"));
    const worktree = join(temp, "feature-worktree");
    try {
        await git(root, ["worktree", "add", "-b", "feature", worktree]);
        const subfolder = join(worktree, "nested");
        await mkdir(subfolder);
        assertEquals(await resolveMemoryCollection({ cwd: worktree }), basename(root));
        assertEquals(await resolveMemoryCollection({ cwd: subfolder }), basename(root));
    } finally {
        await rm(temp, { recursive: true });
        await rm(root, { recursive: true });
    }
});

test("Memory keeps the folder name outside Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-collection-"));
    try {
        assertEquals(await resolveMemoryCollection({ cwd: root }), basename(root));
    } finally {
        await rm(root, { recursive: true });
    }
});

test("Memory reserves global for global scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-collection-"));
    const folder = join(root, "global");
    try {
        await mkdir(folder);
        assertEquals(await resolveMemoryCollection({ cwd: folder }), "default");
    } finally {
        await rm(root, { recursive: true });
    }
});

test("Memory uses the bound remote collection without inspecting the server", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-collection-"));
    try {
        assertEquals(
            await resolveMemoryCollection({ cwd: root, boundCollection: "project@host-1234" }),
            "project@host-1234",
        );
    } finally {
        await rm(root, { recursive: true });
    }
});
