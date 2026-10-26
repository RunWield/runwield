---
planId: "2b9da5c4-bec5-4649-b854-470b5b3bb573"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "LOW"
affectedPaths:
    - "src/shared/attached/coordinator.ts"
    - "src/shared/attached/validation-operation-ids.test.ts"
    - "src/shared/attached/delivery-recorder-recovery.test.ts"
    - "docs/prd/runwield-connect-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-26T02:00:35.947Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 14
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
status: "implemented"
---

# Repair integration findings 5

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at
`c941d2e52e5cf262d80932448f36eda8bc1b1700` and reported 9 findings. The report file is not in this worktree; the
findings are copied in the draft this Plan replaces and summarized below. After this child is delivered, the
integration gate runs again on the whole Epic.

Planning sorted the findings:

| Finding                                         | Decision              | Reason                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Project checks fail                          | **Dismissed**         | Environmental, as in children 10–13. The gate checkout `wld-epic-gate-QcmY6i` had no `node_modules` ("Cannot find package 'typescript'", "Cannot find module '@astrojs/check'", no `node_modules/astro/bin/astro.mjs`) and no initialized submodules ("Local submodule check failed. Initialize submodules…").    |
| #2 No Planning Gate                             | **Dismissed**         | Owner decision (children 10–13): Connect adds no hooks or tool restrictions, as in Core. ADR-014 says "Do not add hooks or permission rules that restrict host tools". The Epic on this branch says "RunWield does not restrict Claude's tools during an Attached Workflow". The gate reads main's old Epic copy. |
| #3 No generated Claude Skills or subagents      | **Dismissed**         | Owner decision (child 12 #8): role instructions are resolved at run time, and "The Connect plugin ships no Skill files" ([Connect PRD: Host-owned reasoning](../../prd/runwield-connect-prd.md#host-owned-reasoning), ADR-014). The Epic says "The adapter ships no generated Skills or copied role prompts".     |
| #4 Untested or unreported host versions proceed | **Dismissed**         | Owner decision (child 10 #3): "Newer or unreported host versions continue with a visible notice" ([Connect PRD: Compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability)). Versions below the tested floor and stale adapters are still refused.           |
| #5 Two Attached workflows share one worktree    | **Dismissed**         | Owner decision (child 10 #4, child 11 #3, child 12 #4, child 13 #3): an Attached Workflow Record references its Plan and does not own it. The Epic puts single-Plan ownership out of scope. `execution-start.ts` reuses an active worktree the same way for Core.                                                 |
| #6 Approve & Run choice lost after a crash      | **Dismissed**         | Owner decision (this child): parity with Core. A Core Session also keeps the "Run" choice only in memory. After this crash the Plan is still ready, nothing runs without permission, and `/runwield:implement` starts it. The Connect PRD **Approval recovery** scenario documents this behavior.                 |
| #7 Review passes a diff it cannot read          | **Dismissed here**    | Owner decision (this child): a Core defect. The diff format and the empty-coverage check are shared Core review code, and Core Sessions have the same gap. The owner fixes it separately.                                                                                                                         |
| #8, #9                                          | **Fix in this child** | Real defects in Connect's own retry and recovery receipts, described below.                                                                                                                                                                                                                                       |

> [!NOTE]
> **The gate can raise #1 to #7 again**
>
> Until the separate gate fixes land (dependencies in the gate checkout, Epic read from the Epic branch), the next gate
> run can report these findings again. They are dismissed on purpose.

The fixes keep these requirements:

- [Connect: Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery):
  "Saved Plans, work, review outcomes, and recovery evidence must allow useful continuation or explicit retry after
  process loss." "Accepted sections and decisions are not repeated."
