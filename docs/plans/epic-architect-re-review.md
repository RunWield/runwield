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
status: "reviewed"
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
  rebuild and run Architect at the authoritative document root
  existing post-planning decision handling
```

The recommended scope is non-Sequence Epics in `ready_for_decomposition` or `ready_for_work`, using the status refreshed by existing reconciliation. This covers the screenshot and later architecture changes without adding a new path for terminal or recovery states.

> **Question (epic-re-review-availability):** Should the new action be available before decomposition and after child Plans exist? I recommend both; sending the parent back does not reset its children.
>
> **Answer:** Both ready_for_decomposition and ready_for_work (recommended) (answered in review)

The steps and checks below use the recommended scope. If review selects the narrower scope, omit the `ready_for_work` action and assert its absence there.

> [!NOTE]
> **Send-back requires a new approval**
>
> Like the existing Planner action, this explicit action returns the parent to `draft` before the Agent turn. It is not ordinary review opening, which preserves approval. Approve for Later then returns an Epic to `ready_for_decomposition`; Approve & Slice starts Slicer. Existing children do not automatically restore the parent to `ready_for_work`.

Do not replace the existing review action or route the new action through browser review. That smaller-looking change would not provide the requested direct Agent handoff.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/load-plan/plan-epic-flow.ts` — expose the new action and return a distinct result.
- `src/cmd/load-plan/index.ts` — share direct send-back orchestration between Planner and Architect.
- `src/cmd/load-plan/plan-presentation.ts` — produce Agent-correct re-review context without implying that an Epic executes.
- `src/cmd/load-plan/index.integration.test.ts` — verify actual handoff, lifecycle, review ordering, and child preservation.
- `src/ui/tui/golden-scenarios/load-plan-epic-workflow.ts` and its test registration — verify the terminal menu and complete Architect re-review journey.
- `src/ui/tui/golden-scenarios/load-plan-workflow.ts` and its tests — preserve existing Planner send-back coverage after sharing orchestration.
- `docs/prd/runwield-core-prd.md` and `docs/plan-lifecycle.md` — document the explicit action and its effect on approval.

Sequence behavior, Workspace menus, Connect protocol, and lifecycle transition rules are outside this change. The shared command can serve its current callers without adding surface-specific actions.

## Reuse Opportunities

- `reopenPlanForReview` in `plan-recovery-worktree.ts` already supports both ready statuses, clears old review evidence, and preserves the registered implementation attempt.
- `prepareSession` resolves the current Plan document, activates the Session, and prepares its working directory before the transition.
- `decidePostPlanning`, `executePostPlanningDecision`, and `shouldKeepPlanningAgentActive` already handle approval, Slicer dispatch, and Agent retention.
- Existing runtime command fixtures and Golden faux-model scripts exercise real storage and workflow behavior. Fake only model and interaction boundaries, not RunWield-owned transitions.

## Implementation Steps

1. `handleEpicPlan` offers `architect_re_review`, labeled **Send back to Architect for re-review**, for the accepted ready statuses on non-Sequence Epics. Place it with the review actions before Slicer. Draft, approved, Sequence, and other status menus keep their existing actions.
2. `runLoadPlanCommand` handles that result separately from `review` and `direct_review`. A local shared send-back routine also serves `planner_re_review`, so lifecycle ordering and Agent restoration have one implementation. It prepares the Session, captures the refreshed status, calls `reopenPlanForReview`, rebuilds the selected planning Agent at `planDocumentRoot`, runs it, and applies the existing post-planning decision and restoration rules. It does not fall through to another menu or start browser review before the Agent turn.
3. `plan-presentation.ts` supplies re-review request text for the selected planning Agent. Architect receives the Epic path, an explicit request to re-review, and the facts that no feedback was submitted and no review page should open first. Planner retains its current meaning. Derive the Agent from the existing classification/type routing rather than adding a user-selectable Agent option.
4. Integration tests prove both supported entry states reach Architect with the saved parent already draft. A reply without `plan_written` leaves Architect active and the parent draft. Later approval uses the normal Epic readiness and Slicer paths. The send-back itself preserves child contents, statuses, IDs, order, dependencies, worktree records, and existing Epic branch history.
5. Golden tests expose the new menu item and select it in a real composed terminal journey. Existing exact menu expectations change only for the accepted statuses. Existing Planner re-review, direct Epic review, Slicer, child selection, and Sequence coverage remain intact.
6. The owning Core PRD capability and lifecycle reference describe explicit send-back separately from review opening. Add scenarios for no-child and existing-child Epics, preservation of child work, and approval for later versus slicing. Link shared behavior rather than duplicating it in Epic decomposition. Keep unrelated target requirements unchanged.

