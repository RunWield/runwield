---
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
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/routes/api/review-handlers.js"
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
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/code-review"
devServerHmr: true
createdAt: "2026-10-07T03:22:48.414Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 6
dependencies:
    - "05-validate-with-claude-owned-review-and-repair-workers"
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "bcbc44f4-cbec-4b05-990c-a2631b0f3b5a"
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

- **Publication continues automatically, like Core.** `start_validation` continues past Semantic Review into code
  review and publication. The project's `codeReview` mode (`none`, `ask`, `always`) decides if the user sees the review
  page. `reviewed` stays only as a resume point for records that child 05 already saved.
- **Every model call runs inside Claude Code.** Attached mode assumes no RunWield presets and no other models. Core
  starts no `HostedSession` in this path. The Recorder and code review feedback repair run as Claude subagents.
- **Manual QA leaves Core in Attached.** Core does not start the Operator turn. After delivery, the plugin command tells
  Claude to suggest manual checks from the Plan.
- **Review chat is answered by the coordinating Claude session ("Ask this session").** This follows Plannotator's model
  and differs on purpose from Core, where each chat message is a Reviewer Feedback Engineer repair round. Claude
  answers a question directly. It dispatches a repair subagent only when the message asks for a change.
- **Plan review chat is also in this child.** The Plan review page and the code review page use the same chat channel
  in Attached.

### Epic Scope Changes

- Child 03 (Plan review) is delivered and stays unchanged. This child adds chat to the Attached Plan review page.
- Child 07 (`07-prove-and-document-the-supported-claude-preview.md`, draft) is not edited. Its headed-browser journey
  already covers the review pages; it must now also exercise chat. Its own Planner session picks this up.

## Objective

After this child, an installed Claude Code user can take one FEATURE from validation to confirmed publication without
leaving Claude Code and without any RunWield model preset:

- configured code review on the real `/review/code` page, approval bound to the current diff;
- chat on the Plan review and code review pages, answered by the Claude session that runs the workflow;
- code review feedback repaired by a Claude subagent and re-verified;
- a Work Record written from sections a Claude subagent submits, then indexed;
- publication with the same Verified meaning as Core, recovery after interruption, and closure.

Child 07 still owns integrated release evidence and the final Preview support claims.

## Approach

### Delivery continues through the shared engine

Remove the host-turn stop in `validation-engine.ts`. The engine runs `runHumanReviewPhase` and `runPublicationPhase`
for host turns. Where those phases would start a Core model turn or block on a browser, they return a host action
through the child 05 host-turn port instead. The Attached coordinator saves the action, `status` returns it, and Claude
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
MCP server hosts the existing `/review/code` page through `startCodeReviewSurface`, the same way `review-host.ts`
hosts Plan review through `startPlanReviewSurface`. Claude polls `status` while the page is open, as it does for Plan
review.

An approval applies only when its diff hash equals the current candidate's hash. Feedback becomes a `human_feedback`
repair action. After repair, the usual re-verification runs and a new review round opens on the new diff.

### Review chat reuses the page's existing channel

Core's review pages already have chat. The page sends a decision with `conversationTurn: true` and reads replies from
`GET /api/review/conversation` (`ReviewConversation` in `review-launcher.ts`). `beginReviewRound` keeps the page open
across rounds. Attached keeps the page code and changes who produces the reply:

```text
user sends a chat message on /review/plan or /review/code
  → Core saves the turn on the open review round (survives a restart)
  → status returns nextAction review_chat { round, message, selected lines }
  → Claude answers in its own conversation context
       question → answers directly
       change   → plan: revises the Plan and calls plan_written
                  code: dispatches a human_feedback repair subagent
  → MCP review_reply { round, text } → Core appends the reply to the conversation
  → the page shows the reply and stays open; a changed Plan or diff starts a new round
```

> [!NOTE]
> **Chat never approves or rejects**
>
> Approval and feedback still come only from the page's structured decisions. A chat reply cannot close a round. A
> reply that changed code invalidates an earlier approval through the diff hash.

### The Recorder is a Claude subagent

