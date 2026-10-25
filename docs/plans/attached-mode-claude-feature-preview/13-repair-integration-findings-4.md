---
planId: "7f620908-2cec-4b11-ba21-1d89d2168b38"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/coordinator.ts"
    - "src/shared/attached/operations.ts"
    - "src/shared/attached/presentation.ts"
    - "src/attached/claude/mcp.ts"
    - "src/attached/claude/plugin/commands/plan-review.md"
    - "src/attached/claude/plugin/commands/request.md"
    - "src/shared/workflow/validation-host-turn.ts"
    - "src/shared/attached/action-content.test.ts"
    - "src/shared/attached/compatibility.test.ts"
    - "src/shared/attached/validation-settlement.test.ts"
    - "src/attached/claude/mcp.test.ts"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/user-documentation/connect-claude-code.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25T22:11:32.442Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 13
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
status: "implemented"
---

# Repair integration findings 4

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at
`fc1ad7ea6f2e9617bc1dc521aa80fb4dd67d281d` and reported 6 findings. The full report is
`docs/plans/attached-mode-claude-feature-preview/integration-report.md` in the primary checkout. After this child is
delivered, the integration gate runs again on the whole Epic.

Planning sorted the findings:

| Finding                                      | Decision              | Reason                                                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Project checks fail                       | **Dismissed**         | Environmental, as in children 10–12. The gate checkout `wld-epic-gate-0IhbJO` had no `node_modules` ("Cannot find package 'typescript'", "Cannot find module '@astrojs/check'", no `astro.mjs`) and no initialized `third_party/plannotator` submodule. |
| #2 No Planning Gate                          | **Dismissed**         | Owner decision (children 10–12): Connect adds no hooks or tool restrictions, as in Core. The Epic on this branch says "RunWield does not restrict Claude's tools during an Attached Workflow", and ADR-014 agrees. The gate reads main's old Epic copy. |
| #3 Two Attached workflows share one worktree | **Dismissed**         | Owner decision (child 10 #4, child 11 #3, child 12 #4): an Attached Workflow Record references its Plan and does not own it. The Epic puts single-Plan ownership out of scope. `execution-start.ts` reuses an active worktree the same way for Core.    |
| #4, #5, #6                                   | **Fix in this child** | Real defects, described below.                                                                                                                                                                                                                          |

> [!NOTE]
> **The gate can raise #1, #2, and #3 again**
>
> Until the separate gate fixes land (dependencies in the gate checkout, Epic read from the Epic branch), the next gate
> run can report these findings again. They are dismissed on purpose.

The fixes keep these requirements:

- [Connect: Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery):
  "Saved Plans, work, review outcomes, and recovery evidence must allow useful continuation or explicit retry after
  process loss." "Accepted sections and decisions are not repeated."
- [Connect: Compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability):
  "Core checks every evidence-carrying operation before dispatch." An incompatible adapter or a host below the tested
  floor rejects. "Status remains readable with a stale adapter for recovery."
- Epic Outcome Evidence, **Host waits survive Core exit**: duplicate and delayed outcomes cannot repeat effects.
- Epic: no transcript is imported. The explicit request is the only host text RunWield keeps.

## Objective

Fix findings #4, #5, and #6 on the Epic branch so that:

- **#4** A fresh Claude conversation that restores a pending Triage or Planner action receives the saved user request
  (and, for the Planner, the Triage outcome) from `get_instructions`.
- **#5** A host that preflight rejects cannot receive role instructions, artifacts, or chat turns for a saved action,
  and `status` does not continue validation for it. Status stays readable.
- **#6** When Core settled a repair completion that ended in a CI decision, but the final Attached write was lost,
  recovery shows the same saved CI decision. CI does not run again without an answer.

## Approach

Each fix goes through the module that already owns the behavior. No new workflow state, record field, or seam.

### #4 Saved request in planning recovery

Activation saves `request.text` in the Attached Workflow Record (`coordinator.ts` `activate`). Nothing returns it.
`get_instructions` returns `context: action`, which for `triage` and `plan` holds only `actionId`, `role`,
`contractVersion`, and `projectSetup`.

```diff
 readAttachedAction (coordinator.ts)
   readStatus -> current action
   ...
   withRoleInstructions(...)
   return { instructions,
-           context: action }
+           context: { ...action,
+                      requestText: record.request.text,        # triage and plan
+                      triageOutcome: record.triageOutcome }    # plan only
```

