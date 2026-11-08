---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/work-records/store.ts"
    - "src/shared/work-records/index-adapter.ts"
    - "src/shared/work-records/auto-generation.ts"
    - "src/shared/work-records/supersession.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/cmd/"
    - "src/shared/settings.js"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 8
dependencies:
    - "external-plan-store/publish-from-retained-plan-inputs"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "c6973854-fcb6-4195-bdbb-ec8daa073b79"
---

# Move Work Records with Delivery Copies

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Work Records currently use checkout-relative files and basename-derived index collections. Moving canonical records without their delivery copies would remove the project's default shared delivery memory.

Owning requirements: [Work Record store](../../prd/plan-store-prd.md#work-record-store); [Delivery copies](../../prd/plan-store-prd.md#repository-footprint-and-delivery-copies); [Work records](../../prd/runwield-core-prd.md#work-records). These are target changes; preserve the existing behavior named below.

## Objective

Canonical Work Records, explicit import and retrieval work on the admitted-package path in the personal Project store, and the same change supplies default-on repository delivery copies. Both copy settings can be tested together without creating a second authority. Command adapters remain preparatory until the local activation child enables the complete public workflow.

## Approach

Retain the existing Work Record schema and eligibility semantics while changing its store owner. Generate/index from
retained publication inputs, and compose enabled Plan/record documents in the publication child's single final commit.
Copy preferences are independent: Plan off by default, Work Record on by default. Persist provenance paths for later
pruning; repository content is never a lookup fallback after admission.

Do not migrate general Memory namespaces; only bind this derived Work Record index to stable Project/owner identity.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/work-records/store.ts` — canonical record persistence and import
- `src/shared/work-records/index-adapter.ts` — stable owner-bound derived index and rebuild
- `src/shared/work-records/auto-generation.ts` — record generation and eligibility after delivery
- `src/shared/work-records/supersession.ts` — home record relationships and native locks
- `src/shared/workflow/validation-publication.ts` — default Work Record copy payload and finalization
- `src/cmd/` — Work Record import/retrieval command integration
- `src/shared/settings.js` — independent Plan and Work Record copy settings
- `docs/domain-language.md` — Work Record and Delivery Copy definitions and relationships
- `docs/prd/runwield-core-prd.md` — Work Record requirements

## Reuse Opportunities

- Reuse record schema, provenance, confidence labels, Ticket aggregation, supersession and existing search adapter.
- Reuse retained attempt inputs and the single copies-commit assembly from publication.

## Implementation Steps

1. Canonical record reads, writes, listing and supersession use the owner's home Project store; IDs and provenance retain their existing meaning.
2. The `wld wr import` command adapter supports explicit file/folder import for admitted package fixtures, preserves original bytes and identity, and resumes without duplicates. Public default command activation waits for the local activation child; ordinary discovery never imports repository records.
3. Default delivery adds a Work Record copy in the single final copies commit; all four settings combinations produce the expected files without `plan.wld.json`. No relocation release can precede working default copies.
4. Stored repository paths and owner/repository bindings support later best-effort cleanup without reading copy content as authority.
5. Record generation after checkout cleanup uses frozen input; provisional/approved/closed confidence and supersession eligibility remain truthful, including Epic child Ticket aggregation.
6. Index collections and locators resolve stable Project/record IDs after folder moves; rebuild works from canonical files and index failure cannot revoke code delivery.
7. Core Work Record requirements describe the tested package contract while public admission remains target. Prepare Work Record/Delivery Copy definitions, avoided aliases and relationships for the activation child; current glossary authority does not change before that cutover. Retention remains target.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/shared/work-records/work-records.test.ts src/shared/work-records/supersession.test.ts src/shared/workflow/validation-work-record-handoff.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- For all four copy settings, inspect final Git contents and one copies commit; with both off only implementation commits remain and the record is still retrievable.
- Import records twice, rename the Project, erase the derived index and rebuild: IDs, confidence, provenance and retrieval eligibility remain unchanged.
- Retry failed recording after execution cleanup; generated output uses retained source, and an index failure leaves confirmed publication intact.
- Manual: Deliver with default settings and verify the repository Work Record; disable both copies, deliver again and retrieve the canonical record from an ordinary Agent query.
- Preserve: Record provenance, archived/superseded exclusion, confidence labels, human-approved drafts, Ticket aggregation and code-delivery proof.
- Retire: Repository-owned live Work Record authority and basename-only index lookup for admitted Projects.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Importing an edited delivery copy must not overwrite a live record with the same ID.
- Managed-remote record mutations and index commands will execute on the personal owner in the later service/activation slices.
