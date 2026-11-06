diffstat only, patch not produced. Full patch: git show -p <rev>
---
planId: "9b9e2418-db1f-4a72-a942-9ae921ea6e59"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/load-plan/plan-epic-flow.ts"
    - "src/cmd/load-plan/index.ts"
    - "src/cmd/load-plan/plan-presentation.ts"
    - "src/cmd/load-plan/index.integration.test.ts"
    - "src/ui/tui/golden-scenarios/load-plan-epic-workflow.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/plan-lifecycle.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-02"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "3158ba6e2090ada88c951322bd03a3c829dcdc71"
workRecord:
    status: "approved"
    recordId: "156333db-fe39-4b42-b2d4-57d2b1aa4dc5"
    path: "docs/work-records/2026-11-03-epic-send-back-to-architect-for-re-review.md"
    lastAttemptAt: "2026-11-03T02:04:05.982Z"
status: "verified"
---
# Send Epics Back to Architect for Re-review
## Context
The Epic menu has no send-back action at `ready_for_decomposition`, the status in the user's screenshot. Planned Changes at `ready_for_work` already offer **Send back to Planner for re-review**. The user wants the equivalent Architect action for Epics.
`handleEpicPlan` offers **Review with Architect** only for draft or approved Epics. Simply widening that condition is not enough: its `review` result takes different paths depending on status, including direct browser review. The requested action must start Architect directly.
Affected product requirements:
- [Core Plan review](../prd/runwield-core-prd.md#plan-review): add an explicit send-back requirement and acceptance scenarios. Preserve **Open saved Plans directly for review**, **Reply or revise in Plan review**, and **Apply the user's review decision to the saved Plan**.
- [Core Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold): extend the available actions under **Deliver independent children and preserve paused work**. Preserve child review, branch ownership, and publication continuation.
- [Plan lifecycle reference](../plan-lifecycle.md#review-conversation-and-reopening): distinguish an explicit send-back from opening or discussing an existing review.
These are proposed behavior additions. No requirement is removed. No new domain term, lifecycle state, or architectural decision is needed.
## Objective
The user can select **Send back to Architect for re-review** from the Epic menu. Core returns the parent to draft and starts Architect on that Epic without opening browser review first or starting Slicer or execution. Existing child work remains intact.
## Approach
Use a distinct `architect_re_review` menu result and share the existing direct send-back flow with Planner. Keep this shared flow local to `runLoadPlanCommand`; no new service or injection seam is needed.
```text
Epic menu: Send back to Architect for re-review
  prepareSession (resolve the current document and refresh Plan data)
  reopenPlanForReview (review_reopened -> draft)
... more lines (truncated by snip)
