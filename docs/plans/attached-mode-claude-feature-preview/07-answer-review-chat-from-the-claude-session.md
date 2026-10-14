---
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
executionAgent: "engineer"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/code-review"
devServerHmr: true
createdAt: "2026-10-13T00:00:00.000Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 8
dependencies:
    - "06-publish-validated-work-and-record-the-outcome"
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "3f9afd7e-ac62-4392-b44f-dda6caf80355"
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
  → Core saves the turn on the open review round (survives a restart)
  → status returns nextAction review_chat { round, message, selected lines }
  → Claude answers in its own conversation context
       question → answers directly
       change   → plan: revises the Plan and calls plan_written
                  code: dispatches a human_feedback repair subagent
  → MCP review_reply { round, text } → Core appends the reply to the conversation
  → the page shows the reply and stays open; a changed Plan or diff starts a new round
```

The review launcher today fills `ReviewConversation` from a live Core turn. This child lets a review host supply turns
and replies from the saved Attached record instead. Core keeps its current chat behavior.

> [!NOTE]
> **Chat never approves or rejects**
>
> A chat reply cannot close a round. A reply that changed code invalidates an earlier approval through the diff hash. A
> revised Plan opens a new Plan review round.

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
- `src/shared/attached/operations.ts`, `coordinator.ts`, `record-store.ts` — the `review_chat` next action, the
  `review_reply` operation, and saved chat turns on the open review round.
- `src/shared/attached/review-host.ts` — wire chat for the Plan review and code review pages.
- `src/attached/claude/mcp.ts`, `src/attached/claude/plugin/commands/` — the `review_reply` tool and command text that
  tells Claude how to answer, revise, or dispatch repair.
- `docs/prd/runwield-connect-prd.md` — the Attached review chat scenario.

Left out on purpose: Core review chat. Core keeps its Reviewer Feedback Engineer chat.

## Reuse Opportunities

- `ReviewConversation`, `beginReviewRound`, `/api/review/conversation` — the existing chat channel on both pages.
- Child 03 `review-host.ts` and saved review rounds — page hosting and decision recovery.
- Child 06 code review wait and `human_feedback` repair path — code changes from chat.
- `plan_written` — Plan changes from chat.

## Implementation Steps

1. A chat message sent from the Attached Plan review page or code review page is saved on the open review round. It
   survives a Core process restart. `status` returns `review_chat` with the round, message text, and selected lines.
2. `review_reply` appends the reply to that round's `ReviewConversation`, and `/api/review/conversation` returns it. A
   reply for a closed or stale round is rejected. Messages that arrive while Claude is busy stay queued in order and are
   returned one at a time.
3. A Plan revised from chat goes through `plan_written` and opens a new Plan review round on the same page. A code
   change from chat goes through the `human_feedback` repair path and re-verification, and opens a new code review
   round. A chat turn never records an approval or feedback decision.
4. The plugin command text tells Claude to answer questions directly, to revise the Plan for Plan change requests, and
   to dispatch a repair subagent for code change requests.
5. Chat text is kept only on the open review round. When the round closes, or the record closes, the text is removed. It
   is not written to the Plan, the Work Record, the memory index, telemetry, or publication evidence.
6. Core review chat behavior does not change.
7. `docs/prd/runwield-connect-prd.md` describes Attached review chat answered by the host session, with an acceptance
   scenario. The complete Preview release stays labeled as target until child 08.

## Verification Plan

- Automated: run
  `bun scripts/run-tests.js src/shared/attached/ src/attached/claude/ src/ui/review/code-review.test.ts src/ui/workspace/workspace-code-review.integration.test.ts`.
- New Attached tests through the real coordinator and record store (fake only the Claude turn boundary):
  - A chat turn on each page produces `review_chat`. `review_reply` text is returned by `/api/review/conversation`. The
    round stays open, and no decision is recorded. This test fails if the reply is dropped or written as a decision.
  - Two messages sent before a reply come back in order, one at a time.
  - A reply for a closed round is rejected.
  - A code change made from chat invalidates an earlier approval through the diff hash.
  - A saved chat turn is returned by `status` from a fresh Core process.
- No Core model turns: instrument `HostedSession` and `runIsolatedAgentSession` creation. The count is zero while
  Attached chat runs.
- Black-box: seed private sentinel text in the Claude conversation, use it in a chat question, then complete delivery.
  The sentinel must not appear in the Plan, the Work Record, the memory index, telemetry, publication evidence, or the
  Attached record after the round closes.
- Headed browser: with the MCP-hosted pages, send a chat message on Plan review and on code review, see Claude's reply,
  restart Claude with a queued message, and see the page restore. `deno task workspace:dev` at
  `http://127.0.0.1:5173/dev/code-review` is a fixture, not recovery proof.
- Protected Core behavior: Core code review chat still runs the Reviewer Feedback Engineer repair round. Existing code
  review and Plan review chat tests keep passing without being rewritten.

## Edge Cases & Considerations

- Claude can misread a change request as a question. The diff hash still catches every real edit, and the user can
  submit structured feedback.
- Assumption: replies show as one complete message, not streamed. `review_reply` sends the whole text.
- Assumption: the page offers no "interrupt now" choice. Messages wait until Claude next polls `status`.
