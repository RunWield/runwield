---
planId: "bcbc44f4-cbec-4b05-990c-a2631b0f3b5a"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/validation-engine.ts"
    - "src/shared/workflow/validation-human-review.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/workflow/publication-attempt.ts"
    - "src/shared/work-records/generation.js"
    - "src/ui/review/review-launcher.ts"
    - "src/shared/attached/operations.ts"
    - "src/shared/attached/coordinator.ts"
    - "src/shared/attached/record-store.ts"
    - "src/shared/attached/review-host.ts"
    - "src/shared/attached/role-instructions.ts"
    - "src/attached/claude/mcp.ts"
    - "src/attached/claude/plugin/commands/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-connect-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/code-review"
devServerHmr: true
createdAt: "2026-10-07T03:22:48.414Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 7
dependencies:
    - "05-validate-with-claude-owned-review-and-repair-workers"
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
status: "in_progress"
---

# Publish validated work and record the outcome

## Context

Child 05 stops the Attached workflow after Semantic Review. `validation-engine.ts` returns `awaiting_delivery` for host
turns, and the Attached record stops in the `reviewed` state. This child takes the workflow from there to confirmed
publication, a Work Record, and closure.

The shared engine runs delivery in this order:

```text
runValidatedReviewerPhase
  runHumanReviewPhase            ← code review page, then feedback repair
  runPublicationPhase
    publishOnce
      seal candidate
      stage lifecycle
      runPostVerificationHandoffs ← Recorder model turn + Manual QA model turn
      seal artifacts → Git publication → cleanup + Mnemoteca index sync
```

Four points in this path start a Core model turn or need a live in-process wait. Attached mode must not use them:

| Point                | Core today                                                  | Attached after this child                                          |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Code review          | Live browser wait in one process                            | Saved wait bound to the diff hash, page hosted by the MCP server   |
| Code review feedback | `runIsolatedAgentSession` repair turn                       | `human_feedback` repair action for a Claude subagent               |
| Work Record sections | `generateRecorderSections` starts a hidden Recorder session | `recorder` pending action for a Claude subagent                    |
| Manual QA checklist  | Hidden Operator turn, display only                          | Not run by Core; the plugin command tells Claude to suggest checks |

The only memory effect in this path is the Mnemoteca index sync of the Work Record during publication cleanup. It runs
the local `mnemoteca` command (`src/shared/work-records/mnemoteca-port.ts`), calls no chat model, and stays in Core.

Owning PRD capabilities:

