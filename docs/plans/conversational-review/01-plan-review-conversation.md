---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/react/PlanQuestionBlocks.tsx"
    - "src/ui/workspace/react/ArtifactConversationSidebar.tsx"
    - "src/ui/workspace/react/artifact-conversation.ts"
    - "src/ui/workspace/react/plan-review-feedback.ts"
    - "src/tools/plan-written.ts"
    - "src/shared/workflow/plan-review-actions.ts"
    - "src/shared/workflow/sequence-review.ts"
    - "src/shared/workflow/decisions.ts"
    - "src/shared/session/agent-switching.js"
    - "src/shared/session/runtime/workflows.ts"
    - "src/cmd/load-plan/plan-session-surface.ts"
    - "src/cmd/load-plan/plan-review-flow.ts"
    - "src/ui/review/plan-review.ts"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/shared/workflow/plan-lifecycle.js"
    - "src/plan-store.js"
    - "src/ui/workspace/server/plan-adapter.js"
    - "src/agent-definitions/planner.md"
    - "src/agent-definitions/architect.md"
    - "docs/plan-lifecycle.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/conversational-review-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
origin: "internal"
parentPlan: "conversational-review"
order: 1
dependencies: []
createdAt: "2026-10-19"
status: "draft"
planId: "74f11e15-6d13-4e7b-9cc8-93a19dba86de"
---

# Plan Review Conversation

## Context

**Every Plan review chat message is a "deny" decision today.** The owner wants a normal conversation with Planner or
Architect. The Agent replies in chat and changes the Plan only when needed.

Source: [Conversational Review PRD](../../prd/conversational-review-prd.md), sections "Plan and Epic review
conversation" and "Plan Status without `feedback`". Owning capabilities:

