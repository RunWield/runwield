import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { archivePlan, getPlanDocumentRoot, listPlans } from "../../plan-store.js";
import { listEntries, updateEntry } from "../worktree-registry.js";
import { enterProjectRuntime } from "../project-runtime-layout.ts";
import { loadControllerView } from "./controller-registry.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { findTargetBranchPlansByParent, preparePlanningWorktreeForPlan } from "./planning-worktree.ts";

type PlanFixtureAttribute = string | number | boolean | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string) {
    const path = join(cwd, "docs", "plans", `${name}.md`);
    await Deno.mkdir(dirname(path), { recursive: true });
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
    await Deno.writeTextFile(path, lines.join("\n"));
}

const fixture = defineGitFixture(async (repo) => {
    await Deno.writeTextFile(join(repo, "README.md"), "base\n");
    await writePlan(repo, "epic", {
        planId: "plan-epic",
        classification: "PROJECT",
        complexity: "HIGH",
        status: "ready_for_work",
        targetBranch: "epic-target",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    }, "# Epic\n");
    await writePlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "draft",
        parentPlan: "epic",
        targetBranch: "epic-target",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    }, "# Child\n\nPRIMARY STALE MARKER\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "main stale plans"]);
    await git(repo, ["switch", "-c", "epic-target"]);
    await Deno.writeTextFile(join(repo, "src-target-only.js"), "export const targetOnly = true;\n");
    await writePlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "draft",
        parentPlan: "epic",
        targetBranch: "epic-target",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    }, "# Child\n\nTARGET PLAN BODY\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "target delivered context"]);
    await git(repo, ["switch", "main"]);
});

Deno.test("planning worktree starts from the target branch and is not execution", async () => {
    const repo = await fixture.checkout();
    await Deno.writeTextFile(join(repo, "primary-dirty.txt"), "do not touch\n");

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(result.reused, false);
    assertEquals(result.entry.status, "planning");
    assertStringIncludes(await Deno.readTextFile(join(result.entry.path, "src-target-only.js")), "targetOnly");
    assertStringIncludes(result.plan.markdown, "TARGET PLAN BODY");
    assertEquals(result.plan.markdown.includes("PRIMARY STALE MARKER"), false);
    assertEquals(await Deno.readTextFile(join(repo, "primary-dirty.txt")), "do not touch\n");

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

Deno.test("planning worktree resume reuses saved Plan edits", async () => {
    const repo = await fixture.checkout();
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(first.entry.path, "docs", "plans", "epic", "01-child.md");
    await Deno.writeTextFile(
        planPath,
        (await Deno.readTextFile(planPath)).replace("TARGET PLAN BODY", "SAVED PLANNER EDIT"),
    );

    const second = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(second.reused, true);
    assertEquals(second.entry.id, first.entry.id);
    assertStringIncludes(second.plan.markdown, "SAVED PLANNER EDIT");
});

async function remotePublication(repo: string) {
    const remote = await Deno.makeTempDir();
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "main", "epic-target"]);
    const publisher = await fixture.checkout();
    await git(publisher, ["remote", "add", "origin", remote]);
    await git(publisher, ["switch", "epic-target"]);
    return publisher;
}

async function publishPreviousChild(publisher: string) {
    await Deno.writeTextFile(join(publisher, "previous-child.js"), "export const delivered = true;\n");
    const parentPath = join(publisher, "docs/plans/epic.md");
    await Deno.writeTextFile(
        parentPath,
        (await Deno.readTextFile(parentPath)).replace('status: "ready_for_work"', 'status: "implemented"'),
    );
    await git(publisher, ["add", "."]);
    await git(publisher, ["commit", "-m", "publish previous child"]);
    await git(publisher, ["push", "origin", "epic-target"]);
    return await git(publisher, ["rev-parse", "HEAD"]);
}

Deno.test("new child planning fetches remote publication despite dirty primary Plan status", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const published = await publishPreviousChild(publisher);
    const parentPath = join(repo, "docs/plans/epic.md");
    const dirtyParent = (await Deno.readTextFile(parentPath)).replace('status: "ready_for_work"', 'status: "draft"');
    await Deno.writeTextFile(parentPath, dirtyParent);
    const primaryHead = await git(repo, ["rev-parse", "HEAD"]);

    const result = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(result.entry.baseCommit, published);
    assertStringIncludes(await Deno.readTextFile(join(result.entry.path, "previous-child.js")), "delivered");
    assertEquals(await Deno.readTextFile(parentPath), dirtyParent);
    assertEquals(await git(repo, ["rev-parse", "HEAD"]), primaryHead);
});

