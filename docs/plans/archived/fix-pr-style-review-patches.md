---
planId: "4c50a988-e730-4699-a0c6-df199f54addf"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/git-snapshot.js"
    - "src/shared/workflow/git-snapshot.test.ts"
    - "src/shared/workflow/review-diff-tool.js"
    - "src/shared/workflow/validation-loop-review.test.js"
    - "src/ui/review/review-consumers.integration.test.js"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/server/session-continuation.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/005-concurrent-worktree-isolation.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-22"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
status: "validated"
validatedCommit: "63e74a2f28d5d4a3a584f2aaa90b3b12d680222a"
workRecord:
    status: "generated"
    recordId: "a36d95ab-5c2d-4623-9c55-6b436f266b45"
    path: "docs/work-records/2026-09-22-pr-style-review-patches-across-all-consumers.md"
    lastAttemptAt: "2026-09-22T17:26:48.815Z"
archivedAt: "2026-09-24T04:21:48.980Z"
archiveReason: "Merged into main and accepted by user"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/fix-pr-style-review-patches.md"
---

# Show PR-Style Patches in Browser and AI Review

## Context

The recent `fix-target-branch-review-diffs` change compares the recorded target branch's latest tree directly with the
execution worktree. If the target advances separately, its new work appears as removals or reversals in review. The user
wants a GitHub pull request or GitLab merge request style patch: changes introduced on the execution branch, not all
file differences between two branches. The user explicitly requires the Reviewer's `review_diff` tool to use this rule
as well as browser Code Review.

Current source confirms the direct comparison in `getWorktreeReviewDiff`. The test named “getWorktreeReviewDiff compares
directly with the latest target tip” explicitly requires the unwanted deletions. This Plan replaces that comparison
rule; it does not undo the shared helper or return to an execution-start snapshot.

Owning capabilities:

- Core [Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair): change **Use one
  target-relative review diff** and its target-advancement scenario. Preserve **Complete inspection before a review
  decision**, independent findings verification, and full-versus-repair scope.
