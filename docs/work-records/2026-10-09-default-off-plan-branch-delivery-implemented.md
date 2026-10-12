---
kind: "work_record"
recordId: "335cc883-ce2f-4fec-9bf9-ca9fc792868a"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-09T17:17:12.873Z"
provenance:
    sourcePlans:
        - "e1c5b772-69c8-472d-b739-9f110cd81fcd"
---
# Default-off Plan Branch delivery implemented

## Summary

Implemented default-off Plan Branch delivery for standalone Plans, with separate intended-target and landing-branch
tracking and repository-default resolution for untargeted Plans. Added publication safeguards for primary-checkout files
and fixes for archive, lifecycle reload, and landing-branch recovery. Completion cards now say “Ready for your merge/PR”
and identify the landing branch. Updated settings and product documentation without expanding Forge Epic scope. Added 21
tests; focused checks, static checks, and browser checks passed. Validation is recorded for commit
`566ae990661a165f56a5dfa7c7ed726c7dbbb693`; publication remains pending. This record does not claim merge or delivery.

## Deviations from Plan

1. Superseded requirement: When the setting is off, RunWield adopts the Plan Branch as the Plan's `targetBranch` at
   execution start. Every downstream consumer — worktree base selection, merge-back, publication attempts, delivery
   evidence, Verified semantics, Work Records, cleanup, recovery — already reads `targetBranch`, so none of the merge
   machinery changes.

No change to `src/shared/workflow/validation-publication.ts`, `src/shared/isolated-publication.ts`, or
`src/shared/worktree.js` merge logic is required for the off-path; an integration test proves the merge lands on
`plan/<plan-name>`, the source branch's head is unchanged, the Plan becomes `verified` with delivery evidence recording
the Plan Branch, and the Work Record generates.

The on-path is provably unchanged: with `plans.autoMergeIntoTargetBranch: true`, a standalone Plan without
`targetBranch` bases its worktree on the current checkout branch and merges back into it, exactly as today. Replacement
requirement: For standalone PLANNED_CHANGE and legacy FEATURE Plans without parentPlan, preserve targetBranch as both
the source and the ultimate intended destination. Do not overwrite targetBranch with an automatically created Plan
Branch. When targetBranch is absent, resolve the project's repository default branch (main, master, or its actual
configured default) and persist it as targetBranch; use that default rather than the current checkout for both setting
values. When plans.autoMergeIntoTargetBranch is off (default), create or reuse plan/<slug-of-full-plan-name> from
targetBranch, base the execution worktree on that Plan Branch, and publish/merge the worktree back into the Plan Branch
without merging onward into targetBranch. Track the actual landing branch separately and use it consistently in
publication, delivery evidence, verification, recovery, Work Records, and cleanup; resumed attempts retain their
recorded landing branch. When auto-merge is on, skip automatic Plan Branch creation, base the worktree on targetBranch,
and commit/merge delivery back into targetBranch. Off-path successful delivery is Verified at its recorded landing
branch, and the end summary card says “Ready for your merge/PR”, clearly names that landing branch, and preserves the
intended target to guide the user's onward merge/PR. Epic/Sequence children, PROJECT, QUICK_FIX, non-Git execution, and
the Forge Epic scope remain unchanged. Correct local publication to leave primary-checkout files untouched when
delivering to an unchecked-out branch and report whether the primary checkout was actually updated. Update affected
implementation steps, tests, acceptance journeys, glossary, lifecycle, and PRD descriptions to these semantics; existing
merge machinery can remain where it already supports the behavior. Reason: User explicitly revised branch semantics and
completion messaging, and approved fixing the discovered local-publication assumption that could erase an uncommitted
canonical Plan.

## Deferred Work

The execution report leaves full CI confirmation outstanding. An intermittent background-task test timeout remains,
along with 20 unresolved documentation links in untouched documents. The full test run had 564 passing files and two
failures; the Workspace import failure was subsequently fixed and rechecked.

## Future Planning Notes

Keep intended-target and actual landing-branch data distinct across publication, evidence, recovery, and cleanup.
Resumed attempts must retain their recorded landing branch. Regression tests for unchecked-out branch publication must
confirm that primary-checkout files remain unchanged.
