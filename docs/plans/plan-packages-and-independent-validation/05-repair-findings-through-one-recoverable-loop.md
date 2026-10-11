---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/review-ledger.ts"
    - "src/shared/workflow/validation-engine.ts"
    - "src/shared/workflow/validation-supervisor.ts"
    - "src/shared/workflow/validation-recovery.ts"
    - "src/shared/workflow/validation-repair-prompt.ts"
    - "src/shared/workflow/plan-lifecycle.js"
    - "src/shared/session/"
    - "src/agent-definitions/"
    - "src/tools/"
    - "docs/plan-lifecycle.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T17:14:00.111Z"
status: "draft"
origin: "internal"
parentPlan: "plan-packages-and-independent-validation"
order: 5
dependencies:
    - "04-run-independent-validation-and-advisory-human-qa"
targetBranch: "epic/plan-packages-and-independent-validation"
planId: "f7dd02c3-cbd1-40c8-80df-3fb9b6c22f7c"
---

# Repair Findings Through One Recoverable Loop

## Context

Independent validation can report trustworthy failure without yet providing the bounded automatic repair promised by the
parent Epic. Current validation and AI review paths have separate retry behavior, generic completion signals can blur
role ownership, and process recovery must not replay completed or interrupted Agent turns.

This child adds one controller-owned loop across Validator and AI review. It also adds the structured, user-approved
return to planning for a defective contract.

## Objective

Preserve finding identity through bounded repair and restart, allow at most three automatic full loops across both
stages, require fresh proof after every code change, and give the user explicit choices to continue, pause, accept, or
approve a Plan-defect return.

## Approach

Extend the existing review ledger with collision-safe stage and approved-check identity. Treat repair reports as claims,
not resolution. The responsible Validator or Reviewer confirms or rejects each claim on the next full proof pass. Store
one shared loop counter and next action in controller state.

```text
loop N
  Validator
  -> one validation repair turn if needed
  -> AI review
  -> one review repair turn if needed
  -> if code changed, consume one loop and return to Validator
```

After loop three, pause before any further automatic work. The option set aside is retaining separate retry budgets for
validation and AI review; that allows one attempt to multiply repair turns and token cost.

## Expected Change Surface

The boundaries below are guidance, not an allowlist: verify the real footprint during implementation and change whatever
the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved
intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk
grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/review-ledger.ts` — validation and AI review identity, claims, rejection, blocked state, and
  durable reporting.
- `src/shared/workflow/validation-engine.ts`, `validation-supervisor.ts`, and `validation-recovery.ts` — shared loop
  budget, phase transitions, pause, continuation, and reconciliation.
- `src/shared/workflow/validation-repair-prompt.ts` — bounded role-specific repair inputs and per-ID reports.
- `src/shared/workflow/plan-lifecycle.js` — controller detail and user-approved `defective` transition without extra
  board statuses.
- `src/shared/session/` — isolated repair segments under one Session and stale completion rejection.
- `src/agent-definitions/` and `src/tools/` — Validation Repair, Review Repair, and Plan-Revision Repair completion
  contracts.
- `docs/plan-lifecycle.md`, `docs/domain-language.md`, and `docs/prd/runwield-core-prd.md` — delivered repair, semantic
  review, recovery, and Plan-defect behavior.

## Reuse Opportunities

- `review-ledger.ts` existing stable IDs and claim/confirm/reject operations.
- Validation controller attempts, generations, checkpoints, and consume-once tool events.
- Existing validation-repair resume behavior that reruns checks instead of replaying a repair turn.
- Current isolated Session role segments and bounded request prompts.
- Existing owner interaction and pause/resume mechanisms.

## Implementation Steps

- Validation and AI review findings use one durable ledger with distinct originating stages, approved outcome or check
  references, evidence, and collision-safe stable IDs.
- Repair Engineer reports each supplied ID as fixed, already satisfied with evidence, or blocked with a reason and
  unblock condition; omitted and blocked IDs remain open.
- A repair report is a claim only: Validator confirms or rejects validation fixes, and Reviewer confirms or rejects AI
  review fixes; rejected claims retain their IDs.
- Each automatic loop permits one Validator run, at most one validation repair turn, one AI review run, and at most one
  review repair turn, with one shared durable loop counter.
- Any source repair from validation, AI review, Code Review chat, or publication conflict invalidates proof for the
  previous candidate and returns independent success to a complete Validator run plus applicable AI review.
- Three consumed automatic loops pause with open findings, partial repairs, unchecked changes, and explicit choices:
  authorize more budget, return to planning, remain paused, or accept the result.
- User pause or acceptance works before loop three; authorization adds an explicit new budget rather than hiding another
  automatic turn.
- Restart reconciles current package, controller state, candidate files, Git facts, and tool-event consumption before
  selecting the next phase; it never replays a completed or interrupted Agent turn.
- An Agent can propose a structured Plan defect with evidence, but only user approval sets `defective` and returns to
  Planner while preserving candidate and attempt history.
- Revised approved intent receives bounded Plan-Revision Repair where safe; rejection of the defect proposal leaves the
  package unchanged and presents repair, pause, or acceptance choices.
- Core execution, semantic review, and lifecycle requirements and scenarios match shared-budget repair, restart, user
  choice, and Plan-defect authority.
- The glossary defines Plan defect and the shared validation loop, with stable relationships to findings, repair claims,
  confirmation, and user acceptance.

## Verification Plan

- Automated: run focused repair and recovery tests through
  `deno run -A scripts/run-tests.js src/shared/workflow/validation-loop-repair.test.js src/shared/workflow/validation-repair-resume.integration.test.ts src/shared/workflow/validation-loop-recovery.test.ts src/shared/workflow/validation-self-healing.integration.test.ts src/shared/workflow/validation-repair-prompt.test.ts`.
- Automated: drive findings from both stages through restart and prove no more than three automatic full loops occur.
- Automated: prove blocked and omitted per-ID reports keep findings open, rejected fixes retain IDs, and same-looking
  IDs from different stages cannot collide.
- Automated: prove a last repair at budget exhaustion remains visibly unvalidated and no final verification runs without
  user authorization.
- Automated: prove all code-repair sources invalidate prior evidence and direct acceptance settles the attempt against
  delayed completions.
- Automated: prove Agent defect proposals do not change lifecycle until user approval, and revised packages require
  review before revision repair.
- Automated: run `deno task seams:check` and `deno task ci`.
- Manual: exercise validation repair, AI review repair, process loss, budget exhaustion, continuation, rejection of a
  fix claim, and both acceptance and return-to-planning choices.
- Documentation: confirm the Core PRD, lifecycle guide, and glossary describe the implemented shared loop and do not
  restore separate retry budgets.

## Edge Cases

- Operational inability to run a check is advisory QA, not an implementation finding to repair.
- A blocked repair for a known defect stays open and can pause the flow.
- Package changes require renewed approval and cannot be repaired as if only code changed.
- Delayed Agent completion after pause, acceptance, or a new generation must be consumed safely without advancing state.
- Loop count bounds automatic repetition, not exact tokens used inside one Agent turn.
