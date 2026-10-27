---
planId: "443c871e-f69d-414e-a55a-9a4ba0f2c3c2"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/agent-definitions/planner.md"
    - "src/agent-definitions/subagent-definitions/slicer-prompt.md"
    - "src/agent-definitions/document-formats/planner-plan-format.md"
    - "src/plan-store.js"
    - "src/shared/workflow/workflow-slicer.ts"
    - "src/shared/workflow/epic-integration.ts"
    - "src/cmd/load-plan/"
    - "src/ui/workspace/server/plan-adapter.js"
    - "src/ui/workspace/server/owner-dashboard.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-26"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
validatedCommit: "cc2904e92e87d22418dacc8d9d4fcdb18f8ab2ae"
workRecord:
    status: "generated"
    recordId: "1357718d-3f80-4e75-bb42-b23d3d0cbb0c"
    path: "docs/work-records/2026-10-27-plan-ordering-independent-of-filenames.md"
    lastAttemptAt: "2026-10-27T21:58:49.371Z"
---

# Plan Order Independent of Filenames

## Context

New Plan filenames must describe the work, not its position. Changing the sequence must change `order`, not filenames or references.

The current sources conflict:

- Planner tells agents to renumber sibling files when inserting a child.
- `saveChildFeaturePlans` adds an order prefix. Slicer repeats that naming rule for its preflight checks.
- Child menus already sort by Front Matter `order`. General Plan lists instead sort by status, classification, then name. Workspace sidebar builders apply another status/category/recency sort.
- Integration repair creation still reads filename digits when choosing the next order.

Owning requirements:

