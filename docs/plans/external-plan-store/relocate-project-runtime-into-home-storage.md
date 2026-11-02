---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/project-runtime-recovery.ts"
    - "src/shared/runwield-owned-paths.ts"
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/collaboration/secrets.js"
    - "src/shared/work-records/index-adapter.ts"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/017-project-runtime-state-under-wld-internal.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 3
dependencies:
    - "external-plan-store/establish-stable-project-identity"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "6412c132-8bb6-4d24-99fd-7770a8bc8ec8"
---

# Relocate Project Runtime into Home Storage

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
`project-runtime-layout.ts` currently owns primary and selected-checkout paths, including registries, staging, secrets, locks, journals and indexes. Moving only Plans leaves that checkout-bound machinery behind.

Owning requirements: [Project runtime](../../prd/plan-store-prd.md#project-runtime-outside-checkouts); [Project initialization](../../prd/runwield-core-prd.md#project-context-and-initialization). These are target changes; preserve the existing behavior named below.

## Objective

Ordinary local execution and manual SSH execution keep all former `.wld/internal/` state in their account home Project tree, preserving unfinished work and settings. This slice changes physical runtime storage while legacy Plan documents can still retain their current format until the later cutover.

## Approach

The shared layout resolves home roots using Project and repository/checkout bindings. Preserve each resource's logical
owner. Stage and verify destination bytes, publish a durable ownership record, then retire recorded sources; native
locks are reacquired after quiescence rather than copied. Git-aware relocation preserves repair checkout registrations
and uncommitted work. Unknown internal files go to a recorded home recovery area.

Managed-remote personal transfer remains behind its explicit version admission until the later laptop-store transport
and activation slices; do not claim remote relocation from a local-path test.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/project-runtime-layout.ts` — complete owner-aware layout and recoverable adoption
- `src/shared/project-runtime-recovery.ts` — recover interrupted old and new layout operations
- `src/shared/runwield-owned-paths.ts` — retire checkout runtime writers without exempting .wld wholesale
- `src/shared/worktree-registry.js` — home registry and repository-scoped locks
- `src/shared/workflow/publication-machine.ts` — relocated staging and repair paths
- `src/shared/collaboration/secrets.js` — private home-owned project secrets
- `src/shared/work-records/index-adapter.ts` — home index location
- `docs/domain-language.md` — Project Runtime State and Internal Root definitions
- `docs/prd/runwield-core-prd.md` — initialization and work protection
- `docs/adr/017-project-runtime-state-under-wld-internal.md` — reconcile the old physical-location rule

## Reuse Opportunities

- Reuse checked runtime inspection versus action-owned entry, migration journals, native locks, and Windows atomic replacement.
- Reuse Git worktree/registry helpers and retained publication proof rather than infer completeness from copied paths.

## Implementation Steps

1. All named layout resources and unknown legacy internal files in primary and linked worktrees have verified home destinations; no local alias or permanent migration marker replaces `.wld/internal/`.
2. Cross-filesystem copy, ownership publication, source retirement and interruption recovery are idempotent. Existing unfinished migration records cannot replay old destinations into the checkout.
3. Unfinished publication/repair directories retain exact Git registrations, commits and uncommitted changes at their recorded relocated paths; registry references match.
4. Runtime locks quiesce before relocation and reacquire at one new authority. Home unavailability reports a prerequisite without any checkout fallback.
5. Settings, Agents, Skills, prompts and user overrides are byte-preserved; debug, index, sharing and repair writers cannot recreate `.wld/internal/`.
6. For legacy unimported Plans, relocated controller/transition evidence stays keyed and readable in its legacy envelope until later package adoption, without auto-importing Markdown.
7. Core requirements, glossary runtime definitions and ADR-017 ownership clauses describe the delivered ordinary-execution layout and explicitly retain managed-remote adoption as target until its child lands.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/shared/project-runtime-layout.test.ts src/shared/project-runtime-entry.integration.test.ts src/shared/project-runtime-read-scope.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Seed every layout resource plus an unknown file and linked-worktree journal; fresh-process interruption after every transfer boundary retains content and leaves no competing writer.
- Exercise sharing, indexing, publication retry and debugging after adoption and assert `.wld/internal/` is absent while every override hash matches.
- Use a real dirty repair worktree in the relocation fixture and prove Git can still inspect the exact branch and uncommitted repair.
- Manual: Resume a paused ordinary workflow after relocation, including one manual-SSH scenario, and inspect home paths and the unchanged project `.wld/` configuration.
- Preserve: Legacy Plan authority until explicit format cutover, proof-bearing publication, recoverable intermediate failures, and passive reads without writes.
- Retire: Ordinary-execution checkout-local runtime writes, no-home fallback, and selected-checkout document lock locations.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- An active old writer must stop before one-way adoption; do not claim mixed-version safety.
- Managed remote may temporarily retain its existing versioned layout during intermediate Epic commits, but the final managed-remote child must retire it.
