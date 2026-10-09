import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { loadPlan, savePlan } from "../../plan-store.js";
import { buildPlanEventUpdates } from "./plan-lifecycle.js";
import { createGitPort } from "../git-port.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { verifyPostMergeCandidatePublished, verifyRecordedPublication } from "./validation-merge-verification.ts";

const fixture = defineCommittedGitFixture({ "file.txt": "base\n" });

Deno.test("a stale legacy controller receipt cannot override the completed Plan committed on its target", async () => {
    const root = await fixture.checkout();
    try {
        await savePlan(root, "legacy", "# Completed legacy Plan\n", {
            planId: "legacy",
            status: "validated",
            targetBranch: "main",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: "a".repeat(40),
                targetBranch: "main",
                targetHeadBeforeMerge: "b".repeat(40),
            },
        });
        await git(root, ["add", "docs/plans/legacy.md"]);
        await git(root, ["commit", "-m", "Legacy validated Plan delivered"]);
        const plan = await loadPlan(root, "legacy");
        assertExists(plan);
        const document = { planName: "legacy", markdown: plan.markdown };
        assertEquals(await verifyRecordedPublication(root, plan.attrs, document), {
            published: true,
            targetBranch: "main",
        });
        assertEquals(
            await verifyRecordedPublication(root, plan.attrs, {
                ...document,
                markdown: `${plan.markdown}\nNew scope\n`,
            }),
            { published: false, targetBranch: "main" },
        );
        assertEquals(
            await verifyRecordedPublication(root, { ...plan.attrs, validatedCommit: "a".repeat(40) }, document),
            { published: false, targetBranch: "main" },
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("an unavailable publication remote leaves continuation available without claiming success", async () => {
    const root = await fixture.checkout();
    try {
        await git(root, ["remote", "add", "origin", `${root}/missing-remote.git`]);
        await git(root, ["switch", "-c", "pending"]);
        await Deno.writeTextFile(`${root}/file.txt`, "pending\n");
        await git(root, ["commit", "-am", "not delivered"]);
        const commit = await git(root, ["rev-parse", "HEAD"]);
        await savePlan(root, "pending", "# Pending\n", {
            status: "validated",
            targetBranch: "main",
            validatedCommit: commit,
        });
        const plan = await loadPlan(root, "pending");
        assertExists(plan);
        assertEquals(
            await verifyRecordedPublication(root, plan.attrs),
            { published: false, targetBranch: "main", unavailable: true },
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("a damaged Git directory cannot turn a validated Plan into non-Git completion", async () => {
    const root = await Deno.makeTempDir({ prefix: "wld-completed-damaged-git-" });
    try {
        await savePlan(root, "done", "# Not published\n", { status: "validated", targetBranch: "release" });
        const plan = await loadPlan(root, "done");
        assertExists(plan);
        await Deno.mkdir(`${root}/.git`);
        assertEquals(await verifyRecordedPublication(root, plan.attrs, { planName: "done", markdown: plan.markdown }), {
            published: false,
            targetBranch: "release",
        });
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("committed validation stamp survives runtime removal and proves only its actual target", async () => {
    const root = await fixture.checkout();
    try {
        await git(root, ["branch", "release"]);
        const targetHeadBeforeMerge = await git(root, ["rev-parse", "release"]);
        await git(root, ["switch", "-c", "implementation"]);
        await Deno.writeTextFile(`${root}/file.txt`, "implemented\n");
        await git(root, ["add", "file.txt"]);
        await git(root, ["commit", "-m", "implementation"]);
        const executionCommit = await git(root, ["rev-parse", "HEAD"]);
        const updates = buildPlanEventUpdates("validation_passed", "reviewed", {
            triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed" },
            executionMode: "worktree",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit,
                targetBranch: "release",
                targetHeadBeforeMerge,
            },
        });
        await savePlan(root, "done", "# Completed change\n", {
            ...updates,
            planId: "completed-stamp",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            affectedPaths: [],
        });
        await git(root, ["add", "docs/plans/done.md"]);
        await git(root, ["commit", "-m", "Record validation"]);
        await Deno.remove(join(resolveProjectRuntimeLayout(root).primary.internalRoot, "controller"), {
            recursive: true,
        });
        const plan = await loadPlan(root, "done");
        assertExists(plan);
        assertEquals(plan.attrs.validatedCommit, executionCommit);
        assertEquals(plan.attrs.deliveryEvidence, undefined);
        assertEquals(await verifyRecordedPublication(root, plan.attrs), { published: false, targetBranch: "release" });
        await git(root, ["switch", "release"]);
        await git(root, ["merge", "--ff-only", "implementation"]);
        assertEquals(await verifyRecordedPublication(root, plan.attrs), { published: true, targetBranch: "release" });
        assertEquals(await verifyRecordedPublication(root, { ...plan.attrs, targetBranch: "main" }), {
            published: false,
            targetBranch: "main",
        });
        assertEquals(
            buildPlanEventUpdates("review_reopened", "validated", { triageMeta: plan.attrs }).validatedCommit,
            null,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("publication stamp proves remote delivery without updating a stale local checkout", async () => {
    const root = await fixture.checkout();
    const remote = await Deno.makeTempDir({ prefix: "wld-completed-remote-" });
    try {
        await git(root, ["init", "--bare", remote]);
        await git(root, ["remote", "add", "origin", remote]);
        await git(root, ["branch", "release"]);
        const localHead = await git(root, ["rev-parse", "release"]);
        await git(root, ["switch", "-c", "implementation"]);
        await Deno.writeTextFile(`${root}/file.txt`, "delivered\n");
        await git(root, ["add", "file.txt"]);
        await git(root, ["commit", "-m", "delivered implementation"]);
        const validatedCommit = await git(root, ["rev-parse", "HEAD"]);
        await git(root, ["push", "origin", "HEAD:release"]);
        await git(root, ["switch", "release"]);
        await Deno.writeTextFile(`${root}/file.txt`, "unsaved local edit\n");
        await savePlan(root, "done", "# Published\n", {
            status: "validated",
            targetBranch: "release",
            validatedCommit,
        });
        const plan = await loadPlan(root, "done");
        assertExists(plan);
        assertEquals(await verifyRecordedPublication(root, plan.attrs), { published: true, targetBranch: "release" });
        assertEquals(await git(root, ["rev-parse", "HEAD"]), localHead);
        assertEquals(await Deno.readTextFile(`${root}/file.txt`), "unsaved local edit\n");
    } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(remote, { recursive: true });
    }
});

Deno.test("publication proof requires the exact candidate and metadata commits", async () => {
    const root = await fixture.checkout();
    try {
        await git(root, ["switch", "-c", "runwield/worktree/demo"]);
        await Deno.writeTextFile(`${root}/file.txt`, "work\n");
        await git(root, ["add", "file.txt"]);
        await git(root, ["commit", "-m", "candidate"]);
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        await Deno.writeTextFile(`${root}/plan.txt`, "verified\n");
        await git(root, ["add", "plan.txt"]);
        await git(root, ["commit", "-m", "metadata"]);
        const metadata = await git(root, ["rev-parse", "HEAD"]);
        await git(root, ["switch", "main"]);
        await git(root, ["merge", "--ff-only", "runwield/worktree/demo"]);

        const proven = await verifyPostMergeCandidatePublished({
            projectRoot: root,
            worktreeBranch: "runwield/worktree/demo",
            worktreeBaseBranch: "main",
            git: createGitPort(),
            executionCommit: candidate,
            metadataCommit: metadata,
            targetBranch: "main",
        });
        assertEquals(proven.merged, true);

        await git(root, ["switch", "-c", "not-published", `${candidate}^`]);
        await Deno.writeTextFile(`${root}/lost.txt`, "lost\n");
        await git(root, ["add", "lost.txt"]);
        await git(root, ["commit", "-m", "not published"]);
        const missing = await git(root, ["rev-parse", "HEAD"]);
        const rejected = await verifyPostMergeCandidatePublished({
            projectRoot: root,
            worktreeBranch: "not-published",
            worktreeBaseBranch: "main",
            git: createGitPort(),
            executionCommit: missing,
            targetBranch: "main",
        });
        assertEquals(rejected.merged, false);
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("committed reviewed metadata alone never proves delivery", async () => {
    const root = await fixture.checkout();
    try {
        await savePlan(root, "pending-review", "# Pending review", { status: "reviewed", targetBranch: "main" });
        await git(root, ["add", "docs/plans/pending-review.md"]);
        await git(root, ["commit", "-m", "Save review candidate"]);
        const plan = await loadPlan(root, "pending-review");
        assertExists(plan);
        assertEquals(
            await verifyRecordedPublication(root, plan.attrs, { planName: "pending-review", markdown: plan.markdown }),
            { published: false, targetBranch: "main" },
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
