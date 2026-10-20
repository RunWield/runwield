import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { archivePlan, getPlanDocumentRoot, listPlans } from "../../plan-store.js";
import { listEntries, refreshPlanningWorktreeBase, updateEntry } from "../worktree-registry.js";
import { enterProjectRuntime } from "../project-runtime-layout.ts";
import { loadControllerView, writeControllerState } from "./controller-registry.ts";
import { PlanningNotStartedError, resolveWorkflowPlanLocation } from "./plan-location.ts";
import { prepareSessionPlanningWorktree } from "./session-planning-worktree.ts";
import { findTargetBranchPlansByParent, preparePlanningWorktreeForPlan } from "./planning-worktree.ts";
import { listTransitionRecoveryRecords, runExecutionPreparationTransition } from "./state-transition.ts";

type PlanFixtureAttribute = string | number | boolean | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string) {
    const path = join(cwd, "docs", "plans", `${name}.md`);
    await fsMkdir(dirname(path), { recursive: true });
    const lines = ["---"];
    for (const [key, value] of Object.entries(attrs)) {
        if (Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
        } else {
            lines.push(`${key}: ${JSON.stringify(value)}`);
        }
    }
    lines.push("---", "", body);
    await fsWriteFile(path, lines.join("\n"));
}

const fixture = defineGitFixture(async (repo) => {
    await fsWriteFile(join(repo, "README.md"), "base\n");
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            complexity: "HIGH",
            status: "ready_for_work",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Epic\n",
    );
    await writePlan(
        repo,
        "epic/01-child",
        {
            planId: "plan-child-01",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "draft",
            parentPlan: "epic",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Child\n\nPRIMARY STALE MARKER\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "main stale plans"]);
    await git(repo, ["switch", "-c", "epic-target"]);
    await fsWriteFile(join(repo, "src-target-only.js"), "export const targetOnly = true;\n");
    await writePlan(
        repo,
        "epic/01-child",
        {
            planId: "plan-child-01",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "draft",
            parentPlan: "epic",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Child\n\nTARGET PLAN BODY\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "target delivered context"]);
    await git(repo, ["switch", "main"]);
});

test("planning worktree starts from the target branch and is not execution", async () => {
    const repo = await fixture.checkout();
    await fsWriteFile(join(repo, "primary-dirty.txt"), "do not touch\n");

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(result.reused, false);
    assertEquals(result.entry.status, "planning");
    assertStringIncludes(await fsReadFile(join(result.entry.path, "src-target-only.js"), "utf8"), "targetOnly");
    assertStringIncludes(result.plan.markdown, "TARGET PLAN BODY");
    assertEquals(result.plan.markdown.includes("PRIMARY STALE MARKER"), false);
    assertEquals(await fsReadFile(join(repo, "primary-dirty.txt"), "utf8"), "do not touch\n");

    const entries = await listEntries(repo);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].status, "planning");

    const view = await loadControllerView(repo, { planName: "epic/01-child", planId: "plan-child-01" }, {});
    assertEquals(view.state.documentWorktreeId, result.entry.id);
    assertEquals(view.state.worktreeId, undefined);
    assertEquals(view.state.worktreePath, undefined);
    assertEquals(view.state.worktreeStatus, undefined);
    assertEquals(view.state.executionMode, undefined);
});

test("planning identity checkpoint works before hook dependencies are installed", async () => {
    const repo = await fixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    const path = join(repo, "docs/plans/epic/01-child.md");
    await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace('planId: "plan-child-01"\n', ""));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "target child without identity"]);
    await git(repo, ["switch", "main"]);
    const hooks = join(repo, ".git/hooks");
    await fsWriteFile(join(hooks, "pre-commit"), "#!/bin/sh\nexec bun node_modules/prettier/bin/prettier.cjs\n");
    await fsChmod(join(hooks, "pre-commit"), 0o755);
    await git(repo, ["config", "core.hooksPath", hooks]);

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", { targetBranch: "epic-target" });
    assertEquals(result.entry.status, "planning");
    assertEquals(Boolean(result.plan.attrs.planId), true);
    assertEquals(await git(result.entry.path, ["status", "--porcelain"]), "");
    assertStringIncludes(
        await git(result.entry.path, ["show", "HEAD:docs/plans/epic/01-child.md"]),
        result.plan.attrs.planId!,
    );
    // The checkpoint exception must not disable hooks for ordinary commits.
    await assertRejects(
        () => git(result.entry.path, ["commit", "--allow-empty", "-m", "ordinary commit still runs hooks"]),
        Error,
        "Module not found",
    );
});

