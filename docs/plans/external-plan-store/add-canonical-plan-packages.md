---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/plan-front-matter.ts"
    - "src/shared/epic-artifacts.ts"
    - "src/shared/workflow/controller-state.ts"
    - "src/shared/private-json-file.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 4
dependencies:
    - "external-plan-store/establish-stable-project-identity"
    - "external-plan-store/relocate-project-runtime-into-home-storage"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "07f18d9a-b269-4ab3-979b-1099c8d5d85f"
---

# Add Canonical Plan Packages

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The existing Plan store combines Markdown front matter with projected controller fields. Later imports and workflows need a package persistence contract that makes ownership explicit.

Owning requirements: [Plan store](../../prd/plan-store-prd.md#plan-store). These are target changes; preserve the existing behavior named below.

## Objective

Core can create, read, edit, rename and archive a canonical home Plan package in real fixtures with independent document and metadata ownership. This is a preparatory capability; public default Plan discovery is activated only after import, lifecycle, publication and Work Records are ready.

## Approach

Put package identity, name, lifecycle/controller facts and relationships in `plan.wld.json`; keep Markdown documents
front-matter-free. IDs own relationships and history references; names locate packages. Separate body hashes from
metadata revision checks and expose strict read outcomes through the existing store interface. New modules, if needed,
remain owned implementation details; no test-injection seam substitutes Plan persistence.

Keep legacy parsing at an explicit import/compatibility boundary rather than pretending old Markdown is a new package.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store.js` — typed package operations and revision contracts
- `src/plan-front-matter.ts` — legacy parsing boundary
- `src/shared/epic-artifacts.ts` — package-owned Epic context and validation artifacts
- `src/shared/workflow/controller-state.ts` — metadata field ownership
- `src/shared/private-json-file.ts` — durable file replacement
- `docs/prd/runwield-core-prd.md` — record preparatory package contract without claiming cutover

## Reuse Opportunities

- Reuse strict reads, body hashes, stale-write errors, private JSON, and native locks.
- Reuse reserved Epic artifact rules and existing Plan ID validation.

## Implementation Steps

1. The package contract writes `context.md`, `validation.md`, optional `manual-qa.md` and versioned `plan.wld.json`; metadata writes leave every Markdown byte unchanged.
2. Document edits compare content hashes; metadata mutations compare metadata revisions. Concurrent stale processes cannot erase newer fields or content.
3. Plan ID, parent/dependency relationships and archive state remain stable across rename; an archive is not another live copy.
4. Epic artifacts remain non-Plan resources within the Epic package. Malformed metadata or missing documents produce isolated typed availability results rather than silent repair during reads.
5. Snapshot capture detects uncoordinated external edits across required documents and never publishes references to uncommitted input.
6. Real fixture callers exercise the full persistence contract, while ordinary unsupported entry continues its admitted legacy format; there is no second writable authority for one Plan.
7. Owning Core requirements retain this as preparatory capability; public Plan/Metadata glossary changes belong to the activation child.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/plan-store.test.js src/plan-store-locks.test.ts src/plan-store-passive-reads.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Create a package from two processes, race metadata and document edits, and verify winning revisions and byte preservation.
- Rename and archive an Epic with children, then resolve all IDs and non-Plan artifacts without inferring parents from filenames.
- Mutate a required document during snapshot capture and prove no approval/execution snapshot is committed from inconsistent inputs.
- Manual: Open a fixture package in an ordinary editor, edit the body and separately advance metadata through Core; inspect both independent results.
- Preserve: Plan ID integrity, archive semantics, reserved artifacts, optimistic conflicts and passive-read isolation.
- Retire: None of the public legacy reader contracts yet; this child establishes the new persistence owner before admission.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Filesystem locks cannot stop an ordinary editor; content hashes must catch its changes.
- New file format versions need explicit rejection or migration, never permissive interpretation.
