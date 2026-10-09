---
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
    - "docs/domain-language.md"
    - "docs/plans/attached-mode-claude-feature-preview/manual-qa.md"
executionAgent: "engineer"
createdAt: "2026-10-07T03:22:47.915Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 6
dependencies:
    - "05a-run-workflow-validation-without-a-core-session"
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "31b97384-eb6c-4c98-8c54-578755ab80da"
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
- `src/shared/attached/role-instructions.ts` — reviewer and repair-engineer addenda.
- `src/attached/claude/plugin/commands/` — validation flow in `request.md` and `implement.md`, and a new `validate.md`
  (`/runwield:validate`) restore command.
- `docs/prd/runwield-connect-prd.md`, `docs/domain-language.md`, `manual-qa.md` — delivered validation subset, glossary
  term, and checklist.

## Reuse Opportunities

- The 05a host-turn entry point, `review-diff.ts`, and `review-outcome.ts` — all validation policy and contracts.
- Child 01 to 04 operation envelope, revision CAS, operation-ID replay, and `reconcilePlanPosition`.
- The `implementation-report.ts` completion contract for repair `task_completed` messages.
- Child 04's non-Git consent pattern for decision requests asked in plain text.

## Implementation Steps

1. From `implemented`, `start_validation` runs the 05a entry point. It saves the returned request as the pending action
   and moves the record to `validating`. If the result is `awaiting_delivery`, the record moves to `reviewed`. A second
   `start_validation` while `validating` is rejected, with guidance to use `status`.
2. `review_diff` accepts only the pending reviewer action ID. It returns pages from `review-diff.ts` and appends the
   read spans to the record. It never changes the round identity or the Plan.
3. `review_complete` accepts only the pending reviewer action, normalizes the payload through `review-outcome.ts`, and
   resumes the entry point with the recorded spans and correction count. A correction result returns a new reviewer
   action with the correction text. A stale round identity is rejected, and the record does not change.
4. `task_completed` accepts implementer actions as in child 04, and repair actions by resuming the entry point with the
   saved repair generation. Repeated operation IDs replay the saved result. A delayed completion for an older generation
   is rejected.
5. The decision operation accepts only the pending decision action, and only one of its offered options or a text
   answer. It resumes the entry point with that answer.
6. `status` on a `validating` record re-exposes the current request with fresh role instructions. On `reviewed`, it
   reports that code review and publication are the next Preview step and that the Plan is not Verified.
7. The plugin commands dispatch fresh reviewer and repair subagents, ask decisions in plain text, and submit outcomes
   only through the operations above. `/runwield:validate` restores a validating workflow.
8. The Connect PRD, glossary (suggested term: **Attached Validation Handoff**), and `manual-qa.md` describe the
   delivered behavior. Code review, publication, and other hosts stay target scope.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/attached/ src/attached/claude/` plus the 05a host-turn
  integration test.
- Automated, multi-process: drive a real fixture from `implemented` to `reviewed` through CLI subprocesses: CI repair,
  reviewer request, `review_diff` reads, feedback, repair `task_completed`, and verify-round approval. Fabricated
  `review_complete` without `review_diff` reads, stale actions, and replayed operation IDs must not advance the record
  or the Plan.
- Automated, CLI and MCP parity for the new operations. The import-isolation test covers the attached validation
  modules.
- Black-box on the supported Claude Code version: a real blocking Review Issue, a fresh repair subagent, and independent
  re-verification. Stop the MCP server mid-review, then restore with `/runwield:validate`.
- Protected: the child 01 to 04 Attached suites, and the Session validation suites listed in 05a.

## Edge Cases & Considerations

- A candidate edit between request and outcome changes the round identity, so the old outcome is rejected.
- Host cancellation, quota loss, or worker failure leaves the pending action in place. It is never treated as completion
  or abandonment.
- Local validation success is not publication. Only child 6 completes delivery.
- Recording and publication in child 06 reuse the same request/resume pattern.
