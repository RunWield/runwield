---
planId: "e1c5b772-69c8-472d-b739-9f110cd81fcd"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/settings.js"
    - "src/cmd/settings/policies.ts"
    - "src/shared/workflow/plan-branch.ts"
    - "src/shared/workflow/execution-start.ts"
    - "src/shared/workflow/plan-branch.test.ts"
    - "src/cmd/settings/index.test.ts"
    - "docs/domain-language.md"
    - "docs/plan-lifecycle.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/forge-change-request-delivery-prd.md"
planDeviations:
    - id: "call_e6f2eab49a3f42ee9fd11b4ef362af69|fc_0bfcdaa1ef300d2e016ac84d022788819384d95bdbb228557c"
      supersededRequirement: "When the setting is off, RunWield adopts the Plan Branch as the Plan's `targetBranch` at execution start. Every downstream consumer — worktree base selection, merge-back, publication attempts, delivery evidence, Verified semantics, Work Records, cleanup, recovery — already reads `targetBranch`, so none of the merge machinery changes.\n\nNo change to `src/shared/workflow/validation-publication.ts`, `src/shared/isolated-publication.ts`, or `src/shared/worktree.js` merge logic is required for the off-path; an integration test proves the merge lands on `plan/<plan-name>`, the source branch's head is unchanged, the Plan becomes `verified` with delivery evidence recording the Plan Branch, and the Work Record generates.\n\nThe on-path is provably unchanged: with `plans.autoMergeIntoTargetBranch: true`, a standalone Plan without `targetBranch` bases its worktree on the current checkout branch and merges back into it, exactly as today."
      replacementRequirement: "For standalone PLANNED_CHANGE and legacy FEATURE Plans without parentPlan, preserve targetBranch as both the source and the ultimate intended destination. Do not overwrite targetBranch with an automatically created Plan Branch. When targetBranch is absent, resolve the project's repository default branch (main, master, or its actual configured default) and persist it as targetBranch; use that default rather than the current checkout for both setting values. When plans.autoMergeIntoTargetBranch is off (default), create or reuse plan/<slug-of-full-plan-name> from targetBranch, base the execution worktree on that Plan Branch, and publish/merge the worktree back into the Plan Branch without merging onward into targetBranch. Track the actual landing branch separately and use it consistently in publication, delivery evidence, verification, recovery, Work Records, and cleanup; resumed attempts retain their recorded landing branch. When auto-merge is on, skip automatic Plan Branch creation, base the worktree on targetBranch, and commit/merge delivery back into targetBranch. Off-path successful delivery is Verified at its recorded landing branch, and the end summary card says “Ready for your merge/PR”, clearly names that landing branch, and preserves the intended target to guide the user's onward merge/PR. Epic/Sequence children, PROJECT, QUICK_FIX, non-Git execution, and the Forge Epic scope remain unchanged. Correct local publication to leave primary-checkout files untouched when delivering to an unchecked-out branch and report whether the primary checkout was actually updated. Update affected implementation steps, tests, acceptance journeys, glossary, lifecycle, and PRD descriptions to these semantics; existing merge machinery can remain where it already supports the behavior."
      reason: "User explicitly revised branch semantics and completion messaging, and approved fixing the discovered local-publication assumption that could erase an uncommitted canonical Plan."
      approvedAt: "2026-10-09T02:12:06.618Z"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-08T21:42:24-0400"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
routingIntent: "PLANNED_CHANGE"
validatedCommit: "566ae990661a165f56a5dfa7c7ed726c7dbbb693"
workRecord:
    status: "generated"
    recordId: "335cc883-ce2f-4fec-9bf9-ca9fc792868a"
    path: "docs/work-records/2026-10-09-default-off-plan-branch-delivery-implemented.md"
    lastAttemptAt: "2026-10-09T17:17:12.873Z"
status: "verified"
---

# Plan Branch Delivery Setting

## Context

Today every standalone Planned Change is published by an automatic merge into its `targetBranch` (or the current
checkout branch when unset) right after validation and the code review gate. The user wants that automatic merge to be
optional, and off by default: RunWield should stop at a per-Plan branch, the way Epics already stop at their Epic
branch, and the user merges onward themselves.

This is the simple version the user asked for instead of advancing the
[Forge Change Request Delivery](forge-change-request-delivery.md) Epic. That Epic stays as-is and is not modified by
this Plan.

Owning capability: `docs/prd/runwield-core-prd.md#execution-validation-and-recovery`. The requirement "Verified means
the reviewed implementation reached its target" is unchanged — with the setting off, the Plan's target becomes the Plan
Branch, so Verified still means exactly "reached its target".

