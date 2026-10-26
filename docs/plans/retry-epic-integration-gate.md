---
planId: "b12dd5b4-1f7d-49d0-86ef-dc389ed60993"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/epic-integration.ts"
    - "src/shared/workflow/epic-integration.test.ts"
    - "src/cmd/load-plan/plan-epic-flow.ts"
    - "src/cmd/load-plan/index.integration.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
    - "docs/plan-lifecycle.md"
    - "docs/user-facing-features.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25T23:53:12-04:00"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
status: "implemented"
---

# Retry the Integration Gate from the Epic Menu

## Context

An `implemented` Epic whose integration gate found problems cannot run the gate again. The only way forward is to plan
and deliver the draft repair child that the gate created. That path is wrong when the findings are no longer true.

The Epic `reliable-usage-dashboard-and-langfuse-export` shows the problem:

- The gate checked `dc60183` on Oct 24. Every project check failed with `Cannot find package 'typescript'`, because the
  temporary checkout had no dependencies.
- Commit `d95f6d2c6` (Oct 25) added `prepareGateCheckout`, which runs `worktree_setup_command` before the checks.
  A rerun on the same commit can now give a real result.
- The gate added the draft `11-repair-integration-findings`. That draft is not settled, so `reconcileEpicDelivery`
  returns `gateReady: false`, and the Epic menu hides "Run the integration gate on the Epic branch".
- The draft exists only in the primary checkout. The Epic menu lists children from the Epic branch, so it shows
  "10 child Planned Changes — 0 remaining" and gives no reason why the gate option is missing.

The owning capability is
[Core PRD — An Epic finishes through its integration gate](../prd/runwield-core-prd.md). Its current text says
findings "become a draft repair child that the user reviews like any child; its delivery runs the gate again". This
Plan adds a second path: the user can retry the gate while that repair child is unstarted. All other gate behavior stays
the same: exact branch head, setup before checks, pause without a repair child, pass marks the Epic `reviewed`, and a
new branch commit returns the Epic to `implemented`.

### Decisions

- **Label:** "Retry the integration gate". The glossary term is **Integration Gate**. It lists "Epic validation run"
  under _Avoid_, so the label does not say "validation".
- **Pass with an open repair draft:** RunWield closes the draft as `closed_without_verification`. The reason names the
  commit on which the retry passed. The draft stays visible and can be archived. RunWield never deletes it.
- **Findings with an open repair draft:** RunWield writes the new findings into the existing draft. It does not add a
  "Repair integration findings 2" child.
- **The automatic gate stays strict.** The gate run after the last child delivers keeps its current rule. Only an
  explicit user retry continues when an open repair draft exists.

## Objective

When an `implemented` Epic is blocked only by unstarted repair drafts from an earlier gate run, the Epic menu offers
"Retry the integration gate". The retry runs the normal gate on the current Epic branch head:

- A pass marks the Epic `reviewed` and closes the open repair drafts with a reason.
- Findings update the newest open repair draft, and the user can then plan it.
- A pause changes nothing.

## Approach

The readiness rule and the repair-draft rule both live in `src/shared/workflow/epic-integration.ts`, the gate's owner.
The menu only reads the result.

```diff
 readEpicDeliveryState
   for each child
     settled = isChildSettled(...)
+    openRepairDraft = isIntegrationRepairChild(name) && status === "draft"
 reconcileEpicDelivery
   gateReady      = implemented && allSettled
+  gateRetryReady = implemented && !allSettled && every child is settled or openRepairDraft
 runEpicIntegrationGate
-  if !gateReady → not_ready
+  if !gateReady && !gateRetryReady → not_ready
   ...
   passed
     record epic_integration_passed
+    close each open repair draft (manual_closed_without_verification, reason names the commit)
   findings
     write report, record epic_integration_failed
-    addRepairChild
+    newest open repair draft ? replace its Findings and checked commit : addRepairChild
```

A "repair child" is identified by name. Today `addRepairChild` already counts siblings with
`name.includes("repair-integration-findings")`. One exported predicate, `isIntegrationRepairChild(name)`, will own that
rule for the count and for the retry. Without it, two modules would each know the naming rule.

The automatic path does not change. `continueEpicAfterValidation` calls the gate only when
`isEpicGateReadyAfterChildren` reports the strict `gateReady`. Continuation reaches that check only when no children
remain, so an open repair draft is first offered as the next child, as it is today.

