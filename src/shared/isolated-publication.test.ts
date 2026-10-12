import { mergeFrontMatterText } from "../plan-store.js";
import { normalizePublicationFailure } from "./workflow/validation-merge-repair.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
    isExecutionCommitPublishedUpstream,
    IsolatedPublicationError,
    type IsolatedPublicationProgress,
    publishExecutionWorktreeIsolated,
} from "./isolated-publication.ts";
import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";
import { removeWorktreeGitArtifacts } from "./worktree.js";
import { RUNWIELD_GITIGNORE_BLOCK } from "./runwield-owned-paths.ts";

for (const change of ["formatting", "definition", "body", "staged", "committed"]) {
    Deno.test(`publication retry recovers only unstaged formatting: ${change}`, async () => {
        const projectRoot = await makeRepo();
        const worktreeRoot = await Deno.makeTempDir({ prefix: "publication-plan-format-" });
        const worktree = await createTestWorktreeAttempt({ projectRoot, planName: "p", worktreeRoot });
        try {
            const path = "docs/plans/p.md";
            const sealed =
                '---\nplanId: "p"\nclassification: "PLANNED_CHANGE"\nstatus: "validated"\naffectedPaths:\n    - "src/a.ts"\ntargetBranch: "main"\n---\n# Validated\n';
            await Deno.mkdir(`${worktree.path}/docs/plans`, { recursive: true });
            await Deno.writeTextFile(`${worktree.path}/${path}`, sealed);
            await git(worktree.path, ["add", path]);
            await git(worktree.path, ["commit", "-m", "Seal formatted Plan"]);
            const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
            const current = change === "definition"
                ? sealed.replace("src/a.ts", "src/b.ts")
                : change === "body"
                ? sealed.replace("# Validated", "# Changed intent")
                : sealed.replace("    -", "  -");
            await Deno.writeTextFile(`${worktree.path}/${path}`, current);
            if (change === "staged" || change === "committed") await git(worktree.path, ["add", path]);
            if (change === "committed") await git(worktree.path, ["commit", "-m", "User Plan edit"]);
            const headBefore = await git(worktree.path, ["rev-parse", "HEAD"]);
            const indexBefore = await git(worktree.path, ["write-tree"]);
            const publish = () =>
                publishExecutionWorktreeIsolated({
                    projectRoot,
                    executionCwd: worktree.path,
                    executionBranch: worktree.branch,
                    targetBranch: "main",
                    planName: "p",
                    sealedExecutionCommit: sealedCommit,
                    allowedPlanPaths: [path],
                });
            if (change !== "formatting") {
                await assertRejects(publish, Error, "changed after the validated candidate was sealed");
                assertEquals(await Deno.readTextFile(`${worktree.path}/${path}`), current);
                assertEquals(await git(worktree.path, ["rev-parse", "HEAD"]), headBefore);
                assertEquals(await git(worktree.path, ["write-tree"]), indexBefore);
            } else {
                await publish();
                assertEquals(
                    await git(projectRoot, ["show", `main:${path}`]),
                    mergeFrontMatterText(sealed, { status: "verified" }).trim(),
                );
                assertEquals(await Deno.readTextFile(`${worktree.path}/${path}`), sealed);
                assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
            }
        } finally {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true });
            await Deno.remove(projectRoot, { recursive: true });
            await Deno.remove(worktreeRoot, { recursive: true });
        }
    });
}