test("planning checkpoints respect relative custom hook configuration without requiring project setup", async () => {
    const repo = await fixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    const path = join(repo, "docs/plans/epic/01-child.md");
    await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace('planId: "plan-child-01"\n', ""));
    await fsMkdir(join(repo, ".checks"));
    const hook = join(repo, ".checks/prepare-commit-msg");
    await fsWriteFile(hook, "#!/bin/sh\necho 'custom project setup is required' >&2\nexit 17\n");
    await fsChmod(hook, 0o755);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "custom hook and anonymous child"]);
    await git(repo, ["switch", "main"]);
    await git(repo, ["config", "core.hooksPath", ".checks"]);
    const primaryHead = await git(repo, ["rev-parse", "HEAD"]);

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", { targetBranch: "epic-target" });
    assertEquals(result.entry.status, "planning");
    assertEquals(Boolean(result.plan.attrs.planId), true);
    assertEquals(await git(result.entry.path, ["config", "--get", "core.hooksPath"]), ".checks");
    assertEquals(await git(repo, ["rev-parse", "HEAD"]), primaryHead);
    // prepare-commit-msg also runs with --no-verify; only the internal checkpoint is exempt.
    await assertRejects(
        () => git(result.entry.path, ["commit", "--no-verify", "--allow-empty", "-m", "normal commit"]),
        Error,
        "custom project setup is required",
    );
});

test("planning refresh preserves edits and imports publication before hook dependencies are installed", async () => {
    const repo = await fixture.checkout();
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const path = join(first.entry.path, "docs/plans/epic/01-child.md");
    await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace("TARGET PLAN BODY", "SAVED PLANNER EDIT"));
    await git(repo, ["switch", "epic-target"]);
    await fsWriteFile(join(repo, "new-publication.js"), "export const published = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "publish target code"]);
    await git(repo, ["switch", "main"]);
    const hooks = join(repo, ".git/hooks");
    await fsWriteFile(join(hooks, "pre-commit"), "#!/bin/sh\nexec bun node_modules/prettier/bin/prettier.cjs\n");
    await fsChmod(join(hooks, "pre-commit"), 0o755);
    await git(repo, ["config", "core.hooksPath", hooks]);

    const refreshed = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    assertEquals(refreshed.entry.id, first.entry.id);
    assertEquals(refreshed.entry.status, "planning");
    assertStringIncludes(refreshed.plan.markdown, "SAVED PLANNER EDIT");
    assertStringIncludes(await fsReadFile(join(refreshed.entry.path, "new-publication.js"), "utf8"), "published");
    assertEquals(await git(refreshed.entry.path, ["status", "--porcelain"]), "");
});

for (const legacyAuthority of [false, true]) {
    test(`session start retries a rolled-back anonymous planning creation${legacyAuthority ? " with legacy ownership" : ""}`, async () => {
        const repo = await fixture.checkout();
        await git(repo, ["switch", "epic-target"]);
        const path = join(repo, "docs/plans/epic/01-child.md");
        await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace('planId: "plan-child-01"\n', ""));
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "target child without identity"]);
        await git(repo, ["switch", "main"]);
        await git(repo, ["config", "gpg.program", "runwield-test-signing-program-does-not-exist"]);
        await git(repo, ["config", "commit.gpgSign", "true"]);
        await assertRejects(
            () => preparePlanningWorktreeForPlan(repo, "epic/01-child", { targetBranch: "epic-target" }),
            Error,
            "gpg failed to sign",
        );
        const [failed] = await listEntries(repo);
        assertEquals(failed.status, "abandoned");
        if (legacyAuthority) {
            // Earlier versions published document ownership before preparation completed.
            await writeControllerState(
                repo,
                { planName: failed.planName, planId: failed.planId },
                {
                    documentWorktreeId: failed.id,
                },
            );
        }
        await git(repo, ["config", "commit.gpgSign", "false"]);

        const snapshot = await resolveWorkflowPlanLocation(repo, "epic/01-child", {
            loadFromTarget: true,
            readOnly: true,
        });
        assertEquals(snapshot.documentRoot, repo);
        assertEquals((await listEntries(repo)).filter((entry) => entry.status === "planning").length, 0);
        const loaded = await prepareSessionPlanningWorktree(repo, "epic/01-child");
        assertEquals(Boolean(loaded.plan?.attrs.planId), true);
        assertEquals(loaded.documentRoot === repo, false);
        assertEquals(loaded.documentRoot === failed.path, false);
        assertStringIncludes(loaded.plan!.markdown, "TARGET PLAN BODY");
        assertEquals((await listEntries(repo)).filter((entry) => entry.status === "planning").length, 1);
    });
}

test("explicit loading keeps the created planning document when its target copy is removed", async () => {
    const repo = await fixture.checkout();
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const path = join(first.entry.path, "docs/plans/epic/01-child.md");
    await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace("TARGET PLAN BODY", "WORKTREE OWNS THIS PLAN"));
    await git(repo, ["switch", "epic-target"]);
    await git(repo, ["rm", "docs/plans/epic/01-child.md"]);
    await git(repo, ["commit", "-m", "remove target copy"]);
    await git(repo, ["switch", "main"]);

    const loaded = await resolveWorkflowPlanLocation(repo, "epic/01-child", { loadFromTarget: true });
    assertEquals(loaded.documentRoot, first.entry.path);
    assertEquals(loaded.plan?.attrs.planId, "plan-child-01");
    assertStringIncludes(loaded.plan!.markdown, "WORKTREE OWNS THIS PLAN");
});

