---
planId: "89831c62-71b3-471c-96c6-9c627de11c68"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/validation-human-review.ts"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/shared/workflow/validation-ports.ts"
    - "src/shared/workflow/validation-session-adapter.ts"
    - "src/shared/workflow/git-snapshot.ts"
    - "src/ui/workspace/react/CodeReviewSurface.tsx"
    - "src/ui/workspace/react/artifact-conversation.ts"
    - "src/agent-definitions/subagent-definitions/reviewer-feedback-engineer.md"
    - "src/shared/workflow/validation-loop-human-review.test.js"
    - "src/ui/tui/golden-scenarios/validation-workflow-tree-human-review.ts"
    - "docs/plan-lifecycle.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/conversational-review-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-19"
origin: "internal"
parentPlan: "conversational-review"
order: 2
dependencies:
    - "01-plan-review-conversation"
userVerifiedAt: null
status: "in_progress"
targetBranch: "main"
---

# Code Review Conversation

## Context

**Every Code Review chat message is a repair today.** A question such as "Why did you use a Set here?" causes all of
the following:

- records Delivery Evidence "Changes requested";
- clears the review decision;
- moves the Plan from `reviewed` to `implemented`;
- runs a repair;
- runs CI again before the review reopens.

Source: [Conversational Review PRD](../../prd/conversational-review-prd.md), section "Code Review conversation".
Owning capabilities:

- [Core Code Review gate](../../prd/runwield-core-prd.md#code-review-gate): changed. A chat turn is a repair only
  when the reviewed patch changed.
- [Core Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair): changed. "In Code
  Review, feedback starts repair and checks" applies only to turns that change the patch.
- [Workspace Browser Plan review and workflow](../../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow):
  changed. Code Review chat uses the review queue from slice 1.

**Behavior that must survive:**

- approval;
- cancellation leaves review pending;
- feedback with a patch change still records evidence, runs CI, and reopens with the fresh diff and the same
  conversation;
- AI review is skipped after owner-requested changes;
- edit-to-suggest annotations;
- standalone Code Review (`wld review`), which is unchanged.

**Depends on slice 1:** the shared `ReviewQueue` component and the reply-or-revise conversation rule.

### Today's flow

```text
CodeReviewSurface sendAgentMessage
  submit("deny", { feedback, conversationTurn: true })
runHumanReviewPhase (validation-human-review.ts)
  recordDeliveryEvidence("human", "Changes requested")
  persistHumanReviewMetadata(changes_requested)
  recordLifecycleEvent(validation_failed)          # reviewed → implemented
  dispatchReviewFeedbackRepair                     # "human-revision Started"; requires task_completed
  return { paused, continueValidation: true }      # CI → skip AI review → reopen Code Review
```

The `for(;;)` loop in `runHumanReviewPhase` already has `if (outcome.kind === "conversation") continue;`, but nothing
returns that outcome. The browser waits for a new `code_review` interaction or a higher conversation revision. A
reply-only turn must therefore reopen the review round.

## Objective

A Code Review chat turn lets Reviewer Feedback Engineer reply, edit code, or both. RunWield compares the reviewed patch
before and after the turn:

- **Changed:** run today's repair pipeline: evidence, metadata, `validation_failed`, CI, and reopen.
- **Unchanged:** only the conversation continues. The review reopens at once with the same diff. The decision,
  Delivery Evidence, lifecycle status, and CI results do not change.

The Code Review page uses the slice 1 review queue and has no send button that closes the review.

## Approach

### Turn first, then decide by the patch

```diff
 runHumanReviewPhase, feedback branch
-  record "Changes requested", clear decision, validation_failed
-  dispatchReviewFeedbackRepair
-  return paused + continueValidation
+  if conversationTurn
+    before = review patch (getWorktreeReviewDiff, after any RunWield front matter write)
+    dispatchReviewConversationTurn           # reply-or-edit prompt; plain text is success
+    after = review patch
+    if after == before
+      append reply to conversation; return { kind: "conversation" }   # loop reopens the same review
+    record "Changes requested" + human-revision evidence for the completed edit
+    persist changes_requested; validation_failed
+    return paused + continueValidation         # unchanged CI → reopen path
+  else (non-chat feedback, no conversation surface)
+    today's flow, unchanged
```

`dispatchReviewConversationTurn` sits beside `dispatchReviewFeedbackRepair` in `validation-semantic.ts`. It uses the
same `runIsolatedAgentSession({ kind: "feedback_engineer" })` port, the review diff tool, and the conversation history.
It differs in three ways:

- It records no "Started" evidence before the turn.
- Its prompt says to reply, and to edit only when the request needs a code change.
- A plain-text answer without `task_completed` is a reply, not a blocker.

A turn that edits code and then stops on a blocker uses today's blocked-repair result.

**Rejected alternative:** reuse the standalone review loop (`review-loop.ts`). It uses a persistent prompt-ready Session
and a review worktree, not the validation session port. It would also bypass the fresh-isolated-repair model that
`docs/plan-lifecycle.md` documents.

### Scope changes need a Plan Deviation

Reviewer Feedback Engineer already lists `record_plan_deviation`. The conversation prompt says that a scope change
agreed in chat becomes authority only through a confirmed Plan Deviation.

### Browser

`CodeReviewSurface.tsx` adopts `ReviewQueue` from slice 1:

- chat is the default view;
- annotations, attachments, and edit suggestions are included by default;
- X excludes a type from one send;
- there is no "Add to chat" button;
- when chat is enabled, there is no feedback button that submits a decision.

The wait after a send has no deadline error, and it accepts a reopened round with an unchanged diff as a reply.

## Expected Change Surface

This list is guidance, not an allowlist. Verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved
intent: the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk
grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/validation-human-review.ts`: the conversation-turn branch decides by the patch, and the
  `conversation` outcome is returned.
- `src/shared/workflow/validation-semantic.ts`: `dispatchReviewConversationTurn` beside
  `dispatchReviewFeedbackRepair`.
- `src/shared/workflow/validation-ports.ts` and `validation-session-adapter.ts`: only if the conversation prompt or
  plain-text result needs a port shape change. Keep the existing `feedback_engineer` kind if possible.
- `src/shared/workflow/git-snapshot.ts`: reused, not changed, unless patch comparison needs a helper.
- `src/agent-definitions/subagent-definitions/reviewer-feedback-engineer.md`: reply-or-edit behavior for conversation
  turns, and when to propose a Plan Deviation. It already lists `record_plan_deviation`.
- `src/ui/workspace/react/CodeReviewSurface.tsx`: review queue, default chat, removed attach and feedback buttons when
  chat is enabled, and reply-only round handling.
- `src/ui/workspace/react/artifact-conversation.ts`: the Code Review turn instruction states the reply-or-edit rule.
- `docs/plan-lifecycle.md` (around L94, L383, L430–441, L469): feedback that does not change the patch does not return
  to mechanical validation.
- `docs/prd/runwield-core-prd.md`, `docs/prd/runwield-workspace-prd.md`, and `docs/domain-language.md`: synchronized.
  `docs/prd/conversational-review-prd.md` is deleted.

Standalone Code Review (`src/shared/standalone-review/`) is deliberately out of scope. It already has a reply-capable
chat.

## Reuse Opportunities

- `getWorktreeReviewDiff` and `captureWorktreeTree` (`src/shared/workflow/git-snapshot.ts`): patch identity before and
  after the turn.
- `dispatchReviewFeedbackRepair` (`validation-semantic.ts:916`): session kind, diff tool, images, and workflow state
  handling.
- The existing `continueValidation` path: CI, then the `changes_requested` AI-review skip, then reopen.
- `ReviewQueue` and the reply-or-revise wording from slice 1.

## Implementation Steps

- `runHumanReviewPhase` handles a `conversationTurn` decision as follows:
    1. It captures the review patch with `getWorktreeReviewDiff` after any RunWield metadata write.
    2. It dispatches `dispatchReviewConversationTurn`.
    3. It captures the patch again.
    4. If the patch is identical, it appends the user and agent entries to the conversation history and events, then
       returns `{ kind: "conversation" }`. The loop then opens the next Code Review round with the same diff.
- On an identical-patch turn, Delivery Evidence, `humanReviewDecision`, `humanReviewedAt`, the Plan status
  (`reviewed`), and CI results are unchanged. No CI run starts.
- If the patch changed, RunWield records "Changes requested" and a completed `human-revision` evidence entry, persists
  `changes_requested`, and records `validation_failed`. It returns `paused` with `continueValidation: true`. CI runs,
  AI review is skipped as today, and Code Review reopens with the fresh diff and the same conversation.
- `dispatchReviewConversationTurn` records no "Started" evidence. Its prompt includes the owner message, queued
  annotations, the conversation history, the diff tool, and the reply-or-edit rule. A plain-text result is a
  successful reply. An edit that stops on a blocker returns the existing blocked-repair pause.
- A non-Git in-place project has no patch identity (`diffText` is `""`). There, every conversation turn keeps today's
  repair flow. This limitation is noted in the Core PRD.
- Non-conversation feedback (`conversationTurn` is not set) keeps today's flow exactly.
- `reviewer-feedback-engineer.md` tells the Agent to propose a Plan Deviation through `record_plan_deviation` when a
  Code Review conversation agrees a scope change. The existing typed confirmation applies.
  **Stop and report** if the tool cannot run in the `feedback_engineer` session kind.
- `CodeReviewSurface.tsx` opens on chat and renders `ReviewQueue`, with all item types included by default and an X
  for each. There is no "Add to chat" button. There is no button that submits a feedback decision while chat is
  enabled; when chat is disabled, today's feedback button remains. The send wait has no deadline error. A reopened
  round with an unchanged diff shows the reply and keeps viewed files, collapse choices, and the guide state.
- `buildArtifactConversationFeedback` for `artifactKind: "code"` states the reply-or-edit rule. It no longer asks the
  Agent to "report what changed so Code Review can reload".
- `docs/plan-lifecycle.md` states that a Code Review conversation turn returns to mechanical validation only when the
  reviewed patch changed.
- The PRDs and glossary match the delivered behavior:
    - Core "Code Review gate" and "Semantic review and repair" describe the patch-change rule, the non-Git
      limitation, and the Plan Deviation path, with updated scenarios.
    - Workspace "Chat in the review" covers Code Review with the review queue.
    - `docs/domain-language.md` Code Review states that a conversation turn records "Changes requested" only when the
      reviewed patch changes.
    - `docs/prd/conversational-review-prd.md` is deleted, and no document links to it.

## Verification Plan

Automated, through real Git fixtures (`defineGitFixture`), with no new seams. The isolated agent session stays the
existing agent-turn boundary.

- `bun scripts/run-tests.js src/shared/workflow/validation-loop-human-review.test.js`:
    - **New test, reply only:**
        - The Engineer turn answers in text and edits nothing.
        - A second Code Review round opens with the same patch and one more conversation event.
        - `ciRuns === 0`.
        - `humanReviewDecision` is unchanged.
        - No `human` "Changes requested" evidence is recorded, and the status stays `reviewed`.
        - Approval in round 2 reaches verified.
        - This test fails if every turn still repairs.
    - **New test, reported fix without an edit:** the Engineer reports a fix but writes nothing. The test expects the
      reply-only result. This shows the patch decides, not the report.
    - **Existing L355 test, rewritten so the Engineer edits a file:** it still asserts:
        - 2 rounds with a fresh patch;
        - `ciRuns === 1`;
        - the same conversation object;
        - `changes_requested`;
        - "Changes requested" plus `human-revision` evidence.
    - **Existing L471, L517, L440, L300, and L327:** these stay green unchanged (non-chat feedback, reviewer skip, no
      duplicate annotations, no-answer pause and retry).
- `bun scripts/run-tests.js src/shared/workflow/validation-review-cancellation.test.ts src/ui/review/code-review.test.ts src/ui/review/review-launcher.test.ts`:
  cancellation still overrides `conversationTurn`.
- **Golden scenario** in `validation-workflow-tree-human-review.ts`: Code Review chat question, then a reply only, then
  approve, with no CI rerun. The existing `feedback-repair-approve` scenario stays.
- **Browser component test** for `CodeReviewSurface`:
    - Chat is the default view.
    - Annotations are queued and included.
    - X excludes them from the sent text.
    - No feedback or attach button renders while chat is enabled.

**Must stay:**

- feedback with a patch change goes through CI and reopens;
- the AI-review skip after `changes_requested`;
- cancellation;
- no-answer retry;
- edit-to-suggest annotations;
- standalone review tests (`review-loop.test.ts`).

**Must stop:**

- a chat turn always recording "Changes requested" and running CI;
- the "Add to chat" button.

**Manual, headed browser.** Run validation on a small Plan with `codereview: always`.

1. Ask "why" in chat. Expected:
    - a reply appears;
    - no CI progress appears;
    - the diff is unchanged;
    - Approve works.
2. Ask for a one-line change. Expected:
    - CI runs;
    - Code Review reopens with the new diff and the earlier chat.
3. Agree in chat to drop a Plan requirement. Expected: Engineer proposes a Plan Deviation, and nothing changes until
   you confirm it.

**Documents:** the Core and Workspace PRDs and the glossary describe the delivered Code Review behavior. The temporary
PRD is gone, and `grep -r conversational-review-prd docs src` finds nothing.

## Edge Cases & Considerations

- **The Plan file is part of the worktree tree.** Take the "before" patch after RunWield's own metadata writes, so a
  front matter write is not mistaken for an Engineer edit.
- **Non-Git in-place projects** keep the repair-on-every-turn behavior. This limitation is documented, not hidden.
- **The Engineer edits and then reverts within one turn.** The patch is unchanged, so the turn is treated as a reply.
  This is correct, because the reviewed work is identical.
- **A fresh isolated session for each turn.** Continuity comes from the conversation history that is already passed
  as context. This is the documented repair model.
- **Assumption:** the approval warning from slice 1 is Plan review only. Code Review has no "conversation not in the
  Plan" warning; a scope change is protected by the Plan Deviation path.
