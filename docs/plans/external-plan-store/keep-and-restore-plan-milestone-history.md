---
planId: "d3f21061-d8b5-479f-9011-91f4bebb98c7"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store/"
    - "src/shared/workflow/"
    - "src/cmd/plans/"
    - "src/shared/remote/"
    - "src/shared/remote/project-store-protocol.ts"
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
userVerifiedAt: null
status: "implemented"
---

# Keep and Restore Plan Milestone History

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Core already retains reviewed and delivered inputs for execution, publication and recording. Users need a separate way to find a milestone by Plan ID, read its Markdown and make it current again, including in a Project without Git. The next child owns pruning.

Owning requirements: [Plan history](../../prd/plan-store-prd.md#plan-history); [Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle). These are target changes; preserve the existing behavior named below.

## Objective

Every admitted Plan keeps frozen milestone versions at approval, delivery and closure/archive, and users can restore its content while preserving stable identity and truthful current workflow state. This extends the core delivery milestone and is required full-proposal scope.

## Approach

Keep milestone history separate from private attempt-input retention. Capture a coherent package version before
publishing its history reference; restore documents through normal revision and approval-invalidation rules. Historical
metadata explains the past but never reinstates old active locks, attempt pointers, status or publication proof.

**Decision for review.** Restore the milestone's Markdown documents as one new edit. Keep the current name, identity, relationships, settings and lifecycle evidence. A meaningful edit to an approved or ready Plan requires fresh review. Inspect archived versions in place. To edit an archived Plan, use the existing archive restore command first. A user can also copy an individual historical Markdown file into an editable live document under ordinary external-edit rules.

Use the bytes bound to the event. Approval captures what was approved. Delivery captures what was delivered even if the live prose changed during execution or repository copies were disabled. Manual closure and archive capture the package as it was closed or archived. Stage the complete document set, including Epic resources, and link it to the committed event so retries can complete after a crash. A later genuine reapproval gets its own entry even when the text repeats.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store/index.ts` exposes named history queries and content restoration. The private package owner stages readable versions under the Project's `history/<plan-id>/` tree.
- `src/plan-store/review.ts`, `sequence-review.ts`, `events.ts`, publication settlement and `archiving.ts` connect history to accepted decisions and confirmed effects. Preserve the event rules in `src/shared/workflow/plan-lifecycle.js`.
- `src/cmd/plans/` and CLI help expose `wld plans history <plan-name-or-id>`, `history show <plan-name-or-id> <version>` and `history restore <plan-name-or-id> <version>`. List the milestone, time and version identifier. Show the version's named Markdown documents.
- `src/plan-store/managed.ts`, `project-service.ts` and `src/shared/remote/project-store-protocol.ts` carry bounded history reads and revision-checked restores to the initiating laptop owner.
- `docs/domain-language.md` — Plan History definition and restoration relationships
- `docs/prd/runwield-core-prd.md` — history requirements and scenarios
- `docs/user-documentation/` — history and restore behavior

## Reuse Opportunities

- Reuse the document roles, hashes, staging and native locks in `src/plan-store/packages.ts`. Its `capturePlanPackageInput` checks for intervening edits and `commitPlanPackageBatch` recovers complete document generations. Keep private attempt inputs independently pinned.
- Reuse remote owner service operations; no Git dependency or copied live Plan.

## Implementation Steps

1. Approval, delivery and closure/archive retain immutable readable package versions with stable Plan identity and a committed history reference.
2. Interrupted capture cannot expose a partially frozen version; retry produces one milestone version for the same event rather than duplicate history.
3. History remains available after rename, archive and execution cleanup, including non-Git Projects and managed remote personal ownership.
4. Restore changes documents as a new current revision, applies ordinary approval invalidation and preserves identity; it cannot replay historical execution pointers, writer ownership, verified status or receipts.
5. Raw external document edits are still live edits and cannot mutate Core metadata; restoring through tools detects concurrent content changes.
   Compare the observed revision of the whole live package, including raw edits to any resource. Restore the historical document membership, including optional resources added or removed since capture. Honor existing write eligibility and collaboration ownership. Interrupted restoration recovers a single complete generation without overwriting an intervening edit.
6. Core requirements and glossary Plan History definitions, avoided aliases and relationships match the implemented restoration semantics; docs distinguish history from backup and private recovery evidence.
7. Existing Plans can begin with empty history. Passive listing and inspection create no versions. A managed retry after a lost acknowledgement returns the original restore outcome. Service loss never selects the execution account's personal store.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Add the history cases to the existing focused files below and run the isolated suite:

```sh
bun scripts/run-tests.js src/plan-store/operations.test.ts src/plan-store/remote-operations.test.ts src/cmd/plans/index.test.ts src/cmd/plans/archive.test.ts src/shared/remote/project-store-protocol.test.ts
bun run plan-store:check
```

Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- In a non-Git fixture approve, edit, close/archive and restore a Plan: retained bytes remain unchanged and restored current content has a fresh revision.
- Interrupt history publication and retry; a listed version always contains the complete frozen package exactly once.
- Approve a Sequence and inspect each approved member by ID. For delivery, edit the live Plan after input capture and confirm the version contains the delivered bytes after execution cleanup. Unconfirmed publication produces no delivered entry. User verification or deliberate closure retains its actual reason.
- Rename an Epic, archive it and inspect its original version by ID. Restore archive membership through the existing command, then restore an eligible version containing different optional documents. Compare all restored bytes and membership, and verify identity, current name and protected metadata.
- Change only a companion Markdown file after reading the live revision. A stale restore preserves that edit and every other live document. Retry against a fresh revision and interrupt the write. On reopening, inspect the complete recovered generation.
- Through the managed service, list and show an existing version, restore with a lost acknowledgement, then retry. Check the owner has one new revision, the execution host has no personal package, and a disconnected read cannot fall back locally.
- Restore a version containing old execution/verified metadata and prove no old attempt or proof becomes current; stale restore revisions are rejected.
- Manual: Inspect an approved version after later edits, restore its prose, then review the new revision; repeat through a managed-remote owner without any local repository Plan copy.
- Preserve: Current lifecycle/receipt authority, plain-file editing, stable identities, archive behavior and owner-native locking.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- History on the same home disk is not a backup.
- Internal attempt snapshots may remain pinned after user history versions become eligible for future pruning.
