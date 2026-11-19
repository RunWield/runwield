---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/plan-location.ts"
    - "src/shared/workflow/planning-worktree.ts"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/workflow/state-transition.ts"
    - "src/shared/worktree-registry.js"
    - "src/cmd/load-plan/"
    - "src/shared/epic-artifacts.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 6
dependencies:
    - "external-plan-store/add-canonical-plan-packages"
    - "external-plan-store/import-plans-with-workflow-evidence"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "60092a58-2a24-443c-8a9e-185544b8a1d6"
---

# Run Lifecycle from Canonical Plans

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
`resolveWorkflowPlanLocation` currently selects document authority from planning/execution checkouts and target refs. That model must end for admitted package Plans without weakening the existing lifecycle.

Owning requirements: [Plan store](../../prd/plan-store-prd.md#plan-store); [Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle); [Execution and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). These are target changes; preserve the existing behavior named below.

## Objective

An admitted package Plan can traverse review, readiness and execution against the same home documents, including sibling edits and one active attempt across linked clones. Publication support follows in its own child before public activation.

## Approach

Keep lifecycle transitions and execution selection separate from document lookup. Plan metadata owns controller state;
repository registries own physical attempts. Snapshot all required documents at consequential boundaries and bind
approval/execution to that revision. A second clone sees the active attempt rather than acquiring a second execution.

```text
Plan ID -> canonical package -> reviewed document snapshot
                             -> execution binding -> code worktree
```

For package Plans remove planning-worktree and target-branch document overlays; retain bounded legacy resolution only for import/old-attempt settlement.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/plan-location.ts` — separate canonical document lookup from execution location
- `src/shared/workflow/planning-worktree.ts` — retire package document worktrees and branch seeding
- `src/shared/workflow/controller-registry.ts` — route controller mutation through package metadata
- `src/shared/workflow/state-transition.ts` — revision-safe transitions and recoverable cross-resource operations
- `src/shared/worktree-registry.js` — global per-Plan attempt admission with repository binding
- `src/cmd/load-plan/` — package-aware ordinary lifecycle and recovery
- `src/shared/epic-artifacts.ts` — Epic context and child ordering
- `docs/prd/runwield-core-prd.md` — lifecycle and execution outcomes

## Reuse Opportunities

- Reuse action evidence checks, current lifecycle events, ordered resource locks and execution worktree isolation.
- Reuse Epic dependency ordering and integration-gate proof; no alternate completion state machine.

## Implementation Steps

1. Package reads always return the personal owner's live document regardless of branch, planning checkout or execution cwd.
2. Review/readiness/execution bind to package document hashes; a later editor change rejects stale approval or execution evidence without letting prose assign lifecycle state.
3. Controller updates mutate only metadata; ordinary document saves cannot reset checkpoints, decisions or receipts.
4. Epic sibling drafts are immediately visible to later children; package workflows create no planning-only worktree, seed no Plan onto a branch and merge no live Plan copies.
5. Attempt admission is serialized across linked clones and scoped to personal owner plus repository identity; changing cwd or matching a Plan ID cannot steal an attempt.
6. Plan-only and Git-effect transitions retain recoverable owner-specific journals with one lock ordering; restart repairs machinery without hand-edit instructions.
7. Core lifecycle/execution requirements document the supported package path while public default admission and delivered Plan/Metadata terminology remain owned by the activation child.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.ts src/shared/workflow/state-transition.test.ts src/shared/workflow/epic-continuation.test.ts src/cmd/load-plan/plan-authority.integration.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- From a primary checkout and two worktrees, read identical package bytes; edit a sibling during another child's execution and prove the next child sees it without Git publication.
- Race execution admission from linked clones and show only one active attempt; a foreign personal owner cannot reuse its identity.
- Interrupt metadata/controller and registry transitions; a fresh process reconciles from authoritative evidence without modifying Markdown or inventing completion.
- Manual: Run a fixture Epic through review and readiness, edit a sibling from another surface, and resume its child using a different checkout.
- Preserve: Approval invalidation, readiness, dependency order, code isolation, recoverable failure and deliberate abandonment.
- Retire: Package Plan authority from execution/planning/target-branch documents; legacy import and settlement remain narrowly bounded.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- A deleted execution worktree does not make the Plan disappear, but code recovery still needs its real Git evidence.
- Core-owned transition machinery must not become a test seam.