- [Core: Plan authoring and external adoption](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption): extend **Generated Plans are easy to read** with descriptive filenames and stable names when work is reordered. Preserve external Markdown adoption and read-only browsing.
- [Core: Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold): preserve the requirement that the picker uses explicit `order`, never filename prefixes. Extend scenarios to unnumbered and mixed legacy/new children.
- [Workspace: Local Plan management](../prd/runwield-workspace-prd.md#local-plan-management): reference Core ordering for child navigation and ordered lists. Preserve stage columns, filters, links, and lifecycle actions.

## Objective

Planner, Sequence authoring, Slicer, and generated repair children use descriptive filenames without added ordinal prefixes. All Plan menus honor explicit `order` within their applicable list or child group. Filename digits never define execution order.

## Approach

Keep Plan storage as the naming and sorting owner. Consumers must preserve its result rather than add local filename sorting.

```text
Planner / Slicer / integration repair
  descriptive child name + Front Matter order
    Plan store
      load-plan menus and completions
      Workspace Plan lists and child navigation
      next-child continuation
```

Use one shared child-name calculation for materialization and Slicer preflight. Remove the duplicated prefix and slug calculation from `workflow-slicer.ts`. New children use `<parent>/<descriptive-slug>`; order changes alone keep the same path and Plan ID.

Keep existing numbered files and exact dependency references valid. Do not rename the existing Plan catalog. When regenerating an existing draft, reuse its exact unprefixed name or a unique legacy prefixed match; reject ambiguous matches before writes. This avoids creating a second copy when an old Epic is edited. Compatibility matching identifies a file; it must not supply its order.

Replace Planner's renumbering instructions with instructions to change Front Matter `order` and update `dependencies` only when prerequisites change. Do not add ordinal prefixes to filenames or headings. Natural numbers in a work description are not ordinal prefixes.

**Proposed menu rule:** explicit numeric order comes first in each applicable list. Entries without order follow ordered entries. Keep current fallback ordering where order is absent or equal. Alphabetical fallback is display-only and must not imply a valid execution sequence. Keep the current ambiguity warning and block automatic next-child selection when child orders are missing or duplicated.

> **Question (top-level-order-priority):** Should explicit order also override status/type priority in top-level Plan menus? I recommend yes: ordered Plans first, then the current fallback for Plans without order. Child lists always use order; board columns stay grouped by status.
>
> **Answer:** No (answered in review)

The recommendation applies to top-level entries only when they carry `order`; it does not compare children from different parents as one execution sequence. If the answer is no, retain top-level status/type sorting and apply the new rule to child lists only. Apply the same decision to both Workspace sidebar builders. Keep dashboard activity rows and their explicit date-sort control unchanged: they show activity, not a Plan sequence.

A prompt-only fix is smaller, but Slicer would still create numbered files. Bulk renaming is not needed and would add link and registry migration risk.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/agent-definitions/planner.md`, `subagent-definitions/slicer-prompt.md`, and `document-formats/planner-plan-format.md` — remove ordinal naming and file-renumbering guidance; show `order` as sequence metadata.
- `src/plan-store.js` and `src/plan-store.test.js` — own descriptive child naming, legacy-name reuse, and canonical list sorting.
- `src/shared/workflow/workflow-slicer.ts` and its integration tests — use the same child names for preflight, writes, results, and rollback.
- `src/shared/workflow/epic-integration.ts` and its tests — allocate repair order from authoritative child metadata, not filename digits.
- `src/cmd/load-plan/`, completion and ACP consumers, and Workspace's `server/plan-adapter.js` — retain canonical order through their filters and presentations; change only consumers that override it.
- `src/ui/workspace/server/owner-dashboard.ts` — make `projectPayload` and `loadOwnerSidebar` preserve explicit order under the approved rule, including the metadata needed by their typed views. Keep sidebar eligibility and limits unchanged.
- `src/shared/session/agents-shared-practice.test.ts` and `subagent-definitions.test.ts` — protect effective naming instructions.
- The owning PRD capabilities above and `docs/plan-lifecycle.md` — describe the delivered naming and order rules and correct affected examples.

This change does not add domain terms, replace lifecycle authority, redesign the board, or rename historical Plans and Work Records.

## Reuse Opportunities

- `compareChildPlansByOrder`, `comparePlansForList`, `findPlansByParent`, and Plan hierarchy builders — central ordering and grouping.
- `saveChildFeaturePlans` validation and revision checks — reject collisions and stale writes without adding a new persistence layer.
- `epicChildOrderProblem` — preserve missing/duplicate order checks before automatic execution.
- Existing dependency resolution — retain exact legacy references and unique legacy alias resolution.
- Existing filesystem and Git fixtures — test real Plan files without injection seams.

## Implementation Steps

1. Effective Planner and Slicer instructions require descriptive names without ordinal prefixes. Planner's child insertion guidance changes only order metadata and real prerequisite relationships; Sequence guidance and the Plan format agree. Existing numbered names remain valid inputs.
2. `saveChildFeaturePlans` creates new child paths from descriptive slugs without adding order. Shared naming logic serves Slicer preflight and writes. Reordering an existing unnumbered draft preserves its path and Plan ID. A unique legacy draft keeps its old path; ambiguous legacy matches and duplicate resulting slugs fail before writes. Existing revision, lock, execution-policy, and rollback protections remain intact.
3. Canonical Plan sorting and all menu consumers implement the approved top-level choice. Child lists use explicit numeric order regardless of name, prefix, status, or creation order. Child-filtered argument completions use child order even if top-level status priority is retained. Both `projectPayload` and `loadOwnerSidebar` honor the approved rule before limiting sidebar results; they reuse shared order comparison instead of duplicating it. Board columns and filters retain their current meaning and preserve order within each displayed group. Missing or equal orders never gain execution authority from filenames. Dashboard activity-date sorting stays unchanged.
4. Integration repair creation uses child Front Matter order, including target-branch-only children. Carry order through `readEpicDeliveryState` where needed and remove filename-digit inference from `addRepairChild`. Generated repair names use the same descriptive naming rule, while existing repair recognition and retry behavior survive.
5. Regression tests prove descriptive materialization, stable paths after reorder, safe legacy updates, dependency resolution, menu ordering, ambiguity behavior, and repair-order allocation. Prompt tests check the loaded instructions rather than only a new sentence in an unused file.
6. Core's owning requirements and acceptance scenarios describe the delivered behavior. Workspace links the shared rule, and affected lifecycle examples agree. Keep unrelated product targets unchanged; no glossary change is needed because the existing terms retain their meaning.

## Approval Confirmation

No Work Record supersession is proposed. Resolve the top-level menu question before execution.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Run focused tests through the isolated runner, never direct `bun test`:

- `bun scripts/run-tests.js src/plan-store.test.js src/shared/workflow/workflow-slicer.integration.test.ts`
- `bun scripts/run-tests.js src/cmd/load-plan/index.integration.test.ts src/shared/workflow/epic-integration.test.ts`
- `bun scripts/run-tests.js src/shared/session/agents-shared-practice.test.ts src/shared/session/subagent-definitions.test.ts`
- `bun scripts/run-tests.js src/cmd/load-plan/getArgumentCompletions.test.ts src/acp/server.test.js src/shared/workflow/sequence-review.test.ts`
- `bun scripts/run-tests.js src/ui/workspace/workspace-board.test.js src/ui/workspace/owner-dashboard-stream.test.ts src/ui/workspace/owner-dashboard-ui.test.js`
- Run affected continuation tests through the same isolated runner if those paths change.
- `bun run doc-links:check`

Required behavioral evidence:

- Materialize children named `Zulu` at order 2 and `Alpha` at order 10. The files are `zulu.md` and `alpha.md`, and their menu order is Zulu then Alpha. Swapping only `order` reverses the menu without changing paths, Plan IDs, or dependency references. This fails with the current prefix writer or a filename-sort substitute.
- Mix `99-first` at order 1, an unnumbered child at order 2, and `01-last` at order 10. Store results, load-plan interactions, completions where children are offered, and Workspace child data agree. Vary statuses to prove child order is not replaced by status priority.
- If top-level order priority is approved, test explicit orders across status/type differences and the fallback for unordered Plans. Cover both Workspace sidebar builders with dates and categories that would produce the opposite order under their old comparators. Otherwise prove top-level priority is unchanged. Assert completion results in returned order; do not sort the actual result before comparison.
- Equal and missing child orders keep manual browsing available but block the next-child shortcut and automatic continuation. No order is inferred or written from a legacy filename. A metadata-free external Plan stays byte-identical after listing.
- Regenerate a unique legacy numbered draft with a changed order: no second file appears and existing dependency references still resolve. Ambiguous legacy matches and colliding slugs fail without partial writes. Repeat stale-write, locked-child, and Slicer rollback tests against the new names.
- A target-branch-only child with a misleading prefix and a higher Front Matter order causes a repair child to receive the next metadata order, not the next prefix number. The repair remains visible to repair retry and continuation logic.
- Retain existing tests for legacy Plan lookup, dependency gating, target-branch document authority, and rollback. Replace expectations that newly generated files have ordinal prefixes; do not remove those behavioral protections.

Manual check: in a disposable Project, open an Epic through `/load-plan` and Workspace, change only two child `order` fields, then reopen both lists. Both show the new order and open the same saved Plans. Inspect the effective Planner/Slicer prompts and the PRD scenarios for conflicting numbering instructions.

## Edge Cases & Considerations

- **Existing names stay stable.** No bulk migration, registry rewrite, or dependency rewrite is part of this change.
- **Duplicate descriptive slugs:** different orders no longer distinguish equal titles. Reject the collision and request distinct descriptive titles; do not silently add ordinal prefixes.
- **Legacy `sequence` descriptor input:** preserve its supported alias behavior for metadata, but never use it to add filename prefixes.
- **Unordered lists:** reviewable assumption — retain the current display fallback when explicit order cannot distinguish entries. This fallback does not define execution order.
- **Natural numbers:** names such as `support-http2` remain valid. Remove generated sequencing numbers, not meaningful numbers from user text.