Deno.test("reused child planning imports remote publication and preserves its saved Plan status and scope", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(first.entry.path, "docs/plans/epic/01-child.md");
    await Deno.writeTextFile(
        planPath,
        (await Deno.readTextFile(planPath)).replace('status: "draft"', 'status: "approved"')
            .replace("TARGET PLAN BODY", "SAVED PLANNER EDIT"),
    );
    const parentPath = join(first.entry.path, "docs/plans/epic.md");
    await Deno.writeTextFile(
        parentPath,
        (await Deno.readTextFile(parentPath)).replace('status: "ready_for_work"', 'status: "draft"'),
    );
    const published = await publishPreviousChild(publisher);

    const second = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });

    assertEquals(second.reused, true);
    assertEquals(second.entry.id, first.entry.id);
    assertStringIncludes(await Deno.readTextFile(join(second.entry.path, "previous-child.js")), "delivered");
    assertEquals(second.entry.baseCommit, published);
    assertEquals(second.plan.attrs.status, "approved");
    assertStringIncludes(second.plan.markdown, "SAVED PLANNER EDIT");
    assertStringIncludes(await Deno.readTextFile(parentPath), "implemented");
    await git(second.entry.path, ["merge-base", "--is-ancestor", published, "HEAD"]);
    const again = await preparePlanningWorktreeForPlan(repo, "epic/01-child", second.plan.attrs);
    assertEquals(again.entry.baseCommit, published);
    assertEquals(again.plan.attrs.status, "approved");
});

