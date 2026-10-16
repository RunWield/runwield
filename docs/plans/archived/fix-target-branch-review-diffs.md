---
planId: "a3bf1047-57dd-407b-8d27-bdb17cbc0627"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/git-snapshot.js"
    - "src/shared/workflow/validation-context.ts"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/shared/workflow/validation-supervisor.ts"
    - "src/shared/workflow/validation-human-review.ts"
    - "src/shared/workflow/review-diff-tool.js"
    - "src/ui/review/"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/agent-definitions/subagent-definitions/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/005-concurrent-worktree-isolation.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-17"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
archivedAt: "2026-09-24T04:16:05.980Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/fix-target-branch-review-diffs.md"
---

# Compare Review Diffs Directly Against the Target Branch

## Context

AI code review reported an existing WinGet submission job as new Plan work. The repair then removed that job. Today,
`validation-semantic.ts` calls `getDiffText(context.baselineTree, context.executionCwd)`. That calls `getWorkflowDiff`,
which compares the saved execution tree with the current files. Changes imported after that snapshot can therefore
appear as new work. `review_diff` only presents the supplied patch; it does not choose the Git comparison.

The owner clarified the required rule: compare the worktree's current contents, committed or uncommitted, directly
against its `targetBranch`. Do not use the original execution snapshot or Git's shared ancestor. Do not substitute
`main` for another recorded target.

The reported release attempt targets `epic/consolidate-project-runtime-state`. At inspection, WinGet submission existed
on `main` but not on that target. This fix must obey the actual target; it does not promise to suppress changes that
exist only on another branch. The affected worktree already had uncommitted repair edits. Do not restore or discard them
as part of this implementation.

Owning capabilities:

- Core [Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair): extend **Resolve
  concrete findings through independent review** with a named **Target-relative review diff** requirement and scenarios
  below.
