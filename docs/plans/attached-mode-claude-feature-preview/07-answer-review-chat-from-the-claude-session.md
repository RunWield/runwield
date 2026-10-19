---
planId: "3f9afd7e-ac62-4392-b44f-dda6caf80355"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/review/review-launcher.ts"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/routes/api/review-handlers.js"
    - "src/shared/attached/operations.ts"
    - "src/shared/attached/coordinator.ts"
    - "src/shared/attached/record-store.ts"
    - "src/shared/attached/review-host.ts"
    - "src/attached/claude/mcp.ts"
    - "src/attached/claude/plugin/commands/"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-core-prd.md"
    - "src/shared/attached/code-review-decision.ts"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/code-review"
devServerHmr: true
createdAt: "2026-10-13T00:00:00.000Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 8
dependencies:
    - "06-publish-validated-work-and-record-the-outcome"
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
status: "implemented"
---

# Answer review chat from the Claude session

## Context

Core's Plan review and code review pages already have chat. In Core, each chat message is a Reviewer Feedback Engineer
repair round that runs as a hidden Core session (`validation-human-review.ts`). Attached mode starts no Core model
session, so the Attached review pages have no chat after children 03 and 06.

This child adds chat to both Attached review pages. The Claude session that runs the workflow answers it.

The page side already exists:

- The page sends a decision with `conversationTurn: true`.
- The page reads replies from `GET /api/review/conversation` (`ReviewConversation` in `review-launcher.ts`).
- `beginReviewRound` keeps the page open across rounds.

Only the source of the reply changes.

### What the Attached pages do today (checked 2026-10-13 on the epic branch)

- **Chat is hidden.** The page enables chat only when the host passes a `reviewConversation`, which sets
  `conversationStatusUrl` (`review-launcher.ts:370`, `:492`). `review-host.ts` passes none on either page.
  `review-host.test.ts` asserts that `/api/review/conversation` returns 404.
- **Code review rejects a chat turn.** `applyAttachedCodeReviewDecision` throws "Review chat is not available in this
  Preview step." (`code-review-decision.ts:15`).
- **Plan review would apply a chat turn as Feedback.** `applyAttachedReviewDecision` has no `conversationTurn` check.
  This must change before chat is enabled.
- **`plan_written` is rejected while a review is pending** (`coordinator.ts:471`). A Plan change from chat must first
  move the workflow from `awaiting_review` to `awaiting_planning`.
- **The saved code review wait is serialized.** The host code review `interaction`, including
  `_meta.reviewConversation`, is copied into the Plan's validation checkpoint. Attached chat must never write events into
  that object.
- **The page ends a chat turn when `revision` increases.** The Plan page reads streamed `events` for the reply text and
  stops waiting when `revision` goes up. It then reads `plan`, which can be unchanged. It waits up to 180 seconds
  (`PlanReviewSurface.tsx`). The code page has no time limit.
- **The pages are hosted by the MCP process** (`ensureReviewHosted`, called after every MCP tool call). The page and
  `status` run in the same process while Claude is open. Saved state on the Attached record carries a turn across a
  restart.

Owning PRD capabilities:

- Connect [artifact privacy and records](../../prd/runwield-connect-prd.md#artifact-privacy-and-records) — no host
  conversation in durable RunWield artifacts. Feedback and approval return as structured workflow outcomes, not chat
  prose.
- Core [execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) — saved
  waits survive a process restart.

### Planning Decisions (2026-10-13)

- **Chat is answered by the coordinating Claude session ("Ask this session").** This follows Plannotator's model. It
  differs on purpose from Core: it fits work driven from Claude Code. Claude answers a question directly. It dispatches
  a repair subagent only when the message asks for a code change.
- **Plan review and code review both get chat.** They use one chat channel in Attached.
- **Chat text is temporary.** The conversation is not a durable artifact. Only code, documents, Work Records, and memory
  are durable. Core may keep chat text on the open review round so the page restores after a restart. Chat text must not
  go into a durable artifact.
- **A code change from chat is saved as Claude's change summary (2026-10-13).** Core's repair path writes the feedback
  text to delivery evidence and to the saved repair request. In Attached, that text is a short summary that Claude
  writes in `review_reply`, such as "Rename `foo` to `bar` in the review handler". The user's chat message is never
  that text. A Plan change from chat records no Feedback text: the revised Plan is the durable result. Set aside: a
  fixed marker only (evidence says nothing, and a restart loses the repair instructions), and question-only code chat
  (drops part of the objective).

### Epic Scope Changes

- Split out of child 06 (`06-publish-validated-work-and-record-the-outcome.md`). Child 06 keeps delivery, code review,
  feedback repair, and the Recorder. It no longer includes chat.
- The former child 07 is now child 08 (`08-prove-and-document-the-supported-claude-preview.md`). Its order and
  dependency now follow this child, and its integrated journey exercises chat on both pages.

## Objective

In an Attached workflow, a user can send a chat message from the Plan review page or the code review page. The Claude
session that runs the workflow answers it, and the answer shows on the same page.

- A question gets an answer and changes nothing.
- A change request to the Plan goes through `plan_written` and opens a new Plan review round.
- A change request to the code goes through `human_feedback` repair and re-verification and opens a new code review
  round.
- Chat never approves or rejects. Approval still comes only from the page's structured decision, bound to the Plan
  revision or the diff hash.

## Approach

A chat message travels on the `status` loop that Claude already polls while a review page is open:

```text
user sends a chat message on /review/plan or /review/code
  → onDecision sees conversationTurn: true
  → coordinator saves the turn on the open round (record.review or record.validation), not as a decision
  → status returns the same review / code_review action with chat { turnId, message, selections }
  → Claude answers in its own conversation context
  → MCP review_reply { turnId, text, change?: { summary } }
       no change     → reply saved, conversation revision +1, page shows the reply, round stays open
       change (plan) → reply saved, round closes as "revising", state awaiting_planning
                       → Claude revises the Plan and calls plan_written → new round on the same page
       change (code) → reply saved, Core resumes validation with a human_feedback repair request
                       whose feedback text is change.summary (never the chat message)
                       → Claude dispatches the repair subagent → re-verification → new code review round
```

The chat item is a field on the existing `review` and `code_review` actions, not a new `nextAction` kind. Hosting keys
on those kinds, and the plugin polling loops keep working.

`review-host.ts` passes a host-owned `ReviewConversation` to both launchers. It builds the object from the saved turns on
the Attached record. It is a separate object from the serialized `interaction._meta.reviewConversation`. Core keeps its
current chat behavior.

> [!NOTE]
> **Chat never approves or rejects**
>
> A chat reply never records an approval or a rejection. A reply with `change` ends the round so the Plan or code can
> change. The new Plan or diff then opens a new round, and the user decides there.

Option set aside: answer each message with a fresh repair subagent, as Core does. It has no conversation context, and a
plain question still triggers a repair round and re-verification.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/review/review-launcher.ts`, `src/ui/workspace/server.js`, `routes/api/review-handlers.js` — let a review host
  supply chat turns and replies from a saved source instead of a live Core turn. The page UI should not change; if it
  must, use `docs/design-system.md` and the current review components.
- `src/shared/attached/operations.ts`, `coordinator.ts`, `record-store.ts` — the `chat` field on the `review` and
  `code_review` actions, the `review_reply` operation, and saved chat turns on the open round.
- `src/shared/attached/review-host.ts`, `code-review-decision.ts` — pass a host-owned `ReviewConversation` to both pages,
  and route `conversationTurn` decisions to the saved chat queue instead of a decision.
- `src/shared/attached/review-host.test.ts` — its 404 assertion for `/api/review/conversation` is expected to change.
- `src/attached/claude/mcp.ts`, `src/attached/claude/plugin/commands/` — the `review_reply` tool and command text that
  tells Claude how to answer, revise, or dispatch repair.
- `docs/prd/runwield-connect-prd.md`, `docs/prd/runwield-core-prd.md` — replace the child 07 target notes and add the
  Attached review chat scenario.

Left out on purpose: Core review chat. Core keeps its Reviewer Feedback Engineer chat.

## Reuse Opportunities

- `ReviewConversation`, `beginReviewRound`, `/api/review/conversation` — the existing chat channel on both pages.
- Child 03 `review-host.ts` and saved review rounds — page hosting and decision recovery.
- Child 06 code review wait and `human_feedback` repair path — code changes from chat.
- `plan_written` — Plan changes from chat.

## Implementation Steps

1. Both Attached review pages show chat: `/api/review/conversation` returns 200 for an open Attached round. A
   `conversationTurn: true` decision from either page is saved as a chat turn on the open round (`record.review` for Plan
   review, `record.validation` for code review). It is not applied as Feedback, approval, or cancellation. It survives a
   Core process restart.
2. While a turn waits, `status` returns the same `review` or `code_review` action with
   `chat: { turnId, message, selections }`. Turns that arrive before a reply stay queued in order, and `status` returns
   the oldest one.
3. `review_reply { turnId, text, change?: { summary } }` saves the reply. `change.summary` is required when `change`
   is present and must be non-empty. `/api/review/conversation` returns it in `events` and increases
   `revision`. The round stays open. A reply for an unknown, answered, or closed round's turn is rejected.
4. `review_reply` with `change` on a Plan round closes the round without a Feedback decision or Feedback text, and
   moves the workflow to `awaiting_planning` with a Planner action. The next `plan_written` opens a new Plan review
   round on the same page, and the page shows the revised Plan as the end of that turn.
5. `review_reply` with `change` on a code review round resumes Core validation through `validation_decision` with
   outcome `feedback` and message `change.summary`. Delivery evidence and the saved repair request hold that summary,
   not the chat message. The repair runs through the existing host repair path and re-verification, then opens a new
   code review round with the new diff. An earlier approval does not carry over, because the decision key includes the
   diff.
6. No chat path records an approval. `interaction._meta.reviewConversation` in the saved validation checkpoint never
   contains chat text.
7. The `review_reply` MCP tool exists in `mcp.ts` and `operations.ts`. `plan-review.md`, `request.md`, and `validate.md`
   tell Claude what to do when `status` returns `chat`: answer questions directly with `review_reply`, use `change` for
   a Plan change and then revise and call `plan_written`, and use `change` for a code change and then dispatch the
   repair subagent that Core requests. The text tells Claude to write `change.summary` as a short description of the
   change, not a quote of the chat message.
8. Chat text is kept only on the open round. When the round closes, or the record closes, the text is removed. It is
   not written to the Plan, the Work Record, the memory index, telemetry, or publication evidence.
9. Core review chat behavior does not change.
10. `docs/prd/runwield-connect-prd.md` replaces the child 07 **TARGET** notes in Review experience, the Code Review
    decision requirement, and the end-to-end journey with delivered Attached review chat, and adds an acceptance
    scenario. `docs/prd/runwield-core-prd.md` drops its matching child 07 target note. The complete Preview release
    stays labeled as target until child 08.

## Verification Plan

- Automated: run
  `bun scripts/run-tests.js src/shared/attached/ src/attached/claude/ src/ui/review/code-review.test.ts src/ui/workspace/workspace-code-review.integration.test.ts`.
- New Attached tests through the real coordinator and record store (fake only the Claude turn boundary):
    - A chat turn on each page makes `status` return the `review` or `code_review` action with `chat`. `review_reply` text is returned by `/api/review/conversation`. The
      round stays open, and no decision is recorded. This test fails if the reply is dropped or written as a decision.
    - Two messages sent before a reply come back in order, one at a time.
    - A reply for a closed round is rejected.
    - A code change made from chat invalidates an earlier approval through the diff hash.
    - A saved chat turn is returned by `status` from a fresh Core process.
    - A Plan chat turn is not applied as Feedback: the round stays `pending` and the Plan status does not change.
    - A code `review_reply` with `change` saves `change.summary` in delivery evidence and the repair request, and neither
      contains the chat message text. A `change` without a summary is rejected.
    - `review_reply` with `change` on a Plan round leads to `awaiting_planning`, and the next `plan_written` opens round
      N+1.
- No Core model turns and privacy: extend `delivery-privacy.test.ts`, which already counts `HostedSession` and
  `runIsolatedAgentSession` creation. Add a chat question on each page that carries the private sentinel. The count stays
  zero. The sentinel must not appear in the Plan (including its validation checkpoint), the Work Record, the memory
  index, telemetry, publication evidence, or the Attached record after the round closes.
- Headed browser: with the MCP-hosted pages, send a chat message on Plan review and on code review, see Claude's reply,
  restart Claude with a queued message, and see the page restore. `deno task workspace:dev` at
  `http://127.0.0.1:5173/dev/code-review` is a fixture, not recovery proof.
- Protected Core behavior: Core code review chat still runs the Reviewer Feedback Engineer repair round. Existing code
  review and Plan review chat tests keep passing without being rewritten.

## Edge Cases & Considerations

- Claude can copy the user's words into `change.summary`. The command text tells Claude to write a short summary of the
  change, not to quote the chat. The privacy test controls the summary, so it cannot prove Claude's wording.
- Claude can misread a change request as a question. The diff hash still catches every real edit, and the user can
  submit structured feedback.
- Assumption: replies show as one complete message, not streamed. `review_reply` sends the whole text.
- Assumption: the page offers no "interrupt now" choice. Messages wait until Claude next polls `status`.
- Assumption: the Plan page keeps its 180-second wait. A Plan revision can take longer. The page then shows "Claude is
  still working", and a reload restores the saved turns and the new round.
