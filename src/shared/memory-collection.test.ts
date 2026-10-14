import { assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { resolveMemoryCollection } from "./memory-collection.ts";

const fixture = defineCommittedGitFixture();

Deno.test("Memory keeps the main checkout collection name", async () => {
    const root = await fixture.checkout();
    try {
        assertEquals(await resolveMemoryCollection({ cwd: root }), basename(root));
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Memory uses the main checkout collection from a worktree or subfolder", async () => {
    const root = await fixture.checkout();
    const temp = await Deno.makeTempDir();
    const worktree = join(temp, "feature-worktree");
    try {
        await git(root, ["worktree", "add", "-b", "feature", worktree]);
        const subfolder = join(worktree, "nested");
        await Deno.mkdir(subfolder);
        assertEquals(await resolveMemoryCollection({ cwd: worktree }), basename(root));
        assertEquals(await resolveMemoryCollection({ cwd: subfolder }), basename(root));
    } finally {
        await Deno.remove(temp, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Memory keeps the folder name outside Git", async () => {
    const root = await Deno.makeTempDir();
    try {
        assertEquals(await resolveMemoryCollection({ cwd: root }), basename(root));
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Memory reserves global for global scope", async () => {
    const root = await Deno.makeTempDir();
    const folder = join(root, "global");
    try {
        await Deno.mkdir(folder);
        assertEquals(await resolveMemoryCollection({ cwd: folder }), "default");
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Memory uses the bound remote collection without inspecting the server", async () => {
    const root = await Deno.makeTempDir();
    try {
        assertEquals(
            await resolveMemoryCollection({ cwd: root, boundCollection: "project@host-1234" }),
            "project@host-1234",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
