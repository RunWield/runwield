import { assertEquals, assertRejects } from "../testing/assertions.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareProjectCheckout, resolveProjectRoot, resolvePrimaryCheckoutRoot } from "./project-checkout.ts";
import { defineGitFixture, git } from "./git-test-fixture.ts";

const repo = defineGitFixture(async (repoPath) => {
    await writeFile(join(repoPath, "README.md"), "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

test("resolvePrimaryCheckoutRoot redirects a linked worktree to the primary checkout", async () => {
    const cwd = await repo.checkout();
    const worktreePath = `${cwd}-linked`;
    try {
        await git(cwd, ["worktree", "add", "-b", "side", worktreePath, "main"]);
        assertEquals(resolvePrimaryCheckoutRoot(worktreePath), await realpath(cwd));
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await rm(cwd, { recursive: true }).catch(() => {});
    }
});

test("resolvePrimaryCheckoutRoot leaves primary, subdirectory, and non-git roots unchanged", async () => {
    const cwd = await repo.checkout();
    const subdir = join(cwd, "subdir");
    const nonGit = await mkdtemp(join(tmpdir(), "rw-test-"));
    try {
        await mkdir(subdir);
        assertEquals(resolvePrimaryCheckoutRoot(cwd), cwd);
        assertEquals(resolvePrimaryCheckoutRoot(subdir), subdir);
        assertEquals(resolvePrimaryCheckoutRoot(nonGit), nonGit);
    } finally {
        await rm(cwd, { recursive: true }).catch(() => {});
        await rm(nonGit, { recursive: true }).catch(() => {});
    }
});

test("Epic child recovery repairs moved submodule links and preserves unfinished work", async () => {
    const root = await repo.checkout();
    const moduleRoot = await repo.checkout();
    const nestedRoot = await repo.checkout();
    const container = await mkdtemp(join(tmpdir(), "runwield-moved-submodules-"));
    const oldRoot = join(container, "old", "deep", "project");
    const movedRoot = join(container, "moved");
    const child = join(container, "child");
    try {
        await git(moduleRoot, ["-c", "protocol.file.allow=always", "submodule", "add", nestedRoot, "nested"]);
        await git(moduleRoot, ["commit", "-am", "nested submodule"]);
        await mkdir(join(container, "old", "deep"), { recursive: true });
        await rename(root, oldRoot);
        await git(oldRoot, ["-c", "protocol.file.allow=always", "submodule", "add", moduleRoot, "vendor/demo module"]);
        await git(oldRoot, ["commit", "-am", "add submodule"]);
        await git(oldRoot, ["worktree", "add", "-b", "epic-child", child]);
        await git(child, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
        const module = join(child, "vendor/demo module");
        const nested = join(module, "nested");
        await writeFile(join(module, "README.md"), "unfinished child work\n");
        await writeFile(join(nested, "README.md"), "unfinished nested work\n");
        const head = await git(child, ["rev-parse", "HEAD"]);
        const index = await readFile(await git(child, ["rev-parse", "--git-path", "index"]));
        const oldModuleGitDir = await git(module, ["rev-parse", "--absolute-git-dir"]);
        await rename(oldRoot, movedRoot);
        await symlink(movedRoot, oldRoot, "dir");
        assertEquals(resolveProjectRoot(oldRoot), await realpath(movedRoot));
        await assertRejects(() => git(child, ["status", "--porcelain"]), Error, "cannot chdir");
        const moduleGitDir = await realpath(oldModuleGitDir);
        const config = join(moduleGitDir, "config");
        const before = await readFile(config, "utf8");
        const { inspectProjectRuntimeReadAccess } = await import("./project-runtime-layout.ts");
        await inspectProjectRuntimeReadAccess(child);
        assertEquals(await readFile(config, "utf8"), before);
        const { confirmRecoveryWorktreeAvailable } = await import("../cmd/load-plan/plan-recovery-worktree.ts");
        const messages: string[] = [];
        const ui: Partial<import("../ui/tui/api.ts").UiAPI> = {
            appendSystemMessage: (message) => messages.push(message),
        };
        assertEquals(
            await confirmRecoveryWorktreeAvailable(
                movedRoot,
                "epic/child",
                { path: child, branch: "epic-child", status: "completed" },
                ui as import("../ui/tui/api.ts").UiAPI,
            ),
            true,
        );
        assertEquals(messages, []);
        assertEquals(await git(child, ["rev-parse", "HEAD"]), head);
        assertEquals(await readFile(await git(child, ["rev-parse", "--git-path", "index"])), index);
        assertEquals(await readFile(join(module, "README.md"), "utf8"), "unfinished child work\n");
        assertEquals(await readFile(join(nested, "README.md"), "utf8"), "unfinished nested work\n");
        assertEquals((await git(child, ["status", "--porcelain"])).includes("vendor/demo module"), true);
        const repaired = await readFile(config, "utf8");
        await prepareProjectCheckout(child);
        assertEquals(await readFile(config, "utf8"), repaired);
    } finally {
        await rm(container, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
        await rm(moduleRoot, { recursive: true, force: true });
        await rm(nestedRoot, { recursive: true, force: true });
    }
});

test("checkout repair preserves submodule metadata belonging to another existing checkout", async () => {
    const root = await repo.checkout();
    const moduleRoot = await repo.checkout();
    const other = await repo.checkout();
    try {
        await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", moduleRoot, "module"]);
        const gitDir = await git(join(root, "module"), ["rev-parse", "--absolute-git-dir"]);
        const config = join(gitDir, "config");
        await git(root, ["config", "--file", config, "core.worktree", other]);
        const before = await readFile(config, "utf8");
        await assertRejects(() => prepareProjectCheckout(root), Error, "another existing checkout");
        assertEquals(await readFile(config, "utf8"), before);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(moduleRoot, { recursive: true, force: true });
        await rm(other, { recursive: true, force: true });
    }
});
