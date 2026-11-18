---
planId: "acdb78a0-8f33-4280-a151-523a632af05b"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/plan-archive-retention.ts"
    - "src/cmd/plans/prune.ts"
    - "src/shared/work-records/"
    - "src/cmd/wr/"
    - "src/plan-store/"
    - "src/shared/settings.js"
    - "src/shared/remote/"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/plan-store-prd.md"
    - "docs/user-documentation/"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 15
dependencies:
    - "external-plan-store/move-work-records-with-delivery-copies"
    - "external-plan-store/activate-managed-remote-store-ownership"
    - "external-plan-store/keep-and-restore-plan-milestone-history"
userVerifiedAt: null
targetBranch: "epic/external-plan-store"
status: "in_progress"
---

# Prune Retained Plans and Work Records

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Home storage becomes the long-lived owner of archived Plans, history and Work Records. Retention must preserve useful recent records and evidence needed by unfinished workflows rather than deleting by age alone.

Owning requirements: [Work Record retention](../../prd/plan-store-prd.md#work-record-store); [Plan history](../../prd/plan-store-prd.md#plan-history); [Work records](../../prd/runwield-core-prd.md#work-records). These are target changes; preserve the existing behavior named below.

**Implementation dependency.** Plan 14, [Keep and Restore Plan Milestone History](keep-and-restore-plan-milestone-history.md), is implemented and awaits publication to `epic/external-plan-store` at planning time. Review Plan 15 now. Before implementation, verify that Plan 14 has landed on the Epic and use its published history and evidence APIs. Plan 14 owns capture, listing and restoration. Plan 15 decides when confirmed pruning can remove that history and which evidence must survive.

On the Epic base, `collectArchivedPlanUnits` in `src/plan-store/archive-retention.ts` returns an empty list for package and managed stores. The existing CLI selects legacy archive units by name. The Work Record CLI already reads canonical records, but has no prune command. Move preview, eligibility checks and confirmed mutations behind the public Plan store so both commands and reminders see the same records.

## Objective

Users can preview and explicitly confirm pruning under the proposal's independent retention settings, with safe repository-copy cleanup and no automatic deletion. This completes the agreed history/retention extension and reconciles the transient proposal into its lasting owners.

## Approach

Apply count-first eligibility independently to archived Plans and Work Records. Work Records retain at least the newest
100 and all records within 90 days by default; zero days means count-only. Retained archived Plans protect their records,
and unfinished publication/Recorder operations pin required inputs regardless of user retention.

Delete only recorded copy paths within the correct repository/owner binding, skip missing/renamed paths, and leave
repository deletions uncommitted. Retrying partial prune must reconcile its recorded effect rather than broaden its scope.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store/index.ts` and its retention implementation — own preview and confirmed pruning by stable identity for both record types. Reuse the selection rules from `src/shared/plan-archive-retention.ts` and make the archive reminder consume the same preview.
- `src/cmd/plans/prune.ts` — dry-run and confirmed package pruning
- `src/shared/work-records/` — record retention, dependency pins and prune operations
- `src/cmd/wr/index.ts` — dispatch and document `wld wr prune`. Show the Work Record reminder on ordinary listing when records are due.
- `src/shared/settings.js` — independent retention settings and defaults
- `src/shared/remote/` — owner-side pruning plus execution-host copy cleanup
- `docs/domain-language.md` — home-owned Plan Archive Retention and record retention relationships
- `docs/prd/runwield-core-prd.md` — lasting retention and completed proposal requirements
- `docs/prd/plan-store-prd.md` — retire only after requirements and references are reconciled
- `docs/user-documentation/` — retention, reminders and dry-run/confirmation behavior

## Reuse Opportunities

- Reuse existing count-first archived-Plan retention, CLI confirmation/dry-run and canonical record eligibility.
- Reuse stored delivery/import path provenance, owner bindings, native locks and recovery receipts.

## Implementation Steps

1. The public Plan store previews archived top-level units with Work Record coverage from `provenance.sourcePlans`. Preserve the existing `plans.archiveKeepLast` and `plans.archiveRetentionDays` settings and Epic family grouping. Work Records rank by `createdAt` with a stable identity tie-breaker and have independent project settings `workRecords.retentionKeepLast` (100) and `workRecords.retentionDays` (90). Protect the count floor first, then the recent window. Zero days means count-only.
2. A record covering an unpruned archived Plan and any snapshot/record needed by unfinished publication or Recorder recovery is protected even if ordinary retention would remove it.
3. Ordinary use may remind about due records but never prunes automatically; both prune flows support dry-run and explicit confirmation with no deletion on decline.
4. The store rechecks identity, coverage, pins and current retention under the owner's existing locking rules before deletion. Confirmed pruning removes only still-eligible approved units and their eligible history. A reused name, newly due unit or newly pinned record cannot be deleted using an earlier confirmation. Interrupted operations resume within that set. Pruned records disappear from canonical list, read and search results, including after an index rebuild.
5. Repository cleanup uses only recorded paths within a known binding, rejects traversal/symlink escape and foreign-owner paths, skips missing or renamed copies, and leaves successful deletions uncommitted.
6. Ordinary local launch prunes the current account's store. A manual SSH login uses that host's account as local owner. In a managed remote launch the laptop performs canonical reads, pins, mutations and indexing through the existing owner service, while the execution host cleans its bound repository. An unavailable binding skips copy cleanup and leaves the canonical prune outcome accurate.
7. Core retention requirements and glossary retention definitions match behavior. Consolidate every delivered Plan Store requirement into its owning central PRD, preserve any genuine unmet target, update references, and remove the transient PRD only after none of its unique requirements are lost.

## Verification Plan

Run the locked install and focused checks through the project's isolated test script. Commit `96b0919c2` on `origin/main` allows compatible local Bun versions (`^1.4.0`); CI and release use `.bun-version`. Use the checkout's supported runtime for these commands.

```sh
bun run install:locked
bun run test src/shared/plan-archive-retention.test.ts src/cmd/plans/prune.test.ts src/cmd/wr/index.test.ts src/shared/work-records/package-store.test.ts src/plan-store/remote-operations.test.ts
```

Extend those suites with real stores, repositories and disposable homes. Use `withProcessGlobalTestLock` for process-global changes.

- With 30 year-old records prune none; with 400 records from the last month prune none; with zero-day age apply only the count floor.
- Retained Plan coverage and unfinished recording/publication pin otherwise eligible records and snapshots; releasing the dependency changes eligibility.
- In the Plan CLI suite, archive a canonical Epic with children and milestone history, alongside an uncovered Plan. Confirm only the covered, due family disappears. A different family and its history remain readable. Introduce a pin between preview and confirmation and verify the owner spares the newly pinned input.
- In the Work Record CLI and package-store suites, prove a due imported or delivered record disappears from list, read and search after confirmation and reindex. Assert the reminder itself, dry-run and decline preserve canonical data and repository copies.
- In the remote suite, place distinguishable records in laptop and execution-account stores. Confirm managed pruning changes only laptop authority and the recorded execution-side copy. A manual SSH launch uses the execution account's home even with SSH environment variables set.
- Dry-run/decline leave all bytes unchanged. Confirm, interrupt and retry pruning with missing, renamed, traversal and symlinked copy paths: only the approved canonical set and safe recorded paths are affected.
- Manual: Preview due Plans and records, decline once, then confirm a bounded prune and inspect uncommitted repository deletions; repeat one unavailable/missing delivery-copy case.
- Preserve: Existing archive semantics, recovery evidence, retained-Plan coverage, independent settings and no automatic destructive work.
- Retire: Repository-owned retention location assumptions and age-only eligibility for the new Work Record policy.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- A missing execution host means best-effort copy cleanup may remain unperformed; report truthful outcome without blocking eligible personal-store pruning.
- Do not delete a transient PRD merely because this child is last in order; reconcile actual implementation and remaining target requirements first.
