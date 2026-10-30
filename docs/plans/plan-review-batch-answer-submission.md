---
planId: "73fd73fa-ac48-4a34-9a95-f3131dae73b4"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "LOW"
affectedPaths:
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/react/PlanQuestionBlocks.tsx"
    - "src/ui/workspace/react/plan-question-blocks.test.tsx"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/design-system.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review"
devServerHmr: true
createdAt: "2026-10-30"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "02f76bc221ed0199468f549a098b0157adbb789a"
workRecord:
    status: "generated"
    recordId: "f9135cce-db44-430d-865a-01bfd3844671"
    path: "docs/work-records/2026-10-30-batch-plan-question-answers-with-visible-planner-progress.md"
    lastAttemptAt: "2026-10-30T16:03:19.329Z"
status: "verified"
---

# Plan Review Batch Answer Submission

## Context

Each answered Plan Question currently submits only its own answer. The right sidebar can remain collapsed, hiding the
Planner's progress. The owner wants one click to send all selected answers and reveal that progress.

This changes **Answer Plan Questions in place** and the related layout and acceptance scenarios in
[Browser Plan review and workflow](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow). Batch submission
and automatic reveal are proposed behavior. Answer persistence, sent-value tracking, chat queue behavior, and approval
remain existing behavior to preserve.

## Objective

Every available question submit button shows **Submit Answer** for one unsent answer, **Submit 2 Answers** for two,
**Submit 3 Answers** for three, and so on. Clicking any of them submits every answered, unsent question in one turn and
opens the right annotations sidebar on its Planner conversation tab so working status is visible immediately.

## Approach

Use the existing answer state and `unsentAnswers` in `PlanReviewDocument`. Derive the shared button count from the same
answer set used for submission. Replace the single-answer selection in `sendPlannerMessage` and `readReview` with an
answers-only batch. Sequence reviews use their existing group collection and count aggregation across mounted tabs.

```text
Question button (shared answer count)
  -> snapshot all unsent answers
  -> open right sidebar and select Planner
  -> send one existing conversation turn
  -> mark accepted values sent; preserve later edits
```

Keep composer text, annotations, attachments, and direct edits out of this explicit answers-only action. An answer
submission includes answers even if their queue chip was excluded for a normal chat send, matching the current direct
answer action. Use existing busy guards, acceptance handling, failure recovery, sidebar animation, and compact-layout
behavior. A new store or endpoint would duplicate state already owned by the review surface.

React's [shared-state guidance](https://react.dev/learn/sharing-state-between-components) supports retaining one owner
for coordinated controls. Preserve the existing RunWield button and sidebar patterns and semantic tokens.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/react/PlanReviewSurface.tsx` — select all pending answers, derive group counts, and reveal Planner.
- `src/ui/workspace/react/PlanQuestionBlocks.tsx` — show the shared singular/plural label and invoke the batch action.
- `src/ui/workspace/react/plan-question-blocks.test.tsx` and existing review test utilities — prove batching, counts,
  sidebar visibility, and draft preservation through the real review surface.
- Existing review dev fixtures, if needed — provide three answerable questions for browser verification.
- `docs/prd/runwield-workspace-prd.md` and `docs/design-system.md` — replace the single-answer rule and document reveal.

## Reuse Opportunities

- `PlanReviewDocument` answer, sent-answer, and `clearSent` handling — preserve exact submitted values and later edits.
- `SequenceReviewSurface` collection, queue aggregation, and busy state — keep group submission consistent.
- `useReviewAnnotations`, `animateSidebarUpdate`, and `ArtifactConversationSidebar` — reveal the existing working view.
- `RunWieldButton` and existing question forms — retain styling, keyboard behavior, and input validation.
- `withReview` in `plan-review-test-dom.tsx` — inspect submitted payloads and hold or fail real UI requests.

## Implementation Steps

1. `PlanReviewSurface.tsx` derives one pending-answer count per review, including Sequence tabs through the existing
   group. `PlanQuestionBlocks.tsx` uses that count on every visible submit button with the exact labels in Objective.
   Blank text, unanswered questions, and unchanged sent values do not count; a selected No answer counts.
2. Every question submit action sends the entire current unsent-answer set once through the existing conversation
   path. The context summary reports the batch size. Composer text and other queued context remain unsent and intact.
   Accepted values show Answer sent and are omitted from later sends; edits or new answers during the turn remain queued.
3. Starting an answer submission opens the right sidebar and selects its Planner tab before awaiting the request.
   This also works after manual collapse or after viewing Annotations. Existing compact layout closes Contents and
   exposes the Planner's working/error state. Busy guards prevent duplicate turns; failed submissions remain retryable.
4. Behavioral coverage replaces the obsolete one-answer-only expectation while preserving its draft isolation,
   retry, approval, persistence, and sent-value protections. It covers one/two/three counts, batch payloads, working
   visibility, in-flight edits, and Sequence consistency.
5. The owning Workspace PRD requirement and scenarios, plus the design-system question and sidebar guidance, describe
   the delivered batch behavior in the same change. Existing unrelated targets remain explicitly targeted or deferred.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

- Use Bun 1.4.3 and run `bun run install:locked` before checks.
- Run `bun scripts/run-tests.js src/ui/workspace/react/plan-question-blocks.test.tsx` and any additional changed review
  test files through the same isolated runner. The payload test must fail if submission still sends only the clicked
  answer; visibility tests must fail if the sidebar remains closed or shows Annotations instead of Planner.
- Run `bun run workspace:check`, `bun run seams:check`, and `bun run fmt:check` with explicit changed paths.
- Start `bun run workspace:dev`; use a headed browser on `/dev/plan-review` and `/dev/workspace/plan-review` with a
  three-question fixture. Select one, two, and three answers and verify every visible button's count. Submit from a
  different block and verify one batch, immediate Planner visibility, and working status.
- At desktop and a narrow phone viewport, repeat after collapsing the right sidebar and after selecting Annotations;
  on the phone, open Contents first and verify it closes when Planner opens. Check button readability and reachability.
- Hold a turn, edit an already-submitted answer and answer another question, and verify both remain queued after
  completion. A second click while busy must not send another request. Fail a request and verify all unsent answers
  survive for retry. Verify blank Other/text is excluded while No is included.
- In a Sequence review, select answers in two tabs and verify the shared count matches the submitted answer payloads
  with each Plan's identity intact. Retain coverage for normal chat exclusions and approval forwarding.
- Inspect the PRD and design-system updates against the verified behavior. RunWield owns full post-implementation CI.

## Edge Cases & Considerations

- **Existing sent answers:** only unsent or edited values belong in the batch; retained selections still serve approval.
- **Answers entered during work:** use the existing submitted-value snapshot, so acceptance cannot consume a later edit.
- **Removed questions:** preserve current pruning on revision; stale ids must not inflate the count or batch.
- **No conversation:** retain the existing Send Annotations fallback; do not add an unavailable question submit action.
- **Reviewable scope assumption:** all question blocks includes all tabs in one Sequence review, consistent with its
  existing shared Review Queue. Separate review pages remain independent.
- **Terminology:** the requested annotations side panel is the existing right sidebar; select its Planner tab because
  that is where live Agent progress is displayed. No new domain terms, storage migration, or server contract is needed.
