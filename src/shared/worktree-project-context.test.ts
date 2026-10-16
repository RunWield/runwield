import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { git, makeRepo } from "./worktree-test-helpers.ts";
import { createWorktreeGitArtifacts, removeWorktreeGitArtifacts } from "./worktree.js";
import { ensureRunWieldOwnedGitignoreBlock, RUNWIELD_GITIGNORE_BLOCK } from "./runwield-owned-paths.ts";

async function write(root: string, path: string, content: string) {
    const fullPath = join(root, path);
    await fsMkdir(join(fullPath, ".."), { recursive: true });
    await fsWriteFile(fullPath, content);
}

test("new worktrees carry only setup context, preserve staging, and recreate the managed ignore block", async () => {
    const root = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await write(root, ".wld/settings.json", '{"verification_command":"printf verified"}\n');
        await write(root, "docs/domain-language.md", "# Domain Language\n\nInitial glossary.\n");
        await git(root, ["add", "docs/domain-language.md"]);
        await write(root, "docs/domain-language.md", "# Domain Language\n\nLatest glossary.\n");
        await write(root, "README.md", "Unrelated dirty work\n");
        await write(root, "unrelated.txt", "untracked\n");
        await write(root, ".gitignore", "unrelated-local-rule/\n");
        await ensureRunWieldOwnedGitignoreBlock(root);
        const status = await git(root, ["status", "--porcelain"]);
        const staged = await git(root, ["diff", "--cached"]);
        const head = await git(root, ["rev-parse", "HEAD"]);
        const entry = await createWorktreeGitArtifacts({
            projectRoot: root,
            planName: "context",
            planId: "context",
            worktreeRoot,
        });
        for (const path of [".wld/settings.json", "docs/domain-language.md"]) {
            assertEquals(await fsReadFile(join(entry.path, path), "utf8"), await fsReadFile(join(root, path), "utf8"));
        }
        assertEquals(await fsReadFile(join(entry.path, ".gitignore"), "utf8"), RUNWIELD_GITIGNORE_BLOCK);
        assertEquals(await fsReadFile(join(entry.path, "README.md"), "utf8"), "base\n");
        await assertRejects(() => fsStat(join(entry.path, "unrelated.txt")), Error, "ENOENT");
        assertEquals(await git(root, ["status", "--porcelain"]), status);
        assertEquals(await git(root, ["diff", "--cached"]), staged);
        assertEquals(await git(root, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(entry.path, ["rev-parse", "HEAD"]), head);
        await removeWorktreeGitArtifacts({ projectRoot: root, path: entry.path, force: true });
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true });
    }
});

test("context transfer merges compatible target changes and rejects conflicts before creating a worktree", async () => {
    const root = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const base = "# Domain Language\n\nFirst: original.\n\nMiddle paragraph.\n\nLast: original.\n";
        await write(root, "docs/domain-language.md", base);
        await git(root, ["add", "docs/domain-language.md"]);
        await git(root, ["commit", "-m", "context baseline"]);
        await git(root, ["checkout", "-b", "target"]);
        await write(root, "docs/domain-language.md", base.replace("First: original", "First: target"));
        await git(root, ["commit", "-am", "target context"]);
        await git(root, ["checkout", "main"]);
        await write(root, "docs/domain-language.md", base.replace("Last: original", "Last: init"));
        const entry = await createWorktreeGitArtifacts({
            projectRoot: root,
            planName: "merge-context",
            planId: "merge-context",
            worktreeRoot,
            baseRef: "target",
        });
        const merged = await fsReadFile(join(entry.path, "docs/domain-language.md"), "utf8");
        assertStringIncludes(merged, "First: target");
        assertStringIncludes(merged, "Last: init");
        await removeWorktreeGitArtifacts({ projectRoot: root, path: entry.path, force: true });
        await write(root, "docs/domain-language.md", base.replace("First: original", "First: conflicting init"));
        const worktrees = await git(root, ["worktree", "list", "--porcelain"]);
        const branches = await git(root, ["branch", "--list"]);
        await assertRejects(
            () =>
                createWorktreeGitArtifacts({
                    projectRoot: root,
                    planName: "conflict",
                    planId: "conflict",
                    worktreeRoot,
                    baseRef: "target",
                }),
            Error,
            "Uncommitted project context conflicts",
        );
        assertEquals(await git(root, ["worktree", "list", "--porcelain"]), worktrees);
        assertEquals(await git(root, ["branch", "--list"]), branches);
        assertStringIncludes(
            await fsReadFile(join(root, "docs/domain-language.md"), "utf8"),
            "First: conflicting init",
        );
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true });
    }
});

test("ignored setup files are carried but committed branch-specific context is not transplanted", async () => {
    const root = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await git(root, ["branch", "target"]);
        await write(root, "docs/domain-language.md", "Committed only on main\n");
        await git(root, ["add", "docs/domain-language.md"]);
        await git(root, ["commit", "-m", "main context"]);
        await write(root, ".gitignore", ".wld/\n");
        await write(root, ".wld/settings.json", '{"verification_command":"printf ignored"}\n');
        const entry = await createWorktreeGitArtifacts({
            projectRoot: root,
            planName: "ignored-context",
            planId: "ignored-context",
            worktreeRoot,
            baseRef: "target",
        });
        assertEquals(
            await fsReadFile(join(entry.path, ".wld/settings.json"), "utf8"),
            '{"verification_command":"printf ignored"}\n',
        );
        await assertRejects(() => fsStat(join(entry.path, "docs/domain-language.md")), Error, "ENOENT");
        await removeWorktreeGitArtifacts({ projectRoot: root, path: entry.path, force: true });
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true });
    }
});

test("context transfer refuses symlink destinations and removes only its newly created checkout", async () => {
    const root = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const outside = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await git(root, ["checkout", "-b", "symlink-target"]);
        await fsSymlink(outside, join(root, "docs"));
        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "symlink docs"]);
        await git(root, ["checkout", "main"]);
        await write(root, "docs/domain-language.md", "Local Init glossary\n");
        const worktrees = await git(root, ["worktree", "list", "--porcelain"]);
        const branches = await git(root, ["branch", "--list"]);
        await assertRejects(
            () =>
                createWorktreeGitArtifacts({
                    projectRoot: root,
                    planName: "symlink",
                    planId: "symlink",
                    worktreeRoot,
                    baseRef: "symlink-target",
                }),
            Error,
            "symlink",
        );
        assertEquals(await git(root, ["worktree", "list", "--porcelain"]), worktrees);
        assertEquals(await git(root, ["branch", "--list"]), branches);
        await assertRejects(() => fsStat(join(outside, "domain-language.md")), Error, "ENOENT");
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true });
        await fsRm(outside, { recursive: true });
    }
});