## Approval Confirmation

No Work Record supersession is proposed. The embedded scope question is the only product choice left for review.

## Verification Plan

Use Bun 1.4.3. Run `bun run install:locked` before checks.

Focused automated checks:

- `bun scripts/run-tests.js src/cmd/load-plan/index.integration.test.ts`
- `bun scripts/run-tests.js src/ui/tui/golden-scenarios/load-plan-epic-workflow.test.ts src/ui/tui/golden-scenarios/load-plan-workflow.test.ts`
- `bun scripts/run-tests.js src/shared/workflow/epic-branch-planning.integration.test.ts`
- `bun run seams:check`
- `bun run doc-links:check`

Required behavioral evidence:

- **Exact reported case:** a `ready_for_decomposition` Epic with no children exposes the action. Selecting it produces an Architect model request before any review-page interaction, with the authoritative parent already `draft`. Assert the Agent and request content, not only the menu label.
- **Existing children:** a `ready_for_work` Epic with unfinished children follows the same route under the recommended scope. Capture child documents, registered child worktrees, and the existing Epic branch before send-back; the no-edit Agent turn leaves them unchanged. Use real Git/storage fixtures and include started child work so parent reset cannot silently reset it.
- **Approval:** a faux Architect calls real `plan_written`. Approve for Later leaves the parent `ready_for_decomposition` without Slicer; Approve & Slice starts Slicer. Neither path executes the parent.
- **No unintended transition:** view and cancel do not invoke send-back or reset approval. Sequences receive no Architect send-back option. Other status menus retain their previous choices.
- **Preserved behavior:** existing Planner send-back still starts Planner, including after canceled execution; direct review still opens the saved Plan; draft Architect review and Slicer/child selection remain usable. No existing behavior is intentionally removed.
- **Counterfeit check:** the first test must fail if the new action only displays a label, returns without work, runs Planner/Slicer, or opens browser review before Architect. The lifecycle assertion must fail if it only resumes Architect without reopening the parent.
- **Documentation:** the Core PRD and lifecycle reference agree on the accepted states and explicit reset. They do not claim that ordinary discussion invalidates approval or that children were reset.

Manual terminal check: load a disposable Epic at `ready_for_decomposition`, select the new action, and confirm Architect starts without a browser opening first. Discuss the Epic, submit it for review, and approve for later. Reload it and confirm Slicer remains available. Repeat with an Epic that has children if that scope is accepted; confirm those children remain visible after reapproval.

## Edge Cases & Considerations

- Reconciliation may advance a loaded Epic beyond a ready status before the menu appears. Offer the action from the refreshed state, not the original file snapshot.
- Cancellation before selection leaves approval intact. Once send-back succeeds, an interrupted or failed Agent turn leaves a resumable draft; do not silently restore old approval.
- A registered planning or execution document can differ from the primary checkout. Preserve the existing document-resolution and session-preparation path; do not write status directly to a guessed file.
- Existing child publication and recovery remain separate. Re-review does not abandon attempts, reset branches, or rewrite child lifecycle fields.
- No new lifecycle state, public dependency-injection seam, glossary term, or architecture layer is needed.