Deno.test("reused planning stops on fetch failure without changing saved work", async () => {
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

Deno.test("planning refresh preserves incompatible scope edits without leaving a conflicted checkout", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const relativePath = "docs/plans/epic/01-child.md";
    const saved = (await Deno.readTextFile(join(first.entry.path, relativePath))).replace(
        "TARGET PLAN BODY",
        "LOCAL SCOPE",
    );
    await Deno.writeTextFile(join(first.entry.path, relativePath), saved);
    await Deno.writeTextFile(
        join(publisher, relativePath),
        (await Deno.readTextFile(join(publisher, relativePath))).replace("TARGET PLAN BODY", "PUBLISHED SCOPE"),
    );
    const published = await publishPreviousChild(publisher);
    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "planning scope conflicts",
    );
    assertEquals(await Deno.readTextFile(join(first.entry.path, relativePath)), saved);
    assertStringIncludes(await git(repo, ["show", `${published}:${relativePath}`]), "PUBLISHED SCOPE");
    assertEquals(await git(first.entry.path, ["diff", "--name-only", "--diff-filter=U"]), "");
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

Deno.test("planning refresh does not overwrite implementation already in the checkout", async () => {
    const repo = await fixture.checkout();
    const publisher = await remotePublication(repo);
    const first = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const path = join(first.entry.path, "src-target-only.js");
    await Deno.writeTextFile(path, "saved implementation\n");
    await publishPreviousChild(publisher);
    await assertRejects(
        () => preparePlanningWorktreeForPlan(repo, "epic/01-child", first.plan.attrs),
        Error,
        "already contains implementation changes",
    );
    assertEquals(await Deno.readTextFile(path), "saved implementation\n");
    assertEquals((await listEntries(repo))[0].baseCommit, first.entry.baseCommit);
});

Deno.test("first Epic child planning starts from a new target branch", async () => {
    const repo = await fixture.checkout();
    const remote = await Deno.makeTempDir();
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

Deno.test("first Epic child uses the remote default branch, not local main", async () => {
    const repo = await fixture.checkout();
    const remote = await Deno.makeTempDir();
    await git(remote, ["init", "--bare", "--initial-branch=trunk"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "main:trunk"]);
    await git(repo, ["switch", "-c", "trunk"]);
    await Deno.writeTextFile(join(repo, "trunk-only.txt"), "default branch\n");
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

Deno.test("target child catalog uses saved planning documents over target branch copies", async () => {
    const repo = await fixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(planning.entry.path, "docs", "plans", "epic", "01-child.md");
    await Deno.writeTextFile(
        planPath,
        (await Deno.readTextFile(planPath)).replace('status: "draft"', 'status: "approved"'),
    );

    const children = await findTargetBranchPlansByParent(repo, "epic-target", "epic");

    assertEquals(children.length, 1);
    assertEquals(children[0].attrs.status, "approved");
    assertEquals(children[0].path, join(planning.entry.path, "docs", "plans", "epic", "01-child.md"));
});

Deno.test("target document is selected before stale primary copy", async () => {
    const repo = await fixture.checkout();

    const location = await resolveWorkflowPlanLocation(repo, "epic/01-child");

    assertStringIncludes(location.plan?.markdown || "", "TARGET PLAN BODY");
    assertEquals(location.plan?.markdown.includes("PRIMARY STALE MARKER"), false);
});

Deno.test("planning document is selected by load and catalog", async () => {
    const repo = await fixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        targetBranch: "epic-target",
    });
    const planPath = join(planning.entry.path, "docs", "plans", "epic", "01-child.md");
    await Deno.writeTextFile(
        planPath,
        (await Deno.readTextFile(planPath)).replace("TARGET PLAN BODY", "SAVED CATALOG BODY"),
    );

    const location = await resolveWorkflowPlanLocation(repo, "epic/01-child");
    const plans = await listPlans(repo);
    const listed = plans.find((item) => item.name === "epic/01-child");

    assertEquals(location.documentRoot, planning.entry.path);
    assertStringIncludes(location.plan?.markdown || "", "SAVED CATALOG BODY");
    assertEquals(listed?.path, planPath);
});

Deno.test("planning preparation stops when target fetch fails", async () => {
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

Deno.test("target discovery errors stop the catalog before stale overlays", async () => {
    const repo = await fixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    await writePlan(repo, "epic/01-child", {
        planId: "different-child-id",
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "draft",
        parentPlan: "epic",
        targetBranch: "epic-target",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    }, "# Child\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "break target identity"]);
    await git(repo, ["switch", "main"]);

    await assertRejects(
        () => listPlans(repo),
        Error,
        "Target Plan epic/01-child has a different Plan ID",
    );
});

Deno.test("planning preparation serializes duplicate callers", async () => {
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

Deno.test("planning preparation returns live execution instead of registering twice", async () => {
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
    await writePlan(repo, "standalone", {
        planId: "standalone-recovery",
        classification: "PLANNED_CHANGE",
        status: "draft",
        targetBranch: "main",
        deliveryBranch: "plan/standalone",
    }, "# Standalone\n\nPRIMARY BODY\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "primary plan"]);
    await git(repo, ["switch", "-c", "plan/standalone"]);
    await writePlan(repo, "standalone", {
        planId: "standalone-recovery",
        classification: "PLANNED_CHANGE",
        status: "draft",
        targetBranch: "main",
        deliveryBranch: "plan/standalone",
    }, "# Standalone\n\nLANDING BODY\n");
    await Deno.writeTextFile(join(repo, "landing-only.txt"), "landing context\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "unfinished landing"]);
    await git(repo, ["switch", "main"]);
});

Deno.test("unfinished standalone without an attempt recovers planning from its recorded landing", async () => {
    const repo = await standaloneLandingFixture.checkout();
    const path = join(repo, "docs/plans/standalone.md");
    const original = await Deno.readTextFile(path);
    const readOnly = await resolveWorkflowPlanLocation(repo, "standalone", { readOnly: true });
    assertEquals(readOnly.plan?.path, path);
    assertEquals(await listEntries(repo), []);
    const recovered = await resolveWorkflowPlanLocation(repo, "standalone");
    assertEquals((await listEntries(repo))[0].baseBranch, "plan/standalone");
    assertEquals((await listEntries(repo))[0].status, "planning");
    assertEquals(recovered.plan?.attrs.targetBranch, "main");
    assertEquals(recovered.plan?.attrs.deliveryBranch, "plan/standalone");
    assertStringIncludes(recovered.plan?.body || "", "LANDING BODY");
    assertEquals(await Deno.readTextFile(join(recovered.documentRoot, "landing-only.txt")), "landing context\n");
    assertEquals(await Deno.readTextFile(path), original);
    assertEquals((await resolveWorkflowPlanLocation(repo, "standalone")).documentRoot, recovered.documentRoot);
});

Deno.test("published-only read snapshots cannot be used as archive document paths", async () => {
    const repo = await fixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    await writePlan(repo, "epic/01-child", {
        planId: "plan-child-01",
        classification: "FEATURE",
        status: "user_verified",
        parentPlan: "epic",
        targetBranch: "epic-target",
    }, "# Published child\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "published child"]);
    await git(repo, ["switch", "main"]);
    const path = join(repo, "docs/plans/epic/01-child.md");
    await Deno.remove(path);
    const snapshot = await resolveWorkflowPlanLocation(repo, "epic/01-child", { readOnly: true });
    assertEquals(snapshot.plan?.attrs.status, "user_verified");
    assertEquals("publishedSnapshot" in snapshot && snapshot.publishedSnapshot, true);
    assertThrows(() => getPlanDocumentRoot(snapshot.plan?.path || ""), Error, "not a writable document path");
    assertEquals(await listEntries(repo), []);
    await assertRejects(() => archivePlan(repo, "epic/01-child"), Error, "published read snapshot");
    assertEquals(await Deno.stat(path).then(() => true).catch(() => false), false);
    assertEquals(await listEntries(repo), []);
});
