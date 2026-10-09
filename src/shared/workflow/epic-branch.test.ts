import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { loadPlan } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { defaultEpicBranchName, ensureEpicBranch } from "./epic-branch.ts";

type PlanFixtureAttribute = string | number | string[];
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

function epicAttrs(extra: PlanFixtureAttributes = {}): PlanFixtureAttributes {
    return {
        planId: "plan-epic",
        classification: "PROJECT",
        complexity: "HIGH",
        status: "ready_for_work",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        ...extra,
    };
}

function childAttrs(order: number, extra: PlanFixtureAttributes = {}): PlanFixtureAttributes {
    return {
        planId: `plan-child-${order}`,
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        status: "draft",
        parentPlan: "epic",
        order,
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        ...extra,
    };
}

const repoFixture = defineGitFixture(async (repo) => {
    await Deno.writeTextFile(join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "primary"]);
});

async function filesOnRef(repo: string, ref: string): Promise<string[]> {
    return (await git(repo, ["ls-tree", "-r", "--name-only", ref])).split("\n").filter(Boolean);
}

Deno.test("defaultEpicBranchName names the branch after the Epic", () => {
    assertEquals(
        defaultEpicBranchName("plan-packages-and-independent-validation"),
        "epic/plan-packages-and-independent-validation",
    );
    assertEquals(defaultEpicBranchName("docs/plans/My Epic.md"), "epic/my-epic");
});

Deno.test("existing Epic branches refresh publication before seeding another child", async () => {
    const repo = await repoFixture.checkout();
    const remote = await Deno.makeTempDir();
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "main", "main:epic/epic"]);
    await git(repo, ["branch", "epic/epic", "main"]);
    await writePlan(repo, "epic", epicAttrs({ targetBranch: "epic/epic" }), "# Epic\n");
    await writePlan(repo, "epic/02-next", childAttrs(2, { targetBranch: "epic/epic" }), "# Next\n");
    const publisher = await repoFixture.checkout();
    await git(publisher, ["remote", "add", "origin", remote]);
    await git(publisher, ["switch", "-c", "epic/epic"]);
    await Deno.writeTextFile(join(publisher, "published.js"), "previous child\n");
    await git(publisher, ["add", "."]);
    await git(publisher, ["commit", "-m", "previous child publication"]);
    await git(publisher, ["push", "origin", "epic/epic"]);
    const published = await git(publisher, ["rev-parse", "HEAD"]);

    const result = await ensureEpicBranch(repo, "epic");

    assertEquals(result.seededChildren, ["epic/02-next"]);
    await git(repo, ["merge-base", "--is-ancestor", published, "origin/epic/epic"]);
    assertStringIncludes(await git(repo, ["show", "origin/epic/epic:published.js"]), "previous child");
});

Deno.test("an unstarted Epic gets its own branch from the latest primary branch with its drafts on it", async () => {
    const repo = await repoFixture.checkout();
    const primaryHead = await git(repo, ["rev-parse", "main"]);
    await writePlan(repo, "epic", epicAttrs(), "# Epic\n");
    await writePlan(repo, "epic/01-first", childAttrs(1), "# First\n");
    await writePlan(repo, "epic/02-second", childAttrs(2), "# Second\n");
    const statusBefore = await git(repo, ["status", "--porcelain"]);

    const result = await ensureEpicBranch(repo, "epic");

    assertEquals(result.kind, "ready");
    assertEquals(result.branch, "epic/epic");
    assertEquals(result.created, true);
    assertEquals(result.seededChildren?.sort(), ["epic/01-first", "epic/02-second"]);
    const epic = await loadPlan(repo, "epic");
    assertEquals(epic?.attrs.targetBranch, "epic/epic");
    assertEquals(epic?.attrs.epicBaseCommit, primaryHead);
    assertEquals((await loadPlan(repo, "epic/01-first"))?.attrs.targetBranch, "epic/epic");
    // The seed commit sits on top of the primary head and carries only the child drafts.
    assertEquals(await git(repo, ["rev-parse", "epic/epic^"]), primaryHead);
    const onBranch = await filesOnRef(repo, "epic/epic");
    assert(onBranch.includes("docs/plans/epic/01-first.md"));
    assert(onBranch.includes("docs/plans/epic/02-second.md"));
    assert(!onBranch.includes("docs/plans/epic.md"));
    // The user's checkout did not move and its files were not staged or rewritten by Git.
    assertEquals(await git(repo, ["branch", "--show-current"]), "main");
    assertEquals(await git(repo, ["rev-parse", "main"]), primaryHead);
    assertEquals(await git(repo, ["diff", "--cached", "--name-only"]), "");
    assertStringIncludes(statusBefore, "docs/");
});

Deno.test("preparing the Epic branch again changes nothing", async () => {
    const repo = await repoFixture.checkout();
    await writePlan(repo, "epic", epicAttrs({ targetBranch: "epic/epic" }), "# Epic\n");
    await writePlan(repo, "epic/01-first", childAttrs(1, { targetBranch: "epic/epic" }), "# First\n");
    await ensureEpicBranch(repo, "epic");
    const head = await git(repo, ["rev-parse", "epic/epic"]);

    const again = await ensureEpicBranch(repo, "epic");

    assertEquals(again.created, false);
    assertEquals(again.seededChildren, []);
    assertEquals(await git(repo, ["rev-parse", "epic/epic"]), head);
});