test("a missing established document is not replaced by the source after retirement", async () => {
    const repo = await fixture.checkout();
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    await updateEntry(repo, first.entry.id, { status: "abandoned" });
    await git(repo, ["worktree", "remove", "--force", first.entry.path]);
    // An identified Plan at the original base is established evidence, not failed ID onboarding.
    await git(repo, ["branch", "--force", first.entry.branch, first.entry.baseCommit]);
    await assertRejects(
        () => resolveWorkflowPlanLocation(repo, "epic/01-child", { loadFromTarget: true }),
        Error,
        "The registered Plan is missing or has a different identity",
    );
});

test("planning worktree resume reuses saved Plan edits", async () => {
    const repo = await fixture.checkout();
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(first.entry.path, "docs", "plans", "epic", "01-child.md");
    await fsWriteFile(planPath, (await fsReadFile(planPath, "utf8")).replace("TARGET PLAN BODY", "SAVED PLANNER EDIT"));

    const second = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(second.reused, true);
    assertEquals(second.entry.id, first.entry.id);
    assertStringIncludes(second.plan.markdown, "SAVED PLANNER EDIT");
});

async function remotePublication(repo: string) {
    const remote = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "main", "epic-target"]);
    const publisher = await fixture.checkout();
    await git(publisher, ["remote", "add", "origin", remote]);
    await git(publisher, ["switch", "epic-target"]);
    return publisher;
}

async function publishPreviousChild(publisher: string) {
    await fsWriteFile(join(publisher, "previous-child.js"), "export const delivered = true;\n");
    const parentPath = join(publisher, "docs/plans/epic.md");
    await fsWriteFile(
        parentPath,
        (await fsReadFile(parentPath, "utf8")).replace('status: "ready_for_work"', 'status: "implemented"'),
    );
    await git(publisher, ["add", "."]);
    await git(publisher, ["commit", "-m", "publish previous child"]);
    await git(publisher, ["push", "origin", "epic-target"]);
    return await git(publisher, ["rev-parse", "HEAD"]);
}

test("new child planning fetches remote publication despite dirty primary Plan status", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const published = await publishPreviousChild(publisher);
    const parentPath = join(repo, "docs/plans/epic.md");
    const dirtyParent = (await fsReadFile(parentPath, "utf8")).replace('status: "ready_for_work"', 'status: "draft"');
    await fsWriteFile(parentPath, dirtyParent);
    const primaryHead = await git(repo, ["rev-parse", "HEAD"]);

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(result.entry.baseCommit, published);
    assertStringIncludes(await fsReadFile(join(result.entry.path, "previous-child.js"), "utf8"), "delivered");
    assertEquals(await fsReadFile(parentPath, "utf8"), dirtyParent);
    assertEquals(await git(repo, ["rev-parse", "HEAD"]), primaryHead);
});

test("reused child planning imports remote publication and preserves its saved Plan status and scope", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(first.entry.path, "docs/plans/epic/01-child.md");
    await fsWriteFile(
        planPath,
        (await fsReadFile(planPath, "utf8"))
            .replace('status: "draft"', 'status: "approved"')
            .replace("TARGET PLAN BODY", "SAVED PLANNER EDIT"),
    );
    const parentPath = join(first.entry.path, "docs/plans/epic.md");
    await fsWriteFile(
        parentPath,
        (await fsReadFile(parentPath, "utf8")).replace('status: "ready_for_work"', 'status: "draft"'),
    );
    const published = await publishPreviousChild(publisher);

    const second = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(second.reused, true);
    assertEquals(second.entry.id, first.entry.id);
    assertStringIncludes(await fsReadFile(join(second.entry.path, "previous-child.js"), "utf8"), "delivered");
    assertEquals(second.entry.baseCommit, published);
    assertEquals(second.plan.attrs.status, "approved");
    assertStringIncludes(second.plan.markdown, "SAVED PLANNER EDIT");
    assertStringIncludes(await fsReadFile(parentPath, "utf8"), "implemented");
    await git(second.entry.path, ["merge-base", "--is-ancestor", published, "HEAD"]);
    const again = await preparePlanningWorktreeForPlan(repo, "epic/01-child", second.plan.attrs);
    assertEquals(again.entry.baseCommit, published);
    assertEquals(again.plan.attrs.status, "approved");
});