- [Core Plan review](../../prd/runwield-core-prd.md#plan-review): changed. Chat turns are not decisions. A reply-only
  turn keeps the review open. "Send Annotations" stops being a review action.
- [Core Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle): changed. `feedback` is removed.
- [Workspace Browser Plan review](../../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow): changed.
  "Chat in the review" and "Answer Plan Questions in place" get the review queue, Submit answer, and the approval
  warning.

**Behavior that must survive:**

- approval actions and Plan Question settlement on approval;
- the open-questions confirmation;
- stale-revision rejection and single application of a repeated decision;
- Sequence group review;
- Epic review with Architect across rounds;
- direct review from `load-plan` and `/plan-review`;
- approval context forwarding to Engineer or Slicer.

### How a chat turn works today

```text
browser sendPlannerMessage
  submit("deny", { feedback, conversationTurn: true })
    applySharedPlanReviewDecision          # writes review_feedback → status: feedback
    plan_written returns "Plan Review Feedback (Round N)"
  Planner must call plan_written again     # artifact-conversation.ts tells it to, "even when the Plan does not change"
  browser waits ≤180 s for a NEW plan_review interaction
    none → "ended without reopening Plan review" error
```

The blocked `plan_written` call is the only thing that holds the review open. If the Agent ends its turn with only a
reply:

- **Local surface:** Approve returns 404 "Review expired or completed".
- **Workspace:** the live interaction is gone. The only recovery is `/plan-review`.

`feedback` behaves like `draft` in every status set. Its only distinct effects are:

- the "needs attention" stage in `workflow-presentation.ts`;
- a Feedback column on the Workspace board, from `STATUS_META.feedback` in `plan-adapter.js`;
- the target of `review_feedback` and `review_reopened` in `plan-lifecycle.js`.

## Objective

When this Plan ships, all of these are true:

- A Plan review chat turn ends with a reply, a Plan revision, or both. The review stays open and approvable after
  either result, with no timeout error.
- A reply-only turn writes nothing to the Plan file.
- Review input is queued on the chat by default. Each item type has an X that excludes it from the next send.
- The Annotations pane has no button that sends or closes the review.
- Each question card can submit its answer immediately.
- The `feedback` status no longer exists. Saved `feedback` Plans read as `draft`.
- A revision of an `approved`, `ready_for_work`, or `ready_for_decomposition` Plan returns it to `draft`.
- Approval warns when chat turns happened after the last revision.

## Approach

### 1. RunWield re-arms the review after a reply-only turn

The design reuses the direct review path that `/plan-review` already uses. The Agent never has to call `plan_written`
to keep the review open.

```diff
 browser chat send
   submit("deny", { feedback, conversationTurn: true })
-    applySharedPlanReviewDecision → review_feedback write
+    conversation turn: no lifecycle or front matter write; only an owner direct edit is saved
   plan_written returns the message to the Agent
+    outcome "conversation" (not "feedback")
 Agent turn
   reply in chat, and optionally edit the Plan and call plan_written
+turn settles without a new plan_written review
+  RunWield reopens the same Plan review (reopenSavedPlanReview → reviewLoadedPlanDirectly)
+  same conversation id → same surface; browser treats the new round as "reply only"
```

`reopenSavedPlanReview` (`src/cmd/load-plan/reopen-plan-review.ts`) already does these things:

- applies approval with no waiting Agent call;
- runs readiness, then Approve & Run, Approve for Later, or Slicer;
- reuses the open surface through `PlanReviewConversationOwner` and `beginReviewRound`.

Direct review currently drops `conversationTurn` (`plan-session-surface.ts` around line 113). It also forces a
revision through `buildReReviewRevisionRequest`. Both change so that a chat turn in direct review reaches the Agent as
a conversation, and the same re-arm applies afterwards.

**Rejected alternative:** a review-owned loop like standalone Code Review (`review-loop.ts`). It would replace the
`plan_written` round model and the Sequence and Epic paths, which is far more change for the same result.

### 2. Lifecycle

```text
on(conversation turn)
  if owner direct edit is present
    save the edited Plan (existing buildPlanSavePayload path)
  no review_feedback, no review_reopened, no failureReason write

on(plan_written presents a Plan in an open review conversation)
  if status in {approved, ready_for_work, ready_for_decomposition}
     and the Plan meaning differs from the previous round's base   # reuse the formatting-tolerant comparison
    record review_reopened → draft

on(owner direct edit saved during a turn on an approved/ready Plan)
  record review_reopened → draft
```

The `feedback` status is removed. `review_feedback` and `review_reopened` target `draft`. `plan-store.js`
`LEGACY_PLAN_STATUSES` maps both `feedback` and `in_review` to `draft`, so every read path normalizes old files in one
place.

### 3. Browser

```tsx
<PlanReviewSurface>                       # rightSidebarView defaults to "planner" (chat)
  <ArtifactConversationSidebar>
    <ReviewQueue>                         # new shared component, reused by Code Review in slice 2
      [3 annotations ×] [1 image ×] [direct edit ×] [2 answers ×]
    composer + Send                       # message, queue, or both
  <Annotations pane>                      # list and edit only; no Send Annotations, no "attach to chat"
  <PlanQuestionBlocks>
    <QuestionForm> … [Submit answer]      # one-answer chat turn; disabled while the Agent works
```

Queue state replaces `conversationContextAttached` (default false today) and `questionContextAttached`. Every item type
is included by default. X excludes that type from the next send without deleting the items. Items return to "included"
after a send.

**The approval warning** is page state derived from the conversation: at least one owner turn completed after the
latest Plan revision in this review. "Ask {Agent} to update the Plan" sends a fixed chat message. "Approve as is"
continues to the existing open-questions confirmation and approval.

## Expected Change Surface

This list is guidance, not an allowlist. Verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved
intent: the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk
grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/react/PlanReviewSurface.tsx`:
    - review queue state;
    - chat as the default view;
    - removal of `submitFeedback` and `attachReviewContextToConversation`;
    - completion detection without a 180 s deadline;
    - the approval warning.
- `src/ui/workspace/react/PlanQuestionBlocks.tsx`: Submit answer button and "sent" state.
- `src/ui/workspace/react/ArtifactConversationSidebar.tsx`, plus a new `ReviewQueue` component in the same folder: a
  queue with per-type X. It is shared so slice 2 reuses it.
- `src/ui/workspace/react/artifact-conversation.ts`: the turn instruction no longer says "call `plan_written` again
  even when the Plan does not need a change". It states the reply-or-revise rule.
- `src/tools/plan-written.ts`:
    - a conversation-turn outcome, separate from `feedback`;
    - the revision-cancels-approval check before a new round.
- `src/shared/workflow/plan-review-actions.ts` and `src/shared/workflow/sequence-review.ts`: conversation turns record
  no lifecycle event. Hard-coded `status = "feedback"` (around lines 278 and 351) becomes `draft`.
- `src/shared/workflow/decisions.ts`, `src/shared/session/agent-switching.js`, `src/shared/session/runtime/workflows.ts`:
  after a conversation turn settles without a new review, RunWield reopens the review. Use the existing
  `reopenPlanReview` and `reopenSavedPlanReview` path.
- `src/cmd/load-plan/plan-session-surface.ts` and `plan-review-flow.ts`: direct review keeps `conversationTurn` and
  runs a conversation turn, not a forced revision.
- `src/ui/review/plan-review.ts` and `src/ui/workspace/server/session-continuation.js`: pass the conversation-turn
  result through without a lifecycle write.
- **Removal of `feedback`:**
    - `src/shared/workflow/plan-lifecycle.js`: status lists, `ALLOWED_FROM`, `EVENT_STATUS`, and help text.
    - `src/plan-store.js`: `PLAN_STATUSES` and `LEGACY_PLAN_STATUSES`.
    - `workflow-presentation.ts`, `session-sidebar.ts`, and `runtime/workflows.ts` (around line 70).
    - The load-plan status sets in `plan-review-flow.ts`, `plan-epic-flow.ts`, `plan-epic-children.ts`, and
      `plan-hold.ts`.
    - `epic-branch.ts`, `epic-sibling-drafts.ts`, `sequence-review.ts`, and `epic-continuation.ts`.
    - `plan-adapter.js` `STATUS_META`, and `.status-feedback` in `src/ui/design-system/components.css` with its use in
      `PlanDetail.jsx`.
- `src/agent-definitions/planner.md`, `src/agent-definitions/architect.md`, `src/skills/runwield/PLANS.md`: the
  reply-or-revise rule; no `feedback` status.
- `docs/plan-lifecycle.md`: statuses, the event table, and Re-open for review.
- `docs/prd/runwield-core-prd.md`, `docs/prd/runwield-workspace-prd.md`, `docs/prd/conversational-review-prd.md`: PRD
  synchronization.
- `docs/domain-language.md`: Feedback, Review Queue, Review Loop, Revision, and Plan Status.
- `docs/design-system.md`: the review queue pattern, if it is new to the design system.

Code Review (`CodeReviewSurface.tsx`, `validation-human-review.ts`) is deliberately not changed here. Slice 2 owns it.

## Reuse Opportunities

- `src/cmd/load-plan/reopen-plan-review.ts` `reopenSavedPlanReview` and `reviewLoadedPlanDirectly`: approve, readiness,
  run, save, and Slicer without a waiting `plan_written` call.
- `src/ui/review/review-launcher.ts` `beginReviewRound` and `PlanReviewConversationOwner`
  (`src/shared/session/plan-review-conversation.ts`): reuse of the same surface and conversation for a new round.
- `reviewSourceStillMatches` in `plan-review-actions.ts`: the formatting-tolerant comparison for "Plan meaning changed".
- `applyPlannerRevision` in `PlanReviewSurface.tsx`: already handles a round with an unchanged Plan.
- `buildPlanReviewFeedback`, `formatPlanQuestionAnswers` (`plan-review-feedback.ts`), and
  `buildArtifactConversationFeedback`: the message assembly.
- `src/ui/design-system/components/react/RunWieldPrimitives.jsx` and `--rw-*` tokens: queue chips and buttons.

## Implementation Steps

- `src/plan-store.js` no longer lists `feedback` in `PLAN_STATUSES`. `LEGACY_PLAN_STATUSES` maps `feedback` and
  `in_review` to `draft`. `parsePlanFrontMatter` returns `status: "draft"` for a file saved with `status: feedback`.
- `src/shared/workflow/plan-lifecycle.js` has no `feedback` in `PlanStatus`, `MANUAL_BOARD_STATUSES`,
  `PLAN_STATUSES`, `ACTIVE_PLAN_STATUSES`, or `ALLOWED_FROM`. `EVENT_STATUS.review_feedback` and
  `EVENT_STATUS.review_reopened` are `draft`. No other `src/` module lists `feedback` as a Plan Status:
    - the status sets named in Expected Change Surface;
    - `workflow-presentation.ts`, which no longer marks planning or review as `needs_attention` for it;
    - the board, which has no Feedback column;
    - `.status-feedback`, which is removed.
- A conversation turn (`conversationTurn: true`) through `applySharedPlanReviewDecision`,
  `applySequenceReviewDecision`, or Workspace `answerInteraction` records no Plan Event. It writes Plan front matter
  only when the owner's direct edit is saved. The Plan revision and `updatedAt` are unchanged for a turn without a
  direct edit.
- When a saved direct edit changes the meaning of an `approved`, `ready_for_work`, or `ready_for_decomposition` Plan,
  that Plan becomes `draft` through `review_reopened`. The same is true when `plan_written` presents such a Plan with
  changed meaning in an open review conversation. A formatting-only change keeps the status.
- `plan_written` returns a distinct outcome for a conversation turn. It is not `feedback`. The tool text gives the
  owner's message and tells the Agent the reply-or-revise rule:
    - reply in chat to explain, clarify, or ask back;
    - revise the Plan and call `plan_written` when the answer changes scope, behavior, a decision, or verification;
    - when in doubt, revise.
- `buildArtifactConversationFeedback` for Plans states the same rule. It no longer asks for `plan_written` when the
  Plan is unchanged.
- When the planning Agent's turn after a conversation turn settles without presenting a new review, RunWield reopens
  the same Plan review for the same conversation. This applies to the `plan_written` path, direct review from
  `load-plan`, and `/plan-review`.
- In the reopened review, the browser shows the reply, and the owner can chat, answer, edit, Approve & Run, Approve
  for Later, or Approve & Slice. Approval runs readiness and the chosen action exactly as before.
- Sequence and Epic reviews follow the same re-arm. A Sequence still applies its group decision through
  `applySequenceReviewDecision`.
- `PlanReviewSurface.tsx` waits for the turn to finish with no 180-second deadline. It accepts the reopened round as a
  reply-only result when the Plan is unchanged. It no longer throws "ended without reopening Plan review" for a turn
  that settled with a reply.
- The right rail opens on chat. Annotations, file annotations, global attachments, the direct edit, and question
  answers are each queued by default as a chip with a count and an X. X excludes that type from the next send. Send is
  enabled for a message, a non-empty included queue, or both. After a send, the sent items leave the queue, as they do
  today on a conversation turn.
- The Annotations pane renders no Send Annotations button and no "attach to chat" button. `submitFeedback` and
  `attachReviewContextToConversation` no longer exist in `PlanReviewSurface.tsx`.
- Fallback: if a Plan review surface has no conversation (`conversationEnabled` is false), the pane keeps one Send
  Annotations button with today's behavior, so feedback still has a path. Record in the handoff whether any production
  surface reaches this branch.
- Each valid question card shows a Submit answer button when it has an answer. Clicking it sends a conversation turn
  that contains only that answer, under the "Question answers" heading. The card then shows that the answer was sent,
  and the answer leaves the queue. While the Agent is working, the button is disabled and the answer stays queued.
- Approve & Run, Approve for Later, and Approve & Slice show a confirmation when at least one owner chat turn completed
  after the latest Plan revision in this review. The confirmation offers three choices:
    - "Ask {Agent} to update the Plan" sends a fixed chat message.
    - "Approve as is" continues to the existing open-questions confirmation and approval.
    - "Cancel" keeps the review open.
      The warning does not appear when the latest turn produced a revision.
- Items still queued at approval go with the approval payload, as today.
- `planner.md`, `architect.md`, and `src/skills/runwield/PLANS.md` describe the reply-or-revise rule and contain no
  `feedback` status. `docs/plan-lifecycle.md` matches the new statuses and events.
- `docs/domain-language.md` defines **Feedback**, **Review Queue**, **Review Loop**, and **Revision** as proposed in the
  PRD's "Proposed Domain Language". **Plan Status** no longer lists `feedback`. The relationship "Denied Plan review
  produces Feedback…" is replaced. The Code Review relationship is not added; slice 2 adds it.
- The PRDs match the delivered behavior:
    - Core "Plan review": Send Annotations is not a review action, and the Epic chat text is updated.
    - Core "Plan lifecycle": the ordinary lifecycle is `draft → approved → …`.
    - Workspace "Chat in the review" and "Answer Plan Questions in place" describe the delivered behavior.
    - All three keep their acceptance scenarios updated.
    - In `docs/prd/conversational-review-prd.md`, the two delivered sections are removed, and the remaining Code Review
      section and Delivery are updated to say slice 1 shipped.

## Verification Plan

Automated, with focused tests through real boundaries. Use `makeValidationProjectRoot` for real Plan files; add no test
seams.

- `bun scripts/run-tests.js src/plan-store.test.js src/shared/workflow/plan-lifecycle.test.js`
    - Proves that a file with `status: feedback` parses as `draft`, and `in_review` parses as `draft`.
    - Proves that `review_feedback` and `review_reopened` target `draft`.
    - Proves that `feedback` is not a valid manual board target.
- `bun scripts/run-tests.js src/shared/workflow/plan-review-actions.test.ts src/shared/workflow/sequence-review.test.ts src/ui/review/plan-review.test.ts`
    - A conversation-turn decision leaves the Plan file byte-identical.
    - A conversation turn with a direct edit on a `ready_for_work` Plan saves the edit and moves the Plan to `draft`.
    - A formatting-only direct edit keeps `ready_for_work`.
    - This test fails if the old `review_feedback` write remains.
- An integration test, alongside `reopen-plan-review-behavior.integration.test.ts` and
  `reopen-epic-chat.integration.test.ts`:
    1. A planning Agent receives a conversation turn and ends its turn with text only, without calling `plan_written`.
    2. The review becomes live again for the same Plan and conversation.
    3. An approval then reaches `ready_for_work`.
       This test fails if the re-arm is missing, because no review is live after the turn.
- A Workspace test in `owner-workspace.test.js` or `session-continuation` coverage: after a reply-only conversation
  turn, a new `plan_review` live interaction exists. Approving through it succeeds.
- A browser component test in `src/ui/workspace/workspace-plan-review-ux.test.tsx`:
    - Chat is the default view. A new annotation and an answer appear as included chips. X on annotations excludes
      them from the sent feedback text but keeps them on the Plan.
    - No Send Annotations button renders when chat is enabled.
    - The approval warning appears after a reply-only round and not after a revision round.
- `src/ui/workspace/react/plan-question-blocks.test.tsx`:
    - Submit answer sends one turn containing only that answer.
    - The answer is not in the next chat send.
    - The button is disabled while the Agent works.
- Golden harness: `src/ui/tui/testing/scenario-runner.js` and affected Golden scenarios expect `draft`, not
  `feedback`. Add one Golden plan-review scenario: chat turn → reply only → re-armed review → approve.

**Existing coverage: what must stay and what must stop.**

- **Stays:**
    - approval and question settlement;
    - stale-revision rejection;
    - single application of a repeated decision;
    - Sequence group decisions;
    - Epic Architect chat across rounds;
    - `/plan-review` reuse;
    - approval feedback and image forwarding.
- **Stops existing:**
    - status `feedback` assertions (rewrite them to `draft`, or to "no write" for conversation turns);
    - "chat turn records `review_feedback`";
    - the "call `plan_written` again even when unchanged" instruction;
    - the attach-to-chat button;
    - the closing Send Annotations path when chat is enabled.

    The tests listed by investigation that assert `feedback` must be rewritten, not deleted:
    - `plan-store.test.js`, `plan-lifecycle.test.js:1071`, `plan-review-actions.test.ts`, and `sequence-review.test.ts`;
    - `execution-progress.test.ts`, `epic-branch-planning.integration.test.ts`, and
      `authority-continuation.integration.test.ts`;
    - the `reopen-*.integration.test.ts` files and `plan-recovery-flow.test.ts`;
    - `cmd/load-plan/index.integration.test.ts`, `ui/review/plan-review.test.ts`, and `owner-workspace.test.js`.

**Manual, headed browser, from a Workspace Session with Planner:**

1. Ask a question in chat. Expected:
    - a reply appears;
    - `git diff` on the Plan is empty;
    - Approve works.
2. Add an annotation that asks for a change. Expected:
    - the chip shows it;
    - Send produces a revision and a diff;
    - on a `ready_for_work` Plan, the status becomes `draft`.
3. Answer a question card and click Submit answer. Expected: the Agent receives only the answer.
4. After a reply-only turn, click Approve & Run. Expected: the warning appears. "Approve as is" runs the Plan.

**Documents:** the glossary and PRDs describe slice 1's behavior only. Code Review conversation stays proposed in the
temporary PRD.

## Edge Cases & Considerations

- **The Agent's turn fails or is canceled after a conversation turn.** The re-arm still reopens the review, and the
  chat shows the error. The review must not be lost, so the owner never needs `/plan-review` to recover.
- **The owner cancels the review with Escape while the Agent works.** Cancellation keeps today's meaning, and no re-arm
  follows a canceled review.
- **The TUI input stays hidden while the review is live.** This is the current Core requirement. The re-arm keeps the
  same behavior.
- **Legacy `feedback` Plans in Epic, Sequence, and dependency checks.** All reads normalize to `draft` in
  `plan-store.js`. A write after normalization saves `draft`.
- **The approval warning becomes noise.** This is accepted for now. The PRD's open question is about narrowing it to
  turns with annotations.
- **Assumption:** the approval-warning flag is page state derived from the review conversation. It does not need to
  survive a full browser reload without conversation history.