- The request is read from the Attached Workflow Record when `get_instructions` runs. It is not added to
  `AttachedWorkflowView`, `nextAction`, compact status, or saved operation receipts. Receipts store whole views, so a
  view field would copy the request into every receipt.
- `/runwield:plan-review` today restores a `plan` action only. It also restores a `triage` action: fetch instructions,
  use `context.requestText` as the user's request, call `triage_report`, then continue with the `/runwield:request`
  flow. Both commands tell the host to use `context.requestText` when the conversation does not have the request.

### #5 Compatibility on current-action reads and status

Today the MCP server adds host evidence to lifecycle operations only (`mcp.ts`, `argumentsWithEvidence`). The read
schemas reject `evidence`, and `runAttachedOperation` skips `assessCompatibility` for reads and status.

```diff
 runAttachedOperation (coordinator.ts)
   read operation (get_instructions | get_artifact | get_pending_chat)
+    parse required evidence
+    assessCompatibility -> unsupported_host | incompatible_adapter | unsupported_host_version
+      reject with that code; return no content
     readAttachedAction
   status
+    parse optional evidence
+    assessCompatibility when evidence is present
+    blocking status: return the read-only view with `compatibility`; do not run start_validation
+    otherwise: the `reviewed` continuation uses the supplied evidence, not the record's activation evidence
     readStatus
```

- `mcp.ts` adds the same evidence object to every operation, including `status` and the three reads.
- Status stays readable with a stale adapter, as the PRD requires. It reports `compatibility`, so the plugin's existing
  "On `incompatible_adapter` or `unsupported_host_version`, show Core's update message and stop" rule applies to the
  restore commands. `compactStatus` keeps the `compatibility` field.
- The read operations require evidence, because they hand host work out. Only Core's own MCP server and tests call
  them, so this is not a cross-version break.

> [!NOTE]
> **Assumption: status without evidence behaves as today**
>
> The acceptance script reads `wld attached status` without evidence. Without evidence, status keeps today's behavior,
> including the `reviewed` continuation with the saved activation evidence. Only a carrier that reports a rejected host
> is stopped. Every Claude path goes through the MCP server, which always sends evidence.

### #6 A lost final write keeps the saved CI decision

The failing path:

```text
task_completed (repair) -> Core records the completion, CI fails, retries exhausted
  checkpoint: lastSettledOperationId = repairGeneration, pendingCiDecision, pendingHostDecision
  final Attached write lost; the record still holds resume = task_completed
start_validation (recovery)
  reconcileConsumedHostResume -> drops the resume (lastSettledOperationId matches)   <- bug
  continueValidationAttempt: no hostResume, so the pending-decision guard (validation-supervisor.ts ~464) is skipped
  runMechanicalValidationPhase: no decision resume -> clears both pending fields -> runs CI again
```

The fix is one condition in `reconcileConsumedHostResume` (`validation-host-turn.ts`): a settled `task_completed`
resume is dropped only when the checkpoint holds no `pendingHostDecision`. When a decision is pending, the resume is
kept. `continueValidationAttempt` then reaches its existing guard and returns the saved `host_request` before the claim
or CI. The coordinator turns it into the same `validation` decision action.