- Core [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve
  isolated work, recoverable failures, recovery snapshots, and publication proof.

These are proposed changes, not a claim that the corrected behavior has shipped. The request does not change browser
layout, review decisions, publication, or branch synchronization.

## Objective

Browser Code Review, the Reviewer's actual `review_diff` output, and full repair context show the same net patch from
the common ancestor of the recorded target and execution HEAD to current worktree files. Target-only changes do not
appear as changes proposed by the execution branch. Committed and uncommitted execution changes remain visible.

## Approach

Keep `getWorktreeReviewDiff(cwd, targetBranch)` as the single full-review comparison owner:

```text
Before: target tip tree -> current worktree tree
After:  merge-base(target tip, execution HEAD) tree -> current worktree tree
Repair-only scope: pre-repair tree -> current worktree tree (unchanged)
```

Resolve the recorded local target and execution HEAD to commit IDs once per computation. Use Git's merge-base for those
commits. Compare its tree with `captureWorktreeTree(cwd)` through `diffTrees`. Keep the temporary-index capture so the
patch includes committed edits, final staged/unstaged bytes, deletions, and non-ignored untracked additions without
changing the real index or files. Do not concatenate separate patches.

```text
AI review / repair and resume / Code Review open and reload
  -> getWorktreeReviewDiff
     -> common ancestor -> current files
  -> review_diff list/show OR browser rawPatch
```

Existing callers already share the helper. Preserve that wiring in `validation-semantic.ts`, `validation-supervisor.ts`,
`validation-human-review.ts`, and segmented repair in `session-runtime.js`. The tool pages the supplied patch; it must
not calculate another comparison. Standalone and Workspace refresh paths must use the same rule. Do not filter by Plan
paths, author, file type, or the primary checkout's branch.

A missing target, missing HEAD, or absent common ancestor is a recoverable comparison failure. Do not substitute a
target tip, `main`, HEAD-only diff, recovery snapshot, or empty patch. Ensure ancestry failures are recognized as
comparison failures by both browser refresh paths, rather than falling through their generic last-patch fallback. Keep
that existing fallback for temporary checkout read failures; do not redesign it.

Update the tool description and applicable prompt text to explain that `full` means the whole proposed branch patch, not
every difference from the current target. `repair` still means only the latest repair. Preserve complete-read checks and
findings rules. Code Review always receives full scope.

Direct target comparison is rejected because it makes unrelated target work look like proposed reversals. A
committed-only three-dot diff is also insufficient: this review must include current uncommitted work. No fetch, merge,
rebase, patch-equivalence filter, or remote service is needed.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/git-snapshot.js` and tests — change the full-review base and cover comparison failures; retain
  current-tree capture and independent recovery helpers.
- `src/shared/workflow/review-diff-tool.js`, relevant Reviewer/repair definitions, and their tests — describe the patch
  correctly while preserving paging, coverage checks, and full/repair scope.
- Workflow review tests and `src/ui/review/review-consumers.integration.test.js` — prove actual Reviewer tool output,
  repair context, and browser payloads exclude target-only changes and contain execution changes.
- `src/ui/workspace/server.js`, `server/session-continuation.js`, and review reload tests — propagate invalid ancestry
  rather than returning a stale patch; verify fresh patches after target and worktree changes.
- `src/shared/session/session-runtime.js` and validation full-diff callers — inspect and test shared-helper wiring on
  resume; change only if needed. No Session storage or controller redesign.
- `docs/prd/runwield-core-prd.md`, `docs/adr/005-concurrent-worktree-isolation.md`, and `docs/plan-lifecycle.md` —
  replace the direct-target rule and scenario with the common-ancestor patch rule. Preserve stable capability links.
- `docs/domain-language.md` — align Semantic Review and Code Review definitions and their shared patch relationship.
  Retain AI review/Code Review naming and legacy compatibility identifiers. No new domain term is needed.

The renderer and vendored Plannotator comparison modes are not the owner of this workflow patch and need no redesign.

## Reuse Opportunities

- `captureWorktreeTree`, `diffTrees`, and the existing comparison error handling.
- Existing recorded `worktreeBaseBranch`; never infer a new review target.
- Existing real-Git fixtures and sandboxed validation test helpers.
- The cross-consumer test already reads real `review_diff list/show` output in 256-byte pages and compares it with
  repair and browser patches. Extend its inputs and independent expectations rather than replace it with mocks.

## Implementation Steps

1. A real-Git regression proves the old helper is wrong: after target and execution diverge, the expected patch contains
   execution edits but no reversals of target-only additions, modifications, or deletions. The current implementation
   fails these assertions before the fix.
2. `getWorktreeReviewDiff` returns the common-ancestor-to-current-files patch, preserves checkout state, and reports
   missing target/HEAD/ancestry as comparison failures. The old latest-target deletion requirement no longer exists.
3. Actual Reviewer `review_diff list/show` pages, full repair context, and standalone/Workspace review payloads contain
   the same correct patch for identical state. Refresh and resumed repair use the shared helper. Full and repair-only
   scopes remain distinct, with complete-read requirements intact.
4. Both browser paths reject invalid comparison ancestry without using an old patch. Temporary-read fallback,
   authentication, and server-side comparison context remain protected by tests.
5. Core requirements and scenarios, ADR-005, lifecycle guidance, tool instructions, and glossary definitions describe
   the delivered rule together. Old direct-target guidance is replaced in current documents, not left as a competing
   option. Historical Plans and Work Records need no rewrite.

## Approval Confirmation

Approval replaces the earlier direct-target comparison requirement with the requested PR/MR-style patch for browser Code
Review and AI review together. No Work Record supersession is proposed. Execution can run autonomously with the
Engineer; the change is in shared patch collection, not visual design.

## Verification Plan

Use the sandboxed runner, never `deno test` directly:

```sh
deno run -A scripts/run-tests.js src/shared/workflow/git-snapshot.test.ts src/shared/workflow/review-diff-tool.test.js src/shared/workflow/review-contract.test.ts src/shared/workflow/validation-loop-review.test.js src/shared/workflow/validation-loop-human-review.test.js src/ui/review/review-consumers.integration.test.js src/ui/review/review-launcher.test.ts src/ui/workspace/workspace-code-review.integration.test.ts
```

Required proof:

- **Divergence:** use a non-main target and a known common-ancestor commit. After branching, target adds, changes, and
  deletes files. Execution makes its own committed change, staged then unstaged edit, untracked addition, and deletion.
  Include a file changed on both branches. Assert expected paths and exact before/after lines from the known ancestor
  and execution files. Target-only reversals must be absent; genuine execution deletions must remain. Check the exact
  patch against an independent Git diff from the fixture's known ancestor, not only against the helper under test.
- **No proposed work:** target advances while execution stays unchanged. The patch is empty, not a deletion of target
  work. With target and execution equal, an uncommitted edit still appears.
- **Imported target work:** preserve the existing imported-target regression and add a real merge after both branches
  have commits. Unchanged imported target content stays absent, execution edits remain. Refresh uses the new common
  ancestor, not the original execution snapshot or a permanently cached fork point.
- **One correct patch across consumers:** extend the cross-consumer fixture with divergence. Read every actual
  `review_diff list/show` page, reconstruct the full patch, and assert equality with repair and both browser payloads.
  Also assert independent expected content and excluded target-only paths. A shared but still-wrong helper, empty stub,
  filtered file list, or browser-only fix must fail. Repeat after target-only advancement and a worktree edit.
- **Repair and resume:** exercise full and repair scopes after a repair. Full retains prior execution changes; repair
  contains only the latest repair. Preserve saved and segmented repair continuation coverage, independent finding
  verification, no-edit resolution of incorrectly attributed findings, and blocking of genuinely missing requirements.
- **Comparison failures:** missing target, missing HEAD, and unrelated histories cannot dispatch AI review/repair with
  an invented patch. Both browser refresh paths must reject invalid comparison ancestry instead of serving their saved
  patch as a successful refresh. Preserve separate transient-read fallback tests.
- **State preservation:** retain tests for committed/staged/unstaged/untracked content, ignored-but-tracked files, real
  index bytes, branch tips, unchanged working files, non-Git skips, and recovery/pre-repair snapshots. Only assertions
  requiring target-only reversals are intentionally retired.
- **Manual:** open a disposable diverged-worktree review in the standalone browser and Workspace. Confirm the file list
  and hunks contain execution changes, not target-only reversals. Advance target independently, edit execution files,
  and reload both pages. Only the execution edit changes the shown patch. Do not alter a live user attempt for testing.
- **Semantic inspection:** trace actual AI, repair/resume, and both browser paths to the one helper. Confirm current
  PRD, ADR, lifecycle, tool, and glossary wording agree. Passing tests alone must not leave direct-target instructions
  active.

## Edge Cases & Considerations

- Git ancestry defines this patch, not authorship or Plan ownership. A cherry-picked equivalent commit is not
  necessarily a shared ancestor; this fix does not add cherry-pick detection or promise to remove all equivalent
  changes.
- The patch describes proposed branch changes, not a simulated merge result. Conflicts and publication remain under
  existing publication checks.
- Resolve target and HEAD once per computation. A later reload can use newer commits; no new lock or durable patch cache
  is introduced.
- Keep recorded non-main targets authoritative. No automatic network fetch or branch mutation.
- Existing unrelated dirty files were present during planning. Preserve them, especially current project-runtime and
  controller work. This Plan does not repair or restore files changed in other active attempts.