Decisions made with the user during planning:

- The setting applies only to standalone Planned Changes (classification `PLANNED_CHANGE`, no `parentPlan`). Epic and
  Sequence children keep merging into their Epic branch; PROJECT Epics are not executed directly; QUICK_FIX is out of
  scope.
- Default is off (no automatic merge into `targetBranch`).
- "main" means the repository's default branch (origin's `HEAD`, falling back to `main`), not a literal `main` ref, so
  `master`-default repositories keep working.
- When the setting is on, behavior is exactly today's: worktree from `targetBranch` or, when unset, the current checkout
  branch, and merge back into it.
- Push behavior follows the existing publication machinery: when the project has an upstream remote, the Plan Branch is
  pushed to it (so the user can open a pull request); local-only projects merge into the local Plan Branch.

## Objective

A new setting, `plans.autoMergeIntoTargetBranch` (default `false`), controls how a standalone Planned Change delivers:

```text
setting off (default):
  source = targetBranch, or the repo default branch when unset
  ensure branch plan/<plan-name> exists, created from source
  write targetBranch: plan/<plan-name> into the Plan      (Epic-style adoption)
  worktree based on plan/<plan-name>
  merge back into plan/<plan-name> -> verified -> Work Record
  user merges plan/<plan-name> into the source branch themselves

setting on:
  today's behavior, unchanged
```

## Approach

Copy the Epic Branch pattern (`src/shared/workflow/epic-branch.ts`) instead of adding a parallel merge path. When the
setting is off, RunWield adopts the Plan Branch as the Plan's `targetBranch` at execution start. Every downstream
consumer — worktree base selection, merge-back, publication attempts, delivery evidence, Verified semantics, Work
Records, cleanup, recovery — already reads `targetBranch`, so none of the merge machinery changes.

```diff
 startActiveExecutionWorkflow (src/shared/workflow/execution-start.ts)
   read targetBranch from Plan front matter
+  if standalone PLANNED_CHANGE && setting off && targetBranch is not already plan/-prefixed
+    ensure plan/<plan-name> exists, created from targetBranch || repo default
+    rewrite Plan targetBranch to plan/<plan-name>   (inside the locked preparation transition)
   prepareTarget(targetBranch) -> worktree base
   ... execution, validation, review ...
   publication merges into targetBranch               (unchanged; now the Plan Branch)
```

The adoption rule, in full:

```text
targetBranch unset            -> adopt plan/<plan-name>, created from the repo default branch
targetBranch set, not plan/*  -> adopt plan/<plan-name>, created from targetBranch
targetBranch already plan/*   -> use as-is (idempotent resume; also respects a user-authored plan/ branch)
```

The main option set aside: keep `targetBranch` pointing at the ultimate target and track the Plan Branch in a separate
field. That would break "Verified means reached its target" (Verified would be claimed while the work is not in the
target branch) and would move the merge-target decision into `validation-publication.ts`, recovery, and evidence
builders — one decision encoded in several modules. The Epic-style rewrite keeps one decision in one place.

> [!NOTE]
> **The Plan stops recording the ultimate target**
>
> After adoption the Plan's `targetBranch` is `plan/<plan-name>`, and the source branch (usually the repo default) is no
> longer in front matter — the same trade-off Epic Branches already make. The delivery evidence still records
> `targetHeadBeforeMerge`, and the branch's merge-base with the default branch shows where it started.

## Expected Change Surface

- `src/shared/settings.js` — new `shouldAutoMergePlansIntoTargetBranch(projectRoot)` reading nested
  `plans.autoMergeIntoTargetBranch` through `getMergedCustomSetting` (project overrides global), default `false`;
  follows the `shouldAutoGenerateWorkRecordsOnPlanCompletion` pattern.
- `src/cmd/settings/policies.ts` — new boolean policy "Auto-merge into target branch" (Off default / On) in the
  `wld settings` policy list, project or global scope.
- `src/shared/workflow/plan-branch.ts` (new) — Plan Branch naming, creation, and the adoption gate; mirrors
  `epic-branch.ts` but much smaller (no child seeding, no family logic).
- `src/shared/workflow/execution-start.ts` — adoption hook inside the execution preparation transition, before worktree
  creation.
- `src/shared/worktree.js` — likely small export or helper so `plan-branch.ts` can create a branch from a specific
  source ref (today `prepareTargetBranchRef` only creates from the repo default).