- Core [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve
  worktree isolation, independent repair verification, continuation, and publication proof.

These are proposed changes. Preserve missing-requirement checks, stable Review Issue identities, repair-round policy,
and non-Git behavior. No package publication policy changes are in scope.

## Objective

Every full workflow review patch equals the direct difference from the recorded target branch's current committed tree
to the execution worktree's current file tree. AI review, repair context, and human review use the same rule, including
resume and browser reload. One shared function owns this calculation for all current and future callers. For the same
target commit and worktree contents, AI review and the code review interface receive the same patch, not merely the same
file list. Existing target content does not appear as added unless the worktree actually differs.

## Approach

Separate review comparison from recovery snapshots:

```text
Full review today: saved execution tree -> current worktree tree
Full review after: recorded target branch tip -> current worktree tree
Repair-only scope: saved pre-repair tree -> current worktree tree (unchanged)
```

Export one shared function, `getWorktreeReviewDiff(cwd, targetBranch)`, beside `captureWorktreeTree` and `diffTrees` in
`git-snapshot.js`. It returns the full patch text and owns target-ref resolution, current-tree capture, Git diff
options, and comparison errors. Callers supply the execution directory and recorded target; they do not construct Git
ranges, filter hunks, or implement their own comparison. Document this as the entry point for every future caller that
needs the worktree's full target-relative diff. Do not add a replaceable implementation or a second diff service.

The function resolves the target to `refs/heads/<resolved-branch>` and then to a commit once per patch computation. It
compares that commit's tree with one captured worktree tree. Reuse the temporary-index snapshot mechanism, without
changing the real index, files, branches, or saved execution baseline. The result is one net patch, not concatenated
committed/staged/unstaged patches. Include non-ignored untracked additions.

```text
AI review / repair context / human review open / both browser reload paths
  -> getWorktreeReviewDiff(executionCwd, recordedTargetBranch)
     -> resolve target commit + capture current files
     -> one full patch
```

`review_diff` only parses and pages that patch. The code review interface only presents it. Neither owns another
comparison algorithm. Equal input state must produce equal patch text; later edits or target advancement can correctly
change a refreshed patch. This does not freeze the worktree or require a new persistent patch cache.

Use the target already resolved by execution (`worktreeBaseBranch`, from the registered attempt), consistent with the
Plan's `targetBranch`. When the Plan omitted an explicit target, use the branch recorded when execution began, not the
primary checkout's branch today. Read local branch refs as existing validation does; this change adds no network fetch,
retargeting, synchronization, merge, or rebase. Missing or invalid target evidence is a recoverable comparison failure,
not permission to use `main`, `HEAD`, an old snapshot, or an empty patch. Non-Git execution keeps its existing path.
Snapshot-only callers, including legacy non-worktree flows without a recorded target, keep their separate contract.

Route the new helper through full-diff calls in `validation-semantic.ts`, `validation-supervisor.ts` (saved repair
handoff), and `validation-human-review.ts`. Keep `getWorkflowDiff` for recovery and explicit pre-repair comparisons; do
not globally change its meaning. Ensure segmented repair continuation receives the corrected full patch too.

Human review currently passes `baselineTree` through interaction metadata, the TUI adapter, review launcher, and
Workspace refresh context. Pass the recorded target instead for worktree-backed review. Both standalone and Workspace
reloads must recompute with the new helper. Keep local paths and internal comparison inputs server-side. Preserve the
existing last-complete-patch display fallback for temporary read failures; initial comparison failures must not dispatch
review or repair using a fabricated or old-baseline patch.

Update tool descriptions and prompts to name the full target-relative patch and the separate repair-only patch. Context
files are not proof of a new change. Repair must check an AI finding against the supplied full patch before reverting
existing behavior. A prior finding can be reported as already satisfied or incorrectly attributed, with evidence, and
independently resolved by the Reviewer without requiring a code edit. Keep its ID; never silently clear the ledger. An
empty repair patch alone must not force rejection of such a disproved finding. Genuine unmet Plan requirements still
block even when their missing implementation has no hunk. Human feedback remains authoritative.

A shared-ancestor diff was set aside because the owner explicitly requested current target-to-worktree differences. Thus
target changes absent from the worktree remain visible as removals or modifications. That is intentional, not a reason
to silently change the comparison.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/git-snapshot.js` and tests — the shared `getWorktreeReviewDiff` entry point owns direct target
  comparison with a complete current-tree snapshot; its interface documents the rule for future callers.
- `validation-context.ts`, `validation-semantic.ts`, `validation-supervisor.ts`, and `validation-human-review.ts` — full
  patches use recorded targets; repair-only and recovery snapshots retain their meanings.
- `src/shared/session/session-runtime.js` and repair handoff tests — verify resumed segmented repair receives the same
  full-patch rule; change handoff plumbing only as needed, not Session storage architecture.
- `review-diff-tool.js` and Reviewer/Validation Repair Engineer definitions — accurate scope descriptions and evidence
  rules for wrongly attributed prior findings.
- `src/ui/tui/runtime-interaction-adapter.js`, `src/ui/review/code-review.ts`, and `review-launcher.ts` — carry the
  target through existing human review plumbing. No visual redesign.
- `src/ui/workspace/server.js` and `server/session-continuation.js`, plus review integration tests — target-relative
  patches on standalone and Workspace reload, without exposing local comparison context.
- `docs/prd/runwield-core-prd.md`, `docs/plan-lifecycle.md`, and `docs/adr/005-concurrent-worktree-isolation.md` — align
  requirements and current review guidance. Record the single shared comparison owner and AI/human patch parity.
  Distinguish the immutable recovery baseline from the live review target. Do not rewrite unrelated ADR-003 recovery
  policy or publication architecture.
- `docs/domain-language.md` — clarify Semantic Code Review, Local Human Code Review, and Review Issue definitions and
  relationships to actual changes and independently disproved findings. No new domain term is needed.

## Reuse Opportunities

- `captureWorktreeTree`, `diffTrees`, and existing Git error handling; no new injectable owner or test-only switch.
- The registered execution target and `resolvePhaseContext`; no new user setting or separate review branch.
- `createReviewDiffTool` list/show/paging and full/repair scopes.
- Existing `already satisfied` repair reports, stable finding IDs, and independent review resolution.
- `defineGitFixture`, `makeValidationProjectRoot`, and scripted external Agent turns for real-Git integration tests.

## Implementation Steps

1. A real-Git regression fails on the existing snapshot comparison: a target commit imported into the worktree is shown
   as added today, but is absent from the required full patch; separate worktree edits remain visible.
2. The target-relative helper returns the exact net target-to-current-files patch, including committed, staged,
   unstaged, and non-ignored untracked changes. It preserves the real index and checkout and reports missing targets.
3. `getWorktreeReviewDiff` is the sole full target-relative diff implementation. All full workflow diff consumers use it
   and the recorded target, including saved and segmented repair handoffs. No caller retains its own Git range or patch
   filtering. A cross-consumer test proves AI review, repair context, and both human review surfaces receive the same
   patch for unchanged target/worktree state. Repair-only scope still measures the latest repair, not the whole target
   difference. Recovery baselines and publication evidence are unchanged.
4. Human review opens and reloads through both existing server paths with a target-relative patch. Target changes are
   resolved again on refresh. No old `baselineTree` metadata path silently restores the previous full-diff behavior.
5. Reviewer and repair instructions distinguish existing context from actual changes and permit evidence-backed
   resolution of wrongly attributed prior findings without forced edits. Ledger IDs, independent verification, and
   genuine missing-requirement blocking remain intact.
6. Owning PRD requirements and scenarios, lifecycle guidance, ADR-005, and glossary definitions/relationships describe
   the implemented comparison together. Unrelated product requirements and deferred work remain unchanged.

## Approval Confirmation

No Work Record supersession is proposed. Approval covers the owner's direct target comparison, not a shared-ancestor
comparison, separate review-branch setting, or restoration of another active attempt's edits. Execution can be
autonomous.

## Verification Plan

Use only the sandboxed test runner. Extend existing files or add focused tests beside them:

```sh
deno run -A scripts/run-tests.js src/shared/workflow/git-snapshot.test.ts src/shared/workflow/review-diff-tool.test.js src/shared/workflow/validation-loop-review.test.js src/shared/workflow/validation-loop-human-review.test.js src/shared/workflow/validation-owner.test.ts src/ui/review/review-launcher.test.ts src/ui/workspace/workspace-code-review.integration.test.ts
deno task ci
```

Required proof:

- **One patch across consumers:** use one real non-main-target fixture with imported target work, committed edits,
  staged/unstaged edits, additions, and deletions. With target and file contents held constant, compare the shared
  function's complete patch with the full patch actually supplied to the AI review tool and repair packet, and the
  `rawPatch` returned by the standalone and Workspace code review endpoints. Assert byte-for-byte equality. Reassemble
  actual paged `review_diff show` hunk content to prove nothing was omitted or changed for the AI. Repeat after changing
  both target and worktree state. Fake only external Agent turns; do not stub the diff function or supply canned
  patches. Separate endpoint tests that only check a shared filename are insufficient. Inspect imports/call paths as
  complementary proof that equal outputs do not conceal duplicate implementations.
- **Imported target work:** start an attempt, advance its non-main target with a WinGet-like job, import that commit,
  and make separate implementation changes. Through real validation and the actual injected `review_diff` tool, assert
  list/show omit the unchanged target job and include the Plan changes. Fake only external Agent responses. The old
  helper and a disconnected replacement must fail this test.
- **Exact comparison:** combine a committed edit, staged addition, unstaged edit, non-ignored untracked file, deletion,
  and a file with staged then further unstaged edits. Assert one net diff per file and exact before/after content. An
  edit later undone to target bytes disappears. Verify index bytes, branch tips, working files, and baseline metadata
  remain unchanged by inspection.
- **Not shared-ancestor:** advance the target without importing it. Assert its absent file appears as a deletion in the
  direct patch. Put distinct content on `main`, the primary checkout, and the recorded non-main target; only the
  recorded target supplies the before side. Move the target again and verify a new computation uses its new tip.
- **Repair/resume:** after a scripted rejection of a real worktree defect, repair it and resume through the saved
  checkpoint and segmented handoff. Inspect actual tool responses: full scope still uses target; repair scope contains
  only before/after repair changes. Target content is not presented as a fresh addition to repair.
- **Wrong prior finding:** provide a finding that attributes unchanged target content to this Plan. Exercise the
  existing already-satisfied report and resolved finding path without file edits. Preserve its ID and independent
  review. Inspect the assembled prompts to ensure empty repair scope does not contradict this path. Also prove a
  genuinely missing requirement stays open; no automatic blanket ledger clearing is allowed.
- **Human review refresh:** exercise actual standalone and Workspace review endpoints. After initial load, change
  worktree files and advance the target. Reload and assert exact updated hunks and absence of the old snapshot patch.
  Preserve authentication, server-side local context, and last-complete-patch fallback tests. No layout changes require
  visual acceptance; a disposable human-review open/reload smoke check confirms the displayed patch.
- **Failure and preserved behavior:** missing target cannot silently fall back or be reported as no changes. Preserve
  snapshot tests for pre-existing dirty files, repair-only paging, non-Git skips, Plan-only/no-implementation policy,
  independent review, and publication ancestry. An actually empty target patch remains empty; do not manufacture work
  from the old baseline to satisfy existing implementation-diff checks.

Semantic Review must trace validation, repair continuation, and both browser reload paths to the actual helper. A new
unused helper, renamed baseline parameter, prompt-only warning, filtered file list, or unchanged old full-diff caller is
not a fix. Duplicate target-relative Git calculations are also a failure even if current fixtures yield equal patches:
the shared function must own the rule. Confirm PRD, ADR, lifecycle, and glossary wording agree with these tests.

## Edge Cases & Considerations

- This is a net file comparison, not commit attribution. It includes all differences from the target regardless of
  commit author, Plan path lists, or whether another branch supplied them. Never filter by `affectedPaths`.
- A target can move during review. Resolve one commit per computation; the next review/refresh uses the new tip. This
  Plan adds no branch lock or publication policy. Existing publication checks retain their authority.
- Work already removed by an earlier repair appears as a real deletion against a target that contains it. Do not hide
  that deletion or automatically restore files in live attempts.
- Concurrent repository work was present during planning. Inspect current source and preserve unrelated edits,
  particularly release tooling and documentation. Modify no live controller, registry, or other attempt during tests.