test("reused planning stops on fetch failure without changing saved work", async () => {
    const repo = await fixture.checkout();
    await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const head = await git(first.entry.path, ["rev-parse", "HEAD"]);
    await git(repo, ["remote", "set-url", "origin", join(repo, "unavailable.git")]);
    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "Could not refresh target branch",
    );
    assertEquals(await git(first.entry.path, ["rev-parse", "HEAD"]), head);
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

test("planning refresh preserves incompatible scope edits without leaving a conflicted checkout", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const relativePath = "docs/plans/epic/01-child.md";
    const saved = (await fsReadFile(join(first.entry.path, relativePath), "utf8")).replace(
        "TARGET PLAN BODY",
        "LOCAL SCOPE",
    );
    await fsWriteFile(join(first.entry.path, relativePath), saved);
    await fsWriteFile(
        join(publisher, relativePath),
        (await fsReadFile(join(publisher, relativePath), "utf8")).replace("TARGET PLAN BODY", "PUBLISHED SCOPE"),
    );
    const published = await publishPreviousChild(publisher);
    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "planning scope conflicts",
    );
    assertEquals(await fsReadFile(join(first.entry.path, relativePath), "utf8"), saved);
    assertStringIncludes(await git(repo, ["show", `${published}:${relativePath}`]), "PUBLISHED SCOPE");
    assertEquals(await git(first.entry.path, ["diff", "--name-only", "--diff-filter=U"]), "");
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

test("planning refresh does not overwrite implementation already in the checkout", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const path = join(first.entry.path, "src-target-only.js");
    await fsWriteFile(path, "saved implementation\n");
    await publishPreviousChild(publisher);
    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "already contains implementation changes",
    );
    assertEquals(await fsReadFile(path, "utf8"), "saved implementation\n");
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

async function rewritePublishedTarget(publisher: string) {
    await fsWriteFile(join(publisher, "src-target-only.js"), "export const rewrittenTarget = true;\n");
    await git(publisher, ["add", "."]);
    await git(publisher, ["commit", "--amend", "-m", "rewritten target context"]);
    await git(publisher, ["push", "--force", "origin", "epic-target"]);
    return await git(publisher, ["rev-parse", "HEAD"]);
}

test("planning refresh replants saved edits after the target branch is rewritten", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const relativePath = "docs/plans/epic/01-child.md";
    const saved = (await fsReadFile(join(first.entry.path, relativePath), "utf8"))
        .replace("TARGET PLAN BODY", "SAVED PLANNER EDIT")
        .replace('status: "draft"', 'status: "approved"');
    await fsWriteFile(join(first.entry.path, relativePath), saved);
    // The published target already has the owned ignore rules in the reported incident.
    await fsWriteFile(join(publisher, ".gitignore"), await fsReadFile(join(first.entry.path, ".gitignore")));
    const published = await rewritePublishedTarget(publisher);

    const second = await preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs);

    assertEquals(second.entry.id, first.entry.id);
    assertEquals(second.entry.baseCommit, published);
    assertEquals(second.entry.baseRef, published);
    assertEquals(second.entry.baseTree, await git(repo, ["rev-parse", `${published}^{tree}`]));
    assertEquals(second.plan.attrs.status, "approved");
    assertStringIncludes(second.plan.markdown, "SAVED PLANNER EDIT");
    assertEquals(await git(second.entry.path, ["log", "-1", "--format=%P"]), published);
    assertEquals(await git(second.entry.path, ["diff", "--name-only", published, "HEAD"]), relativePath);
    const backup = `refs/runwield/planning-replaced/${first.entry.id}`;
    assertStringIncludes(await git(repo, ["show", `${backup}:${relativePath}`]), "SAVED PLANNER EDIT");
    await git(repo, ["merge-base", "--is-ancestor", first.entry.baseCommit, backup]);
    assertEquals(await git(second.entry.path, ["status", "--porcelain"]), "");
});

test("rewritten target with a conflicting Plan edit refuses without changes", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const relativePath = "docs/plans/epic/01-child.md";
    const path = join(first.entry.path, relativePath);
    const saved = (await fsReadFile(path, "utf8")).replace("TARGET PLAN BODY", "LOCAL SCOPE");
    await fsWriteFile(path, saved);
    await fsWriteFile(
        join(publisher, relativePath),
        (await fsReadFile(join(publisher, relativePath), "utf8")).replace("TARGET PLAN BODY", "PUBLISHED SCOPE"),
    );
    await rewritePublishedTarget(publisher);
    const head = await git(first.entry.path, ["rev-parse", "HEAD"]);
    const status = await git(first.entry.path, ["status", "--porcelain"]);
    const index = await git(first.entry.path, ["write-tree"]);
    const refs = await git(repo, ["for-each-ref", `refs/runwield/planning-replaced/${first.entry.id}`]);

    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        `Cannot refresh ${relativePath}: planning scope conflicts`,
    );

    assertEquals(await git(first.entry.path, ["rev-parse", "HEAD"]), head);
    assertEquals(await git(first.entry.path, ["status", "--porcelain"]), status);
    assertEquals(await git(first.entry.path, ["write-tree"]), index);
    assertEquals(await fsReadFile(path, "utf8"), saved);
    assertEquals(await git(repo, ["for-each-ref", `refs/runwield/planning-replaced/${first.entry.id}`]), refs);
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

test("rewritten target keeps implementation and explains the rewrite", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const path = join(first.entry.path, "saved-implementation.js");
    await fsWriteFile(path, "saved implementation\n");
    await rewritePublishedTarget(publisher);
    const head = await git(first.entry.path, ["rev-parse", "HEAD"]);

    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "branch was rewritten after planning started",
    );
    assertEquals(await fsReadFile(path, "utf8"), "saved implementation\n");
    assertEquals(await git(first.entry.path, ["rev-parse", "HEAD"]), head);
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