Deno.test("publication without a remote safely advances the local target branch", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-local-publication-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "local-delivery", worktreeRoot });
        await Deno.writeTextFile(`${projectRoot}/.gitignore`, RUNWIELD_GITIGNORE_BLOCK);
        await Deno.writeTextFile(`${projectRoot}/untracked-user-note.txt`, "preserve me\n");
        await Deno.writeTextFile(
            `${worktree.path}/.gitignore`,
            `node_modules\n${RUNWIELD_GITIGNORE_BLOCK}`,
        );
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "local validated implementation\n");
        await Deno.writeTextFile(`${worktree.path}/AGENTS.md`, "repository guidance\n");
        await Deno.symlink("AGENTS.md", `${worktree.path}/CLAUDE.md`);
        await git(worktree.path, ["add", ".gitignore", "implementation.txt", "AGENTS.md", "CLAUDE.md"]);
        await git(worktree.path, ["commit", "-m", "Validated local candidate"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const oldMain = await git(projectRoot, ["rev-parse", "main"]);
        const progress: IsolatedPublicationProgress[] = [];

        const published = await publishExecutionWorktreeIsolated({
            projectRoot,
            executionCwd: worktree.path,
            executionBranch: worktree.branch,
            targetBranch: "main",
            planName: "local-delivery",
            sealedExecutionCommit: sealedCommit,
            allowedPlanPaths: [],
            onProgress: (step) => progress.push(step),
        });

        assertEquals(published.publicationMode, "local");
        assertEquals(progress, ["preparing", "reading_target", "using_local_target", "combining_work", "verifying"]);
        assert((await git(projectRoot, ["rev-parse", "main"])) !== oldMain);
        await git(projectRoot, ["merge-base", "--is-ancestor", sealedCommit, "main"]);
        assertEquals(await Deno.readTextFile(`${projectRoot}/implementation.txt`), "local validated implementation\n");
        assertEquals(await Deno.readTextFile(`${projectRoot}/AGENTS.md`), "repository guidance\n");
        assert((await Deno.lstat(`${projectRoot}/CLAUDE.md`)).isSymlink);
        assertEquals(await Deno.readLink(`${projectRoot}/CLAUDE.md`), "AGENTS.md");
        assertEquals(
            (await git(projectRoot, ["ls-tree", "main", "CLAUDE.md"])).split(/\s+/)[0],
            "120000",
        );
        assertEquals(await Deno.readTextFile(`${projectRoot}/untracked-user-note.txt`), "preserve me\n");
        assertEquals(await Deno.readTextFile(`${projectRoot}/.gitignore`), `node_modules\n${RUNWIELD_GITIGNORE_BLOCK}`);
        assertEquals(
            await isExecutionCommitPublishedUpstream({
                projectRoot,
                executionBranch: worktree.branch,
                targetBranch: "main",
                executionCommit: sealedCommit,
            }),
            true,
        );
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("isolated publication pushes the target upstream without touching the primary checkout", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "isolated-delivery", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "validated implementation\n");
        await Deno.mkdir(`${worktree.path}/docs/work-records`, { recursive: true });
        await Deno.writeTextFile(`${worktree.path}/docs/work-records/isolated.md`, "work record\n");
        await Deno.mkdir(`${worktree.path}/.wld/agents`, { recursive: true });
        await Deno.mkdir(`${worktree.path}/.wld/skills/local`, { recursive: true });
        await Deno.mkdir(`${worktree.path}/.wld/prompts`, { recursive: true });
        await Deno.writeTextFile(`${worktree.path}/.wld/settings.json`, "{}\n");
        await Deno.writeTextFile(`${worktree.path}/.wld/agents/local.md`, "agent\n");
        await Deno.writeTextFile(`${worktree.path}/.wld/skills/local/SKILL.md`, "skill\n");
        await Deno.writeTextFile(`${worktree.path}/.wld/prompts/local.md`, "prompt\n");
        await git(worktree.path, [
            "add",
            "implementation.txt",
            "docs/work-records/isolated.md",
            ".wld/settings.json",
            ".wld/agents/local.md",
            ".wld/skills/local/SKILL.md",
            ".wld/prompts/local.md",
        ]);
        await git(worktree.path, ["commit", "-m", "Validated execution candidate"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);

        await Deno.writeTextFile(`${projectRoot}/README.md`, "user's uncommitted primary work\n");
        await Deno.writeTextFile(`${projectRoot}/untracked.txt`, "leave me alone\n");
        const primaryHead = await git(projectRoot, ["rev-parse", "main"]);
        const primaryStatus = await git(projectRoot, ["status", "--porcelain", "--untracked-files=all"]);
        assertEquals(
            await isExecutionCommitPublishedUpstream({
                projectRoot,
                executionBranch: worktree.branch,
                targetBranch: "main",
                executionCommit: sealedCommit,
            }),
            false,
        );

        const progress: IsolatedPublicationProgress[] = [];
        const published = await publishExecutionWorktreeIsolated({
            projectRoot,
            executionCwd: worktree.path,
            executionBranch: worktree.branch,
            targetBranch: "main",
            planName: "isolated-delivery",
            sealedExecutionCommit: sealedCommit,
            allowedPlanPaths: [],
            onProgress: (step) => progress.push(step),
        });

        assertEquals(progress, ["preparing", "reading_target", "combining_work", "publishing", "verifying"]);

        assertEquals(await git(projectRoot, ["rev-parse", "main"]), primaryHead);
        assertEquals(await git(projectRoot, ["status", "--porcelain", "--untracked-files=all"]), primaryStatus);
        assertEquals(await Deno.readTextFile(`${projectRoot}/README.md`), "user's uncommitted primary work\n");
        assertEquals(await Deno.readTextFile(`${projectRoot}/untracked.txt`), "leave me alone\n");
        const remoteHead = await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"]);
        assertEquals(remoteHead.split(/\s+/)[0], published.publicationCommit);
        await git(projectRoot, ["fetch", "origin", "main"]);
        await git(projectRoot, ["merge-base", "--is-ancestor", sealedCommit, "origin/main"]);
        assertEquals(await git(projectRoot, ["show", "origin/main:implementation.txt"]), "validated implementation");
        assertEquals(await git(projectRoot, ["show", "origin/main:docs/work-records/isolated.md"]), "work record");
        assertEquals(await git(projectRoot, ["show", "origin/main:.wld/settings.json"]), "{}");
        assertEquals(await git(projectRoot, ["show", "origin/main:.wld/agents/local.md"]), "agent");
        assertEquals(await git(projectRoot, ["show", "origin/main:.wld/skills/local/SKILL.md"]), "skill");
        assertEquals(await git(projectRoot, ["show", "origin/main:.wld/prompts/local.md"]), "prompt");
        await assertRejects(() => git(projectRoot, ["show", "origin/main:.wld/internal/state.json"]));
        assertEquals(
            await isExecutionCommitPublishedUpstream({
                projectRoot,
                executionBranch: worktree.branch,
                targetBranch: "main",
                executionCommit: sealedCommit,
            }),
            true,
        );
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("remote publication refuses runtime history even when the final tree is clean", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-runtime-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-runtime-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "runtime-history", worktreeRoot });
        await Deno.mkdir(`${worktree.path}/.wld/internal/future`, { recursive: true });
        await Deno.writeTextFile(`${worktree.path}/.wld/internal/future/state.json`, "runtime\n");
        await git(worktree.path, ["add", ".wld/internal/future/state.json"]);
        await git(worktree.path, ["commit", "-m", "Accidentally track runtime"]);
        await Deno.remove(`${worktree.path}/.wld/internal/future/state.json`);
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "safe final tree\n");
        await git(worktree.path, ["add", "."]);
        await git(worktree.path, ["commit", "-m", "Remove runtime and keep work"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const remoteHeadBefore = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];

        const failure = await assertRejects(() =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree!.path,
                executionBranch: worktree!.branch,
                targetBranch: "main",
                planName: "runtime-history",
                sealedExecutionCommit: sealedCommit,
                allowedPlanPaths: [],
            })
        );

        assert(failure instanceof IsolatedPublicationError);
        assertEquals(failure.mergeFailureKind, "runwield_runtime_tracked");
        assertStringIncludes(failure.message, ".wld/internal/future/state.json");
        const remoteHeadAfter = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];
        assertEquals(remoteHeadAfter, remoteHeadBefore);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("remote publication refuses runtime history from a merged side branch", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-side-runtime-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-side-runtime-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "runtime-side-history", worktreeRoot });
        await git(worktree.path, ["checkout", "-b", "runtime-source-side"]);
        await Deno.mkdir(`${worktree.path}/.wld/internal/future`, { recursive: true });
        await Deno.writeTextFile(`${worktree.path}/.wld/internal/future/side.json`, "runtime\n");
        await git(worktree.path, ["add", ".wld/internal/future/side.json"]);
        await git(worktree.path, ["commit", "-m", "Accidentally track side runtime"]);
        await Deno.remove(`${worktree.path}/.wld/internal/future/side.json`);
        await git(worktree.path, ["add", ".wld/internal/future/side.json"]);
        await git(worktree.path, ["commit", "-m", "Remove side runtime"]);
        await git(worktree.path, ["checkout", worktree.branch]);
        await git(worktree.path, ["merge", "--no-ff", "runtime-source-side", "-m", "Merge side runtime history"]);
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "safe final tree\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Safe final work"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const remoteHeadBefore = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];

        const failure = await assertRejects(() =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree!.path,
                executionBranch: worktree!.branch,
                targetBranch: "main",
                planName: "runtime-side-history",
                sealedExecutionCommit: sealedCommit,
                allowedPlanPaths: [],
            })
        );

        assert(failure instanceof IsolatedPublicationError);
        assertEquals(failure.mergeFailureKind, "runwield_runtime_tracked");
        assertStringIncludes(failure.message, ".wld/internal/future/side.json");
        const remoteHeadAfter = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];
        assertEquals(remoteHeadAfter, remoteHeadBefore);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("saved publication copy refuses deleted runtime history before automatic metadata commits", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-saved-runtime-remote-" });
    const publicationRoot = await Deno.makeTempDir({ prefix: "runwield-saved-runtime-publication-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-saved-runtime-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "saved-runtime", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "safe work\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "safe execution"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        await Deno.remove(publicationRoot, { recursive: true });
        await git(projectRoot, ["clone", "--no-hardlinks", projectRoot, publicationRoot]);
        await git(publicationRoot, ["config", "user.email", "runwield@example.com"]);
        await git(publicationRoot, ["config", "user.name", "RunWield Test"]);
        await git(publicationRoot, ["remote", "rename", "origin", "runwield-source"]);
        await git(publicationRoot, ["remote", "add", "publication", remoteRoot]);
        await Deno.mkdir(`${publicationRoot}/.wld/internal`, { recursive: true });
        await Deno.writeTextFile(`${publicationRoot}/.wld/internal/saved.json`, "runtime\n");
        await git(publicationRoot, ["add", ".wld/internal/saved.json"]);
        await git(publicationRoot, ["commit", "-m", "unsafe saved publication state"]);
        await Deno.remove(`${publicationRoot}/.wld/internal/saved.json`);
        await Deno.writeTextFile(`${publicationRoot}/saved-repair.txt`, "safe final repair\n");
        await git(publicationRoot, ["add", "."]);
        await git(publicationRoot, ["commit", "-m", "delete saved runtime state"]);
        const savedHeadBefore = await git(publicationRoot, ["rev-parse", "HEAD"]);
        const remoteHeadBefore = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];

        const failure = await assertRejects(() =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree!.path,
                executionBranch: worktree!.branch,
                targetBranch: "main",
                planName: "saved-runtime",
                sealedExecutionCommit: sealedCommit,
                allowedPlanPaths: [],
                publicationRoot,
            })
        ) as IsolatedPublicationError;

        assertEquals(failure.mergeFailureKind, "runwield_runtime_tracked");
        assertStringIncludes(failure.message, ".wld/internal/saved.json");
        assertEquals(
            (await git(publicationRoot, ["log", "--format=%s", "-1"])).startsWith("Record delivery for"),
            false,
        );
        await git(publicationRoot, ["merge-base", "--is-ancestor", savedHeadBefore, "HEAD"]);
        const remoteHeadAfter = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];
        assertEquals(remoteHeadAfter, remoteHeadBefore);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(publicationRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("publication refuses to advance the source branch after the artifact is sealed", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-sealed-publication-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-sealed-publication-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "sealed-artifact", worktreeRoot });
        await Deno.mkdir(`${worktree.path}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(`${worktree.path}/docs/plans/sealed-artifact.md`, "validated plan\n");
        await git(worktree.path, ["add", "docs/plans/sealed-artifact.md"]);
        await git(worktree.path, ["commit", "-m", "Seal publication artifact"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        await Deno.writeTextFile(`${worktree.path}/docs/plans/sealed-artifact.md`, "changed after sealing\n");

        await assertRejects(
            () =>
                publishExecutionWorktreeIsolated({
                    projectRoot,
                    executionCwd: worktree!.path,
                    executionBranch: worktree!.branch,
                    targetBranch: "main",
                    planName: "sealed-artifact",
                    sealedExecutionCommit: sealedCommit,
                    allowedPlanPaths: ["docs/plans/sealed-artifact.md"],
                }),
            Error,
            "changed after the validated candidate was sealed",
        );
        assertEquals(await git(worktree.path, ["rev-parse", "HEAD"]), sealedCommit);
        assertEquals(await git(projectRoot, ["rev-parse", worktree.branch]), sealedCommit);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("remote publication records the lease head when the primary target is behind", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-ahead-remote-" });
    const contributorRoot = await Deno.makeTempDir({ prefix: "runwield-publication-contributor-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-ahead-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "remote-ahead", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "validated implementation\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Validated execution candidate"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);

        await git(projectRoot, ["clone", "--no-checkout", remoteRoot, contributorRoot]);
        await git(contributorRoot, ["config", "user.name", "RunWield Tests"]);
        await git(contributorRoot, ["config", "user.email", "runwield@example.com"]);
        await git(contributorRoot, ["checkout", "main"]);
        await Deno.writeTextFile(`${contributorRoot}/remote-only.txt`, "new target commit\n");
        await git(contributorRoot, ["add", "remote-only.txt"]);
        await git(contributorRoot, ["commit", "-m", "Advance remote target"]);
        await git(contributorRoot, ["push", "origin", "main"]);
        const leaseHead = await git(contributorRoot, ["rev-parse", "HEAD"]);

        const published = await publishExecutionWorktreeIsolated({
            projectRoot,
            executionCwd: worktree.path,
            executionBranch: worktree.branch,
            targetBranch: "main",
            planName: "remote-ahead",
            sealedExecutionCommit: sealedCommit,
            allowedPlanPaths: [],
        });

        assertEquals(published.targetHeadBeforeMerge, leaseHead);
        await git(projectRoot, ["fetch", "origin", "main"]);
        await git(projectRoot, ["merge-base", "--is-ancestor", leaseHead, "origin/main"]);
        await git(projectRoot, ["merge-base", "--is-ancestor", sealedCommit, "origin/main"]);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(contributorRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("a remote policy rejection is typed as fatal and leaves the execution branch recoverable", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-rejecting-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-retry-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "retryable-delivery", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "safe candidate\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Validated retryable candidate"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const remoteHeadBefore = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"]))
            .split(/\s+/)[0];
        const hookPath = `${remoteRoot}/hooks/pre-receive`;
        await Deno.writeTextFile(
            hookPath,
            "#!/bin/sh\necho 'protected branch policy: pre-receive hook declined' >&2\nexit 1\n",
        );
        await Deno.chmod(hookPath, 0o755);

        const failure = await assertRejects(() =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree!.path,
                executionBranch: worktree!.branch,
                targetBranch: "main",
                planName: "retryable-delivery",
                sealedExecutionCommit: sealedCommit,
                allowedPlanPaths: [],
            })
        );
        assert(failure instanceof IsolatedPublicationError);
        assertEquals(failure.mergeFailureKind, "policy_violation");

        assert((await Deno.stat(worktree.path)).isDirectory);
        assertEquals(await git(worktree.path, ["rev-parse", "HEAD"]), sealedCommit);
        assertEquals(await git(projectRoot, ["rev-parse", worktree.branch]), sealedCommit);
        const remoteHeadAfter = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"]))
            .split(/\s+/)[0];
        assertEquals(remoteHeadAfter, remoteHeadBefore);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("force-with-lease rejection is typed as a target race", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-lease-race-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-lease-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "lease-race", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "safe candidate\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Validated candidate"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const hookPath = `${remoteRoot}/hooks/pre-receive`;
        await Deno.writeTextFile(hookPath, "#!/bin/sh\necho 'stale info: target moved' >&2\nexit 1\n");
        await Deno.chmod(hookPath, 0o755);

        const failure = await assertRejects(() =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree!.path,
                executionBranch: worktree!.branch,
                targetBranch: "main",
                planName: "lease-race",
                sealedExecutionCommit: sealedCommit,
                allowedPlanPaths: [],
            })
        );

        assert(failure instanceof IsolatedPublicationError);
        assertEquals(failure.mergeFailureKind, "target_reference_race");
        assertStringIncludes(failure.message, "force-with-lease");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("unreachable upstream is typed as transient without changing the primary checkout", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-unavailable-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-unavailable-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "remote-down", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "safe candidate\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Validated candidate"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const primaryHead = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["remote", "set-url", "origin", `${remoteRoot}-missing`]);

        const failure = await assertRejects(() =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree!.path,
                executionBranch: worktree!.branch,
                targetBranch: "main",
                planName: "remote-down",
                sealedExecutionCommit: sealedCommit,
                allowedPlanPaths: [],
            })
        );

        assert(failure instanceof IsolatedPublicationError);
        assertEquals(failure.mergeFailureKind, "remote_unavailable");
        assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), primaryHead);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("saved publication clone remains usable after an upstream outage during preparation", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-publication-retry-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-publication-retry-worktree-" });
    const publicationRoot = `${worktreeRoot}/publication`;
    const offlineRemote = `${remoteRoot}-offline`;
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        const worktree = await createTestWorktreeAttempt({ projectRoot, planName: "retry-outage", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "safe candidate\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Validated candidate"]);
        const sealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const primaryHead = await git(projectRoot, ["rev-parse", "HEAD"]);
        const primaryReadme = await Deno.readTextFile(`${projectRoot}/README.md`);
        const publish = () =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree.path,
                executionBranch: worktree.branch,
                targetBranch: "main",
                planName: "retry-outage",
                sealedExecutionCommit: sealedCommit,
                allowedPlanPaths: [],
                publicationRoot,
            });

        await Deno.rename(remoteRoot, offlineRemote);
        const failure = await assertRejects(publish, IsolatedPublicationError);
        assertEquals(failure.mergeFailureKind, "remote_unavailable");
        assertEquals(await git(publicationRoot, ["status", "--porcelain"]), "");
        assertEquals(await Deno.readTextFile(`${publicationRoot}/README.md`), primaryReadme);
        await Deno.rename(offlineRemote, remoteRoot);

        const published = await publish();
        assertEquals(await git(remoteRoot, ["rev-parse", "main"]), published.publicationCommit);
        await git(remoteRoot, ["merge-base", "--is-ancestor", sealedCommit, "main"]);
        assertEquals(await git(remoteRoot, ["show", "main:implementation.txt"]), "safe candidate");
        assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), primaryHead);
        assertEquals(await Deno.readTextFile(`${projectRoot}/README.md`), primaryReadme);
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(offlineRemote, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("completed publication repair imports a newer execution commit before retrying", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-repaired-publication-remote-" });
    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-repaired-publication-worktree-" });
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    let repairRoot: string | undefined;
    try {
        await Deno.writeTextFile(`${projectRoot}/conflict.txt`, "base\n");
        await git(projectRoot, ["add", "conflict.txt"]);
        await git(projectRoot, ["commit", "-m", "Add conflict fixture"]);
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);

        worktree = await createTestWorktreeAttempt({ projectRoot, planName: "repaired-delivery", worktreeRoot });
        await Deno.writeTextFile(`${worktree.path}/conflict.txt`, "execution\n");
        await git(worktree.path, ["add", "conflict.txt"]);
        await git(worktree.path, ["commit", "-m", "Validated conflicting candidate"]);
        const firstSealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);

        await Deno.writeTextFile(`${projectRoot}/conflict.txt`, "target\n");
        await git(projectRoot, ["add", "conflict.txt"]);
        await git(projectRoot, ["commit", "-m", "Advance target with conflict"]);
        await git(projectRoot, ["push", "origin", "main"]);

        try {
            await publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd: worktree.path,
                executionBranch: worktree.branch,
                targetBranch: "main",
                planName: "repaired-delivery",
                sealedExecutionCommit: firstSealedCommit,
                allowedPlanPaths: [],
            });
            throw new Error("Expected the first publication attempt to conflict.");
        } catch (error) {
            if (!(error instanceof IsolatedPublicationError) || !error.mergeWorktreePath) throw error;
            repairRoot = error.mergeWorktreePath;
        }

        assert(repairRoot);
        await Deno.writeTextFile(`${repairRoot}/conflict.txt`, "resolved\n");
        await git(repairRoot, ["add", "conflict.txt"]);
        await git(repairRoot, ["commit", "--no-edit"]);

        await Deno.writeTextFile(`${projectRoot}/arrived-during-repair.txt`, "must survive publication retry\n");
        await git(projectRoot, ["add", "arrived-during-repair.txt"]);
        await git(projectRoot, ["commit", "-m", "Advance target while publication repair is pending"]);
        await git(projectRoot, ["push", "origin", "main"]);
        const targetHeadAfterRepairStarted = await git(projectRoot, ["rev-parse", "HEAD"]);

        await Deno.writeTextFile(`${worktree.path}/final-lifecycle.txt`, "recorded after repair\n");
        await git(worktree.path, ["add", "final-lifecycle.txt"]);
        await git(worktree.path, ["commit", "-m", "Record final lifecycle state"]);
        const finalSealedCommit = await git(worktree.path, ["rev-parse", "HEAD"]);

        const published = await publishExecutionWorktreeIsolated({
            projectRoot,
            executionCwd: worktree.path,
            executionBranch: worktree.branch,
            targetBranch: "main",
            planName: "repaired-delivery",
            sealedExecutionCommit: finalSealedCommit,
            allowedPlanPaths: [],
            repairedPublicationRoot: repairRoot,
        });

        const remoteHead = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];
        assertEquals(remoteHead, published.publicationCommit);
        await git(projectRoot, ["fetch", "origin", "main"]);
        await git(projectRoot, ["merge-base", "--is-ancestor", finalSealedCommit, "origin/main"]);
        await git(projectRoot, ["merge-base", "--is-ancestor", targetHeadAfterRepairStarted, "origin/main"]);
        assertEquals(await git(projectRoot, ["show", "origin/main:conflict.txt"]), "resolved");
        assertEquals(await git(projectRoot, ["show", "origin/main:final-lifecycle.txt"]), "recorded after repair");
        assertEquals(
            await git(projectRoot, ["show", "origin/main:arrived-during-repair.txt"]),
            "must survive publication retry",
        );
        repairRoot = undefined;
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        if (repairRoot) await Deno.remove(repairRoot, { recursive: true }).catch(() => {});
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("local publication retains blocking filenames for the recovery prompt", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir({ prefix: "publication-dirty-paths-" });
    const worktree = await createTestWorktreeAttempt({ projectRoot, planName: "p", worktreeRoot });
    try {
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "validated implementation\n");
        await git(worktree.path, ["add", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Validated candidate"]);
        await Deno.writeTextFile(`${projectRoot}/README.md`, "user work that must be preserved\n");
        const head = await git(projectRoot, ["rev-parse", "HEAD"]);
        const sealedExecutionCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
        const error = await assertRejects(() =>
            publishExecutionWorktreeIsolated({
                projectRoot,
                sealedExecutionCommit,
                executionCwd: worktree.path,
                executionBranch: worktree.branch,
                targetBranch: "main",
                planName: "p",
                allowedPlanPaths: [],
            }), IsolatedPublicationError);
        assertEquals(normalizePublicationFailure(error).blockingPaths, ["README.md"]);
        assertEquals(await Deno.readTextFile(`${projectRoot}/README.md`), "user work that must be preserved\n");
        assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), head);
    } finally {
        await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true });
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(worktreeRoot, { recursive: true });
    }
});

Deno.test("off-checkout local publication preserves primary Plan, context, and unrelated tracked edits", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir({ prefix: "off-checkout-publication-" });
    await git(projectRoot, ["branch", "plan/p"]);
    const worktree = await createTestWorktreeAttempt({
        projectRoot,
        planName: "p",
        worktreeRoot,
        baseBranch: "plan/p",
        baseRef: "refs/heads/plan/p",
    });
    try {
        const head = await git(projectRoot, ["rev-parse", "HEAD"]);
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        const primaryPlan = "# Untracked canonical Plan, with user prose\n";
        await Deno.writeTextFile(`${projectRoot}/docs/plans/p.md`, primaryPlan);
        await Deno.writeTextFile(`${projectRoot}/README.md`, "unrelated dirty edit\n");
        await git(projectRoot, ["add", "README.md"]);
        await Deno.writeTextFile(`${projectRoot}/.gitignore`, `user-owned primary ignore\n${RUNWIELD_GITIGNORE_BLOCK}`);
        await Deno.mkdir(`${worktree.path}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${worktree.path}/docs/plans/p.md`,
            '---\nplanId: "p"\nclassification: "PLANNED_CHANGE"\nstatus: "reviewed"\ntargetBranch: "main"\ndeliveryBranch: "plan/p"\n---\n# Delivered\n',
        );
        await Deno.writeTextFile(`${worktree.path}/implementation.txt`, "implemented\n");
        await git(worktree.path, ["add", "docs/plans/p.md", "implementation.txt"]);
        await git(worktree.path, ["commit", "-m", "Seal delivery"]);
        const index = await git(projectRoot, ["write-tree"]);
        const published = await publishExecutionWorktreeIsolated({
            projectRoot,
            executionCwd: worktree.path,
            executionBranch: worktree.branch,
            targetBranch: "plan/p",
            planName: "p",
            sealedExecutionCommit: await git(worktree.path, ["rev-parse", "HEAD"]),
            allowedPlanPaths: ["docs/plans/p.md"],
        });
        assertEquals(published.updatedPrimaryCheckout, false);
        assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(projectRoot, ["write-tree"]), index);
        assertEquals(await Deno.readTextFile(`${projectRoot}/docs/plans/p.md`), primaryPlan);
        assertEquals(await Deno.readTextFile(`${projectRoot}/README.md`), "unrelated dirty edit\n");
        assertEquals(
            await Deno.readTextFile(`${projectRoot}/.gitignore`),
            `user-owned primary ignore\n${RUNWIELD_GITIGNORE_BLOCK}`,
        );
        assertEquals(await git(projectRoot, ["show", "plan/p:implementation.txt"]), "implemented");
        assertStringIncludes(await git(projectRoot, ["show", "plan/p:docs/plans/p.md"]), 'status: "verified"');
    } finally {
        await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true });
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(worktreeRoot, { recursive: true });
    }
});
