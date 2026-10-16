---
planId: "1e706d9e-56a0-43cc-8c6f-f3984fd7aea6"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/worktree.js"
    - "src/shared/worktree-guards.test.ts"
    - "src/shared/workflow/execution-context.ts"
    - "src/shared/workflow/execution-context.test.ts"
    - "src/cmd/load-plan/plan-recovery-actions.ts"
    - "src/cmd/load-plan/plan-recovery-reset.ts"
    - "src/cmd/load-plan/plan-hold.ts"
    - "src/cmd/load-plan/plan-recovery-flow.test.ts"
    - "docs/plan-lifecycle.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-08T09:29:42-04:00"
status: "feedback"
origin: "internal"
userVerifiedAt: null
---

# Make Worktree Discard Cleanup Safe and Complete

## Context

After `/load-plan` abandoned an execution attempt, its `worktree/` branch remained. Git first refused manual deletion
because the primary checkout was temporarily on that branch. The reflog proves that state from 09:15:30 to 09:15:56,
then shows a return to `main`. The branch tip equaled `main`, so the immediate repair lost no commit. Diagnosis deleted
the stale ref, then restored it at its exact tip at the user's request; it still has no diff from local `main`. The
user's separate Quick Fix remains as uncommitted primary-checkout files. The 09:14 `git-up auto-stash` also remains.

Two defects can produce or worsen this state:

- Validation recovery can accept the primary checkout as an execution worktree and run `git switch -c` there. The reflog
  does not prove that this code caused the historical switch, but the path must not be possible.
- Abandon, recreate, and held-Plan reset trust saved path/branch data, omit the attempt's base commit, ignore safe
  branch deletion refusal, and can clear normal recovery pointers after Git keeps a branch.

Recovery must never change or remove the primary checkout. It must only discard the exact confirmed attempt and keep
recovery proof whenever Git cannot finish cleanup.

## Objective

Make `/load-plan` abandon, delete/recreate, and held-Plan delete/reset safe against stale identity and primary-checkout
branch state. Successful discard removes the exact execution checkout and each branch Git proves has no unique work.
Blocked or partial discard preserves registry/controller evidence and explains what Git kept. A branch with unique
commits remains named rescue work, not an unexplained orphan.

## Approach

Put destructive Git checks in the existing worktree module. All three recovery actions must consume one cleanup result
before retiring attempt state.

```text
confirmed recovery action
  verify primary path != attempt path
  verify attempt path <-> attempt branch
  remove exact execution checkout
  delete branch with merged/base-commit proof
  complete -> retire attempt and clear active pointers
  unique commits -> keep named abandoned record and report rescue branch
  blocked identity/check-out -> preserve active recovery state and return to menu
```

Validation recovery rejects the primary checkout before path reconciliation or branch restoration. It never switches a
primary-checkout branch.