- `docs/domain-language.md` — new **Plan Branch** entry mirroring **Epic Branch**.
- `docs/plan-lifecycle.md` — `targetBranch` paragraph mentions Plan Branch adoption.
- `docs/prd/runwield-core-prd.md` — owning capability gains the setting requirement and scenarios.
- `docs/prd/forge-change-request-delivery-prd.md` — its "Direct Delivery remains the default … merges into the local
  target branch" statements are adjusted to the new default; Epic scope itself is untouched.
- Existing workflow/publication tests that run standalone Plans without the setting — expectations move to the Plan
  Branch flow, or they enable the setting to keep covering the on-path.

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need. Stop and report only when discovery changes approved intent.

## Reuse Opportunities

- `src/shared/workflow/epic-branch.ts` — the adoption pattern: create the branch before recording it, write
  `targetBranch` through `updatePlanFrontMatter` with `expectedRevision`, use an existing branch as-is.
- `src/shared/worktree.js` — `prepareTargetBranchRef` / `createLocalBranchFromDefault` (repo-default resolution,
  remote-first), `assertValidTargetBranchName`, `remoteBranchExists`, `slugify`.
- `src/shared/settings.js` — `getMergedCustomSetting` nested-key pattern (`workRecords.autoGenerateOnPlanCompletion`).
- `src/shared/git-test-fixture.ts` (`defineGitFixture`) — real repositories for the new tests; no new seams
  (`deno task seams:check` must stay clean).

## Implementation Steps

- `src/shared/settings.js` exports `shouldAutoMergePlansIntoTargetBranch(projectRoot): boolean`; it returns `true` only
  when the merged `plans` object's `autoMergeIntoTargetBranch` is literally `true`, and `false` otherwise (unset,
  non-boolean, or non-object `plans`). Unit tests cover default-false, project-over-global, and invalid values.
- `src/cmd/settings/policies.ts` lists an "Auto-merge into target branch" policy with Off (default) and On choices,
  saved as `plans.autoMergeIntoTargetBranch` in the chosen scope; `src/cmd/settings/index.test.ts` covers persisting
  both values and the scope prompt.
- `src/shared/workflow/plan-branch.ts` exists and exports `PLAN_BRANCH_PREFIX` (`"plan/"`),
  `defaultPlanBranchName(planName)` (slug of the full Plan name, same slug rules as the worktree branch), and
  `ensurePlanBranch({ projectRoot, planName, sourceBranch })` which: uses an existing `plan/<plan-name>` branch as-is;
  otherwise creates it from `sourceBranch` (remote ref first, then local ref) or, when `sourceBranch` is unset, from the
  repo default branch; and returns `{ branch, created }`. It never checks out, resets, or writes any working tree.
- `src/shared/workflow/plan-branch.ts` exports the adoption gate: adoption applies exactly when the Plan's
  classification is `PLANNED_CHANGE` (or legacy `FEATURE`), it has no `parentPlan`, the setting is off, and its
  `targetBranch` is unset or does not start with `plan/`. Tests prove Epic children, PROJECT Plans, and `plan/`-prefixed
  targets are excluded.
- In `startActiveExecutionWorkflow` (`src/shared/workflow/execution-start.ts`), when the adoption gate passes, the
  preparation transition's `prepare` step: (1) calls `ensurePlanBranch` with the Plan's `targetBranch` as source (or
  unset for repo default), (2) rewrites the canonical Plan's `targetBranch` to the Plan Branch via
  `updatePlanFrontMatter` under the plan lock with the locked revision, and (3) bases the new worktree on the Plan
  Branch, so `createWorktreeGitArtifacts` records it as `baseBranch`. The branch exists before the front-matter write. A
  resumed or repaired Plan whose `targetBranch` is already the Plan Branch skips adoption and reuses it.
- No change to `src/shared/workflow/validation-publication.ts`, `src/shared/isolated-publication.ts`, or
  `src/shared/worktree.js` merge logic is required for the off-path; an integration test proves the merge lands on
  `plan/<plan-name>`, the source branch's head is unchanged, the Plan becomes `verified` with delivery evidence
  recording the Plan Branch, and the Work Record generates.
- The on-path is provably unchanged: with `plans.autoMergeIntoTargetBranch: true`, a standalone Plan without
  `targetBranch` bases its worktree on the current checkout branch and merges back into it, exactly as today.
- `docs/domain-language.md` defines **Plan Branch** (branch a standalone Planned Change delivers to when auto-merge is
  off, recorded as the Plan's `targetBranch`, default `plan/<plan-name>`, created from the Plan's target or the repo
  default branch; RunWield never merges it onward; the user merges it or opens a pull request; _Avoid_: feature branch,
  Epic Branch) and the entry contains no unimplemented claims.
