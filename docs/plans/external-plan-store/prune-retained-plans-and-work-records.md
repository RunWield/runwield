---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/plan-archive-retention.ts"
    - "src/cmd/plans/prune.ts"
    - "src/shared/work-records/"
    - "src/cmd/"
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
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "acdb78a0-8f33-4280-a151-523a632af05b"
---

# Prune Retained Plans and Work Records

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Home storage becomes the long-lived owner of archived Plans, history and Work Records. Retention must preserve useful recent records and evidence needed by unfinished workflows rather than deleting by age alone.

Owning requirements: [Work Record retention](../../prd/plan-store-prd.md#work-record-store); [Plan history](../../prd/plan-store-prd.md#plan-history); [Work records](../../prd/runwield-core-prd.md#work-records). These are target changes; preserve the existing behavior named below.

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

- `src/shared/plan-archive-retention.ts` — preserve archived-Plan count-first policy on package storage
- `src/cmd/plans/prune.ts` — dry-run and confirmed package pruning
- `src/shared/work-records/` — record retention, dependency pins and prune operations
- `src/cmd/` — Work Record prune command and reminders
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

1. Archived Plan and Work Record policies evaluate count floors before age; default Work Record values are 100 and 90 days, and zero days means count-only.
2. A record covering an unpruned archived Plan and any snapshot/record needed by unfinished publication or Recorder recovery is protected even if ordinary retention would remove it.
3. Ordinary use may remind about due records but never prunes automatically; both prune flows support dry-run and explicit confirmation with no deletion on decline.
4. Confirmed pruning removes eligible canonical units and their eligible history while preserving dependency pins; interrupted operations resume without expanding the approved set.
5. Repository cleanup uses only recorded paths within a known binding, rejects traversal/symlink escape and foreign-owner paths, skips missing or renamed copies, and leaves successful deletions uncommitted.
6. Managed remote pruning executes personal-store mutations on the laptop and eligible repository cleanup on the execution host; unavailable bindings do not make store pruning fabricate cleanup success.
7. Core retention requirements and glossary retention definitions match behavior. Consolidate every delivered Plan Store requirement into its owning central PRD, preserve any genuine unmet target, update references, and remove the transient PRD only after none of its unique requirements are lost.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/shared/plan-archive-retention.test.ts src/cmd/plans/prune.test.ts src/shared/work-records/work-records.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- With 30 year-old records prune none; with 400 records from the last month prune none; with zero-day age apply only the count floor.
- Retained Plan coverage and unfinished recording/publication pin otherwise eligible records and snapshots; releasing the dependency changes eligibility.
- Dry-run/decline leave all bytes unchanged. Confirm, interrupt and retry pruning with missing, renamed, traversal and symlinked copy paths: only the approved canonical set and safe recorded paths are affected.
- Manual: Preview due Plans and records, decline once, then confirm a bounded prune and inspect uncommitted repository deletions; repeat one unavailable/missing delivery-copy case.
- Preserve: Existing archive semantics, recovery evidence, retained-Plan coverage, independent settings and no automatic destructive work.
- Retire: Repository-owned retention location assumptions and age-only eligibility for the new Work Record policy.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- A missing execution host means best-effort copy cleanup may remain unperformed; report truthful outcome without blocking eligible personal-store pruning.
- Do not delete a transient PRD merely because this child is last in order; reconcile actual implementation and remaining target requirements first.