`publishOnce` prepares the Work Record before sealing artifacts. For host turns, it returns a `recorder` action. The
action carries the Recorder role instructions from `role-instructions.ts` and canonical references: Plan, diff,
evidence. A Claude subagent produces the sections and submits them through `work_record_completed`, the existing Core
tool name. Core validates, persists, deduplicates, and indexes them through `src/shared/work-records/`. Publication then
continues.

Option set aside: let the coordinating Claude session write the sections itself. A subagent keeps the Recorder role
prompt separate from the coordinator's conversation and keeps private chat content out of the record.

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
- `src/ui/review/review-launcher.ts`, `src/ui/workspace/server.js`, `routes/api/review-handlers.js` — let a review
  host supply chat turns and replies from a saved source instead of a live Core turn. The page UI should not change;
  if it must, use `docs/design-system.md` and the current review components.
- `src/shared/attached/operations.ts`, `coordinator.ts`, `record-store.ts` — new next actions (`code_review`,
  `review_chat`, `recorder`), new operations (`review_reply`, `work_record_completed`), saved chat turns, the
  `delivered` closure reason.
- `src/shared/attached/review-host.ts` — host the code review page and wire chat for both pages.
- `src/shared/attached/role-instructions.ts` — Recorder and code review repair instructions.
- `src/attached/claude/mcp.ts`, `src/attached/claude/plugin/commands/` — MCP tools and command text for code review,
  chat, Recorder dispatch, and the post-delivery manual check suggestion.
- `docs/prd/runwield-connect-prd.md`, `docs/prd/runwield-core-prd.md` — owning scenarios for Attached delivery, chat,
  and recording.

Left out on purpose: Workspace Plan and Session pages outside the review surfaces, and the Core review chat behavior.
Core keeps its Reviewer Feedback Engineer chat.

## Reuse Opportunities

- `runValidatedReviewerPhase`, `runHumanReviewPhase`, `publishOnce`, `publication-attempt.ts` — the one delivery
  sequence and its recovery.
- Child 05 host-turn port (`validation-host-turn.ts`) and `requestHostRepair` — saved host actions and repair.
- Child 03 `review-host.ts` and saved review rounds — page hosting and decision recovery.
- `ReviewConversation`, `beginReviewRound`, `/api/review/conversation` — the existing chat channel on both pages.
- `src/shared/work-records/` validation, persistence, deduplication, and `mnemoteca-port.ts` index sync.

## Implementation Steps

1. For an Attached workflow, `start_validation` continues past Semantic Review into code review and publication. No
   host-turn path returns `awaiting_delivery`. A record saved by child 05 in `reviewed` resumes into delivery on the next
   `status` or `start_validation` call.
2. With `codeReview` set to `always`, or `ask` and the user accepts, `status` returns `code_review` and the MCP server
   hosts `/review/code` for the current candidate. The pending review is saved on the Attached record with the diff-hash
   identity. With `none`, no page opens and delivery continues.
3. An approval whose diff hash differs from the current candidate is rejected. Feedback produces a `human_feedback`
   repair action for a Claude subagent, then re-verification, then a new code review round. Core starts no
   `runIsolatedAgentSession` and no `HostedSession` in this path.
4. A chat message sent from the Attached Plan review page or code review page is saved on the open review round. It
   survives a Core process restart. `status` returns `review_chat` with the round, message text, and selected lines.
5. `review_reply` appends the reply to that round's `ReviewConversation`, and `/api/review/conversation` returns it. A
   reply for a closed or stale round is rejected. Chat messages that arrive while Claude is busy stay queued in order
   and are returned one at a time.
6. A Plan revised from chat goes through `plan_written` and opens a new Plan review round on the same page. A code change
   from chat goes through the `human_feedback` repair path and re-verification, and opens a new code review round. A
   chat turn never records an approval or feedback decision.
7. During `publishOnce`, an Attached workflow returns a `recorder` action that carries the Recorder instructions and
   canonical references. `work_record_completed` sections pass the same validation as Core sections. Valid sections are
   persisted, deduplicated, and indexed through the existing Work Record code. Core starts no Recorder session.
8. An invalid Recorder submission is rejected with the validation errors and gets one retry. After a second invalid
   submission, Core records the Work Record failure and publication continues, as the Core PRD requires.
9. Core starts no Operator turn for an Attached workflow. After delivery, the plugin command tells Claude to suggest
   manual checks from the Plan. Nothing about those checks is saved.
