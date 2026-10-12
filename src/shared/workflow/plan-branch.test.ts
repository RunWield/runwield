import { assertEquals, assertRejects } from "@std/assert";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { defaultPlanBranchName, ensurePlanBranch, shouldAdoptPlanBranch } from "./plan-branch.ts";
import { setCustomSetting } from "../settings.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";

const repo = defineCommittedGitFixture();

Deno.test("Plan Branch names use the full worktree slug", () => {
    assertEquals(defaultPlanBranchName("Fix/API auth"), "plan/fix-api-auth");
    assertEquals(defaultPlanBranchName("A".repeat(60)), `plan/${"a".repeat(48)}`);
});

Deno.test("Plan Branch starts from an explicit source and existing work is retained", async () => {
    const root = await repo.checkout();
    try {
        await git(root, ["checkout", "-b", "release"]);
        await Deno.writeTextFile(`${root}/release.txt`, "release\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "release"]);
        const head = await git(root, ["rev-parse", "HEAD"]);
        assertEquals(await ensurePlanBranch({ projectRoot: root, planName: "fix", sourceBranch: "release" }), {
            branch: "plan/fix",
            created: true,
        });
        assertEquals(await git(root, ["rev-parse", "plan/fix"]), head);
        assertEquals(await ensurePlanBranch({ projectRoot: root, planName: "fix", sourceBranch: "main" }), {
            branch: "plan/fix",
            created: false,
        });
        assertEquals(await git(root, ["rev-parse", "plan/fix"]), head);
        assertEquals(await git(root, ["branch", "--show-current"]), "release");
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Plan Branch defaults to main locally rather than the current checkout", async () => {
    const root = await repo.checkout();
    try {
        const base = await git(root, ["rev-parse", "main"]);
        await git(root, ["checkout", "-b", "scratch"]);
        await git(root, ["commit", "--allow-empty", "-m", "scratch"]);
        await ensurePlanBranch({ projectRoot: root, planName: "fix" });
        assertEquals(await git(root, ["rev-parse", "plan/fix"]), base);
        assertEquals(await git(root, ["branch", "--show-current"]), "scratch");
        await assertRejects(
            () => ensurePlanBranch({ projectRoot: root, planName: "missing", sourceBranch: "missing" }),
            Error,
            "Source branch does not exist",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Plan Branch uses origin's default and explicit remote sources", async () => {
    const remote = await repo.checkout();
    const root = await repo.checkout();
    try {
        await git(remote, ["branch", "-m", "master"]);
        await git(remote, ["commit", "--allow-empty", "-m", "remote default"]);
        const base = await git(remote, ["rev-parse", "HEAD"]);
        await git(root, ["remote", "add", "origin", remote]);
        await ensurePlanBranch({ projectRoot: root, planName: "default" });
        assertEquals(await git(root, ["rev-parse", "plan/default"]), base);
        await git(remote, ["branch", "release"]);
        await ensurePlanBranch({ projectRoot: root, planName: "release", sourceBranch: "origin/release" });
        assertEquals(await git(root, ["rev-parse", "plan/release"]), base);
    } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(remote, { recursive: true });
    }
});

Deno.test("only standalone Planned Changes without an authored Plan Branch adopt one", async () => {
    await withRuntimeCommandFixture("plan-adoption-gate-", async ({ projectRoot }) => {
        assertEquals(shouldAdoptPlanBranch(projectRoot, { classification: "PLANNED_CHANGE" }), true);
        assertEquals(shouldAdoptPlanBranch(projectRoot, { classification: "FEATURE" }), true);
        assertEquals(shouldAdoptPlanBranch(projectRoot, { classification: "PROJECT" }), false);
        assertEquals(shouldAdoptPlanBranch(projectRoot, { classification: "QUICK_FIX" }), false);
        assertEquals(
            shouldAdoptPlanBranch(projectRoot, { classification: "PLANNED_CHANGE", parentPlan: "epic" }),
            false,
        );
        assertEquals(
            shouldAdoptPlanBranch(projectRoot, { classification: "PLANNED_CHANGE", targetBranch: " plan/custom " }),
            false,
        );
        await setCustomSetting("plans", { autoMergeIntoTargetBranch: true }, "project", projectRoot);
        assertEquals(shouldAdoptPlanBranch(projectRoot, { classification: "PLANNED_CHANGE" }), false);
    });
});