Keep publication cleanup conservative and separate. Force-deleting every unmerged branch was set aside because it could
destroy the Quick Fix the user was trying to protect.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/worktree.js` — own primary-path exclusion, exact path/branch checks, and complete/retained/blocked cleanup
  results.
- `src/shared/worktree-guards.test.ts` — prove cleanup rules with real repositories and linked worktrees.
- `src/shared/workflow/execution-context.ts` — prevent recovery from selecting primary as an execution directory or
  creating an execution branch there.
- `src/shared/workflow/execution-context.test.ts` — prove primary rejection without losing valid linked-worktree repair.
- `src/cmd/load-plan/plan-recovery-actions.ts` — settle abandon metadata only after a safe cleanup result.
- `src/cmd/load-plan/plan-recovery-reset.ts` — validate recreation inputs before old-attempt mutation and use the shared
  cleanup result.
- `src/cmd/load-plan/plan-hold.ts` — apply the same rules to held-Plan delete/reset.
- `src/cmd/load-plan/plan-recovery-flow.test.ts` or a focused integration test — assert Git, registry, controller, Plan,
  and primary-checkout outcomes together.
- `docs/plan-lifecycle.md` — document complete, retained-rescue, and blocked results.

`src/shared/workflow/publication-machine.ts` remains under ADR-016. It already keeps registry proof after incomplete
published cleanup and must not gain explicit-discard semantics.

## Reuse Opportunities

- `src/shared/worktree.js` — reuse `parseWorktreeRecords`, `deleteMergedWorktreeBranch`, `runGitResult`, and canonical
  path patterns. Do not add a subprocess seam.
- `src/shared/primary-checkout.ts` — reuse primary-checkout resolution where invocation and authority roots differ.
- `src/shared/workflow/state-transition.ts` — record each completed destructive effect with `markEffect`.
- `src/shared/git-test-fixture.ts` — use real disposable Git repositories.
- `src/shared/workflow/publication-machine.ts` — follow its pattern of preserving proof and returning cleanup details.

## Implementation Steps

- The shared cleanup interface rejects the canonical primary checkout and any path/branch mismatch before changing Git
  or attempt state. A branch-only stale attempt is eligible only when Git proves no checkout exists at its missing path.
- Validation recovery never selects primary as `executionCwd`, reconciles an attempt registry path to primary, or runs
  branch restoration there. It returns a specific blocked result with primary branch and files unchanged.
- Explicit discard supplies the recorded `baseCommit` to branch cleanup on every route, including a branch-only attempt
  whose recorded checkout is already missing. An unchanged branch can be deleted even when its base branch is not
  current `HEAD`; merged branches remain deletable; unique-commit branches remain intact.
- Abandon, recreate, and held-Plan delete/reset all consume the cleanup result. They do not ignore `deleted: false`,
  claim full deletion when Git kept artifacts, or clear the only proof for blocked or partial cleanup.
- A retained unique-work branch has a durable abandoned registry record and a message naming it as rescue work. It is
  not an active attempt, but `plans doctor` can still relate it to the Plan and attempt.
- Recreate validates `planId`, base ref/commit, attempt identity, and replacement prerequisites before old checkout
  removal. Each completed Git and registry effect is journaled immediately, so interruption remains diagnosable.
- Successful cleanup clears active controller execution state and reloads the surviving Plan only after Git and registry
  settlement agree. Primary branch, files, and stash remain unchanged.
- `docs/plan-lifecycle.md` matches implemented behavior. No domain-language or architecture change is required.

## Approval Confirmation

No Work Record is superseded. This Plan repairs current behavior without replacing a delivered outcome.

## Verification Plan

- Automated: run
  `deno run -A scripts/run-tests.js src/shared/worktree-guards.test.ts src/shared/workflow/execution-context.test.ts src/cmd/load-plan/plan-recovery-flow.test.ts`
  plus any new focused integration test file.
- Automated: run `deno task seams:check` and `deno task ci`.
- Real-Git regression: record primary as the attempt path with the branch missing. Resolution must block, stay on
  `main`, create no branch, preserve dirty tracked/untracked files, and keep recovery records. This fails for a
  message-only fix.
- Real-Git regression: check the attempt branch out in primary while its saved path is stale. Abandon/reset must not
  adopt or remove primary and must keep active recovery evidence.
- Real-Git regression: point the attempt path at a different dirty linked worktree. Cleanup preserves that checkout,
  branch, files, and recovery metadata.
- Real-Git regression: diverge `main` and a non-current target, create an unchanged attempt at the recorded target base,
  remove only its checkout so the registry path is stale, then confirm abandon. Cleanup must use `baseCommit` on this
  branch-only route: delete the branch, settle registry/controller state, and leave primary branch, HEAD, dirty files,
  untracked files, and stash unchanged. Also cover the same proof while the linked checkout still exists.
- Real-Git regression: create an attempt with an unmerged commit. Abandon retains the branch and abandoned registry
  proof, names the rescue branch, and does not report full deletion.
- Real-Git regression: recreate without valid `planId` or base data fails before old checkout, branch, registry,
  controller, or Plan state changes.
- Preserve existing valid linked-path repair, conservative publication cleanup, merged/unchanged branch deletion,
  execution-document authority, and successful reset/recreate execution.
- Stop primary-checkout adoption, primary branch restoration, forced removal from stale path alone, ignored
  branch-cleanup refusal, and metadata-only success after partial cleanup.
- Manual: in a disposable repository, add an unmerged commit to a failed worktree-backed Plan and abandon it through
  `/load-plan`. Confirm the message names the rescue branch and primary stays on its original branch. Make the branch
  safe, retry cleanup, and confirm checkout and branch disappear.

## Edge Cases & Considerations

- The process that first moved primary onto the execution branch is not proven. Cover the unsafe code path without
  claiming it caused the historical switch.
- A race can change attachment after preflight. Treat Git refusal as incomplete cleanup, preserve evidence, and allow a
  retry. Never switch the user's branch automatically.
- If checkout removal succeeds but branch deletion is refused, retain a recoverable missing-path plus branch record.
- Missing path and branch are idempotent success only when Git and attempt identity agree that no artifact remains.
- Unrelated Quick Fix files are currently dirty in primary. Execution must not reset, stash, stage, or rewrite them.

## Implementation Result

Implemented on 2026-09-08 as part of the main-checkout repair. The shared discard path verifies the primary checkout and
recorded branch, passes the recorded starting commit through linked and missing-path cleanup, and reports retained
rescue branches. Recreate resolves its inputs and creates the replacement before removing the old checkout. Held-Plan
reset also clears the selected document reference.

`deno task ci` passed: 359 test files, type checks, Workspace checks, lint, documentation links, submodules, language
policy, and the zero-seam check. Real Git tests cover wrong primary paths, attempt branches checked out in primary,
unrelated dirty linked checkouts, divergent target branches, missing checkout paths, unique commits, invalid recreation
inputs, and a branch checkout race after directory removal. A `/load-plan` integration test confirms rescue messaging
and cleanup retry after the branch is merged. These tests exercise the production command and Git operations; no
separate manual TUI run was required.

See [the repair record](../work-records/2026-09-08-main-checkout-and-worktree-recovery-repair.md).
