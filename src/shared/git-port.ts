/**
 * @module shared/git-port
 * The Git boundary: operations RunWield asks Git to perform, and nothing else.
 *
 * Git is a separate program with its own state, so it is a legitimate place to
 * substitute a fake in tests. RunWield's *own* worktree policy is not, even when it
 * has a Git-sounding name — `mergeExecutionWorktree` proves a sealed candidate,
 * enforces candidate and publication policy. Those are RunWield decisions that happen to call Git, and
 * replacing them in a test replaces the behaviour under test.
 *
 * That distinction is the whole point of this file. A dependency bag cannot express
 * it: every entry looks alike, so the machinery ends up as substitutable as the
 * subprocess. Here the boundary is named, so what belongs behind it is a decision
 * someone has to make out loud.
 *
 * Membership test for a method here: it is a thin translation of a Git command, its
 * result is Git's answer rather than RunWield's judgement, and a reader could predict
 * what it runs. Anything that decides *whether* or *how* to publish belongs in the
 * lifecycle, not here.
 */

import { captureWorktreeTree, diffTrees, getWorkflowDiff } from "./workflow/git-snapshot.ts";
import { getBranchHead, isCommitAncestorOfBranch } from "./worktree.ts";

/**
 * Git operations, expressed behaviourally.
 *
 * Deliberately one method per question asked of Git, not one per call site. A bag
 * that grows an entry for every caller stops being a boundary and becomes a list.
 */
export interface GitPort {
    /** Current commit of a local branch. */
    branchHead(projectRoot: string, branch: string): Promise<string>;
    /**
     * Whether `commit` is reachable from `branch`.
     *
     * The argument order matters and is easy to invert, so it is pinned by a
     * contract test that runs real Git rather than by a fake's assumptions.
     */
    isAncestor(projectRoot: string, commit: string, branch: string): Promise<boolean>;
    /** Tree object for everything in a working directory, tracked or not. */
    captureTree(cwd: string): Promise<string>;
    /** Textual diff between two tree objects. */
    diffTrees(cwd: string, fromTree: string, toTree: string): Promise<string>;
    /** Textual diff of a working directory against a baseline tree. */
    diffAgainstTree(cwd: string, baselineTree: string): Promise<string>;
}

/** The real Git boundary. Construct once at the edge and pass it down. */
export function createGitPort(): GitPort {
    return {
        branchHead: (projectRoot, branch) => getBranchHead(projectRoot, branch),
        isAncestor: (projectRoot, commit, branch) => isCommitAncestorOfBranch(projectRoot, commit, branch),
        captureTree: (cwd) => captureWorktreeTree(cwd),
        diffTrees: (cwd, fromTree, toTree) => diffTrees(cwd, fromTree, toTree),
        diffAgainstTree: (cwd, baselineTree) => getWorkflowDiff(cwd, baselineTree),
    };
}