> [!TIP]
> **Why the gate accepts retry readiness without a flag**
>
> A `retry: true` option would push the decision to each caller. The strict automatic trigger already guards the
> automatic path. So the gate itself can accept `gateReady || gateRetryReady`, and the menu needs no special call.

Closing a draft uses the existing `manual_closed_without_verification` lifecycle event through `recordPlanEvent`. That
event already accepts `draft` (`MANUAL_BOARD_SOURCE_STATUSES`) and requires a reason. The user chose the retry
deliberately, so "manual" is accurate. This needs no new lifecycle event.

Rejected alternative: tell the user to close the repair child by hand and then run the gate. That takes two steps, and
the user must know that the hidden draft is the blocker. The menu today does not even list that draft.

## Expected Change Surface

This list is guidance, not an allowlist. Verify the real footprint during implementation and change what the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent:
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `src/shared/workflow/epic-integration.ts` — the repair-child predicate, the per-child `openRepairDraft` flag,
  `gateRetryReady`, gate acceptance, closing drafts on pass, and updating the draft on findings.
- `src/shared/workflow/epic-integration.test.ts` — behavioral tests for retry readiness, pass, findings, and the strict
  automatic rule, through real Git fixtures.
- `src/cmd/load-plan/plan-epic-flow.ts` — the menu option and a short message that names the open repair draft and the
  report.
- `src/cmd/load-plan/index.integration.test.ts` (or the Epic golden scenario
  `src/ui/tui/golden-scenarios/load-plan-epic-workflow.ts`) — the menu shows the retry option only in the right state.
- `docs/prd/runwield-core-prd.md` — the integration gate requirement and acceptance scenarios.
- `docs/domain-language.md` — the **Integration Gate** entry.
- `docs/plan-lifecycle.md` — the "Epic Branches and the Integration Gate" section.
- `docs/user-facing-features.md` — the Epic feature line about repeating the gate.

Not changed: `src/shared/session/runtime/epic-gate.ts` and `workflows.ts`. The automatic trigger keeps strict
`gateReady`.

## Reuse Opportunities

- `src/shared/workflow/plan-lifecycle.js` — `manual_closed_without_verification` with
  `closedWithoutVerificationReason`, through `recordPlanEvent`.
- `src/shared/workflow/epic-integration.ts` — `addRepairChild` content and `renderFindings`. Extract the findings and
  context text so that a new draft and an updated draft use the same rendering.
- `src/shared/workflow/plan-location.ts` — `resolveWorkflowPlanLocation`, to find where a repair draft document lives
  (primary checkout or Epic branch) before it is closed or updated.
- `src/shared/workflow/epic-integration.test.ts` — `epicWithPendingSecondChild`, `deliverSecondChild`,
  `scriptedReviewer`, `scriptedChecks`, and `gateSession`.

## Implementation Steps

1. `src/shared/workflow/epic-integration.ts` exports `isIntegrationRepairChild(name: string): boolean`. `addRepairChild`
   uses it to count earlier repairs. No other module repeats the `repair-integration-findings` string.
2. `EpicChildDelivery` has `openRepairDraft: boolean`. It is true only when `isIntegrationRepairChild(name)` is true and
   the child status is `draft`. `readEpicDeliveryState` sets it for children found on the Epic branch and for drafts
   found only in the primary checkout. `allSettled` keeps its current meaning.
3. `EpicReconcileResult` has `gateRetryReady: boolean`. It is true only when the reconciled status is `implemented`, at
   least one child is unsettled, and every unsettled child has `openRepairDraft`. `gateReady` keeps its current
   definition. The `ready_for_work → implemented` reconciliation (`epic_children_delivered`) still requires
   `allSettled`.
4. `runEpicIntegrationGate` runs when `gateReady || gateRetryReady`. In any other state it returns `not_ready`, as it
   does today.
5. When a gate run passes and open repair drafts exist, RunWield records `epic_integration_passed` for the Epic. Then it
   records `manual_closed_without_verification` on each open repair draft with a reason, for example: `The integration
gate passed on <branch> at <commit> after a retry; these findings no longer apply.` Each draft keeps its body, Plan
   ID, and order.
6. When a gate run finds problems and open repair drafts exist, RunWield writes the report and records
   `epic_integration_failed` as it does today. Then, in the open repair draft with the highest `order`, it replaces the
   checked commit in Context and the whole `## Findings` section. No new child is created. Front matter (`planId`,
   `order`, `status`, `targetBranch`) and all other sections stay unchanged. The `findings` result returns that draft as
   `repairChild`.
7. When no open repair draft exists, pass and findings behave exactly as they do today. A findings run still creates a
   new repair child.
