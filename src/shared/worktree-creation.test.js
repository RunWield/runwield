import { assertEquals, assertMatch, assertRejects, assertStringIncludes } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import { getHomeDir } from "../constants.js";

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

Deno.test("resolveWorktreeParent keeps overrides and home placement while no-home fallback uses primary internal storage", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const projectRoot = await makeRepo();
        const linkedParent = await Deno.makeTempDir({ prefix: "runwield-worktree-parent-linked-" });
        const linkedRoot = join(linkedParent, "linked");
        try {
            Deno.env.set("HOME", "/Users/alice");
            assertEquals(
                resolveWorktreeParent("/Users/alice/Documents/web/runwield", undefined),
                "/Users/alice/.wld/worktrees/--Users-alice-Documents-web-runwield--",
            );
            assertEquals(resolveWorktreeParent(projectRoot, "/tmp/worktrees"), "/tmp/worktrees");

            await git(projectRoot, ["worktree", "add", "-b", "linked-parent", linkedRoot]);
            Deno.env.delete("HOME");
            const expected =
                resolveProjectRuntimeLayout(await Deno.realPath(projectRoot)).primary.fallbackWorktreesRoot;
            assertEquals(resolveWorktreeParent(projectRoot, undefined), expected);
            assertEquals(resolveWorktreeParent(linkedRoot, undefined), expected);
            assertEquals(expected.endsWith(join(".wld", "internal", "worktrees")), true);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await new Deno.Command("git", {
                cwd: projectRoot,
                args: ["worktree", "remove", "--force", linkedRoot],
                stdout: "null",
                stderr: "null",
            }).output().catch(() => {});
            await Deno.remove(linkedParent, { recursive: true }).catch(() => {});
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("resolveCurrentCheckoutBranch returns the primary checkout branch", async () => {
    const projectRoot = await makeRepo();
    try {
        assertEquals(await resolveCurrentCheckoutBranch(projectRoot), "main");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("createTestWorktreeAttempt creates a unique branch/path and registry entry", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
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
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("createTestWorktreeAttempt leaves dirty primary checkout unchanged", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
    let worktree;
    try {
        await Deno.writeTextFile(`${projectRoot}/README.md`, "base\nprimary work\n");
        await Deno.writeTextFile(`${projectRoot}/untracked.txt`, "must stay\n");
        const readmeBefore = await Deno.readTextFile(`${projectRoot}/README.md`);
        const untrackedBefore = await Deno.readTextFile(`${projectRoot}/untracked.txt`);

        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Dirty Primary Plan",
            planId: "plan-dirty-primary",
            worktreeRoot,
        });

        assertEquals(await Deno.readTextFile(`${projectRoot}/README.md`), readmeBefore);
        assertEquals(await Deno.readTextFile(`${projectRoot}/untracked.txt`), untrackedBefore);
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
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("createTestWorktreeAttempt leaves created Git evidence when registry settlement fails", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
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
        for await (const item of Deno.readDir(worktreeRoot)) {
            if (item.isDirectory && item.name.includes("settled-plan")) created.push(item.name);
        }
        assertEquals(created.length, 1);
        createdPath = `${worktreeRoot}/${created[0]}`;
        createdBranch = await git(createdPath, ["branch", "--show-current"]);
        assertMatch(createdBranch, /^worktree\/settled-plan-[a-f0-9]{8}$/);
    } finally {
        if (createdPath) await git(projectRoot, ["worktree", "remove", "--force", createdPath]).catch(() => "");
        if (createdBranch) await git(projectRoot, ["branch", "-D", createdBranch]).catch(() => "");
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("createTestWorktreeAttempt initializes submodules", async () => {
    // GIT_ALLOW_PROTOCOL is process-global and affects every concurrent git call.
    await withProcessGlobalTestLock(async () => {
        const projectRoot = await makeRepo();
        const submoduleRoot = await makeRepo();
        const worktreeRoot = await Deno.makeTempDir();
        const previousAllowedProtocols = Deno.env.get("GIT_ALLOW_PROTOCOL");
        /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
        let worktree;
        try {
            await Deno.writeTextFile(`${submoduleRoot}/module.css`, "body { color: red; }\n");
            await git(submoduleRoot, ["add", "."]);
            await git(submoduleRoot, ["commit", "-m", "add module css"]);
            Deno.env.set("GIT_ALLOW_PROTOCOL", "file");
            await git(projectRoot, ["submodule", "add", submoduleRoot, "third_party/demo"]);
            await git(projectRoot, ["commit", "-m", "add submodule"]);

            worktree = await createTestWorktreeAttempt({
                projectRoot,
                planName: "Submodule Plan",
                planId: "plan-submodule",
                worktreeRoot,
            });

            assertEquals(
                await Deno.readTextFile(`${worktree.path}/third_party/demo/module.css`),
                "body { color: red; }\n",
            );
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: false,
            });
            await assertRejects(() => Deno.stat(worktree?.path || ""), Deno.errors.NotFound);
            worktree = undefined;
        } finally {
            if (previousAllowedProtocols === undefined) {
                Deno.env.delete("GIT_ALLOW_PROTOCOL");
            } else {
                Deno.env.set("GIT_ALLOW_PROTOCOL", previousAllowedProtocols);
            }
            if (worktree) {
                await removeWorktreeGitArtifacts({
                    projectRoot,
                    path: worktree.path,
                    force: true,
                }).catch(() => {});
            }
            await Deno.remove(projectRoot, { recursive: true });
            await Deno.remove(submoduleRoot, { recursive: true });
            await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("createTestWorktreeAttempt rejects duplicate live legacy plan-name attempts", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.realPath(await Deno.makeTempDir());
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
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("prepareTargetBranchRef returns an existing local branch", async () => {
    const projectRoot = await makeRepo();
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        await git(projectRoot, ["checkout", "main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, " feature-base ");

        assertEquals(prepared, { baseRef: "refs/heads/feature-base", baseBranch: "feature-base" });
        assertEquals(await git(projectRoot, ["branch", "--show-current"]), "main");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("prepareTargetBranchRef uses the remote ref without moving a local branch", async () => {
    const remoteRoot = await makeRepo();
    const projectRoot = await Deno.makeTempDir();
    try {
        await git(remoteRoot, ["checkout", "-b", "feature-base"]);
        await Deno.writeTextFile(`${remoteRoot}/remote.txt`, "remote\n");
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
        await Deno.remove(remoteRoot, { recursive: true });
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("prepareTargetBranchRef refreshes a remote target while the local checkout stays stale", async () => {
    const remoteRoot = await makeRepo();
    const projectRoot = await Deno.makeTempDir();
    try {
        await git(projectRoot, ["clone", remoteRoot, "."]);
        const localHead = await git(projectRoot, ["rev-parse", "refs/heads/main"]);
        await Deno.writeTextFile(`${remoteRoot}/new-remote.txt`, "new remote work\n");
        await git(remoteRoot, ["add", "new-remote.txt"]);
        await git(remoteRoot, ["commit", "-m", "advance remote target"]);
        const remoteHead = await git(remoteRoot, ["rev-parse", "refs/heads/main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, "main");

        assertEquals(prepared, { baseRef: "refs/remotes/origin/main", baseBranch: "main" });
        assertEquals(await git(projectRoot, ["rev-parse", "refs/heads/main"]), localHead);
        assertEquals(await git(projectRoot, ["rev-parse", prepared.baseRef]), remoteHead);
    } finally {
        await Deno.remove(remoteRoot, { recursive: true });
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("prepareTargetBranchRef accepts explicit origin branch input", async () => {
    const remoteRoot = await makeRepo();
    const projectRoot = await Deno.makeTempDir();
    try {
        await git(remoteRoot, ["checkout", "-b", "feature-explicit"]);
        await Deno.writeTextFile(`${remoteRoot}/explicit.txt`, "remote\n");
        await git(remoteRoot, ["add", "."]);
        await git(remoteRoot, ["commit", "-m", "explicit remote branch"]);
        await git(remoteRoot, ["checkout", "main"]);
        await git(projectRoot, ["clone", remoteRoot, "."]);
        await git(projectRoot, ["checkout", "main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, "origin/feature-explicit");

        assertEquals(prepared, { baseRef: "refs/remotes/origin/feature-explicit", baseBranch: "feature-explicit" });
        assertEquals(await git(projectRoot, ["show", "refs/remotes/origin/feature-explicit:explicit.txt"]), "remote");
    } finally {
        await Deno.remove(remoteRoot, { recursive: true });
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("prepareTargetBranchRef creates a new target branch from main", async () => {
    const projectRoot = await makeRepo();
    try {
        const mainCommit = await git(projectRoot, ["rev-parse", "refs/heads/main"]);

        const prepared = await prepareTargetBranchRef(projectRoot, "new-target");

        assertEquals(prepared, { baseRef: "refs/heads/new-target", baseBranch: "new-target" });
        assertEquals(await git(projectRoot, ["rev-parse", "refs/heads/new-target"]), mainCommit);
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("prepareTargetBranchRef rejects invalid and reserved branch names", async () => {
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
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("createTestWorktreeAttempt records supplied target branch independent of current checkout", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
    let worktree;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        await Deno.writeTextFile(`${projectRoot}/feature.txt`, "feature-base\n");
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
        assertEquals(await Deno.readTextFile(`${worktree.path}/feature.txt`), "feature-base\n");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});