test("preparing twice after a target rewrite reuses the same planning commit", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    await rewritePublishedTarget(publisher);
    const second = await preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs);
    const head = await git(second.entry.path, ["rev-parse", "HEAD"]);

    const again = await preparePlanningWorktreeForPlan(repo, "epic/01-child", second.plan.attrs);

    assertEquals(again.entry, second.entry);
    assertEquals(await git(again.entry.path, ["rev-parse", "HEAD"]), head);
});

test("replanted planning history settles an interrupted registry update without another commit", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const path = join(first.entry.path, "docs/plans/epic/01-child.md");
    await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace("TARGET PLAN BODY", "SAVED PLANNER EDIT"));
    const published = await rewritePublishedTarget(publisher);
    const refreshed = await preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs);
    const head = await git(refreshed.entry.path, ["rev-parse", "HEAD"]);
    // Recreate the durable boundary: the new Git commit exists, but the registry still has the old base.
    await refreshPlanningWorktreeBase(repo, first.entry.id, published, {
        baseRef: first.entry.baseRef,
        baseCommit: first.entry.baseCommit,
        baseTree: await git(repo, ["rev-parse", `${first.entry.baseCommit}^{tree}`]),
    });

    const resumed = await preparePlanningWorktreeForPlan(repo, "epic/01-child", refreshed.plan.attrs);

    assertEquals(resumed.entry.baseCommit, published);
    assertEquals(await git(resumed.entry.path, ["rev-parse", "HEAD"]), head);
    assertStringIncludes(resumed.plan.markdown, "SAVED PLANNER EDIT");
});

test("rewritten planning branch refuses without touching saved state", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    await publishPreviousChild(publisher);
    // Rewrite only this disposable planning branch, not the target.
    await fsWriteFile(join(first.entry.path, "docs/plans/epic/01-child.md"), first.plan.markdown + "\nSAVED SCOPE\n");
    await git(first.entry.path, ["reset", "--soft", first.entry.baseCommit]);
    await git(first.entry.path, ["add", "."]);
    await git(first.entry.path, ["commit", "--amend", "-m", "rewrite planning history"]);
    const head = await git(first.entry.path, ["rev-parse", "HEAD"]);
    const saved = await fsReadFile(join(first.entry.path, "docs/plans/epic/01-child.md"), "utf8");

    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "planning branch history no longer contains its recorded base",
    );

    assertEquals(await git(first.entry.path, ["rev-parse", "HEAD"]), head);
    assertEquals(await fsReadFile(join(first.entry.path, "docs/plans/epic/01-child.md"), "utf8"), saved);
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

test("replant carries new drafts, deleted Plans, and binary planning assets without replaying old target code", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const draft = "docs/plans/epic/new-draft.md";
    await fsWriteFile(join(first.entry.path, draft), "# New draft\n");
    const binary = "docs/plans/diagram.bin";
    const bytes = new Uint8Array([0, 255, 128, 10]);
    await fsWriteFile(join(first.entry.path, binary), bytes);
    await fsRm(join(first.entry.path, "docs/plans/epic.md"));
    const published = await rewritePublishedTarget(publisher);

    const refreshed = await preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs);

    assertEquals(await fsReadFile(join(refreshed.entry.path, draft), "utf8"), "# New draft\n");
    assertEquals(new Uint8Array(await fsReadFile(join(refreshed.entry.path, binary))), bytes);
    assertEquals(await git(refreshed.entry.path, ["ls-tree", "HEAD", "--", "docs/plans/epic.md"]), "");
    assertEquals(
        await fsReadFile(join(refreshed.entry.path, "src-target-only.js"), "utf8"),
        "export const rewrittenTarget = true;\n",
    );
    assertEquals(await git(refreshed.entry.path, ["log", "-1", "--format=%P"]), published);
});

test("replant does not overwrite ignored local files with rewritten target files", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    await fsWriteFile(join(publisher, ".gitignore"), "local-cache.txt\n");
    await publishPreviousChild(publisher);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    await fsWriteFile(join(first.entry.path, "local-cache.txt"), "valuable ignored content\n");
    await fsWriteFile(join(publisher, "local-cache.txt"), "new published content\n");
    await git(publisher, ["add", "-f", "local-cache.txt"]);
    await rewritePublishedTarget(publisher);
    const head = await git(first.entry.path, ["rev-parse", "HEAD"]);

    await assertRejects(() => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs));

    assertEquals(await fsReadFile(join(first.entry.path, "local-cache.txt"), "utf8"), "valuable ignored content\n");
    assertEquals(await git(first.entry.path, ["rev-parse", "HEAD"]), head);
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

