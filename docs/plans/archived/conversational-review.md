---
planId: "eb894f76-005e-48bd-a56a-cb3b5977c534"
classification: "PROJECT"
type: "sequence"
complexity: "HIGH"
affectedPaths:
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/react/CodeReviewSurface.tsx"
    - "src/ui/workspace/react/ArtifactConversationSidebar.tsx"
    - "src/ui/workspace/react/artifact-conversation.ts"
    - "src/tools/plan-written.ts"
    - "src/shared/workflow/plan-review-actions.ts"
    - "src/shared/workflow/plan-lifecycle.js"
    - "src/plan-store.js"
    - "src/shared/workflow/validation-human-review.ts"
    - "docs/prd/conversational-review-prd.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/domain-language.md"
createdAt: "2026-10-19"
origin: "internal"
userVerifiedAt: null
epicCompletionMode: "done_enough"
epicDoneEnoughAt: "2026-10-22T02:47:51.646Z"
epicDoneEnoughSummary: "All 2 child plans are completed after conversational-review/02-code-review-conversation."
workRecord:
    status: "generated"
    recordId: "06b05a39-3df8-41bf-a084-718e1238093e"
    path: "docs/work-records/2026-10-22-conversational-plan-and-code-review.md"
    lastAttemptAt: "2026-10-22T02:48:01.980Z"
status: "verified"
archivedAt: "2026-10-26T13:51:07.730Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/conversational-review.md"
---

# Conversational Review

## Context

**Two Plans, reviewed together and executed in order.** The owner asked for a Sequence after the
[Core Plan review requirements](../../prd/runwield-core-prd.md#plan-review) settled the product decisions.

Today every review chat message is a review decision. In Plan review, the Planner or Architect can only answer by
republishing the Plan, and each message writes `status: feedback` to the Plan. In Code Review, each message records
"Changes requested", starts a repair, and runs CI again.

Both chats become normal conversations. The Agent replies, and it changes the work only when the work must change.

Owning capabilities:

- [Core Plan review](../../prd/runwield-core-prd.md#plan-review) and [Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle)
- [Core Code Review gate](../../prd/runwield-core-prd.md#code-review-gate) and
  [Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair)
- [Workspace Browser Plan review and workflow](../../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow)

## Objective

1. [Plan Review Conversation](conversational-review/01-plan-review-conversation.md):
    - the review queue on the chat;
    - Submit answer on question cards;
    - removal of Send Annotations;
    - reply-only planning turns that keep the review open;
    - removal of the `feedback` Plan Status;
    - the approval warning for conversation that is not in the Plan.
2. [Code Review Conversation](conversational-review/02-code-review-conversation.md): Code Review reuses the review
   queue from slice 1. A turn starts CI and reopens the review only when the reviewed patch changed.

Engineer owns both children, and each is specified for autonomous execution. Slice 2 depends on slice 1 because it
reuses the review queue and the reply-or-revise conversation model. No Slicer decomposition is needed.

## Decisions

- **No `feedback` status in Core.** Every unapproved Plan is `draft`. Review conversation activity is not a Core Plan Status.
- **Only a real Plan change cancels approval.** A reply-only turn changes nothing.
- **The Agent does not have to revise.** The approval warning is deterministic and fires after any chat turn since the
  last revision. It will be tuned after real use.
- **Sent annotations are not tracked threads in Core.**
- **Code Review decides by the patch, not by the Agent's report.** A scope change agreed in chat needs a confirmed Plan
  Deviation.

## PRD Lifecycle

The PRD is temporary. Slice 1 folds its delivered Plan review and Plan Status requirements into the Core and Workspace
PRDs and removes those sections from the proposal. Slice 2 folds the Code Review requirements and deletes
`docs/prd/conversational-review-prd.md`.