- Core [execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) and
  [Work Records](../../prd/runwield-core-prd.md#work-records) — publication, Verified meaning, recording failure does
  not block publication.
- Connect [artifact privacy and records](../../prd/runwield-connect-prd.md#artifact-privacy-and-records) — no raw host
  transcript in RunWield storage. Connect also requires that feedback and approval return as structured workflow
  outcomes, not chat prose.
- [ADR-016](../../adr/016-proof-bearing-publication-state-machine.md) — publication evidence and the state machine.

### Planning Decisions (2026-10-13)

- **Publication continues automatically, like Core.** `start_validation` continues past Semantic Review into code review
  and publication. The project's `codeReview` mode (`none`, `ask`, `always`) decides if the user sees the review page.
  `reviewed` stays only as a resume point for records that child 05 already saved.
- **Every model call runs inside Claude Code.** Attached mode assumes no RunWield presets and no other models. Core
  starts no `HostedSession` in this path. The Recorder and code review feedback repair run as Claude subagents.
- **Manual QA leaves Core in Attached.** Core does not start the Operator turn. After delivery, the plugin command tells
  Claude to suggest manual checks from the Plan.
- **Review chat moves to child 07.** Chat on the Plan review and code review pages, answered by the coordinating Claude
  session, is planned in `07-answer-review-chat-from-the-claude-session.md`.

### Epic Scope Changes

- Review chat on both pages moved out of this child into the new child 07
  (`07-answer-review-chat-from-the-claude-session.md`).
- The former child 07 is now child 08 (`08-prove-and-document-the-supported-claude-preview.md`). Its order and
  dependency now follow child 07, and its integrated journey exercises chat.

## Objective

After this child, an installed Claude Code user can take one FEATURE from validation to confirmed publication without
leaving Claude Code and without any RunWield model preset:

- configured code review on the real `/review/code` page, approval bound to the current diff;
- code review feedback repaired by a Claude subagent and re-verified;
- a Work Record written from sections a Claude subagent submits, then indexed;
- publication with the same Verified meaning as Core, recovery after interruption, and closure.

Child 08 still owns integrated release evidence and the final Preview support claims.

## Approach

### Delivery continues through the shared engine

Remove the host-turn stop in `validation-engine.ts`. The engine runs `runHumanReviewPhase` and `runPublicationPhase` for
host turns. Where those phases would start a Core model turn or block on a browser, they return a host action through
the child 05 host-turn port instead. The Attached coordinator saves the action, `status` returns it, and Claude
completes it.

```diff
 runValidatedReviewerPhase
-  if host turn → return awaiting_delivery
   runHumanReviewPhase
+    host turn: save code review wait → nextAction code_review
+    feedback: requestHostRepair(human_feedback) → re-verify
   runPublicationPhase
     publishOnce
-      runPostVerificationHandoffs (Recorder + Manual QA turns)
+      host turn: Recorder → nextAction recorder; Manual QA skipped
       seal artifacts → Git publication → cleanup + index sync
+  host turn: close record with reason delivered
```

Do not copy the publication state machine into Attached. Publication attempts, sealing, and recovery stay in
`publishOnce` and `publication-attempt.ts`.

### Code review is a saved wait

The code review identity already hashes the diff. The Attached record saves the pending review with that identity. The
MCP server hosts the existing `/review/code` page through `startCodeReviewSurface`, the same way `review-host.ts` hosts
Plan review through `startPlanReviewSurface`. Claude polls `status` while the page is open, as it does for Plan review.

An approval applies only when its diff hash equals the current candidate's hash. Feedback becomes a `human_feedback`
repair action. After repair, the usual re-verification runs and a new review round opens on the new diff.

### The Recorder is a Claude subagent

`publishOnce` prepares the Work Record before sealing artifacts. For host turns, it returns a `recorder` action. The
action carries the Recorder role instructions from `role-instructions.ts` and canonical references: Plan, diff,
evidence. A Claude subagent produces the sections and submits them through `work_record_completed`, the existing Core
tool name. Core validates, persists, deduplicates, and indexes them through `src/shared/work-records/`. Publication then
continues.

Option set aside: let the coordinating Claude session write the sections itself. A subagent keeps the Recorder role
prompt separate from the coordinator's conversation and keeps private conversation content out of the record.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/validation-engine.ts` — remove the host-turn stop before delivery.
- `src/shared/workflow/validation-human-review.ts` — host-turn branch: save the code review wait and route feedback to
  `requestHostRepair`.
- `src/shared/workflow/validation-publication.ts`, `publication-attempt.ts` — host-turn Recorder action, Manual QA skip,
  resume from a saved Recorder submission.
- `src/shared/work-records/generation.js` — accept submitted sections without starting a Recorder session; keep
  validation and persistence shared.
- `src/ui/review/review-launcher.ts` — start the code review surface for an Attached host without a live in-process
  decision wait. The page UI should not change.
- `src/shared/attached/operations.ts`, `coordinator.ts`, `record-store.ts` — new next actions (`code_review`,
  `recorder`), the new `work_record_completed` operation, the saved code review wait, and the `delivered` closure
  reason.
- `src/shared/attached/review-host.ts` — host the code review page.
- `src/shared/attached/role-instructions.ts` — Recorder and code review repair instructions.
- `src/attached/claude/mcp.ts`, `src/attached/claude/plugin/commands/` — MCP tools and command text for code review,
  Recorder dispatch, and the post-delivery manual check suggestion.
- `docs/prd/runwield-connect-prd.md`, `docs/prd/runwield-core-prd.md` — owning scenarios for Attached delivery and
  recording.

Left out on purpose: review chat (child 07), and Workspace Plan and Session pages outside the review surfaces.

## Reuse Opportunities

- `runValidatedReviewerPhase`, `runHumanReviewPhase`, `publishOnce`, `publication-attempt.ts` — the one delivery
  sequence and its recovery.
- Child 05 host-turn port (`validation-host-turn.ts`) and `requestHostRepair` — saved host actions and repair.
- Child 03 `review-host.ts` and saved review rounds — page hosting and decision recovery.
- `src/shared/work-records/` validation, persistence, deduplication, and `mnemoteca-port.ts` index sync.

## Implementation Steps

1. For an Attached workflow, `start_validation` continues past Semantic Review into code review and publication. No
   host-turn path returns `awaiting_delivery`. A record saved by child 05 in `reviewed` resumes into delivery on the
   next `status` or `start_validation` call.
2. With `codeReview` set to `always`, or `ask` and the user accepts, `status` returns `code_review` and the MCP server
   hosts `/review/code` for the current candidate. The pending review is saved on the Attached record with the diff-hash
   identity. With `none`, no page opens and delivery continues.
3. An approval whose diff hash differs from the current candidate is rejected. Feedback produces a `human_feedback`
   repair action for a Claude subagent, then re-verification, then a new code review round. Core starts no
   `runIsolatedAgentSession` and no `HostedSession` in this path.
4. During `publishOnce`, an Attached workflow returns a `recorder` action that carries the Recorder instructions and
   canonical references. `work_record_completed` sections pass the same validation as Core sections. Valid sections are
   persisted, deduplicated, and indexed through the existing Work Record code. Core starts no Recorder session.
5. An invalid Recorder submission is rejected with the validation errors and gets one retry. After a second invalid
   submission, Core records the Work Record failure and publication continues, as the Core PRD requires.
6. Core starts no Operator turn for an Attached workflow. After delivery, the plugin command tells Claude to suggest
   manual checks from the Plan. Nothing about those checks is saved.
7. Supersession proposals resolve as "decide later" during Attached publication, and the delivery result names
   `wld wr supersede`.
8. Externally visible Verified and successful closure require proven publication. Local validation, staging, Claude's
   text, or a successful subprocess alone cannot claim delivery. After proven publication, the record closes with the
   new `delivered` closure reason, and active host restrictions are removed. The Plan, Work Record, worktree, and
   recovery evidence stay.
9. A fresh Core process resumes each saved point without repeating accepted work: pending code review, pending Recorder
   action, accepted Recorder sections, artifact sealing, publication attempt, and cleanup. Failed publication, retry
   limits, cancellation, and quota exhaustion leave a resumable state. Closing Claude never abandons the workflow.
10. `docs/prd/runwield-connect-prd.md` and `docs/prd/runwield-core-prd.md` describe Attached delivery, the Claude-run
    Recorder, and the Manual QA difference, with acceptance scenarios. The complete Preview release stays labeled as
    target until child 08.

## Verification Plan

- Automated: run
  `bun scripts/run-tests.js src/shared/attached/ src/attached/claude/ src/shared/workflow/validation-publication.test.ts src/shared/workflow/publication-machine.e2e.test.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-revalidation.test.ts src/shared/workflow/validation-work-record-handoff.test.ts src/ui/review/code-review.test.ts src/ui/workspace/workspace-code-review.integration.test.ts`.
- New Attached tests through the real coordinator and record store (fake only the Claude turn boundary):
  - Delivery: a FEATURE goes from `start_validation` to `delivered` closure with a merged commit in the fixture repo.
    This test fails if `awaiting_delivery` is still returned.
  - No Core model turns: instrument `HostedSession` and `runIsolatedAgentSession` creation; the count is zero for the
    whole Attached delivery.
  - Stale approval: change the worktree after the page opens; the approval is rejected.
  - Recorder: valid sections produce a Work Record equal in shape to a Core record; two invalid submissions produce a
    recorded failure and publication still completes.
- Recovery: kill Core before and after each saved point in step 9. Resume in a fresh process and compare publication
  evidence, Plan lifecycle, Work Record identity, and index state. Accepted work is not repeated.
- Headed browser: with the MCP-hosted code review page, submit feedback, see the refreshed diff, approve, and restore a
  pending review after Claude restarts. Confirm the pages stop with Claude. `deno task workspace:dev` at
  `http://127.0.0.1:5173/dev/code-review` is a fixture, not recovery proof.
- Black-box: seed private sentinel text in the Claude conversation before invoking RunWield, and complete delivery. The
  sentinel must not appear in the Work Record, the memory index, telemetry, or publication evidence.
- Protected Core behavior: Core still runs the Recorder and Manual QA turns. Existing publication, code review, Work
  Record, and memory tests keep passing without being rewritten.
- PRD check: the Connect and Core scenarios match delivered behavior, and the full Preview stays labeled as target.

## Edge Cases & Considerations

- Recording can change publication artifacts after validation. Keep the existing sealing and revalidation rules; do not
  treat every artifact change as new implementation.
- Merge conflicts, target branch movement, or uncertain publication go through evidence reconciliation and supported
  continuation, not a destructive reset.
- Cleanup failure keeps recoverable files and truthful delivery evidence.
- Assumption: Epic-child Manual QA artifacts stay unsupported in Attached. The Preview runs one FEATURE.