for (const afterRegistryUpdate of [false, true]) {
    test(`replant resumes through a real interrupted transition journal ${afterRegistryUpdate ? "after" : "before"} registry settlement`, async () => {
        const repo = await fixture.checkout();
        const publisher = await remotePublication(repo);
        const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
            planId: "plan-child-01",
            targetBranch: "epic-target",
        });
        const relativePath = "docs/plans/epic/01-child.md";
        await fsWriteFile(
            join(publisher, relativePath),
            (await fsReadFile(join(publisher, relativePath), "utf8")).replace(
                'complexity: "MEDIUM"',
                'complexity: "HIGH"',
            ),
        );
        const target = await rewritePublishedTarget(publisher);
        await fsWriteFile(
            join(first.entry.path, relativePath),
            (await fsReadFile(join(first.entry.path, relativePath), "utf8")).replace(
                "TARGET PLAN BODY",
                "SAVED LOCAL SCOPE",
            ),
        );
        const refreshed = await preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs);
        const beforeHead = await git(repo, ["rev-parse", `refs/runwield/planning-replaced/${first.entry.id}`]);
        const afterHead = await git(first.entry.path, ["rev-parse", "HEAD"]);
        await git(first.entry.path, ["reset", "--keep", beforeHead]);
        await refreshPlanningWorktreeBase(repo, first.entry.id, target, {
            baseRef: first.entry.baseRef,
            baseCommit: first.entry.baseCommit,
            baseTree: await git(repo, ["rev-parse", `${first.entry.baseCommit}^{tree}`]),
        });
        // Use the real transition writer and Git move to retain the journal from a failed refresh.
        const interrupted = await runExecutionPreparationTransition({
            projectRoot: first.entry.path,
            planName: first.entry.planName,
            worktreeId: first.entry.id,
            targetRef: first.entry.baseBranch,
            expectedPlanEvent: false,
            prepare: async ({ markEffect }) => {
                await markEffect("planning_refresh_prepared", { worktreeId: first.entry.id, beforeHead, afterHead });
                await git(first.entry.path, ["reset", "--keep", afterHead]);
                if (afterRegistryUpdate) {
                    await refreshPlanningWorktreeBase(repo, first.entry.id, first.entry.baseCommit, {
                        baseRef: target,
                        baseCommit: target,
                        baseTree: await git(repo, ["rev-parse", `${target}^{tree}`]),
                    });
                    await markEffect("planning_target_refreshed", { worktreeId: first.entry.id, baseCommit: target });
                }
                throw new Error("Interrupted refresh");
            },
        });
        assertEquals(interrupted.status, "needs_recovery");
        assertEquals((await listTransitionRecoveryRecords(first.entry.path)).length, 1);

        const resumed = await preparePlanningWorktreeForPlan(repo, "epic/01-child", refreshed.plan.attrs);

        assertEquals(resumed.entry.baseCommit, target);
        assertEquals(resumed.plan.attrs.complexity, "HIGH");
        assertStringIncludes(resumed.plan.markdown, "SAVED LOCAL SCOPE");
        assertEquals(await git(resumed.entry.path, ["rev-parse", "HEAD"]), afterHead);
        assertEquals(await listTransitionRecoveryRecords(first.entry.path), []);
    });
}

test("an editor save during replant is kept and used on retry", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const relativePath = "docs/plans/epic/01-child.md";
    await fsWriteFile(join(publisher, ".gitattributes"), `${relativePath} filter=editor\n`);
    await publishPreviousChild(publisher);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    await rewritePublishedTarget(publisher);
    const path = join(first.entry.path, relativePath);
    await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace("TARGET PLAN BODY", "SAVED PLANNER EDIT"));
    const scratch = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const filter = join(scratch, "editor.mjs");
    await fsWriteFile(
        filter,
        `
        import { readFile, writeFile } from "node:fs/promises";
        let content = "";
        for await (const chunk of process.stdin) content += chunk;
        const path = process.argv[2];
        const saved = await readFile(path, "utf8");
        if (saved.includes("SAVED PLANNER EDIT")) {
            await writeFile(path, saved.replace("SAVED PLANNER EDIT", "EDITOR SAVE DURING REFRESH"));
        }
        process.stdout.write(content);
    `,
    );
    await git(repo, ["config", "filter.editor.clean", `"${execPath}" "${filter}" "${path}"`]);
    await git(repo, ["config", "filter.editor.required", "true"]);

    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "saved files changed during refresh",
    );

    assertStringIncludes(await fsReadFile(path, "utf8"), "EDITOR SAVE DURING REFRESH");
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
    const resumed = await preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs);
    assertStringIncludes(resumed.plan.markdown, "EDITOR SAVE DURING REFRESH");
});

test("unreadable recorded ancestry preserves the planning worktree instead of treating it as a rewrite", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    await rewritePublishedTarget(publisher);
    const missingCommit = "0000000000000000000000000000000000000000";
    await refreshPlanningWorktreeBase(repo, first.entry.id, first.entry.baseCommit, {
        baseRef: missingCommit,
        baseCommit: missingCommit,
        baseTree: await git(repo, ["rev-parse", `${first.entry.baseCommit}^{tree}`]),
    });
    const head = await git(first.entry.path, ["rev-parse", "HEAD"]);
    const saved = await fsReadFile(join(first.entry.path, "docs/plans/epic/01-child.md"), "utf8");

    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "Could not check planning branch history",
    );

    assertEquals(await git(first.entry.path, ["rev-parse", "HEAD"]), head);
    assertEquals(await fsReadFile(join(first.entry.path, "docs/plans/epic/01-child.md"), "utf8"), saved);
    assertEquals((await listEntries(repo))[0].baseCommit, missingCommit);
    assertEquals(await git(repo, ["for-each-ref", `refs/runwield/planning-replaced/${first.entry.id}`]), "");
});

