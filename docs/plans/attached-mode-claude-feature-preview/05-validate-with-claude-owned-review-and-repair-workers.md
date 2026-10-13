---
planId: "31b97384-eb6c-4c98-8c54-578755ab80da"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/"
    - "src/cmd/attached/"
    - "src/attached/claude/"
    - "src/shared/attached/role-instructions.ts"
    - "src/attached/claude/plugin/commands/"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/plans/attached-mode-claude-feature-preview/manual-qa.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-07T03:22:47.915Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 6
dependencies:
    - "05a-run-workflow-validation-without-a-core-session"
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
validatedCommit: "e04fdfeeebe18360dd2a271b994f9fa9246ccabb"
status: "verified"
---

# Validate with Claude-owned review and repair workers

## Context

Child 04 leaves an Attached Workflow at `implemented`. Child 05a supplies a Session-free validation entry point
(`continueHostTurnValidation` or its final name). It runs the shared supervisor and engine and returns typed reviewer,
repair, and decision requests. A fresh process resumes it from the Validation Checkpoint and an accepted outcome, and it
stops at `reviewed` with `awaiting_delivery`.

This child connects that entry point to Claude. It covers the Attached record, coordinator operations, the MCP
`review_diff` operation, the plugin commands, and the Connect documentation. It owns no validation policy.

Owning capabilities:

- [Connect: Shared Plan and verification outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes)
  — validation continuation becomes delivered for the Preview subset. Code review and publication remain targets.
- [Connect: Host-owned reasoning](../../prd/runwield-connect-prd.md#host-owned-reasoning) — independent reviewer and
  repair workers are fresh Claude subagents.
- [Connect: Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery) — host
  or Core loss during validation.
- Core [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) and
  [Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair) stay authoritative and
  unchanged.

Decisions already made (child 05/05a planning session):

1. **The reviewer worker calls RunWield MCP `review_diff` directly.** Core records each read against the pending
   reviewer action, so diff coverage is Core-observed. The coordinating conversation submits `review_complete`, and Core
   supplies the recorded coverage to the engine. A coverage claim in the payload is ignored.
2. **`task_completed` is generalized.** It accepts any pending completion-gated action: implementer or validation repair
   engineer. The payload stays `{ actionId, message }`, as in Core, where `task_completed` covers every workflow
   transition except `triage_report` and `plan_written`.
3. **Reuse Core tool names.** `review_complete` uses the Core tool's payload field names (`approved`, `feedback`,
   `findings`, `advisories`, `integrationNotes`). New names are only for operations with no Core counterpart.
4. **Long CI runs keep one MCP call open.** `start_validation` and repair `task_completed` run the configured CI inside
   one MCP call. Claude Code cancels an MCP call that is silent for 300 seconds. The MCP carrier sends a progress
   notification about every 30 seconds while the 05a entry point runs, and the plugin `.mcp.json` sets a generous
   per-server `timeout` as a backup. A detached background run with `status` polling was considered and set aside: it
   needs a claim that outlives the MCP server and a check-back loop, and nothing shows CI runs longer than Claude Code's
   turn limits.
5. **Paused and failed results are recoverable.** A `paused` or `failed` result from the 05a entry point keeps the
   record in `validating`. It is never terminal.
6. **No new glossary term.** The saved reviewer, repair, or decision step is "the pending action during validation".
   **Attached Validation Handoff** was considered and dropped, to avoid a second name for the record's pending action.

## Objective

After implementation, Claude starts validation automatically. Core runs Mechanical Validation and the configured CI.
Fresh Claude subagents perform independent Semantic Review and bounded repairs, and Core re-verifies each repair. Each
wait is saved before Core exits, and a fresh Claude conversation can restore it. The workflow reaches `reviewed` and
reports optional code review and publication as the next Preview step (child 06). It never reports Verified.

## Approach

```text
implemented ──start_validation──► validating ── host request? ──► pending action saved ──► Claude acts
                                     ▲                                                      │
                                     └──── review_complete / task_completed / decision ◄────┘
validating ── awaiting_delivery ──► reviewed  (next: child 06)
```

- **The record.** New states `validating` and `reviewed`. A `validation` field holds the current host request: its kind,
  action ID, round identity, correction count, the repair generation for repairs, and the recorded `review_diff` spans.
  It references the Plan checkpoint and never copies it.
