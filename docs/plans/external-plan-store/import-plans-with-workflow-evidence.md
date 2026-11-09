---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/plan-front-matter.ts"
    - "src/shared/workflow/plan-location.ts"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/worktree-registry.js"
    - "src/cmd/plans/"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 5
dependencies:
    - "external-plan-store/relocate-project-runtime-into-home-storage"
    - "external-plan-store/add-canonical-plan-packages"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "6352d5e5-174f-4db4-8afa-bf8cd64818be"
---

# Import Plans with Workflow Evidence

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Copying an old primary Markdown file can overwrite a newer execution-worktree Plan. Explicit import must join document content with the current controller and execution evidence.

Owning requirements: [Plan import](../../prd/plan-store-prd.md#plan-import); [Plan authoring](../../prd/runwield-core-prd.md#plan-authoring-and-external-adoption). These are target changes; preserve the existing behavior named below.

## Objective

An import transaction can prepare and commit one canonical package per existing Plan identity, restart safely, and preserve originals. Public `wld plans import` and path-loading activation remain with the local cutover child after workflow consumers are ready.

## Approach

Use existing legacy authority resolution only at the import boundary. Inventory canonical documents, linked children,
archived units and runtime evidence before committing packages. Maintain source provenance for ID-less imports and
one batch relationship map; readers must not observe half a family. Already imported IDs never become a route for
silently overwriting the live package.

The selected public behavior remains explicit import, not an automatic repository scan disguised as migration.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store.js` — import transaction and identity/relationship mapping
- `src/plan-front-matter.ts` — separate legacy front matter from body
- `src/shared/workflow/plan-location.ts` — bounded pre-cutover authority discovery
- `src/shared/workflow/controller-registry.ts` — adopt retained controller evidence once
- `src/shared/worktree-registry.js` — preserve attempt bindings and legacy proof
- `src/cmd/plans/` — prepare import command integration
- `docs/prd/runwield-core-prd.md` — import capability scope

## Reuse Opportunities

- Reuse strict legacy parsing, duplicate identity checks, current canonical location inspection and runtime migration recovery.
- Reuse atomic no-clobber package creation; do not import a stale in-memory controller projection.

## Implementation Steps

1. Single-file and folder import preserve existing IDs, statuses, parent/dependency relationships, archive state, Tickets and original source bytes; front matter becomes metadata and remaining prose becomes `context.md`.
2. Plain Markdown creates a draft; import provenance makes repeated ID-less import idempotent, while changed source content cannot silently replace an existing live Plan.
3. Batch import maps relationships before publication and resumes interrupted operations without duplicate IDs or partially visible families.
4. Unfinished imported Plans use canonical pre-cutover content plus relocated controller, execution and publication evidence; stale primary copies cannot reset them.
5. Legacy sealed attempts keep exact recorded candidates and settlement semantics rather than being reclassified as new-format attempts. Missing/conflicting evidence is explicit and recoverable.
6. Repository source paths are recorded for later best-effort pruning, without a permanent dependency on their contents.
7. Core authoring/adoption requirements distinguish prepared import capability from public cutover; no background import is introduced.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.ts src/plan-store.test.js src/shared/workflow/plan-location.integration.test.ts src/shared/workflow/controller-registry.integration.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Import a real Epic family with archived Plans and an active execution whose primary copy is stale; verify the canonical content and all identities after a fresh-process retry.
- Kill the importer between staging, relationship publication and completion; exactly one visible package per Plan remains and originals are unchanged.
- Import an ID-less file twice and then change its source; distinguish duplicate retry from a new explicit content decision without overwriting live work.
- Manual: Prepare a mixed folder containing legacy Plans, plain Markdown and archived children, interrupt import, resume, and inspect the resulting identity/hierarchy report.
- Preserve: Current lifecycle and publication proof, source content ownership, Tickets and archive identity.
- Retire: Implicit adoption from normal browsing only when the public cutover child activates; this preparatory child does not change discovery defaults.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Unrecognized legacy metadata must be preserved or reported, never silently dropped by a whitelist.
- Missing external original paths must not prevent reading an already imported Plan.