> [!TIP]
> **Why not change the mechanical phase**
>
> Making `runMechanicalValidationPhase` replay a pending CI decision whenever no answer arrives would break the intended
> rule that a plain no-answer restart runs CI again (`validation-host-turn-decisions.test.ts`, "CI exhaustion without
> an answer reruns CI rather than replaying the old decision"). The bug is in recovery dropping a consumed outcome,
> not in that rule.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/attached/coordinator.ts` — `readAttachedAction` adds the saved request and Triage outcome to planning
  context (#4). `runAttachedOperation` assesses evidence for reads and status; `readStatus` uses current evidence for
  its `reviewed` continuation and skips it for a rejected host (#5).
- `src/shared/attached/operations.ts` — read schemas and `parseAttachedActionReadInput` require `evidence`; the
  `status` schema and `parseStatusInput` accept optional `evidence`; `AttachedActionReadEnvelope` and `StatusEnvelope`
  carry it (#5).
- `src/shared/attached/presentation.ts` — `compactStatus` keeps `compatibility` (#5).
- `src/attached/claude/mcp.ts` — sends host evidence for every operation (#5).
- `src/attached/claude/plugin/commands/plan-review.md`, `request.md` — restore a `triage` action and use
  `context.requestText` (#4).
- `src/shared/workflow/validation-host-turn.ts` — `reconcileConsumedHostResume` keeps a settled `task_completed`
  resume while a decision is pending (#6).
- Tests: `action-content.test.ts`, `compatibility.test.ts`, `validation-settlement.test.ts`, `mcp.test.ts` (and the
  read callers in `mcp-validation.test.ts`, `mcp-review-recovery.test.ts`, `src/cmd/attached/index.test.ts`, which
  must now send evidence).
- `docs/prd/runwield-connect-prd.md`, `docs/user-documentation/connect-claude-code.md` — recovery and compatibility
  text matches the delivered behavior.

No ADR changes: ADR-014 already requires host evidence in the operation envelope. No glossary change: no new terms.

## Reuse Opportunities

- `assessCompatibility` (`compatibility.ts`) and `parseHostEvidence` / `readEvidence` (`operations.ts`) — the same
  check lifecycle operations use.
- `loadAttachedWorkflowRecord` (`record-store.ts`) — read the saved request for `readAttachedAction`.
- The existing pending-decision guard in `continueValidationAttempt` (`validation-supervisor.ts`) — no new replay code.
- `attachedValidationFixture` (`validation-test-fixture.ts`) with `validationCiAttempts: 2`, and the lost-write pattern
  in the "two lost final writes preserve the original … receipt" loop in `validation-settlement.test.ts`.
- `spawnAttachedCli`, `activateInput`, `triageReportInput`, and `withProject` (`attached-test-fixture.ts`).

## Implementation Steps

- **#4** For a current `triage` action, `get_instructions` returns `context.requestText` equal to the `requestText`
  saved at activation. For a current `plan` action, `context` has `requestText` and `triageOutcome` equal to the saved
  record values. These values come from the Attached Workflow Record at read time.
- **#4** `AttachedWorkflowView`, compact status, and saved `acceptedOperations` receipts contain no `requestText` field
  that they did not contain before this change.
- **#4** `plan-review.md` restores a `triage` action: it fetches `get_instructions`, uses `context.requestText` as the
  user's request, calls `triage_report`, and continues with the `/runwield:request` flow. `request.md` and
  `plan-review.md` tell the host to use `context.requestText` and `context.triageOutcome` when the conversation does
  not contain the request.
- **#5** `get_instructions`, `get_artifact`, and `get_pending_chat` require an `evidence` object in their schema and
  parser. A missing or malformed `evidence` rejects with `invalid_input`.
- **#5** With `unsupported_host`, `incompatible_adapter`, or `unsupported_host_version` evidence, each read rejects
  with that code and returns no `instructions`, `context`, `artifact` content, `chat`, or decision `request`. The
  Attached record bytes do not change.
- **#5** `status` accepts optional `evidence`. With evidence, the result includes `compatibility`. With blocking
  evidence, status returns `ok: true` and the current view, and a `reviewed` workflow does not run `start_validation`
  (no CI run, no revision change). With non-blocking evidence, the `reviewed` continuation passes the supplied
  evidence to `runValidationOperation`. Without evidence, status behaves as today.
- **#5** `mcp.ts` sends `{ host, hostVersion, adapterVersion, adapterContract }` evidence with `status` and all three
  reads, as it does for lifecycle operations. `compactStatus` keeps `compatibility`.
- **#6** `reconcileConsumedHostResume` returns the `task_completed` resume unchanged when
  `checkpoint.lastSettledOperationId === resume.identity.repairGeneration` and `checkpoint.pendingHostDecision` is set.
  It still returns `undefined` for a settled completion with no pending decision.
- `docs/prd/runwield-connect-prd.md`: Lazy project setup and recovery has a scenario for restoring a pending Triage or
  Planner action with the saved request, and the Saved delivery recovery scenario says a saved CI decision is shown
  again without running CI. Compatibility and honest availability says current-action reads are evidence-carrying and
  reject like lifecycle operations, and status reports the assessment and does not continue validation for a rejected
  host.
- `docs/user-documentation/connect-claude-code.md`: the `/runwield:plan-review` row says it also restores pending
  Triage and planning. The version section says a rejected host gets no new worker instructions; status stays
  available.

## Verification Plan

- Automated:
  `bun scripts/run-tests.js src/shared/attached/action-content.test.ts src/shared/attached/compatibility.test.ts src/shared/attached/validation-settlement.test.ts src/shared/workflow/validation-host-turn-decisions.test.ts src/shared/workflow/validation-host-turn-repair.test.ts src/attached/claude/mcp.test.ts src/attached/claude/mcp-validation.test.ts src/attached/claude/mcp-review-recovery.test.ts src/cmd/attached/index.test.ts`
- **#4 regression** (`action-content.test.ts`): activate with `requestText: "Add a dark mode toggle"`. In a fresh
  process (`spawnAttachedCli`), `get_instructions` for the triage action returns that exact `context.requestText`.
  After `triage_report`, `get_instructions` for the plan action returns the same `requestText` and
  `triageOutcome.summary`. Compact status output does not contain the request text. This fails today because
  `context` has no `requestText`.
- **#5 regression** (`compatibility.test.ts`): for each refusal (non-Claude host, stale contract, below-floor
  version) and each read operation with a valid current `workflowId`/`actionId`, the result is not ok, the code
  matches, and no content is returned; record bytes are unchanged. For `status` with blocking evidence on a `reviewed`
  fixture, the result is ok with the blocking `compatibility`, `ciCount()` and the record revision are unchanged.
  These fail today because reads skip the assessment and status ignores evidence.
- **#5 MCP** (`mcp.test.ts`): an MCP client that reports a version below the tested floor gets a rejected
  `get_instructions` for a current action, and its `status` returns the `unsupported_host_version` compatibility
  notice. A client on the tested version gets instructions as before.
- **#6 regression** (`validation-settlement.test.ts`): `attachedValidationFixture({ attrs: { validationCiAttempts: 2 }
})`; `start_validation` returns a repair request (no `marker`, so CI fails); capture the durable claim made by
  `task_completed`; let Core settle into the CI decision; rewrite the record to the claim to lose the final write;
  recover with `start_validation`. The next action is the same decision identity, `ciCount()` is unchanged, and the Plan
  still has `pendingCiDecision` and `pendingHostDecision`. This fails today because CI runs again and both fields are
  cleared.
- Protected behavior, unchanged tests:
    - "CI exhaustion without an answer reruns CI rather than replaying the old decision"
      (`validation-host-turn-decisions.test.ts`) still passes without edits: a plain no-answer restart still runs CI.
    - The supervisor guard test in `validation-host-turn-repair.test.ts` and the existing lost-write loops in
      `validation-settlement.test.ts` still pass.
    - Lifecycle operations still reject blocking evidence (`compatibility.test.ts` refusal loop), and status stays
      readable after a refusal.
    - The malformed-envelope test in `action-content.test.ts` still rejects bad IDs, extra keys, and malformed
      evidence. Its `{ ...input, evidence: {} }` case stays invalid; a valid evidence object is now accepted.
- Expected to stop existing: read operations accepting a call without evidence. Update the CLI and MCP read callers in
  tests to send evidence; do not delete those tests.
- PRD check: the Connect PRD scenarios and the host guide describe the behavior above and claim nothing else.

## Edge Cases & Considerations

- **Saved request size** — the request is bounded by `MAX_REQUEST_TEXT_LENGTH` at activation. Reading it at
  `get_instructions` time adds no copies to receipts.
- **Privacy** — the request is the explicit user request, which Attached already stores. No conversation text is added.
- **Older plugin commands** — an older installed plugin ignores `context.requestText`; it still works in the original
  conversation. The MCP server ships with Core, so the evidence change needs no adapter contract bump.
- **Status wait loop** — `mcp.ts` polls `readStatus` directly after the first `status` call. The first call already
  carried and checked evidence, so the loop needs none.
- **Consumed Retry, then a lost write** — if the user answers Retry, CI fails again, and the final Attached write is
  lost, recovery runs CI once more and raises an equivalent decision. It never advances without an answer. This child
  leaves that extra CI run as is; the reported defect is the dropped pending decision.
- **Pending Code Review decision after a repair** — the kept resume returns the saved Code Review wait through the
  existing guard. A stale approval is still rejected, because the decision checks the diff hash and the next
  `start_validation` runs the pre-phase candidate check.