test("first Epic child planning starts from a new target branch", async () => {
    const repo = await fixture.checkout();
    const remote = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "main"]);
    const mainCommit = await git(repo, ["rev-parse", "main"]);

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "new-target",
    });

    assertEquals(result.entry.baseCommit, mainCommit);
    assertEquals(await git(repo, ["rev-parse", "new-target"]), mainCommit);
    assertStringIncludes(result.plan.markdown, "PRIMARY STALE MARKER");
});

test("first Epic child uses the remote default branch, not local main", async () => {
    const repo = await fixture.checkout();
    const remote = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    await git(remote, ["init", "--bare", "--initial-branch=trunk"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "main:trunk"]);
    await git(repo, ["switch", "-c", "trunk"]);
    await fsWriteFile(join(repo, "trunk-only.txt"), "default branch\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "advance default branch"]);
    await git(repo, ["push", "origin", "trunk"]);
    const defaultCommit = await git(repo, ["rev-parse", "trunk"]);
    await git(repo, ["switch", "main"]);

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "new-target",
    });

    assertEquals(result.entry.baseCommit, defaultCommit);
    assertEquals(await git(repo, ["rev-parse", "new-target"]), defaultCommit);
});

test("target child catalog uses saved planning documents over target branch copies", async () => {
    const repo = await fixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(planning.entry.path, "docs", "plans", "epic", "01-child.md");
    await fsWriteFile(planPath, (await fsReadFile(planPath, "utf8")).replace('status: "draft"', 'status: "approved"'));

    const children = await findTargetBranchPlansByParent(repo, "epic-target", "epic");

    assertEquals(children.length, 1);
    assertEquals(children[0].attrs.status, "approved");
    assertEquals(children[0].path, join(planning.entry.path, "docs", "plans", "epic", "01-child.md"));
});

test("target document is selected before stale primary copy", async () => {
    const repo = await fixture.checkout();

    await assertRejects(() => resolveWorkflowPlanLocation(repo, "epic/01-child"), PlanningNotStartedError);
    assertEquals(await listEntries(repo), []);
    await prepareSessionPlanningWorktree(repo, "epic/01-child");
    const location = await resolveWorkflowPlanLocation(repo, "epic/01-child");

    assertStringIncludes(location.plan?.markdown || "", "TARGET PLAN BODY");
    assertEquals(location.plan?.markdown.includes("PRIMARY STALE MARKER"), false);
});

test("planning document is selected by load and catalog", async () => {
    const repo = await fixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(planning.entry.path, "docs", "plans", "epic", "01-child.md");
    await fsWriteFile(planPath, (await fsReadFile(planPath, "utf8")).replace("TARGET PLAN BODY", "SAVED CATALOG BODY"));

    const location = await resolveWorkflowPlanLocation(repo, "epic/01-child");
    const plans = await listPlans(repo);
    const listed = plans.find((item) => item.name === "epic/01-child");

    assertEquals(location.documentRoot, planning.entry.path);
    assertStringIncludes(location.plan?.markdown || "", "SAVED CATALOG BODY");
    assertEquals(listed?.path, planPath);
});

test("planning preparation stops when target fetch fails", async () => {
    const repo = await fixture.checkout();
    await git(repo, ["update-ref", "refs/remotes/origin/epic-target", "epic-target"]);
    await git(repo, ["remote", "add", "origin", join(repo, "missing-remote.git")]);

    await assertRejects(
        () =>
            preparePlanningWorktreeForPlan(repo, "epic/01-child", {
                planId: "plan-child-01",
                targetBranch: "epic-target",
            }),
        Error,
        "Could not refresh target branch",
    );

    assertEquals((await listEntries(repo)).length, 0);
});

test("target discovery errors stop the catalog before stale overlays", async () => {
    const repo = await fixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    await writePlan(
        repo,
        "epic/01-child",
        {
            planId: "different-child-id",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "draft",
            parentPlan: "epic",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Child\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "break target identity"]);
    await git(repo, ["switch", "main"]);

    await assertRejects(() => listPlans(repo), Error, "Target Plan epic/01-child has a different Plan ID");
});

test("planning preparation serializes duplicate callers", async () => {
    const repo = await fixture.checkout();
    await enterProjectRuntime(repo);

    const [first, second] = await Promise.all([
        preparePlanningWorktreeForPlan(repo, "epic/01-child", {
            planId: "plan-child-01",
            targetBranch: "epic-target",
        }),
        preparePlanningWorktreeForPlan(repo, "epic/01-child", {
            planId: "plan-child-01",
            targetBranch: "epic-target",
        }),
    ]);

    assertEquals(first.entry.id, second.entry.id);
    assertEquals((await listEntries(repo)).length, 1);
});