Deno.test("an existing Epic branch is used as it is and only missing drafts are added", async () => {
    const repo = await repoFixture.checkout();
    await git(repo, ["switch", "-c", "epic/epic"]);
    await writePlan(
        repo,
        "epic/01-first",
        childAttrs(1, { targetBranch: "epic/epic", status: "validated" }),
        "# Done\n",
    );
    await Deno.writeTextFile(join(repo, "feature.js"), "export const done = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "first child delivered"]);
    const branchHead = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["switch", "main"]);
    await writePlan(repo, "epic", epicAttrs({ targetBranch: "epic/epic" }), "# Epic\n");
    await writePlan(repo, "epic/01-first", childAttrs(1, { targetBranch: "epic/epic" }), "# Stale primary draft\n");
    await writePlan(repo, "epic/02-second", childAttrs(2, { targetBranch: "epic/epic" }), "# Second\n");

    const result = await ensureEpicBranch(repo, "epic");

    assertEquals(result.created, false);
    assertEquals(result.seededChildren, ["epic/02-second"]);
    assertEquals(await git(repo, ["rev-parse", "epic/epic^"]), branchHead);
    const delivered = await git(repo, ["show", "epic/epic:docs/plans/epic/01-first.md"]);
    assertStringIncludes(delivered, "# Done");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.epicBaseCommit, undefined);
});

Deno.test("a checked-out Epic branch is never moved under that checkout", async () => {
    const repo = await repoFixture.checkout();
    await git(repo, ["branch", "epic/epic"]);
    const linked = `${repo}-linked`;
    await git(repo, ["worktree", "add", linked, "epic/epic"]);
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    await writePlan(repo, "epic", epicAttrs({ targetBranch: "epic/epic" }), "# Epic\n");
    await writePlan(repo, "epic/01-first", childAttrs(1, { targetBranch: "epic/epic" }), "# First\n");

    const error = await assertRejects(() => ensureEpicBranch(repo, "epic"));

    assertStringIncludes(String(error), "is checked out at");
    assertEquals(await git(repo, ["rev-parse", "epic/epic"]), head);
});

Deno.test("an Epic whose children already started without a branch keeps legacy delivery", async () => {
    const repo = await repoFixture.checkout();
    await writePlan(repo, "epic", epicAttrs(), "# Epic\n");
    await writePlan(repo, "epic/01-first", childAttrs(1, { status: "validated" }), "# Done\n");
    await writePlan(repo, "epic/02-second", childAttrs(2), "# Second\n");

    const result = await ensureEpicBranch(repo, "epic");

    assertEquals(result, { kind: "none", reason: "started_without_branch" });
    assertEquals((await loadPlan(repo, "epic"))?.attrs.targetBranch, undefined);
    assertEquals(await git(repo, ["branch", "--list", "epic/epic"]), "");
});

Deno.test("an Epic whose default branch cannot be created records nothing and keeps legacy delivery", async () => {
    const repo = await repoFixture.checkout();
    // No `main` anywhere and an origin with no default branch: there is no primary branch to start from.
    await git(repo, ["branch", "-m", "main", "trunk"]);
    const remote = `${repo}-origin.git`;
    await git(repo, ["init", "--bare", remote]);
    await git(repo, ["remote", "add", "origin", remote]);
    await writePlan(repo, "epic", epicAttrs(), "# Epic\n");
    await writePlan(repo, "epic/01-first", childAttrs(1), "# First\n");

    const result = await ensureEpicBranch(repo, "epic");

    assertEquals(result.kind, "none");
    assertEquals(result.reason, "branch_unavailable");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.targetBranch, undefined);
    assertEquals((await loadPlan(repo, "epic/01-first"))?.attrs.targetBranch, undefined);
});

Deno.test("a draft committed before it had an identity is replaced on the Epic branch by its identified copy", async () => {
    const repo = await repoFixture.checkout();
    await writePlan(repo, "epic", epicAttrs(), "# Epic\n");
    const { planId: _planId, ...unidentified } = childAttrs(1);
    await writePlan(repo, "epic/01-first", unidentified, "# First\n");
    await git(repo, ["add", "docs"]);
    await git(repo, ["commit", "-m", "hand-written Epic"]);

    const result = await ensureEpicBranch(repo, "epic");

    assertEquals(result.seededChildren, ["epic/01-first"]);
    const local = await loadPlan(repo, "epic/01-first");
    assert(local?.attrs.planId);
    const onBranch = await git(repo, ["show", "epic/epic:docs/plans/epic/01-first.md"]);
    assertStringIncludes(onBranch, String(local?.attrs.planId));
});

Deno.test("a Sequence gets no branch unless the user named one", async () => {
    const repo = await repoFixture.checkout();
    await writePlan(repo, "epic", epicAttrs({ type: "sequence" }), "# Sequence\n");
    await writePlan(repo, "epic/01-first", childAttrs(1, { status: "ready_for_work" }), "# First\n");

    const result = await ensureEpicBranch(repo, "epic");

    assertEquals(result, { kind: "none", reason: "sequence_without_branch" });
    assertEquals((await loadPlan(repo, "epic"))?.attrs.targetBranch, undefined);
    assertEquals((await loadPlan(repo, "epic/01-first"))?.attrs.targetBranch, undefined);
    assertEquals(await git(repo, ["branch", "--list", "epic/epic"]), "");
});
