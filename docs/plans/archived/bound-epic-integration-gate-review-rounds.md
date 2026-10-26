---
planId: "5d5dbde5-c78a-4cb6-8f1d-47c9fb043752"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/epic-integration.ts"
    - "src/shared/workflow/epic-integration.test.ts"
    - "src/shared/workflow/controller-state.ts"
    - "src/shared/workflow/validation-ports.ts"
    - "src/shared/workflow/validation-session-adapter.ts"
    - "src/shared/session/subagent-definitions.ts"
    - "src/agent-definitions/subagent-definitions/integration-reviewer-prompt.md"
    - "src/agent-definitions/subagent-definitions/integration-reviewer-verify-prompt.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "7bac6a9c0615a7b836cae5201889129e73c38e84"
workRecord:
    status: "generated"
    recordId: "fcb85ab0-8d6a-4261-b664-75bb0c48aa04"
    path: "docs/work-records/2026-10-26-bounded-epic-integration-gate-reviews.md"
    lastAttemptAt: "2026-10-26T13:13:02.118Z"
status: "verified"
archivedAt: "2026-10-26T13:50:46.155Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/bound-epic-integration-gate-review-rounds.md"
---

# Bound the Epic Integration Gate Review Rounds

## Context

The Epic **Integration Gate** never converges. Each gate run is a new full review of the whole Epic diff. When it finds
problems, RunWield adds a repair child automatically. Epic continuation delivers that child and runs the gate again.
Nothing stops the loop except a clean review, and a new full review almost always finds something new.

The live Epic `attached-mode-claude-feature-preview` shows it. Five gate runs produced five repair children:

| Gate run | Repair child | Findings | Same issue as before | New issue |
| -------- | ------------ | -------- | -------------------- | --------- |
| 1        | `10-…`       | 10       | —                    | 10        |
| 2        | `11-…-2`     | 7        | 3                    | 4         |
| 3        | `12-…-3`     | 8        | 4                    | 4         |
| 4        | `13-…-4`     | 6        | 3                    | 3         |
| 5        | `14-…-5`     | 9        | 4                    | 5         |

Two patterns cause the loop:

- **New findings every run.** Every run is a discovery sweep. The reviewer has no record of earlier findings, so it
  reports different issues each time.
- **The same issue under a new name.** "Planning Gate is absent" and "two workflows own one worktree" appear in all five
  reports with different titles. Nothing ties them to the earlier finding, so nothing records that a fix was attempted
  and rejected, and no user decision is ever requested.

The cause is in `runEpicIntegrationGate` (`src/shared/workflow/epic-integration.ts`):

```text
runEpicIntegrationGate
  runIntegrationReview          # createLedger() each run: no earlier findings, no round number
  findings > 0
    addRepairChild              # always automatic, no limit
workflows.ts Epic continuation  # delivers the repair child, then runs the gate again
```

Per-Plan Semantic Review already solved this problem. It keeps a Review Issue Ledger with stable finding IDs. Rounds 1–2
review everything, and later rounds only verify open findings and the repair diff. After three automatic rounds, the user
decides. The Integration Gate uses none of this.

> [!NOTE]
> **Project-check findings in this Epic came from an unprepared checkout**
>
> All five reports start with "Project checks fail on the Epic branch". The saved logs show an uninitialized
> `third_party/plannotator` submodule and missing packages (`typescript`, `astro`). No repair child can fix that. Gate
> checkout setup (`prepareGateCheckout`) landed on `main` on 2026-10-25, and those runs most likely used an older build.
> This Plan does not change setup. The round limit stops the loop even when a check failure has no code fix.

### PRD

- [Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold) owns the changed requirement
  **An Epic finishes through its integration gate** and the scenario "Given gate findings, the Epic report lists them
  and a draft repair child opens in Planner; its delivery runs the gate again."
