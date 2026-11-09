---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/workflow/publication-attempt.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/workflow/publication-receipt.ts"
    - "src/shared/work-records/published-source.ts"
    - "src/shared/settings.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/015-proof-bearing-publication-state-machine.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 7
dependencies:
    - "external-plan-store/run-lifecycle-from-canonical-plans"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "a7c63f74-260c-40dd-9768-aedcbfc3e779"
---

# Publish from Retained Plan Inputs

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Publication and Recorder recovery currently recover Plan documents through Git artifact commits. Plan copies cannot be disabled safely until exact delivery inputs survive independently.

Owning requirements: [Delivery copies](../../prd/plan-store-prd.md#repository-footprint-and-delivery-copies); [Execution and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). These are target changes; preserve the existing behavior named below.

## Objective

Package publication retains immutable attempt inputs and supports optional Plan delivery copies while preserving Git proof, retries and cleanup. The Work Record storage/copy activation follows next; no new user setting may disable a required copy before its canonical store is ready.

## Approach

Retain reviewed documents, source metadata, relevant Epic child inputs, copy settings and intended paths before any
publication effect. The attempt references committed inputs by identity/digest. Git phases retain their existing proof
semantics; the personal store records the matching final receipt. Build one final copies commit from frozen inputs,
not from live edited Plans.

This child supplies the unified copies-commit interface used by the next Work Record child; do not add a second finalization commit for new-format lifecycle status.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/publication-machine.ts` — store-backed artifact sources and proof-bearing retry
- `src/shared/workflow/publication-attempt.ts` — immutable input references and effective copy policy
- `src/shared/workflow/validation-publication.ts` — candidate and store settlement integration
- `src/shared/workflow/publication-receipt.ts` — permanent proof after attempt cleanup
- `src/shared/work-records/published-source.ts` — retained source instead of new-format git-show reconstruction
- `src/shared/settings.js` — separate copy policy definitions
- `docs/prd/runwield-core-prd.md` — publication and execution recovery requirements
- `docs/adr/015-proof-bearing-publication-state-machine.md` — reconcile Git artifacts versus canonical Plan truth

## Reuse Opportunities

- Reuse publication phase/revision guards, independent remote ancestry checks, target lease behavior and existing fault-matrix fixtures.
- Reuse immutable file persistence and Plan snapshot hashes from the package store.

## Implementation Steps

1. Each new-format attempt retains exact approved documents, relevant metadata and Epic child/Ticket inputs before recording a reference or performing publication effects.
2. Plan copies are off by default; when enabled, only Markdown documents enter the copies commit and `plan.wld.json` never does. The Work Record payload composes through the same interface.
3. Effective settings and paths are frozen per attempt; a retry after live edits or setting changes reuses those inputs and produces exactly the intended single copies commit.
4. Git proof remains necessary for `verified`; personal metadata settlement can recover after lost acknowledgement without pushing twice or reading a delivery copy as authority.
5. Recorder source and pending index evidence survive execution checkout removal and remain pinned while any unfinished operation needs them.
6. Legacy attempts retain their original evidence interpretation until settlement; no snapshot alone upgrades old status to confirmed publication.
7. Core publication requirements, Delivery Copy terminology preparation and ADR-016 distinguish canonical store receipts from optional repository artifacts; final public setting exposure waits for Work Record readiness.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-revalidation.test.ts src/shared/work-records/published-delivery-source.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Kill a real-Git publication process after each store/registry/external-effect boundary and prove exact ancestry, one copies commit and truthful settlement.
- Edit live Plan documents after sealing, advance target head and retry; copied bytes remain the sealed source and no metadata file appears in Git.
- Delete the execution checkout after confirmed delivery and prove Recorder reads retained new-format inputs without `git show docs/plans/...`.
- Manual: Deliver one package Plan with copies disabled and another enabled, interrupt final settlement and resume from a fresh process.
- Preserve: Confirmed-publication completion, target advancement handling, source/primary preservation, revalidation and local-only/non-Git behavior.
- Retire: New-format publication dependence on committed live Plans or target metadata commits solely to represent Plan status.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- A new input reference is durable only after its snapshot is durable.
- The later Forge proposal remains out of scope; this contract supports existing publication modes.
