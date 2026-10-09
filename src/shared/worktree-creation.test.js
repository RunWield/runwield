import process from "node:process";
import { readdir } from "node:fs/promises";
import { captureForegroundProcess } from "./captured-process.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { match as assertMatch } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { basename, dirname, join } from "node:path";

import { resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";
import { addEntry, findByPlanId } from "./worktree-registry.js";
import {
    findReusableWorktree,
    getWorktreeStatus,
    prepareTargetBranchRef,
    removeWorktreeGitArtifacts,
    resolveCurrentCheckoutBranch,
    resolveWorktreeParent,
} from "./worktree.js";

import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";

test("resolveWorktreeParent keeps overrides and home placement while no-home fallback uses primary internal storage", async () => {
    await withProcessGlobalTestLock(async () => {
        const homeKeys = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA"];
        const previousHome = new Map(homeKeys.map((key) => [key, process.env[key]]));
        const projectRoot = await makeRepo();
        const linkedParent = await fsMkdtemp(join(tmpdir(), "runwield-worktree-parent-linked-"));
        const linkedRoot = join(linkedParent, "linked");
        try {
            process.env.HOME = "/Users/alice";
            assertEquals(
                resolveWorktreeParent("/Users/alice/Documents/web/runwield", undefined),
                join("/Users/alice", ".wld", "worktrees", "--Users-alice-Documents-web-runwield--"),
            );
            assertEquals(resolveWorktreeParent(projectRoot, "/tmp/worktrees"), "/tmp/worktrees");

            await git(projectRoot, ["worktree", "add", "-b", "linked-parent", linkedRoot]);
            for (const key of homeKeys) delete process.env[key];
            const expected = resolveProjectRuntimeLayout(await fsRealpath(projectRoot)).primary.fallbackWorktreesRoot;
            assertEquals(resolveWorktreeParent(projectRoot, undefined), expected);
            assertEquals(resolveWorktreeParent(linkedRoot, undefined), expected);
            assertEquals(expected.endsWith(join(".wld", "internal", "worktrees")), true);
        } finally {
            for (const [key, value] of previousHome) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            await captureForegroundProcess("git", {
                cwd: projectRoot,
                args: ["worktree", "remove", "--force", linkedRoot],
            }).catch(() => {});
            await fsRm(linkedParent, { recursive: true }).catch(() => {});
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

test("resolveCurrentCheckoutBranch returns the primary checkout branch", async () => {
    const projectRoot = await makeRepo();
    try {
        assertEquals(await resolveCurrentCheckoutBranch(projectRoot), "main");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("createTestWorktreeAttempt creates a unique branch/path and registry entry", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Demo Plan",
            planId: "plan-demo",
            worktreeRoot,
        });
        assertMatch(worktree.branch, /^worktree\/demo-plan-[a-f0-9]{8}$/);
        assertEquals(dirname(worktree.path), worktreeRoot);
        assertMatch(basename(worktree.path), /demo-plan-[a-f0-9]{8}$/);
        assertEquals(await git(worktree.path, ["branch", "--show-current"]), worktree.branch);
        const registryEntry = await findByPlanId(projectRoot, "plan-demo");
        assertEquals(registryEntry?.id, worktree.id);
        assertEquals(registryEntry?.baseTree, await git(projectRoot, ["rev-parse", "HEAD^{tree}"]));

        const status = await getWorktreeStatus({ projectRoot, path: worktree.path, branch: worktree.branch });
        assertEquals(status.exists, true);
        assertEquals(status.clean, true);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("createTestWorktreeAttempt leaves dirty primary checkout unchanged", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    let worktree;
    try {
        await fsWriteFile(`${projectRoot}/README.md`, "base\nprimary work\n");
        await fsWriteFile(`${projectRoot}/untracked.txt`, "must stay\n");
        const readmeBefore = await fsReadFile(`${projectRoot}/README.md`, "utf8");
        const untrackedBefore = await fsReadFile(`${projectRoot}/untracked.txt`, "utf8");

        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Dirty Primary Plan",
            planId: "plan-dirty-primary",
            worktreeRoot,
        });

        assertEquals(await fsReadFile(`${projectRoot}/README.md`, "utf8"), readmeBefore);
        assertEquals(await fsReadFile(`${projectRoot}/untracked.txt`, "utf8"), untrackedBefore);
        const statusAfter = await git(projectRoot, ["status", "--short"]);
        assertStringIncludes(statusAfter, "M README.md");
        assertStringIncludes(statusAfter, "?? untracked.txt");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("createTestWorktreeAttempt leaves created Git evidence when registry settlement fails", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {string | undefined} */
    let createdPath;
    /** @type {string | undefined} */
    let createdBranch;
    try {
        await addEntry(projectRoot, {
            id: "existing",
            planName: "Settled Plan",
            planId: "plan-1",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: await git(projectRoot, ["rev-parse", "HEAD^{tree}"]),
            branch: "worktree/settled-plan-existing",
            path: `${worktreeRoot}/existing`,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const error = await assertRejects(
            () =>
                createTestWorktreeAttempt({
                    projectRoot,
                    planName: "Settled Plan",
                    planId: "plan-1",
                    worktreeRoot,
                }),
            Error,
            "registry settlement failed",
        );
        assertMatch(error.message, /inspect .* on branch worktree\/settled-plan-/);

        const created = [];
        for await (const item of await readdir(worktreeRoot, { withFileTypes: true })) {
            if (item.isDirectory() && item.name.includes("settled-plan")) created.push(item.name);
        }
        assertEquals(created.length, 1);
        createdPath = `${worktreeRoot}/${created[0]}`;
        createdBranch = await git(createdPath, ["branch", "--show-current"]);
        assertMatch(createdBranch, /^worktree\/settled-plan-[a-f0-9]{8}$/);
    } finally {
        if (createdPath) await git(projectRoot, ["worktree", "remove", "--force", createdPath]).catch(() => "");
        if (createdBranch) await git(projectRoot, ["branch", "-D", createdBranch]).catch(() => "");
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("createTestWorktreeAttempt initializes submodules", async () => {
    // GIT_ALLOW_PROTOCOL is process-global and affects every concurrent git call.
    await withProcessGlobalTestLock(async () => {
        const projectRoot = await makeRepo();
        const submoduleRoot = await makeRepo();
        const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
        /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
        let worktree;
        try {
            await fsWriteFile(`${submoduleRoot}/module.css`, "body { color: red; }\n");
            await git(submoduleRoot, ["add", "."]);
            await git(submoduleRoot, ["commit", "-m", "add module css"]);
            process.env.GIT_ALLOW_PROTOCOL = "file";
            await git(projectRoot, ["submodule", "add", submoduleRoot, "third_party/demo"]);
            await git(projectRoot, ["commit", "-m", "add submodule"]);

            worktree = await createTestWorktreeAttempt({
                projectRoot,
                planName: "Submodule Plan",
                planId: "plan-submodule",
                worktreeRoot,
            });

            assertEquals(
                (await fsReadFile(`${worktree.path}/third_party/demo/module.css`, "utf8")).replaceAll("\r\n", "\n"),
                "body { color: red; }\n",
            );
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: false,
            });
            await assertRejects(() => fsStat(worktree?.path || ""), Error, "ENOENT");
            worktree = undefined;
        } finally {
            if (previousAllowedProtocols === undefined) {
                delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
                process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
            }
            if (worktree) {
                await removeWorktreeGitArtifacts({
                    projectRoot,
                    path: worktree.path,
                    force: true,
                }).catch(() => {});
            }
            await fsRm(projectRoot, { recursive: true });
            await fsRm(submoduleRoot, { recursive: true });
            await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
        }
    });
});

test("createTestWorktreeAttempt rejects duplicate live legacy plan-name attempts", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsRealpath(await fsMkdtemp(join(tmpdir(), "portable-fixture-")));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>>[]} */
    const worktrees = [];
    try {
        worktrees.push(
            await createTestWorktreeAttempt({
                projectRoot,
                planName: "Repeated Plan",
                planId: "plan-repeated",
                worktreeRoot,
            }),
        );
        const refused = await assertRejects(
            () =>
                createTestWorktreeAttempt({
                    projectRoot,
                    planName: "Repeated Plan",
                    planId: "plan-repeated",
                    worktreeRoot,
                }),
            Error,
            "more than one unfinished worktree attempt",
        );
        // The registry refusal is wrapped with the created path and branch. Both halves
        // have to survive: the path so nothing is silently orphaned, and the registry's
        // own reassurance that it changed nothing.
        assertStringIncludes(refused.message, "registry settlement failed");
        assertStringIncludes(refused.message, "Nothing has been changed or deleted");

        const reusable = await findReusableWorktree({
            projectRoot,
            planName: "Repeated Plan",
            planId: "plan-repeated",
            worktreeId: worktrees[0].id,
        });

        assertEquals(reusable?.id, worktrees[0].id);
    } finally {
        for (const worktree of worktrees.toReversed()) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            }).catch(() => {});
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("prepareTargetBranchRef returns an existing local branch", async () => {
    const projectRoot = await makeRepo();
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        await git(projectRoot, ["checkout", "main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, " feature-base ");

        assertEquals(prepared, { baseRef: "refs/heads/feature-base", baseBranch: "feature-base" });
        assertEquals(await git(projectRoot, ["branch", "--show-current"]), "main");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("prepareTargetBranchRef uses the remote ref without moving a local branch", async () => {
    const remoteRoot = await makeRepo();
    const projectRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await git(remoteRoot, ["checkout", "-b", "feature-base"]);
        await fsWriteFile(`${remoteRoot}/remote.txt`, "remote\n");
        await git(remoteRoot, ["add", "."]);
        await git(remoteRoot, ["commit", "-m", "remote branch"]);
        await git(remoteRoot, ["checkout", "main"]);
        await git(projectRoot, ["clone", remoteRoot, "."]);
        await git(projectRoot, ["checkout", "main"]);
        await git(projectRoot, ["branch", "-D", "feature-base"]).catch(() => Promise.resolve());

        const prepared = await prepareTargetBranchRef(projectRoot, "feature-base");

        assertEquals(prepared, { baseRef: "refs/remotes/origin/feature-base", baseBranch: "feature-base" });
        await assertRejects(() => git(projectRoot, ["rev-parse", "refs/heads/feature-base"]));
        assertEquals(await git(projectRoot, ["show", "refs/remotes/origin/feature-base:remote.txt"]), "remote");
    } finally {
        await fsRm(remoteRoot, { recursive: true });
        await fsRm(projectRoot, { recursive: true });
    }
});

test("prepareTargetBranchRef refreshes a remote target while the local checkout stays stale", async () => {
    const remoteRoot = await makeRepo();
    const projectRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await git(projectRoot, ["clone", remoteRoot, "."]);
        const localHead = await git(projectRoot, ["rev-parse", "refs/heads/main"]);
        await fsWriteFile(`${remoteRoot}/new-remote.txt`, "new remote work\n");
        await git(remoteRoot, ["add", "new-remote.txt"]);
        await git(remoteRoot, ["commit", "-m", "advance remote target"]);
        const remoteHead = await git(remoteRoot, ["rev-parse", "refs/heads/main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, "main");

        assertEquals(prepared, { baseRef: "refs/remotes/origin/main", baseBranch: "main" });
        assertEquals(await git(projectRoot, ["rev-parse", "refs/heads/main"]), localHead);
        assertEquals(await git(projectRoot, ["rev-parse", prepared.baseRef]), remoteHead);
    } finally {
        await fsRm(remoteRoot, { recursive: true });
        await fsRm(projectRoot, { recursive: true });
    }
});

test("prepareTargetBranchRef accepts explicit origin branch input", async () => {
    const remoteRoot = await makeRepo();
    const projectRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await git(remoteRoot, ["checkout", "-b", "feature-explicit"]);
        await fsWriteFile(`${remoteRoot}/explicit.txt`, "remote\n");
        await git(remoteRoot, ["add", "."]);
        await git(remoteRoot, ["commit", "-m", "explicit remote branch"]);
        await git(remoteRoot, ["checkout", "main"]);
        await git(projectRoot, ["clone", remoteRoot, "."]);
        await git(projectRoot, ["checkout", "main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, "origin/feature-explicit");

        assertEquals(prepared, { baseRef: "refs/remotes/origin/feature-explicit", baseBranch: "feature-explicit" });
        assertEquals(await git(projectRoot, ["show", "refs/remotes/origin/feature-explicit:explicit.txt"]), "remote");
    } finally {
        await fsRm(remoteRoot, { recursive: true });
        await fsRm(projectRoot, { recursive: true });
    }
});

test("prepareTargetBranchRef creates a new target branch from main", async () => {
    const projectRoot = await makeRepo();
    try {
        const mainCommit = await git(projectRoot, ["rev-parse", "refs/heads/main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, "new-target");

        assertEquals(prepared, { baseRef: "refs/heads/new-target", baseBranch: "new-target" });
        assertEquals(await git(projectRoot, ["rev-parse", "refs/heads/new-target"]), mainCommit);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("prepareTargetBranchRef rejects invalid and reserved branch names", async () => {
    const projectRoot = await makeRepo();
    try {
        await assertRejects(() => prepareTargetBranchRef(projectRoot, "HEAD"), Error, "not HEAD");
        await assertRejects(
            () => prepareTargetBranchRef(projectRoot, "refs/heads/main"),
            Error,
            "must not be a full ref",
        );
        await assertRejects(
            () => prepareTargetBranchRef(projectRoot, "worktree/demo"),
            Error,
            "reserved execution prefix",
        );
        await assertRejects(() => prepareTargetBranchRef(projectRoot, "bad branch"), Error, "Invalid target branch");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("createTestWorktreeAttempt records supplied target branch independent of current checkout", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    let worktree;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        await fsWriteFile(`${projectRoot}/feature.txt`, "feature-base\n");
        await git(projectRoot, ["add", "."]);
        await git(projectRoot, ["commit", "-m", "feature base"]);
        await git(projectRoot, ["checkout", "main"]);

        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Targeted Plan",
            planId: "plan-targeted",
            baseRef: "refs/heads/feature-base",
            baseBranch: "feature-base",
            worktreeRoot,
        });

        assertEquals(worktree.baseBranch, "feature-base");
        assertEquals(worktree.baseRef, "refs/heads/feature-base");
        assertEquals(await fsReadFile(`${worktree.path}/feature.txt`, "utf8"), "feature-base\n");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("disposable Git configuration checks out long tracked paths beneath a short worktree root", async () => {
    const projectRoot = await makeRepo();
    const parent = await fsMkdtemp(join(tmpdir(), "rwlp-"));
    let attempt;
    try {
        if (process.platform === "win32") {
            assertEquals((await git(projectRoot, ["config", "--get", "core.longpaths"])).trim(), "true");
        }
        // Git's explicit GIT_DIR setup has a separate PATH_MAX - 40 guard even
        // with core.longpaths enabled. Exercise long tracked files, not an
        // unsupported oversized repository root; keep ordinary product naming.
        const relativeFile = join("a".repeat(80), "b".repeat(80), "c".repeat(80), "proof.bin");
        const sourceFile = join(projectRoot, relativeFile);
        const contents = "long tracked file from committed primary";
        await fsMkdir(dirname(sourceFile), { recursive: true });
        await fsWriteFile(sourceFile, contents);
        await git(projectRoot, ["add", "--", relativeFile]);
        await git(projectRoot, ["commit", "-m", "Add nested tracked file"]);
        attempt = await createTestWorktreeAttempt({ projectRoot, planName: "long-file", worktreeRoot: parent });
        if (process.platform === "win32") {
            assertEquals(join(attempt.path, ".git").length <= 220, true, "fixture Git root must remain short");
        }
        const checkedOutFile = join(attempt.path, relativeFile);
        assertEquals(checkedOutFile.length > 260, true);
        assertEquals(await fsReadFile(checkedOutFile, "utf8"), contents);
        assertEquals(
            await fsReadFile(join(attempt.path, "README.md"), "utf8"),
            await fsReadFile(join(projectRoot, "README.md"), "utf8"),
        );
        assertEquals((await git(attempt.path, ["status", "--porcelain"])).trim(), "");
    } finally {
        if (attempt) await removeWorktreeGitArtifacts({ projectRoot, path: attempt.path, force: true });
        await fsRm(projectRoot, { recursive: true });
        await fsRm(parent, { recursive: true });
    }
});