- [Semantic review and repair](../prd/runwield-core-prd.md#semantic-review-and-repair) owns the principles this Plan
  applies to the gate: **Distinguish repair claims from confirmed fixes** and **Hand the decision to the user after
  automatic rounds** (three automatic rounds).
- Behavior that stays the same: the gate checks the exact branch head, runs project checks, uses the Epic document from
  the checked branch, pauses on setup failure without a repair child, offers Code Review per `codereview`, never merges
  the Epic branch, and returns a passed Epic to `implemented` when the branch moves.

## Objective

The Integration Gate converges, and the user decides once automatic effort is spent:

- **Findings keep their identity across gate runs.** The Epic keeps one Review Issue Ledger. A repair child lists
  findings by ID, and the next gate run confirms or rejects each one under the same ID.
- **Only the first gate review is a full sweep.** Later gate reviews verify open findings and check the changes since
  the last review for regressions. They do not sweep the Epic again.
- **Three automatic gate reviews, then the user decides.** From the third gate review on, findings do not create a
  repair child automatically. RunWield asks the user to plan another repair, review the Epic in Code Review, or stop.

**Decision:** the gate does one full sweep, not two as per-Plan Semantic Review does. Each child already had its own full
review, and the live Epic shows that each extra sweep only adds new findings.

## Approach

Apply the per-Plan review model to the gate. Reuse its ledger, verification prompt pattern, and repair-scope diff.

### Gate review state

The Epic's controller record gains one field. It is runtime state and never appears in the Plan document:

```ts
type EpicIntegrationReviewState = {
    /** Integration reviews counted for this Epic, including seeded earlier rounds. Prefixes new finding IDs. */
    round: number;
    /** Every integration finding with a stable ID, across all gate runs. */
    ledger: ReviewLedger;
    /** Epic head the last review checked; the next review's repair diff starts here. */
    checkedCommit: string;
    /** The user approved the Epic in Code Review over open integration findings. Not AI approval. */
    userTakeoverAt?: string | null;
};
```

`WorkflowControllerState.epicIntegrationReview` holds it. Adding the field to `CONTROLLER_STATE_FIELDS` routes it through
the controller registry, the same route `validationCheckpoint` uses.

The full sweep runs when this state is absent, because no ledger exists to verify. Every run with saved state is a
verify review.

**Decision: existing Epics count their earlier repair children.** An Epic without saved state seeds `round` from the
number of integration repair children it already has. Its next run is a full sweep, because it has no ledger yet, but
the limit applies at once. For `attached-mode-claude-feature-preview` (five repair children), the next run with
findings asks the user instead of adding a sixth child.

One helper identifies an integration repair child. `addRepairChild` already counts siblings whose name contains
`repair-integration-findings` to number the next title. That rule moves into the helper, and both numbering and seeding
use it, so the naming rule lives in one place.

### One gate run

```diff
 runEpicIntegrationGate
   reconcile, checkout, setup, checks          # unchanged
+  read epicIntegrationReview (absent → round = existing repair children, empty ledger)
+  if head moved since checkedCommit: claimReviewFixes(ledger)
+  mode = state absent ? "integration" : "integration_verify"
-  runIntegrationReview(full diff)
+  runIntegrationReview(mode, ledger, full diff, repair diff checkedCommit..head)
+  applyRoundFindings(ledger, findings, round); save state with checkedCommit = head
   findings = check failure + open ledger items + Code Review changes
-  findings > 0 → addRepairChild
+  Code Review changes          → addRepairChild (the user already decided)
+  round < 3                    → addRepairChild
+  round ≥ 3                    → ask the user
```

A verify review follows `reviewer-verify-prompt.md`: account for every open ID, confirm or reject each one with a reason,
and open new findings only for regressions in the repair diff. The ledger rejects a result that omits an open ID and
sends it back to the reviewer (`unaccountedOpenItems`), as per-Plan review does.

### At the limit

```text
Integration review found <n> open finding(s) after <round> gate reviews.
  > Plan another repair          → repair child; the next run is another verify review, then asks again
    Let me review the Epic       → Code Review of the whole Epic (only when project checks pass)
    Stop                          → paused; report and ledger saved; Epic menu still offers "done enough"
```

Approval in that Code Review marks the Epic `reviewed`. The pass records `userTakeoverAt`, and the status message says
the integration review did not approve. A Code Review change request creates a repair child.

The prompt goes through the existing `port.requestInteraction`. A host that cannot answer pauses the gate, and nothing
else changes. The automatic run in `workflows.ts` continues to the repair child only when the gate returns `findings`.

> [!TIP]
> **Why the limit is in code and the scope is in the prompt**
>
> The verify prompt narrows what a later review reports, but the reviewer is still a model. The round limit is the
> guarantee: no Epic gets more than three automatic repair cycles, whatever the reviewer does.

Option set aside: a limit alone, with every run still a full sweep. It stops the loop, but it gives the user three
unrelated finding lists and no record of which fixes were rejected.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent —
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `src/shared/workflow/epic-integration.ts` — reads and saves gate review state, selects the review mode, applies the
  ledger, puts finding IDs in repair children, and asks the user at the limit.
- `src/shared/workflow/controller-state.ts` — adds `epicIntegrationReview` to `WorkflowControllerState` and
  `CONTROLLER_STATE_FIELDS`.
- `src/shared/workflow/validation-ports.ts` — adds `"integration_verify"` to `ReviewerRoundMode`.
- `src/shared/workflow/validation-session-adapter.ts` and `src/shared/session/subagent-definitions.ts` — route
  `"integration_verify"` to the Integration Reviewer with its verify prompt.
- `src/agent-definitions/subagent-definitions/integration-reviewer-verify-prompt.md` — new verify prompt for later gate
  reviews.
- `src/agent-definitions/subagent-definitions/integration-reviewer-prompt.md` — says it is the one full sweep.
- `src/shared/workflow/epic-integration.test.ts` — round, ledger, limit, and takeover tests.
- `docs/prd/runwield-core-prd.md` — the gate requirement and scenarios.
- `docs/domain-language.md` — the **Integration Gate** entry.

Not changed: gate checkout setup, `reconcileEpicDelivery`, Epic continuation in `workflows.ts`, and per-Plan Semantic
Review.

## Reuse Opportunities

- `src/shared/workflow/review-ledger.ts` — `createLedger`, `normalizeLedger`, `applyRoundFindings`, `claimReviewFixes`,
  `unaccountedOpenItems`, `openItems`, `renderOpenItems`, `renderResolvedItems`.
- `src/shared/workflow/review-diff-tool.js` — `createReviewDiffTool({ full, repair }, { ledger })` already exposes
  `scope: "repair"`.
- `src/agent-definitions/subagent-definitions/reviewer-verify-prompt.md` — the verify contract to adapt for the Epic.
- `src/shared/workflow/validation-semantic.ts` — `promptForSemanticRoundLimit` shows the per-Plan limit prompt and the
  takeover evidence wording.
- `src/shared/workflow/validation-types.ts` — `SEMANTIC_REVIEW_CYCLES` is the three-round budget; the gate uses the same
  constant.

## Implementation Steps

- `WorkflowControllerState` in `src/shared/workflow/controller-state.ts` has an `epicIntegrationReview` field of a
  named `EpicIntegrationReviewState` type (`round`, `ledger`, `checkedCommit`, `userTakeoverAt`), and
  `CONTROLLER_STATE_FIELDS` lists it. Writing it for an Epic stores it in the controller record, not in the Epic's
  Markdown.
- `ReviewerRoundMode` includes `"integration_verify"`. The validation session adapter runs the Integration Reviewer
  subagent for it with `integration-reviewer-verify-prompt.md` and the same read-only tool ceiling as `"integration"`.
- `integration-reviewer-verify-prompt.md` states the verify contract for an Epic. Every open ID must appear in the
  result as `fix_confirmed` or `fix_rejected` with a reason. New findings are allowed only for regressions in the repair
  scope, with `origin: "repair_regression"`. The prompt forbids sweeping the Epic again and composes `review-practice`.
- One exported helper in `epic-integration.ts` decides whether a child Plan is an integration repair child. Both
  `addRepairChild` title numbering and round seeding use it; no other code matches `repair-integration-findings`.
- `runEpicIntegrationGate` reads `epicIntegrationReview`. Absent state means an empty ledger and a `round` equal to the
  number of the Epic's existing integration repair children (0 for a new Epic). When the Epic head differs from a saved
  `checkedCommit`, it calls `claimReviewFixes` before the review.
- A run without saved state reviews in `"integration"` mode with the full Epic diff. A run with saved state reviews in
  `"integration_verify"` mode. The verify request lists open and resolved ledger items, and `review_diff` has a
  `repair` scope from `checkedCommit` to the head.
- `runIntegrationReview` passes the persisted ledger to `createReviewDiffTool`. In verify mode it rejects a result that
  omits an open ID and nudges the reviewer within `MAX_REVIEWER_ATTEMPTS`.
- After each completed review, `applyRoundFindings` updates the ledger with the new round number (`round + 1`). After
  the existing checks that the Epic is still `implemented` and its head has not moved, the gate saves the new round,
  the ledger, and `checkedCommit = head`, and only then creates a repair child, asks the user, or records a pass. A
  paused or `not_ready` run saves nothing.
- Repair-child findings and the integration report name each ledger finding by ID (for example `### R1-3. <title>`).
  Check failures and Code Review changes appear without ledger IDs.
- When the round just completed is below `SEMANTIC_REVIEW_CYCLES`, findings create a repair child automatically, as
  today. When it is at or above the limit, the gate creates no repair child and asks: plan another repair, review the Epic in Code
  Review, or stop. Code Review is offered only when project checks passed on this head.
- "Plan another repair" returns `findings` with a new repair child. "Stop", or an unanswered prompt, returns `paused`
  with a reason that names the open findings and the report path, and creates no child.
- Approval in the limit Code Review records `epic_integration_passed` with `humanReviewMode: "always"` and
  `humanReviewDecision: "approved"`. It sets `epicIntegrationReview.userTakeoverAt`, and the status message says the
  integration review did not approve. A change request creates a repair child.
- Code Review change requests from the normal post-review Code Review always create a repair child, whatever the round.
- `integration-reviewer-prompt.md` says this is the gate's one full review and later gate reviews only verify its
  findings. The rest of the prompt is unchanged.
- In `docs/prd/runwield-core-prd.md#epic-decomposition-and-hold`, the gate requirement describes stable finding IDs,
  one full review then verify-only reviews, and the three-review limit with its three choices. The acceptance scenarios
  cover each, and the existing "Given gate findings" scenario reflects the limit.
- The **Integration Gate** entry in `docs/domain-language.md` describes the same behavior. It also says a pass makes
  the Epic `reviewed`, not `validated`, to match ADR-016 and the code.

## Verification Plan

Automated, through the real gate with a Git fixture, controller records on disk, and a scripted reviewer:

```bash
bun scripts/run-tests.js src/shared/workflow/epic-integration.test.ts src/shared/session/agents-shared-practice.test.ts src/shared/workflow/validation-prompts.test.ts
```

New tests in `src/shared/workflow/epic-integration.test.ts`:

- **First review is a full sweep with IDs.** Round 1 returns two findings. The reviewer ran in `"integration"` mode.
  The repair child and report list `R1-1` and `R1-2`, and controller state has `round: 1` and `checkedCommit` equal to
  the checked head. Fails if the gate does not persist state or does not assign IDs.
- **Later review only verifies.** Deliver a repair commit, then run the gate. The reviewer ran in
  `"integration_verify"` mode. The request lists `R1-1` and `R1-2`, and `review_diff` `scope: "repair"` shows only the
  repair commit. The scripted result confirms `R1-1` and rejects `R1-2`. The new repair child lists `R1-2` with the
  rejection reason, not a renamed finding. Fails if every run is a fresh sweep.
- **Omitted IDs are sent back.** A verify result that omits an open ID is nudged. A second result that accounts for it
  completes the review.
- **The limit asks.** At the third review with findings, no repair child is written before the prompt. "Stop" returns
  `paused`, writes the report, and adds no child. "Plan another repair" adds exactly one child. Fails if the gate keeps
  creating children automatically.
- **Takeover.** With passing checks at the limit, "Let me review the Epic" opens Code Review. Approval makes the Epic
  `reviewed` with `userTakeoverAt` set. With failing checks, the choice is not offered.
- **Code Review changes are not limited.** A Code Review change request at round 3 creates a repair child without the
  limit prompt.
- **Existing Epics count earlier repair children.** An Epic with no saved state and two existing
  `repair-integration-findings` children runs a full `"integration"` review. When it returns findings, the gate asks
  the user and writes no repair child. Saved state then has `round: 3`. Fails if seeding is missing.

Behavior that existing tests must still protect: the exact-head check, one controller request ID per review, a stale
pass after a new commit, report and draft repair child on round 1, no run before every child is delivered, setup before
checks, setup failure pausing without a child, and requirements read from the checked branch. Nothing those tests cover
is meant to stop existing.

Prompt registry tests cover the new `integration-reviewer-verify-prompt.md` and its `review-practice` composition.

Manual:

- On a small test Epic with a real reviewer, run the gate until it creates a repair child. Deliver that child, and
  confirm the second run says it is verifying earlier findings and lists them by ID.
- On `attached-mode-claude-feature-preview`, after the next gate run, confirm the project checks do not fail from a
  missing submodule or packages. If they still do, report it as a separate setup defect.

Documents: the Core PRD gate requirement and scenarios and the **Integration Gate** glossary entry describe the delivered
behavior, with nothing unimplemented claimed.

## Edge Cases & Considerations

- **Existing Epics have repair children but no saved state.** Their next run is a full sweep, and the limit counts
  their earlier repair children. A user who renamed a repair child away from the generated name loses that one from
  the count; the limit still applies after later rounds.
- **The Epic branch merges `main`.** The repair diff from `checkedCommit` includes those merged changes. The verify
  reviewer can report a regression they cause. This is correct for the assembled Epic, but the diff can be large.
- **Head moves during a review.** The gate already returns `not_ready` when the branch moved. It saves no state then, so
  the next run reviews the same round again.
- **The passed Epic goes stale.** The ledger and round persist. The next run is a verify review of the new commits, and
  findings still count toward the limit.
- **Project checks with no code fix.** Check failures are not ledger items, because they are re-run every time. They
  still make a round end with findings, so the limit applies to them.
- **Headless or Connect host.** The limit prompt uses the existing interaction port. A host that cannot answer pauses
  the gate with findings saved, which is the same as "Stop".