- **Operations.**
  - `start_validation` is new and starts from `implemented`.
  - `review_diff` is new and read-only. It records coverage spans against the reviewer action.
  - `review_complete` uses the Core tool name.
  - `task_completed` is generalized to repair actions.
  - One new decision operation carries a user's answer to a decision request. Its name is the Engineer's choice and has
    no Core counterpart.

  Each mutating operation runs the 05a entry point and saves the next pending action with revision CAS.
- **Locking.** The engine call runs outside the record transaction, because CI can take minutes. `claimValidation`
  guards the validation attempt. The record write that follows checks the expected revision and reconciles if the record
  moved.
- **Keeping the call alive.** The MCP tool handler in `src/attached/claude/mcp.ts` starts a progress timer before it
  calls a long operation and stops it when the operation settles:

  ```text
  on(tools/call start_validation | task_completed)
    if the request carries a progressToken
      every ~30s: send notifications/progress ("Validation is running")
    run the operation
    stop the timer, return the result
  ```

  If Claude still cuts the call off, RunWield keeps running and saves the result. `status` and `/runwield:validate`
  return it.
- **Plan position.** While validation runs, Core moves the Plan to `validationPhase: semantic` and then to status
  `reviewed`. Today `reconcilePlanPosition` (`src/shared/attached/coordinator.ts`) reads both as "the Plan advanced in
  Core" and closes the workflow with `plan_advanced_in_core`. In the `validating` record state both are expected. In the
  `reviewed` record state, Plan status `reviewed` is expected.
- **Reviewer and repair instructions.** `AttachedHostRole` has only `router`, `planner`, `engineer`, and
  `frontend-engineer`. The reviewer prompt (`reviewer-prompt.md`, `reviewer-verify-prompt.md`) is a subagent prompt that
  `loadAgentDef` cannot load. So the reviewer worker receives the prompt text from the 05a reviewer request plus an
  Attached addendum. The repair worker uses `reviewer-feedback-engineer.md` plus an Attached addendum.
- **Workers.** The plugin dispatches a fresh reviewer subagent with the role instructions, `workflowId`, `actionId`, and
  the execution directory. It tells the subagent to read the diff only through `review_diff`, then return findings. A
  repair subagent receives the repair prompt and works only in the execution directory. Decisions are asked in plain
  text, like non-Git consent in child 04.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/attached/operations.ts`, `record-store.ts` — states, record `validation` field, operation descriptors, and
  strict payload parsers. Old records load with `validation: null`.
- `src/shared/attached/coordinator.ts` — the new operations, generalized `task_completed`, `nextActionFor` and
  `reconcilePlanPosition` for `validating` and `reviewed`.
- `src/shared/attached/role-instructions.ts` — reviewer and repair-engineer addenda. The reviewer instructions wrap the
  prompt text from the 05a request, not a loaded agent definition.
- `src/attached/claude/mcp.ts` — progress notifications during long operations.
- `src/attached/claude/plugin/.mcp.json` — per-server `timeout` for the `runwield` server.
- `src/attached/claude/plugin/commands/` — validation flow in `request.md` and `implement.md`, and a new `validate.md`
  (`/runwield:validate`) restore command.
- `docs/prd/runwield-connect-prd.md`, `manual-qa.md` — delivered validation subset and checklist.
- `docs/domain-language.md` is deliberately not changed. The change adds no new term: the PRD calls the saved validation
  step "the pending action during validation", the record's existing word.

## Reuse Opportunities

- The 05a host-turn entry point, `review-diff.ts`, and `review-outcome.ts` — all validation policy and contracts.
- Child 01 to 04 operation envelope, revision CAS, operation-ID replay, and `reconcilePlanPosition`.
- The `implementation-report.ts` completion contract for repair `task_completed` messages.
- Child 04's non-Git consent pattern for decision requests asked in plain text.

## Implementation Steps

1. From `implemented`, `start_validation` runs the 05a entry point. It saves the returned request as the pending action
   and moves the record to `validating`. If the result is `awaiting_delivery`, the record moves to `reviewed`.
   `start_validation` on a `validating` record does one of two things:
   - If a pending action is saved, it returns that action and does not run the engine.
   - If no pending action is saved (a lost record write, or a saved `paused` or `failed` result), it re-enters the 05a
     entry point from the Validation Checkpoint.
2. A `paused` or `failed` result keeps the record in `validating` with no pending action. The record stores the result
   kind, reason, and recovery message. `status` shows them and tells the host to call `start_validation` again.
3. `reconcilePlanPosition` accepts Plan `validationPhase: semantic` and Plan status `reviewed` while the record is
   `validating`, and Plan status `reviewed` while the record is `reviewed`. Neither closes the workflow with
   `plan_advanced_in_core`. Other Plan movements keep their current handling.
4. `review_diff` accepts only the pending reviewer action ID. It returns pages from `review-diff.ts` and appends the
   read spans to the record. It never changes the round identity or the Plan.
5. `review_complete` accepts only the pending reviewer action, normalizes the payload through `review-outcome.ts`, and
   resumes the entry point with the recorded spans and correction count. A correction result returns a new reviewer
   action with the correction text. A stale round identity is rejected, and the record does not change.
6. `task_completed` accepts implementer actions as in child 04, and repair actions by resuming the entry point with the
   saved repair generation. Repeated operation IDs replay the saved result. A delayed completion for an older generation
   is rejected.
7. The decision operation accepts only the pending decision action, and only one of its offered options or a text
   answer. It resumes the entry point with that answer.
8. `status` on a `validating` record re-exposes the current request with fresh role instructions, or the saved
   `paused`/`failed` reason and recovery message. On `reviewed`, it reports that code review and publication are the
   next Preview step and that the Plan is not Verified.
9. `role-instructions.ts` exposes reviewer instructions built from the 05a request prompt plus an Attached addendum
   (read the diff only through `review_diff`, return findings, do not edit), and repair instructions built from
   `reviewer-feedback-engineer.md` plus an Attached addendum (work only in the execution directory, finish with
   `task_completed`).
10. While `start_validation` or `task_completed` runs and the MCP request carries a `progressToken`, the MCP carrier
    sends `notifications/progress` about every 30 seconds and stops when the operation settles. The plugin `.mcp.json`
    sets a per-server `timeout` for the `runwield` server that covers a long CI run.
11. The plugin commands dispatch fresh reviewer and repair subagents, ask decisions in plain text, and submit outcomes
    only through the operations above. `/runwield:validate` restores a validating workflow, including one whose last MCP
    call was cut off.
12. The Connect PRD and `manual-qa.md` describe the delivered behavior, using existing terms ("pending action" for the
    saved reviewer, repair, or decision step). Code review, publication, and other hosts stay target scope.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/attached/ src/attached/claude/` plus the 05a host-turn
  integration test.
