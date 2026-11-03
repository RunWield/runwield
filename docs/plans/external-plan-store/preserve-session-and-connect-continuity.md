---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/session/file-session-storage.ts"
    - "src/shared/session/file-session-store-local.ts"
    - "src/shared/session/file-session-control.ts"
    - "src/shared/attached/record-store.ts"
    - "src/shared/owner-coordination/projects.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-connect-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 2
dependencies:
    - "external-plan-store/establish-stable-project-identity"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "f89f9ef2-95f1-4887-820e-95e1da5f2442"
---

# Preserve Session and Connect Continuity

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Session bundles and Attached Workflow directories are presently located through path-derived keys. A stable Project ID alone cannot recover those existing records after a rename.

Owning requirements: [Project identity](../../prd/plan-store-prd.md#project-identity); [Session continuity](../../prd/runwield-core-prd.md#session-continuity); [Connect recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery). These are target changes; preserve the existing behavior named below.

## Objective

Existing Sessions and Connect workflows remain discoverable after Project moves or clone linking, with the same committed history, IDs, and native lock owner. This delivers continuity independently from the Plan format cutover.

## Approach

Record verified legacy storage locators against Project identity. Keep existing Session bundle locations and lock
paths until their own explicit migration requires movement; new storage may use the stable ID. Current execution cwd
is separate from historical transcript cwd. Map Workspace registration IDs and Attached Workflow lookup into the
same Project identity without treating an Attached Workflow as a Session.

Rewriting every transcript or changing the global directory encoder would expand migration risk without helping lookup.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/file-session-storage.ts` — stable Project-to-bundle lookup
- `src/shared/session/file-session-store-local.ts` — resolve current and legacy bundles through one binding
- `src/shared/session/file-session-control.ts` — preserve operation-scoped native writer authority
- `src/shared/attached/record-store.ts` — stable lookup of existing Attached Workflow records
- `src/shared/owner-coordination/projects.ts` — reconcile registration identity and roots
- `docs/prd/runwield-core-prd.md` — Session continuity
- `docs/prd/runwield-connect-prd.md` — continuation and lazy setup

## Reuse Opportunities

- Reuse file-authoritative manifests, segment IDs, and existing Session writer-lock APIs.
- Reuse existing Attached Workflow record revisions and compatibility evidence rather than importing host transcripts.

## Implementation Steps

1. Every existing local Session storage locator can be bound once to stable Project identity without changing Session/segment IDs or committed transcript bytes.
2. Folder moves resolve the same bundles and update current execution context without rewriting historical cwd evidence or reconstructing transcript authority from Workspace SQLite.
3. An old active writer must settle before a binding change; two aliases resolving one Session cannot create separate native locks.
4. Existing Attached Workflow IDs and revisions remain reachable through the new Project binding; no host transcript is ingested.
5. Renaming preserves owner-only Session visibility and Connect request ownership; lost/corrupt locators remain explicit unavailable evidence rather than guessed foreign data.
6. Core Session continuity and Connect recovery requirements and ADR-015 locator clauses describe delivered lookup behavior, retaining the existing ownership and segment guarantees.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/shared/session/file-session-store.test.ts src/shared/session/file-session-store-owner.test.ts src/shared/attached/status-restore.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Before/after transcript hashes and Session/segment IDs match across a folder rename; a new process resumes the same Session.
- Open two aliases concurrently and prove exactly one mutation owner; delete Workspace SQLite in a fixture and intact local Sessions remain usable.
- Start an Attached Workflow, rename its Project and resume by workflow ID with unchanged revision and request scope.
- Manual: Resume a Session and an existing Connect workflow after moving the Project, then observe both through their ordinary surfaces.
- Preserve: File-authoritative history, private transcripts, operation-scoped locking, and existing remote Session save authority.
- Retire: Current cwd as the sole lookup key for already-bound Session and Attached Workflow records.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- A missing legacy directory is not permission to create an empty replacement history.
- Metrics and general Memory namespace migration stay outside this child.
