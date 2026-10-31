import { test } from "node:test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { prepareTargetBranchRef } from "../worktree.js";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import {
    captureWorktreeTree,
    diffTrees,
    getWorktreeReviewDiff,
    readWorktreeReviewBaseFile,
    WorktreeReviewTargetError,
    WorktreeReviewComparisonError,
} from "./git-snapshot.ts";

const retainedFixture = defineGitFixture(async (cwd) => {
    await writeFile(join(cwd, "shared.md"), "old local target\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "old target"]);
    await git(cwd, ["branch", "target"]);
    await writeFile(join(cwd, "shared.md"), "published remote target\n");
    await writeFile(join(cwd, "delivered.ts"), "export const delivered = true;\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "previous delivery"]);
});

test("retained worktree review excludes previous remote delivery but keeps all new proposals", async () => {
    const cwd = await retainedFixture.checkout();
    const execution = join(cwd, "retained");
    try {
        // A real remote starts newer than the primary checkout's local target.
        const remote = join(cwd, ".git", "fixture-remote.git");
        await git(cwd, ["clone", "--bare", ".", remote]);
        await git(cwd, ["--git-dir", remote, "update-ref", "refs/heads/target", "refs/heads/main"]);
        await git(cwd, ["remote", "add", "origin", remote]);
        await git(cwd, ["fetch", "origin"]);
        const target = await git(cwd, ["rev-parse", "refs/remotes/origin/target"]);
        await git(cwd, ["worktree", "add", "-b", "execution", execution, target]);
        await writeFile(join(execution, "committed.md"), "proposed before this execution\n");
        await git(execution, ["add", "committed.md"]);
        await git(execution, ["commit", "-m", "retained proposed work"]);
        // An execution-baseline diff would incorrectly hide committed.md.
        await captureWorktreeTree(execution);
        await writeFile(join(execution, "shared.md"), "current proposal\n");
        await writeFile(join(execution, "uncommitted.md"), "new proposed work\n");
        const expected = await diffTrees(execution, target, await captureWorktreeTree(execution));
        const patch = await getWorktreeReviewDiff(execution, "target");
        assertEquals(patch, expected);
        assertStringIncludes(patch, "committed.md");
        assertStringIncludes(patch, "uncommitted.md");
        assertEquals(patch.includes("delivered.ts"), false);
        assertEquals(await readWorktreeReviewBaseFile(execution, "target", "shared.md"), "published remote target\n");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

async function remoteCheckout() {
    const cwd = await retainedFixture.checkout();
    const remote = join(cwd, ".git", "fixture-remote.git");
    await git(cwd, ["clone", "--bare", ".", remote]);
    await git(cwd, ["--git-dir", remote, "update-ref", "refs/heads/target", "refs/heads/main"]);
    await git(cwd, ["remote", "add", "origin", remote]);
    await git(cwd, ["fetch", "origin"]);
    return { cwd, remote };
}

test("review follows the configured publication remote, not an arbitrary origin ref", async () => {
    const { cwd, remote } = await remoteCheckout();
    try {
        await git(cwd, ["remote", "add", "delivery", remote]);
        await git(cwd, ["fetch", "delivery"]);
        await git(cwd, ["config", "branch.target.remote", "delivery"]);
        await git(cwd, ["update-ref", "refs/remotes/origin/target", "target"]);
        assertEquals(await getWorktreeReviewDiff(cwd, "target", "refs/remotes/origin/target"), "");
        assertEquals(await readWorktreeReviewBaseFile(cwd, "target", "shared.md"), "published remote target\n");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an explicitly local publication target ignores a newer origin tracking ref", async () => {
    const { cwd } = await remoteCheckout();
    try {
        await git(cwd, ["config", "branch.target.remote", "."]);
        const patch = await getWorktreeReviewDiff(cwd, "target", "refs/heads/target");
        assertStringIncludes(patch, "delivered.ts");
        assertEquals(await readWorktreeReviewBaseFile(cwd, "target", "shared.md"), "old local target\n");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("target preparation fetches the configured delivery remote before worktree review", async () => {
    const cwd = await retainedFixture.checkout();
    const execution = join(cwd, "execution");
    try {
        const delivery = join(cwd, ".git", "delivery.git");
        const origin = join(cwd, ".git", "origin.git");
        await git(cwd, ["clone", "--bare", ".", delivery]);
        await git(cwd, ["reset", "--hard", "target"]);
        const localHead = await git(cwd, ["rev-parse", "main"]);
        await git(cwd, ["clone", "--bare", ".", origin]);
        await git(cwd, ["remote", "add", "origin", origin]);
        await git(cwd, ["remote", "add", "delivery", delivery]);
        await git(cwd, ["config", "branch.main.remote", "delivery"]);

        // No manual fetch: setup must make the same authority available to review.
        const prepared = await prepareTargetBranchRef(cwd, "main");
        await git(cwd, ["worktree", "add", "-b", "execution", execution, prepared.baseRef]);
        await writeFile(join(execution, "proposal.md"), "new proposal\n");
        const patch = await getWorktreeReviewDiff(execution, prepared.baseBranch, prepared.baseRef);
        assertStringIncludes(patch, "proposal.md");
        assertEquals(patch.includes("delivered.ts"), false);
        assertEquals(prepared, { baseRef: "refs/remotes/delivery/main", baseBranch: "main" });
        assertEquals(
            await readWorktreeReviewBaseFile(execution, "main", "shared.md", prepared.baseRef),
            "published remote target\n",
        );
        assertEquals(await git(cwd, ["rev-parse", "main"]), localHead);
        assertEquals(await git(cwd, ["branch", "--show-current"]), "main");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("local-only target preparation and review ignore an available newer origin", async () => {
    const cwd = await retainedFixture.checkout();
    const execution = join(cwd, "execution");
    try {
        const origin = join(cwd, ".git", "origin.git");
        await git(cwd, ["clone", "--bare", ".", origin]);
        await git(cwd, ["reset", "--hard", "target"]);
        const localHead = await git(cwd, ["rev-parse", "main"]);
        await git(cwd, ["remote", "add", "origin", origin]);
        await git(cwd, ["config", "branch.main.remote", "."]);

        const prepared = await prepareTargetBranchRef(cwd, "main");
        await git(cwd, ["worktree", "add", "-b", "execution", execution, prepared.baseRef]);
        await writeFile(join(execution, "proposal.md"), "new proposal\n");
        const patch = await getWorktreeReviewDiff(execution, prepared.baseBranch, prepared.baseRef);
        assertStringIncludes(patch, "proposal.md");
        assertEquals(patch.includes("delivered.ts"), false);
        assertEquals(prepared, { baseRef: "refs/heads/main", baseBranch: "main" });
        assertEquals(
            await readWorktreeReviewBaseFile(execution, "main", "shared.md", prepared.baseRef),
            "old local target\n",
        );
        assertEquals(await git(cwd, ["rev-parse", "main"]), localHead);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("target preparation cannot replace an unavailable configured remote with a local target", async () => {
    const cwd = await retainedFixture.checkout();
    try {
        await git(cwd, ["config", "branch.main.remote", "missing"]);
        await assertRejects(
            () => prepareTargetBranchRef(cwd, "main"),
            Error,
            "Publication remote missing is unavailable",
        );
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("target preparation fails closed when delivery is unreachable even with a usable origin", async () => {
    const { cwd } = await remoteCheckout();
    try {
        await git(cwd, ["remote", "add", "delivery", join(cwd, ".git", "unavailable.git")]);
        await git(cwd, ["config", "branch.main.remote", "delivery"]);
        await assertRejects(
            () => prepareTargetBranchRef(cwd, "main"),
            Error,
            "Could not check remote target branch delivery/main",
        );
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a required remote target ref cannot fall back to the existing local branch", async () => {
    const { cwd } = await remoteCheckout();
    try {
        await git(cwd, ["update-ref", "-d", "refs/remotes/origin/target"]);
        await assertRejects(() => getWorktreeReviewDiff(cwd, "target"), WorktreeReviewTargetError);
        await assertRejects(() => readWorktreeReviewBaseFile(cwd, "target", "shared.md"), WorktreeReviewTargetError);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a recorded remote target stays required after its remote configuration is removed", async () => {
    const { cwd } = await remoteCheckout();
    try {
        await git(cwd, ["remote", "remove", "origin"]);
        const baseRef = "refs/remotes/origin/target";
        await assertRejects(() => getWorktreeReviewDiff(cwd, "target", baseRef), WorktreeReviewTargetError);
        await assertRejects(
            () => readWorktreeReviewBaseFile(cwd, "target", "shared.md", baseRef),
            WorktreeReviewTargetError,
        );
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an unavailable configured publication remote is indeterminate, not local-only", async () => {
    const cwd = await retainedFixture.checkout();
    try {
        await git(cwd, ["config", "branch.target.remote", "missing"]);
        await assertRejects(() => getWorktreeReviewDiff(cwd, "target"), WorktreeReviewComparisonError);
        await assertRejects(
            () => readWorktreeReviewBaseFile(cwd, "target", "shared.md"),
            WorktreeReviewComparisonError,
        );
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a moved remote target uses ancestry until merged and then removes only delivered proposals", async () => {
    const { cwd } = await remoteCheckout();
    try {
        const base = await git(cwd, ["rev-parse", "main"]);
        await git(cwd, ["switch", "-c", "proposal"]);
        await writeFile(join(cwd, "proposed.md"), "committed proposal\n");
        await git(cwd, ["add", "proposed.md"]);
        await git(cwd, ["commit", "-m", "proposal"]);
        await git(cwd, ["switch", "main"]);
        await writeFile(join(cwd, "target-only.md"), "later target work\n");
        await git(cwd, ["add", "target-only.md"]);
        await git(cwd, ["commit", "-m", "target advanced"]);
        await git(cwd, ["push", "origin", "HEAD:target"]);
        await git(cwd, ["fetch", "origin"]);
        await git(cwd, ["switch", "proposal"]);
        await writeFile(join(cwd, "dirty.md"), "uncommitted proposal\n");
        const expected = await diffTrees(cwd, base, await captureWorktreeTree(cwd));
        assertEquals(await getWorktreeReviewDiff(cwd, "target", base), expected);
        assertEquals(await readWorktreeReviewBaseFile(cwd, "target", "target-only.md"), null);
        // Publication has now incorporated the candidate; only dirty work remains proposed.
        await git(cwd, ["switch", "main"]);
        await git(cwd, ["merge", "--no-edit", "proposal"]);
        await git(cwd, ["push", "origin", "HEAD:target"]);
        await git(cwd, ["switch", "proposal"]);
        await git(cwd, ["fetch", "origin"]);
        const patch = await getWorktreeReviewDiff(cwd, "target");
        assertStringIncludes(patch, "dirty.md");
        assertEquals(patch.includes("proposed.md"), false);
        assertEquals(await readWorktreeReviewBaseFile(cwd, "target", "proposed.md"), "committed proposal\n");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

for (const remoteName of ["origin", "delivery"]) {
    test(`a recorded local target can be reviewed before its first ${remoteName} publication`, async () => {
        const cwd = await retainedFixture.checkout();
        try {
            const remote = join(cwd, ".git", "first-publication.git");
            await git(cwd, ["clone", "--bare", "--single-branch", "--branch", "main", ".", remote]);
            const publishedHead = await git(cwd, ["rev-parse", "main"]);
            await git(cwd, ["reset", "--hard", "target"]);
            await git(cwd, ["remote", "add", remoteName, remote]);
            await git(cwd, ["config", "branch.main.remote", remoteName]);
            await git(cwd, ["config", "branch.new-target.remote", remoteName]);
            const { baseRef } = await prepareTargetBranchRef(cwd, "new-target");
            assertEquals(baseRef, "refs/heads/new-target");
            assertEquals(await git(cwd, ["rev-parse", baseRef]), publishedHead);
            await git(cwd, ["switch", "-c", "execution", baseRef]);
            await writeFile(join(cwd, "proposal.md"), "committed proposal\n");
            await git(cwd, ["add", "proposal.md"]);
            await git(cwd, ["commit", "-m", "proposal"]);
            const proposal = await git(cwd, ["rev-parse", "HEAD"]);
            await writeFile(join(cwd, "dirty.md"), "uncommitted proposal\n");
            const refs = await git(cwd, ["show-ref"]);
            const index = await git(cwd, ["ls-files", "--stage"]);
            const expected = await diffTrees(cwd, baseRef, await captureWorktreeTree(cwd));
            assertEquals(await getWorktreeReviewDiff(cwd, "new-target", baseRef), expected);
            assertStringIncludes(expected, "proposal.md");
            assertStringIncludes(expected, "dirty.md");
            assertEquals(await readWorktreeReviewBaseFile(cwd, "new-target", "proposal.md", baseRef), null);
            assertEquals(await git(cwd, ["show-ref"]), refs);
            assertEquals(await git(cwd, ["ls-files", "--stage"]), index);

            // The live local target, not the execution's original snapshot, now contains the proposal.
            await git(cwd, ["update-ref", baseRef, proposal]);
            const dirtyPatch = await getWorktreeReviewDiff(cwd, "new-target", baseRef);
            assertStringIncludes(dirtyPatch, "dirty.md");
            assertEquals(dirtyPatch.includes("proposal.md"), false);
            assertEquals(
                await readWorktreeReviewBaseFile(cwd, "new-target", "proposal.md", baseRef),
                "committed proposal\n",
            );

            // Once remote publication exists it is authoritative, even with a stale local target.
            await git(cwd, ["push", remoteName, "HEAD:new-target"]);
            await git(cwd, ["fetch", remoteName]);
            await git(cwd, ["update-ref", baseRef, "main"]);
            assertEquals(await getWorktreeReviewDiff(cwd, "new-target", baseRef), dirtyPatch);
            assertEquals(
                await readWorktreeReviewBaseFile(cwd, "new-target", "proposal.md", baseRef),
                "committed proposal\n",
            );
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });
}