- [Connect: Artifact privacy and records](../../prd/runwield-connect-prd.md#artifact-privacy-and-records), **Bounded
  invalid recording**: the second invalid Recorder submission records failure, publication continues, and the notice
  reports both outcomes.
- Epic Outcome Evidence, **Host waits survive Core exit**: a repeated submission returns the recorded result without
  repeating effects.

## Objective

Fix findings #8 and #9 on the Epic branch so that:

- **#8** Every successful `start_validation` response has a saved receipt, so a retry with the same `operationId`
  returns the same result after the workflow revision has moved on.
- **#9** When publication finished but the final Attached write was lost, recovery replays a rejected Recorder
  submission as `invalid_outcome`, the same result the live call returns. It never becomes `ok: true`.

## Approach

Each fix goes through the module that already owns the behavior. No new workflow state and no new seam.

### #8 Save a receipt for a restored validation handoff

In plain terms: Claude can send the same call twice, for example after a dropped connection. Each call has an ID, so
the repeat should get the saved first answer. One case saves no answer, so the repeat can get a false "workflow
changed" conflict, and Claude shows an error that did not happen.

`runValidationOperation` (`coordinator.ts:1937-1952`) returns `{ ok: true, operation, workflow }` when
`start_validation` finds a fresh pending request, without `accept` or `commit`. A later write moves the revision, and
the retry reaches the revision check at `1915` before any receipt can replay.

The fix routes that branch through `accept` + `commit` with `{ state: "validating", pendingAction: null }`, as
`review_diff` already does. That is one record write and a revision bump, like every other accepted operation.
`readStatus` calls `start_validation` for a `reviewed` record with a random `operationId`; setting `validating` limits
that path to one write.

### #9 Recovery reports a rejected Recorder submission the same way

In plain terms: after two invalid Work Record submissions, RunWield still publishes the code and tells Claude the Work
Record was rejected. If the process stops after publication but before that answer is saved, recovery rebuilds the
answer as "success", and Claude tells the user the Work Record was fine.

The live path (`coordinator.ts:2163-2185`) computes `recorderError` from the submitted sections
(`parseRecorderSections`) or from a `failed` Work Record after publication, and replaces the receipt with
`invalid_outcome`. The `readStatus` delivered branch (`1588-1607`) rebuilds the original operation's receipt with
`accept` only, so it saves `ok: true`.

The fix moves the rule into one function in `coordinator.ts`, used by both paths:

```ts
/** The error the host must see for a Recorder submission, or undefined when it was accepted. */
function recorderSubmissionError(
    submitted: RecorderResume | undefined,
    workRecord: PlanFrontMatter["workRecord"] | undefined,
): string | undefined;
```

The live path keeps its first-invalid retry rule (`host_request` with `validationError`). In `readStatus`,
`submitted` is `loaded.record.validation?.resume` when its kind is `recorder`, and `workRecord` is
`projected.closure.workRecord`. When the function returns an error, the rebuilt receipt is `invalid_outcome` with the
delivered view, as on the live path. A valid submission whose Work Record was saved still replays `ok: true`.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/attached/coordinator.ts` — receipt for the restored handoff (#8); `recorderSubmissionError` shared by
  the live path and `readStatus` (#9).
- Tests: `validation-operation-ids.test.ts` (#8); `delivery-recorder-recovery.test.ts` (#9).
- `docs/prd/runwield-connect-prd.md` — the Recorder-recovery scenario matches the delivered behavior.

Not changed:

- The Attached review decision path, `plan-review-actions.ts`, and the Connect **Approval recovery** scenario (#6 is
  dismissed).
- Shared review-diff code and the Core PRD (#7 is dismissed here).
- ADRs: ADR-014 and ADR-016 already require durable decisions and honest recovery.
- The glossary: no new terms.

## Reuse Opportunities

- `accept` and `commit` (`coordinator.ts`) — the receipt path `review_diff` already uses.
- `parseRecorderSections` (`work-records/generation.js`) — the existing Recorder check.
- `attachedValidationFixture` (`validation-test-fixture.ts`), `crash` (`delivery-recovery-test-fixture.ts`), and the
  observed-claim lost-write pattern in `validation-settlement.test.ts`.

## Implementation Steps

### Restored validation handoff receipt (#8)

- The fresh-request branch of `runValidationOperation` saves a receipt through `accept` and `commit` with
  `{ state: "validating", pendingAction: null }`. A lost race returns the winner's receipt for this `operationId`, or
  `revision_conflict`.

### Recorder recovery receipt (#9)

- `coordinator.ts` has one function, `recorderSubmissionError`, that both the live path and the `readStatus`
  delivered branch use. The live path's results are unchanged.
- In `readStatus`, a delivered recovery whose saved `validation.resume` is a Recorder submission that the function
  rejects saves the original `operationId` receipt as `invalid_outcome` with the delivered view.

### Documentation

- `docs/prd/runwield-connect-prd.md`, **Bounded invalid recording** or **Saved delivery recovery**: after process loss
  at publication, a rejected Recorder submission is still reported as rejected, with delivery shown as complete.

## Verification Plan

- Automated:
  `bun scripts/run-tests.js src/shared/attached/validation-operation-ids.test.ts src/shared/attached/validation-recovery.test.ts src/shared/attached/validation-process.test.ts src/shared/attached/validation-command.test.ts src/shared/attached/validation-settlement.test.ts src/shared/attached/delivery-recorder-recovery.test.ts src/shared/attached/delivery-recovery.test.ts src/attached/claude/mcp-validation.test.ts`
  (drop a path only if that file does not exist; do not drop it to hide a failure).
- **#8 regression** (`validation-operation-ids.test.ts`): start validation and get a `validation` action; call
  `start_validation` again with `operationId: "restore-handoff"`; call `review_diff list` (revision moves on); retry
  `start_validation` with `"restore-handoff"` and the original `expectedRevision`. The retry deep-equals the first
  restore result, and `ciCount()` is 1. This fails today with `revision_conflict`.
- **#9 regression** (`delivery-recorder-recovery.test.ts`): reach the Recorder action, submit one invalid submission
  (retry granted), then submit a second invalid one with `operationId: "second-invalid"`. Observe the durable claim,
  let Core publish, and rewrite the record to that claim (the observed-claim pattern in
  `validation-settlement.test.ts`), or use `crash` at the matching point. A fresh-process `status` reports
  `delivered`; retrying `work_record_completed` with `"second-invalid"` returns `ok: false` with
  `invalid_outcome`. This fails today with `ok: true`. A valid submission with a lost final write still replays
  `ok: true` (existing `recoverDelivery` cases).
- Protected behavior, existing tests that must still pass without weakening:
    - `review-write-recovery.test.ts` is unchanged: recovery after approval still reports saved work without
      inventing an approval action (#6 dismissed).
    - "an invalid Recorder submission gets exactly one retry after a crash" in `delivery-recorder-recovery.test.ts`.
    - Validation tests that hit the restore branch (`validation-recovery`, `validation-command`,
      `validation-handoff`, `validation-settlement`, `reviewer-instructions`, `delivery-review`) keep passing; where a
      test asserted the unchanged revision of a restore call, update it to `revision + 1`.
- Expected to stop existing: a restored `start_validation` handoff that returns without a receipt or revision bump
  (#8), and a recovered `ok: true` receipt for a rejected Recorder submission (#9).
- PRD check: the Connect PRD scenario above describes the delivered behavior and claims nothing else.

## Edge Cases & Considerations

- **Receipt growth (#8)** — each restore call adds one receipt, as each `review_diff` page already does. Receipts are
  not pruned today; this child does not change that.
- **Valid submission, failed record (#9)** — if a valid submission's Work Record failed for another reason, recovery
  reports `invalid_outcome`, the same as the live path.