- Automated, multi-process: drive a real fixture from `implemented` to `reviewed` through CLI subprocesses: CI repair,
  reviewer request, `review_diff` reads, feedback, repair `task_completed`, and verify-round approval. Fabricated
  `review_complete` without `review_diff` reads, stale actions, and replayed operation IDs must not advance the record
  or the Plan.
- Automated, recovery: on a `validating` record with a saved pending action, a second `start_validation` returns that
  action and runs no CI. With the pending action removed (simulating a lost write), it re-enters from the Validation
  Checkpoint and saves the next request. A fixture whose CI fails with a `paused` result leaves the record `validating`;
  `status` reports the reason, and a later `start_validation` resumes.
- Automated, Plan position: a record driven through validation is never closed with `plan_advanced_in_core`, while a
  Plan moved by Core outside validation still is.
- Automated, keep-alive: through `src/shared/mcp/fixture-server.ts` or a direct MCP client, a `start_validation` call
  with a `progressToken` against a slow CI command (for example `sleep 70 && true`) receives at least two
  `notifications/progress` messages before the result. A call without a `progressToken` receives none. This test fails
  if the timer is a stub.
- Automated, CLI and MCP parity for the new operations. The import-isolation test covers the attached validation
  modules.
- Black-box on the supported Claude Code version: a real blocking Review Issue, a fresh repair subagent, and independent
  re-verification. Stop the MCP server mid-review, then restore with `/runwield:validate`. Run a CI command longer than
  five minutes and confirm Claude waits on the call and continues without a retry.
- Protected: the child 01 to 04 Attached suites, and the Session validation suites listed in 05a.

## Edge Cases & Considerations

- A candidate edit between request and outcome changes the round identity, so the old outcome is rejected.
- Host cancellation, quota loss, or worker failure leaves the pending action in place. It is never treated as completion
  or abandonment.
- Claude can still cut off a long call (an old client, or a client that sends no `progressToken`). Core finishes and
  saves the result anyway; the cut-off is client-side only. The next `status` or `start_validation` returns the saved
  request, so a retried call does not run CI twice.
- The process can die after the engine finishes and before the record write. The next `start_validation` finds no
  pending action and re-enters from the Validation Checkpoint, which 05a makes safe to repeat.
- Local validation success is not publication. Only child 6 completes delivery.
- Recording and publication in child 06 reuse the same request/resume pattern.