8. `src/cmd/load-plan/plan-epic-flow.ts` shows "Run the integration gate on the Epic branch" when `gateReady` is true.
   When only `gateRetryReady` is true, it shows "Retry the integration gate". Both use the existing `integration_gate`
   handler and need `session.runEpicIntegrationGate`. When `gateRetryReady` is true, the menu first shows a message
   that names each open repair draft and `epicIntegrationReport`. The message tells the user to retry the gate or plan
   the repair child.
9. `epic-integration.test.ts` covers, through real Git fixtures and scripted review and check ports:
    - retry readiness with an open repair draft that exists only in the primary checkout;
    - no retry readiness when the repair child is not `draft`, or when any non-repair child is unsettled;
    - a passing retry, which marks the Epic `reviewed` and closes the draft with the reason;
    - a findings retry, which updates the same draft and creates no second repair child;
    - the strict automatic rule: `gateReady` stays false while the draft is open.
10. A load-plan test proves the Epic menu offers "Retry the integration gate" for an `implemented` Epic whose only
    unsettled child is an open repair draft. It also proves the menu does not offer it when a non-repair child is
    undelivered.
11. Core PRD `An Epic finishes through its integration gate` states the retry path and has acceptance scenarios for
    retry pass and retry findings. `docs/domain-language.md` **Integration Gate** describes the retry while the repair
    child is unstarted. In the same entry, "A pass makes the Epic `validated`" becomes `reviewed`, to match the code and
    PRD. `docs/plan-lifecycle.md` and `docs/user-facing-features.md` describe the same behavior.

## Verification Plan

- Automated:
    - `bun scripts/run-tests.js src/shared/workflow/epic-integration.test.ts`
    - `bun scripts/run-tests.js src/cmd/load-plan/index.integration.test.ts` (or the Epic golden scenario test if the
      menu test lives there)
    - `bun run fmt:check <changed files>`
- Tests that fail on a counterfeit:
    - If `runEpicIntegrationGate` keeps rejecting non-strict readiness, the retry-pass test fails, because the Epic stays
      `implemented`.
    - If the pass path does not close the draft, the retry-pass test fails, because the draft is still `draft`.
    - If the findings path still calls `addRepairChild`, the retry-findings test fails, because a second repair child
      exists.
    - If `gateReady` is loosened instead of adding `gateRetryReady`, the strict-automatic test fails.
- Existing behavior that must stay protected (do not delete or weaken these tests):
    - "integration findings produce a report and a draft repair child on the Epic branch" (first run, no open draft);
    - "the gate does not run before every child is delivered";
    - "failed gate setup pauses without checks, review, or a repair child";
    - "a new commit on the Epic branch makes a passed gate stale".
      No existing behavior is expected to stop.
- Manual: load `reliable-usage-dashboard-and-langfuse-export`.
    - The menu explains that `11-repair-integration-findings` is open and offers "Retry the integration gate".
    - The retry installs dependencies with `bun run install:locked` and runs the checks on `dc60183`.
    - On a pass, the Epic is `reviewed` and child 11 is `closed_without_verification` with the reason.
    - On findings, child 11 has the new findings and no child 12 exists.
- Docs: the Core PRD, glossary, `plan-lifecycle.md`, and `user-facing-features.md` describe the retry. Each one says
  that the automatic gate still waits for the repair child.

## Edge Cases & Considerations

- **Repair draft stored only in the primary checkout** (the current Epic). Close or update it where
  `resolveWorkflowPlanLocation` finds it. Do not assume that it is on the Epic branch.
- **The repair child was started** (status other than `draft`). It stays a real blocker, so no retry is offered,
  because started children keep their scope (Core PRD).
- **A draft with a planning worktree.** Assumption: status `draft` alone defines "open". If a Planner session already
  made a planning worktree, closing the draft leaves that worktree in place. Updating the draft changes only the
  Context commit and the Findings section, so the user's other edits stay.
- **More than one open repair draft.** A pass closes all of them. Findings update only the draft with the highest
  `order`. The older drafts stay as they are.
- **The Epic branch moves during the retry.** The existing "branch moved" check returns `not_ready`, and no draft is
  closed or changed.
- **A retry that pauses** (setup failure, missing branch document, reviewer that never reports). No draft or Epic
  status changes.
- **Out of scope:** the Epic menu child list and progress count come from the Epic branch, so they do not show a
  repair draft that exists only in the primary checkout. The message in step 8 names the draft. Fixing the list
  itself, or why this draft was never seeded onto the branch, is a separate change.
