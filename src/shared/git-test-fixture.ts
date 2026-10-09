import { tmpdir } from "node:os";
import { captureForegroundProcess } from "./captured-process.ts";
import { rmSync } from "node:fs";
import process from "node:process";
import { copyFile, mkdir, mkdtemp, readdir, readlink, symlink, writeFile } from "node:fs/promises";
/**
 * @module shared/git-test-fixture
 * Real Git repositories for tests, built once per module and copied per test.
 *
 * Tests that need Git should use real Git. Its operations are cheap — measured on
 * this repo: `worktree add` 24ms, `merge` 30ms, `worktree list` 9ms,
 * `merge-base --is-ancestor` 5ms — and its semantics are the thing under test
 * whenever RunWield treats a Git fact as proof. What is *not* cheap is building a
 * repository from nothing for every test: `git init` plus config plus two commits
 * costs 71ms, more than all the queries a test will then run against it.
 *
 * So build the repository once per test module and copy it. A copy costs 16ms, so a
 * test gets its own isolated repository for under a quarter of what initializing
 * one costs, and gives up no fidelity to get it.
 *
 * Deliberately not a fake. A convincing in-memory Git is a project in itself, and
 * the part RunWield leans on hardest — worktrees — is exactly the part no existing
 * library models (isomorphic-git has no worktree commands at all). A fake would
 * save tens of milliseconds per test and put the merge path, where being wrong is
 * most expensive, behind semantics we wrote ourselves from the same assumptions as
 * the production code it is meant to check.
 */

import { dirname, join } from "node:path";

/**
 * Copy a directory tree.
 *
 * Written out rather than shelling out to `cp -R` so the helper works the same on
 * every platform the test suite runs on, and rather than pulling in `@std/fs` for
 * one function.
 */
async function copyTree(source: string, destination: string, insideGitDir = false) {
    await mkdir(destination, { recursive: true });
    for await (const entry of await readdir(source, { withFileTypes: true })) {
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        const entryInsideGitDir = insideGitDir || entry.name === ".git";
        if (entryInsideGitDir && entry.name.endsWith(".lock")) continue;
        if (entry.isDirectory()) await copyTree(from, to, entryInsideGitDir);
        else if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
        else {
            try {
                await copyFile(from, to);
            } catch (error) {
                if (
                    entry.name.endsWith(".lock") && error instanceof Error && "code" in error && error.code === "ENOENT"
                ) continue;
                throw error;
            }
        }
    }
}

/** Run a Git command, throwing its stderr on failure. */
export async function git(cwd: string, args: string[]): Promise<string> {
    const { code, stdout, stderr } = await captureForegroundProcess("git", {
        cwd,
        args,
    });
    const decoder = new TextDecoder();
    if (code !== 0) throw new Error(decoder.decode(stderr) || decoder.decode(stdout));
    return decoder.decode(stdout).trim();
}

/** Identity for fixture commits, so a developer's own Git config cannot change results. */
async function configureFixtureIdentity(cwd: string) {
    await git(cwd, ["config", "user.email", "fixture@runwield.test"]);
    await git(cwd, ["config", "user.name", "RunWield Fixture"]);
    // Fixtures own their byte format; CRLF-specific tests opt in explicitly.
    await git(cwd, ["config", "core.autocrlf", "false"]);
    // Keep commits independent of the host's signing setup.
    await git(cwd, ["config", "commit.gpgsign", "false"]);
}

const templatesToRemove: string[] = [];
let cleanupRegistered = false;

function registerTemplateCleanup() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.on("exit", () => {
        for (const path of templatesToRemove) {
            try {
                rmSync(path, { recursive: true });
            } catch {
                // Best effort: a leftover temp directory is harmless, and throwing here
                // would fail an otherwise passing run.
            }
        }
    });
}

export interface GitFixture {
    /** An isolated copy of the template. The caller owns it and should remove it. */
    checkout: (options?: { prefix?: string }) => Promise<string>;
}

/**
 * Declare a Git repository shape once, then stamp out isolated copies of it.
 *
 * Call this at module scope. The template is built on first use and reused for the
 * life of the test module — the runner gives each test file its own process, so one
 * template per module is already per-file isolation.
 *
 * The `build` callback runs against the template. Create commits, branches, and
 * files there; do **not** create worktrees. A worktree records absolute paths in
 * `.git/worktrees/<name>/gitdir` and in the worktree's own `.git` file, so copying a
 * repository that has one yields a copy pointing back at the template. Tests add
 * worktrees to their own copy, after `checkout()`.
 */
export function defineGitFixture(build: (repoPath: string) => Promise<void>): GitFixture {
    let template: Promise<string> | undefined;

    const buildTemplate = async () => {
        const path = await mkdtemp(join(tmpdir(), "runwield-git-template-"));
        templatesToRemove.push(path);
        registerTemplateCleanup();
        await git(path, ["init", "-b", "main"]);
        await configureFixtureIdentity(path);
        await build(path);
        return path;
    };

    return {
        checkout: async (options: { prefix?: string } = {}) => {
            template = template || buildTemplate();
            const source = await template;
            const destination = await mkdtemp(join(tmpdir(), options.prefix || "runwield-git-fixture-"));
            await copyTree(source, destination);
            return destination;
        },
    };
}

/** The common shape: one commit on `main` holding the given files. */
export function defineCommittedGitFixture(files: Record<string, string> = { "README.md": "# Fixture\n" }): GitFixture {
    return defineGitFixture(async (repoPath) => {
        for (const [relativePath, contents] of Object.entries(files)) {
            const target = join(repoPath, relativePath);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, contents);
        }
        await git(repoPath, ["add", "."]);
        await git(repoPath, ["commit", "-m", "fixture base"]);
    });
}