10. Supersession proposals resolve as "decide later" during Attached publication, and the delivery result names
    `wld wr supersede`.
11. Externally visible Verified and successful closure require proven publication. Local validation, staging, Claude's
    text, or a successful subprocess alone cannot claim delivery. After proven publication, the record closes with the
    new `delivered` closure reason, and active host restrictions are removed. The Plan, Work Record, worktree, and
    recovery evidence stay.
12. A fresh Core process resumes each saved point without repeating accepted work: pending code review, queued chat,
    pending Recorder action, accepted Recorder sections, artifact sealing, publication attempt, and cleanup. Failed
    publication, retry limits, cancellation, and quota exhaustion leave a resumable state. Closing Claude never abandons
    the workflow.
13. Review chat text is kept only on the open review round for page restore. It is not written to the Work Record, the
    memory index, or telemetry.
14. `docs/prd/runwield-connect-prd.md` and `docs/prd/runwield-core-prd.md` describe Attached delivery, review chat
    answered by the host session, the Claude-run Recorder, and the Manual QA difference, with acceptance scenarios. The
    complete Preview release stays labeled as target until child 07.

## Verification Plan

- Automated: run
  `bun scripts/run-tests.js src/shared/attached/ src/attached/claude/ src/shared/workflow/validation-publication.test.ts src/shared/workflow/publication-machine.e2e.test.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-revalidation.test.ts src/shared/workflow/validation-work-record-handoff.test.ts src/ui/review/code-review.test.ts src/ui/workspace/workspace-code-review.integration.test.ts`.
- New Attached tests through the real coordinator and record store (fake only the Claude turn boundary):
    - Delivery: a FEATURE goes from `start_validation` to `delivered` closure with a merged commit in the fixture repo.
      This test fails if `awaiting_delivery` is still returned.
    - No Core model turns: instrument `HostedSession` and `runIsolatedAgentSession` creation; the count is zero for the
      whole Attached delivery.
    - Stale approval: change the worktree after the page opens; the approval is rejected.
    - Chat: a chat turn on each page produces `review_chat`; `review_reply` text is returned by
      `/api/review/conversation`; the round stays open; no decision is recorded.
    - Recorder: valid sections produce a Work Record equal in shape to a Core record; two invalid submissions produce a
      recorded failure and publication still completes.
- Recovery: kill Core before and after each saved point in step 12. Resume in a fresh process and compare publication
  evidence, Plan lifecycle, Work Record identity, and index state. Accepted work is not repeated.
- Headed browser: with the MCP-hosted pages, send a chat message on Plan review and on code review, reply from Claude,
  then submit feedback, see the refreshed diff, approve, and restore a pending review after Claude restarts. Confirm the
  pages stop with Claude. `deno task workspace:dev` at `http://127.0.0.1:5173/dev/code-review` is a fixture, not recovery
  proof.
- Black-box: seed private sentinel text in the Claude conversation before invoking RunWield, use it in a chat question,
  and complete delivery. The sentinel must not appear in the Work Record, the memory index, telemetry, or any record
  that outlives the review round.
- Protected Core behavior: Core code review chat still runs the Reviewer Feedback Engineer repair round. Core still runs
  the Recorder and Manual QA turns. Existing publication, code review, Work Record, and memory tests keep passing
  without being rewritten.
- PRD check: the Connect and Core scenarios match delivered behavior, and the full Preview stays labeled as target.

## Edge Cases & Considerations

- Recording can change publication artifacts after validation. Keep the existing sealing and revalidation rules; do not
  treat every artifact change as new implementation.
- Claude can misread a change request as a question. The diff hash still catches every real edit, and the user can
  submit structured feedback.
- Merge conflicts, target branch movement, or uncertain publication go through evidence reconciliation and supported
  continuation, not a destructive reset.
- Cleanup failure keeps recoverable files and truthful delivery evidence.
- Assumption: chat replies show as one complete message, not streamed. `review_reply` sends the whole text.
- Assumption: the page offers no "interrupt now" choice. Messages wait until Claude next polls `status`.
- Assumption: Epic-child Manual QA artifacts stay unsupported in Attached. The Preview runs one FEATURE.