test("planning preparation returns live execution instead of registering twice", async () => {
    const repo = await fixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    await updateEntry(repo, planning.entry.id, { status: "active" });

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(result.reused, true);
    assertEquals(result.entry.id, planning.entry.id);
    assertEquals((await listEntries(repo)).length, 1);
});

const standaloneLandingFixture = defineGitFixture(async (repo) => {
    await writePlan(
        repo,
        "standalone",
        {
            planId: "standalone-recovery",
            classification: "PLANNED_CHANGE",
            status: "draft",
            targetBranch: "main",
            deliveryBranch: "plan/standalone",
        },
        "# Standalone\n\nPRIMARY BODY\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "primary plan"]);
    await git(repo, ["switch", "-c", "plan/standalone"]);
    await writePlan(
        repo,
        "standalone",
        {
            planId: "standalone-recovery",
            classification: "PLANNED_CHANGE",
            status: "draft",
            targetBranch: "main",
            deliveryBranch: "plan/standalone",
        },
        "# Standalone\n\nLANDING BODY\n",
    );
    await fsWriteFile(join(repo, "landing-only.txt"), "landing context\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "unfinished landing"]);
    await git(repo, ["switch", "main"]);
});

test("unfinished standalone without an attempt recovers planning from its recorded landing", async () => {
    const repo = await standaloneLandingFixture.checkout();
    const path = join(repo, "docs/plans/standalone.md");
    const original = await fsReadFile(path, "utf8");
    const readOnly = await resolveWorkflowPlanLocation(repo, "standalone", { readOnly: true });
    assertEquals(readOnly.plan?.path, path);
    assertEquals(await listEntries(repo), []);
    assertEquals(readOnly.planningNotStarted, true);
    await assertRejects(() => resolveWorkflowPlanLocation(repo, "standalone"), PlanningNotStartedError);
    assertEquals(await listEntries(repo), []);
    const recovered = await prepareSessionPlanningWorktree(repo, "standalone");
    assertEquals((await listEntries(repo))[0].baseBranch, "plan/standalone");
    assertEquals((await listEntries(repo))[0].status, "planning");
    assertEquals(recovered.plan?.attrs.targetBranch, "main");
    assertEquals(recovered.plan?.attrs.deliveryBranch, "plan/standalone");
    assertStringIncludes(recovered.plan?.body || "", "LANDING BODY");
    assertEquals(await fsReadFile(join(recovered.documentRoot, "landing-only.txt"), "utf8"), "landing context\n");
    assertEquals(await fsReadFile(path, "utf8"), original);
    assertEquals((await resolveWorkflowPlanLocation(repo, "standalone")).documentRoot, recovered.documentRoot);
});

test("session preparation fetches a recorded standalone landing absent from local refs", async () => {
    const repo = await standaloneLandingFixture.checkout();
    const remote = await fsMkdtemp(join(tmpdir(), "standalone-remote-"));
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "plan/standalone"]);
    await git(repo, ["update-ref", "-d", "refs/heads/plan/standalone"]);
    await git(repo, ["update-ref", "-d", "refs/remotes/origin/plan/standalone"]);
    const refs = await git(repo, ["show-ref"]);
    const snapshot = await resolveWorkflowPlanLocation(repo, "standalone", { readOnly: true });
    assertEquals(snapshot.planningNotStarted, true);
    assertEquals(await git(repo, ["show-ref"]), refs);
    const prepared = await prepareSessionPlanningWorktree(repo, "standalone");
    assertStringIncludes(prepared.plan?.body || "", "LANDING BODY");
    assertEquals((await listEntries(repo)).length, 1);
});

test("published-only read snapshots cannot be used as archive document paths", async () => {
    const repo = await fixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    await writePlan(
        repo,
        "epic/01-child",
        {
            planId: "plan-child-01",
            classification: "FEATURE",
            status: "user_verified",
            parentPlan: "epic",
            targetBranch: "epic-target",
        },
        "# Published child\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "published child"]);
    await git(repo, ["switch", "main"]);
    const path = join(repo, "docs/plans/epic/01-child.md");
    await fsRm(path);
    const snapshot = await resolveWorkflowPlanLocation(repo, "epic/01-child", { readOnly: true });
    assertEquals(snapshot.plan?.attrs.status, "user_verified");
    assertEquals("publishedSnapshot" in snapshot && snapshot.publishedSnapshot, true);
    assertThrows(() => getPlanDocumentRoot(snapshot.plan?.path || ""), Error, "not a writable document path");
    assertEquals(await listEntries(repo), []);
    await assertRejects(() => archivePlan(repo, "epic/01-child"), Error, "published read snapshot");
    assertEquals(
        await fsStat(path)
            .then(() => true)
            .catch(() => false),
        false,
    );
    assertEquals(await listEntries(repo), []);
});