- `docs/plan-lifecycle.md`'s `targetBranch` paragraph states that RunWield may adopt a Plan Branch as the delivery
  target at execution start when the setting is off.
- `docs/prd/runwield-core-prd.md#execution-validation-and-recovery` gains a named requirement for the
  `plans.autoMergeIntoTargetBranch` setting (default off; Plan Branch delivery; on-path preserves today's behavior) with
  acceptance scenarios for both paths, and existing scenarios that assumed automatic merge-into-target are updated
  rather than contradicted.
- `docs/prd/forge-change-request-delivery-prd.md` statements that Direct Delivery is the default that "merges it into
  the local target branch" are updated to name the setting and the Plan Branch stop point; no Epic scope, objectives, or
  invariants change.
- Every existing test that executes a standalone Planned Change end-to-end without the setting either asserts the new
  Plan Branch flow or explicitly enables the setting to keep asserting the on-path; no test is deleted for compile
  reasons without that split being recorded in the change.

## Approval Confirmation

No `supersedes` Work Record IDs are proposed; this is new behavior, not a replacement of a delivered record.

## Verification Plan

- Automated: `deno task test` (full suite; RunWield also runs `deno task ci` after implementation). Focused new
  coverage:
  - `src/shared/workflow/plan-branch.test.ts` (real Git fixture): default naming; creation from an explicit source
    branch; creation from the repo default when unset; existing-branch reuse without recreation; adoption-gate
    exclusions (Epic child with `parentPlan`, PROJECT, `plan/`-prefixed target).
  - Settings unit tests: default false, project-over-global precedence, non-boolean values ignored.
  - An execution-start + publication integration test (real Git fixture, setting off): branch `plan/<plan-name>` exists
    and is based on the repo default; the worktree `baseBranch` is the Plan Branch; the Plan's front matter records
    `targetBranch: plan/<plan-name>`; after validation the merge commit is on the Plan Branch; the source branch head is
    unchanged; the Plan is `verified`. This test fails if the setting is added but not wired into execution start, or if
    publication still merges into the source branch.
  - An on-path integration test (setting true, no `targetBranch`): worktree based on the current checkout branch and
    merged back into it — today's behavior, protected.
- Manual: in a scratch repository, run `wld settings`, toggle "Auto-merge into target branch" off (default) and on; load
  a small standalone Plan end-to-end with the setting off and confirm `git branch` shows `plan/<plan-name>`, the default
  branch is untouched, and the Plan shows Verified; then repeat with the setting on and confirm the merge lands on the
  target/current branch.
- Behavior that must survive: Epic and Sequence children still deliver to their Epic branch; the on-path is
  byte-for-byte today's flow; publication evidence, recovery, Work Record generation, and worktree cleanup semantics are
  unchanged (their target is now the Plan Branch). Behavior that intentionally stops existing: standalone Planned
  Changes no longer merge into `targetBranch`/current checkout automatically unless the setting is on.
- Confirm `docs/domain-language.md`, `docs/plan-lifecycle.md`, and both PRDs describe the delivered behavior with no
  unimplemented proposals promoted as current.

## Edge Cases & Considerations

- **Default flip changes every existing standalone-Plan flow** — the off-path is the new default, so existing tests and
  golden scenarios that assert merge-into-target must be updated or moved to the on-path; the step list makes that split
  explicit so coverage is not silently lost.
- **Two Plans slug to the same branch name** (e.g. `fix-a` and `fix/a`) — the second Plan adopts the first's existing
  branch. Rare for standalone Plans (nested names are usually Epic children, which are excluded); accepted, same
  trade-off as Epic Branch naming.
- **Repo has no `main`** — repo-default resolution (origin `HEAD`, then `main`) already handles `master`-default
  repositories; a repository with neither fails with the existing "does not exist" error before any Plan state changes.
- **User-authored `plan/` target** — used as-is, never re-based or re-adopted; mirrors how a named Epic branch is
  respected.
- **Remote projects** — the existing remote publication path pushes the Plan Branch to the upstream (creating it there
  when absent), which is what makes a pull request possible; local-only projects merge locally. No new push logic is
  added.
- **Setting changed between attempts** — a Plan that already adopted a Plan Branch keeps it (the `plan/` prefix rule
  makes adoption idempotent); toggling the setting does not retarget an in-flight or resumed attempt, matching the
  existing rule that changing checkout metadata does not retarget an active attempt.
- **Non-Git projects** — the in-place execution path returns before target resolution; unaffected.
