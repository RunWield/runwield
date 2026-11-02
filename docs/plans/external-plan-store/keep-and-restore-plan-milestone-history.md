---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/shared/workflow/"
    - "src/cmd/plans/"
    - "src/shared/remote/"
    - "src/shared/epic-artifacts.ts"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/user-documentation/"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 14
dependencies:
    - "external-plan-store/activate-the-local-home-store"
    - "external-plan-store/activate-managed-remote-store-ownership"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "d3f21061-d8b5-479f-9011-91f4bebb98c7"
---

# Keep and Restore Plan Milestone History

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The core store retains immutable attempt inputs for correctness, but users also need approved/delivered/closed versions they can inspect and restore without Git.

Owning requirements: [Plan history](../../prd/plan-store-prd.md#plan-history); [Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle). These are target changes; preserve the existing behavior named below.

## Objective

Every admitted Plan keeps frozen milestone versions at approval, delivery and closure/archive, and users can restore its content while preserving stable identity and truthful current workflow state. This extends the core delivery milestone and is required full-proposal scope.

## Approach

Keep milestone history separate from private attempt-input retention. Capture a coherent package version before
publishing its history reference; restore documents through normal revision and approval-invalidation rules. Historical
metadata explains the past but never reinstates old active locks, attempt pointers, status or publication proof.

The Epic's content-only restoration interpretation is a reviewable assumption: Planner must make that user-visible behavior explicit during this child's review rather than silently restoring runtime metadata.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store.js` — milestone capture, listing and revision-safe content restore
- `src/shared/workflow/` — milestone lifecycle hooks without metadata rollback
- `src/cmd/plans/` — history and restore entry points
- `src/shared/remote/` — owner-executed history operations
- `src/shared/epic-artifacts.ts` — include package-owned Epic documents
- `docs/domain-language.md` — Plan History definition and restoration relationships
- `docs/prd/runwield-core-prd.md` — history requirements and scenarios
- `docs/user-documentation/` — history and restore behavior

## Reuse Opportunities

- Reuse package snapshot hashes, native owner locks, atomic persistence and lifecycle invalidation.
- Reuse remote owner service operations; no Git dependency or copied live Plan.

## Implementation Steps

1. Approval, delivery and closure/archive retain immutable readable package versions with stable Plan identity and a committed history reference.
2. Interrupted capture cannot expose a partially frozen version; retry produces one milestone version for the same event rather than duplicate history.
3. History remains available after rename, archive and execution cleanup, including non-Git Projects and managed remote personal ownership.
4. Restore changes documents as a new current revision, applies ordinary approval invalidation and preserves identity; it cannot replay historical execution pointers, writer ownership, verified status or receipts.
5. Raw external document edits are still live edits and cannot mutate Core metadata; restoring through tools detects concurrent content changes.
6. Core requirements and glossary Plan History definitions, avoided aliases and relationships match the implemented restoration semantics; docs distinguish history from backup and private recovery evidence.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/plan-store.test.js src/cmd/plans/archive.test.ts src/shared/workflow/state-transition.test.js
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- In a non-Git fixture approve, edit, close/archive and restore a Plan: retained bytes remain unchanged and restored current content has a fresh revision.
- Interrupt history publication and retry; a listed version always contains the complete frozen package exactly once.
- Restore a version containing old execution/verified metadata and prove no old attempt or proof becomes current; stale restore revisions are rejected.
- Manual: Inspect an approved version after later edits, restore its prose, then review the new revision; repeat through a managed-remote owner without any local repository Plan copy.
- Preserve: Current lifecycle/receipt authority, plain-file editing, stable identities, archive behavior and owner-native locking.
- Retire: No current runtime guarantee; this adds history, and explicitly excludes metadata replay as restoration.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- History on the same home disk is not a backup.
- Internal attempt snapshots may remain pinned after user history versions become eligible for future pruning.
