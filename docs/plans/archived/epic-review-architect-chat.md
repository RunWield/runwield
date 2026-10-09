---
planId: "f1ce6d60-4ae5-468b-a068-4f975ba6e327"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/hosted-session.js"
    - "src/shared/session/session-runtime-interactions.js"
    - "src/tools/plan-written.ts"
    - "src/ui/review/plan-review.ts"
    - "src/ui/review/review-launcher.ts"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review?variant=project"
devServerHmr: true
createdAt: "2026-09-27"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "77e7db770fa6b1f26618366e77119a67645b6fee"
workRecord:
    status: "generated"
    recordId: "72865c2d-85d1-47d1-91e4-91c0d2435a29"
    path: "docs/work-records/2026-09-28-architect-chat-delivered-in-epic-review.md"
    lastAttemptAt: "2026-09-28T04:56:57.634Z"
archivedAt: "2026-10-08T19:57:14.773Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/epic-review-architect-chat.md"
---

# Architect Chat in Epic Review

## Context

The owner wants Architect chat in Epic review with the same controls and revision flow as Planner chat in Plan Review.
The owner confirmed that this includes saved and reopened reviews, in both standalone and Workspace views.

The shared browser panel already supports an Architect label. Normal Architect `plan_written` calls supply chat
metadata. Direct saved-Plan reviews do not. Standalone reviews therefore omit chat; Workspace reviews can show Planner
instead of Architect. Adding a tab alone does not fix the review-to-Agent-to-revision flow.

Affected product requirements:

- [Core Plan review](../prd/runwield-core-prd.md#plan-review): extend **Apply the user’s review decision to the saved
  Plan** with an explicit in-review conversation requirement. Preserve **Open saved Plans directly for review** and
  **Return to the most recent Plan review in the same Session**. Opening review must not start a model turn.
- [Workspace Browser Plan review and workflow](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow):
  extend **Review the current Plan and preserve explicit execution choices** with Epic chat acceptance. Link shared
  conversation semantics to Core rather than duplicate them.

These are proposed changes, not claims of delivery. No requirement is removed.

## Objective

A user can open or reopen a saved Epic, message Architect, attach review notes, and read replies and revised Epic
content without leaving review. A second message works in the same page. Chat never approves the Epic or starts Slicer.

## Approach

Reuse `ArtifactConversationSidebar` and the existing review transports. Repair conversation setup at the shared Session
interaction boundary so direct reviews and `plan_written` use the same live conversation across an Agent handoff.

```text
saved Epic review or plan_written
  shared Plan review conversation setup
    standalone token page OR Workspace live review
      user message and optional review notes
        Architect in the same Session
          plan_written publishes the next review round
            reply and revised Epic appear in the existing page
```

Move conversation identity and assistant-event collection out of the `createPlanWrittenTool` closure into
`HostedSession`. Add `getPlanReviewConversation({ planId, planningAgentName })`, keyed by the Plan or Sequence container
ID, with named types in `src/shared/session/plan-review-conversation.ts`. Capture text for the active review and
planning Agent through `publishRuntimeEvent`, not a subscription for each tool instance.

Preserve the same conversation object and events array across Agent/tool rebuilding and managed Session dehydration. The
standalone server retains that object; reusing only its ID is insufficient. Do not expose HostedSession to command code
or add a separate chat service.

`requestHostedSessionInteraction` supplies the shared metadata for Plan reviews. Preserve the existing capability
checks, saved review reference, current-file evidence, and review decision processing. Carry `conversationTurn` through
response normalization where needed to distinguish an intermediate chat round from a final decision.

The planning Agent already selected by the workflow determines the label. An Epic uses Architect; a Sequence still uses
Planner. Do not map all `PROJECT` documents to Architect.

> [!NOTE]
> **Chat is not approval**
>
> Keep Send Annotations as final feedback. Keep Approve & Slice and Approve for Later as explicit decisions. Do not add
> execution controls to Epics or start decomposition from a chat message.

A separate Epic chat component would duplicate the existing composer, attachments, polling, and revision handling. It is
not needed. No new visual pattern, durable chat store, public API, or architectural decision is planned.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/hosted-session.js`, `plan-review-conversation.ts`, and `session-runtime-interactions.js` — own and
  supply the same conversation object for direct and Agent-authored review rounds.
- `src/tools/plan-written.ts` — remove closure-local conversation ownership and use the shared runtime setup.
- `src/cmd/load-plan/` tests — exercise direct review and feedback handoff. The command boundary already supplies
  `planningAgentName`; do not add another command API or pass internal Session objects through it.
- `src/ui/review/plan-review.ts`, `review-launcher.ts`, and review adapters — preserve intermediate-round metadata,
  existing token reuse, and final review cleanup.
- `src/ui/workspace/server/session-continuation.js` and the live Plan review page — receive the correct label and retain
  operation/interaction navigation across revisions. Avoid a second classification-to-label rule in the browser.
- `src/ui/workspace/react/PlanReviewSurface.tsx` and `ReviewDevSurface.tsx` — retain the shared panel and add a
  realistic Epic revision fixture. Change production rendering only where the real journey needs it.
- Runtime, direct-review, launcher, Workspace, and browser tests — prove the connected journey rather than source
  strings.
- Core and Workspace PRD capabilities linked above — document the delivered behavior and acceptance scenarios.

`review-agent-handlers.js` owns Guided Code Review jobs, not this chat. Code Review, remote shared-review services, and
Sequence decision semantics are outside the change. No domain term changes, so no glossary edit is needed.

## Reuse Opportunities

- `ArtifactConversationSidebar.tsx` and `artifact-conversation.ts` — composer, reply rendering, explicit attachment
  chip, and message formatting.
- `PlanReviewSurface.tsx` — `sendPlannerMessage`, `waitForStandaloneReview`, `waitForPlannerReview`, and
  `applyPlannerRevision` already implement the shared interaction. Their internal Planner names do not require a rename.
- `startPlanReviewSurface` — existing conversation-ID lookup, token-page reuse, and `beginReviewRound` revision update.
- `reviewLoadedPlanDirectly`, `requestHostedSessionInteraction`, and normal planning runners — existing Agent selection,
  review authority, and feedback handoff.
- `withRuntimeCommandFixture` — real saved Plans and Session runtime with a controlled model boundary. Do not replace
  RunWield-owned review writes or lifecycle processing with injected fakes.

## Implementation Steps

1. `HostedSession.getPlanReviewConversation` owns the conversation object by container Plan ID. `publishRuntimeEvent`
   records assistant text only for the active conversation and its planning Agent. `createPlanWrittenTool` no longer
   creates a conversation, formats its own label, or adds an event subscription. Shared setup in
   `requestHostedSessionInteraction` runs after authority and source checks; it resolves identity from
   `reviewContainerPlanId`, `planId`, then `triageMeta.planId`. Tool rebuilding and `dehydrateManagedSession` preserve
   the object and events array. Separate Sessions and unrelated Plans do not share events or token pages.
2. Capture continues across intermediate chat and planning feedback. Save, approval, and cancellation stop active
   capture. Retained per-Plan state is cleared on `HostedSession.dispose`. A Session-owned lifetime signal closes any
   standalone page retained between rounds through the review surface's `stop` wrapper, including registry cleanup. Do
   not use the interaction request signal for that lifetime: the broker aborts it after each answer.
3. Direct and reopened Epic review requests carry Architect chat metadata before presentation. Opening review alone
   makes no model request. The selected `planningAgentName` remains authoritative; ordinary Planner reviews and grouped
   Sequence reviews keep their existing Agent and decision rules.
4. The review response path preserves intermediate-chat intent where the shared owner needs it. A submitted message and
   attached notes reach Architect in the same Session. Architect's next `plan_written` updates the original standalone
   token page; Workspace receives the next live interaction and updates its answer URL. A second message uses the new
   round. No chat result authorizes execution or decomposition.
5. The existing shared sidebar shows Architect in its tab, composer, send action, replies, and working/error labels.
   Users can attach or remove current review notes. Changed Epic content replaces the reader and opens the before/after
   diff; an unchanged republication completes the chat without inventing a diff. Existing final feedback, approval,
   stale-review checks, and cancellation remain operational.
6. Focused automated tests cover the real saved/reopened Epic journey, two chat rounds, Agent handoff, revision
   delivery, and final decisions. Existing tests for authored Architect reviews, Planner chat, Sequence grouping, token
   protection, stale decisions, and cancellation retain their behavioral coverage. A fixture-only or label-only change
   cannot pass.
7. The linked Core and Workspace requirements and acceptance scenarios match the delivered behavior in the same change.
   Preserve unrelated local PRD edits. Keep any unmet broader Session or remote collaboration intent marked as target or
   deferred. Use the existing design-system artifact conversation pattern without a redesign.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

### Automated

Use the sandboxed runner, never `deno test` directly. Extend existing tests or add focused sibling tests as needed.

- `deno run -A scripts/run-tests.js src/cmd/load-plan/reopen-plan-review-shapes.test.ts src/cmd/load-plan/reopen-plan-review-behavior.integration.test.ts src/tools/__tests__/plan-written.test.js`
- `deno run -A scripts/run-tests.js src/ui/review/plan-review.test.ts src/ui/review/review-launcher.test.ts src/ui/workspace/owner-workspace.test.js src/ui/workspace/workspace-plan-review-ux.test.tsx`
- Run new conversation-owner and connected browser test files through `deno run -A scripts/run-tests.js <paths>`.
- `deno task workspace:check` and `deno task workspace:build`.

Required behavioral evidence:

- Start with a saved `PROJECT` Epic, once with omitted type and once with `type: epic`. Open direct review and reopen it
  through `/plan-review`. Assert Architect metadata and zero model calls before chat. Do not fabricate conversation
  metadata in the test adapter; use the production request path.
- Through the real standalone review server, send chat from that direct review. Use the controlled model boundary to
  confirm Architect instructions, receive the message and attached notes, change the saved Epic, and call
  `plan_written`. Assert the same conversation ID, URL, and token; observable assistant text; incremented revision; and
  actual revised Markdown. Send a second message and prove it reaches Architect and the next revision returns to the
  same page. This is the primary test that fails if the fix only adds a label, URL, or unused owner.
- Through Workspace review projection and answer handling, assert Architect labels, message delivery, a new live
  interaction, and a second answer to the new interaction. Exercise the browser surface to show the reply and updated
  document/diff, not only the server's metadata.
- Exercise attach and detach, an unchanged republication, an error, final Send Annotations, cancellation, Approve for
  Later, and Approve & Slice. Only the last action enters decomposition. Reject a stale approval as before.
- Prove strict conversation-object and events-array identity through tool rebuilding and dehydration, one copy of each
  assistant event, and no event leakage across Sessions or unrelated Plans. Final approval or cancellation stops active
  capture and closes the page. Send Annotations closes its page but still permits the normal planning response.
  Disposing a Session between chat rounds closes its retained server and clears registry/state even with no active
  interaction.
- Retain regression coverage for ordinary Planner reviews and grouped Sequence review. Only missing/wrong chat setup is
  expected to stop existing; no current review behavior is retired.

### Headed browser

Use `agent-browser --headed` in a named session specific to the execution worktree. Run `deno task workspace:dev` on an
available worktree-owned port; the default is `http://127.0.0.1:5173`.

1. At `/dev/plan-review?variant=project` and `/dev/workspace/plan-review?variant=project`, compare the Epic panel with
   the existing Planner panel. At 1440×1000 and 390×844, open the annotations sidebar and Architect tab. Check keyboard
   focus, composer/send behavior, working state, attachment removal, readable replies, and the revised document/diff.
2. Repeat two chat rounds against a real saved/reopened Epic on a standalone token page and a Workspace live review.
   Confirm the Agent is Architect, the first page stays usable, and final approval acts on the latest Epic. A
   development fixture alone is not evidence that the connection works.
3. Capture desktop and phone screenshots and inspect console/network failures. Confirm no duplicate chat UI, horizontal
   overflow, or missing approval actions. If credentials prevent the live model check, report that limit; do not claim a
   fixture proved the live journey.
4. Compare PRD scenarios with the observed behavior and test results. Confirm no glossary change or new visual pattern
   has been introduced without the matching documentation.

## Edge Cases & Considerations

- **Agent handoff:** Direct review can begin without Architect tools. Conversation ownership must survive the later tool
  creation; creating metadata separately in each caller recreates the defect.
- **Sequence distinction:** `PROJECT` does not always mean Epic. Keep Planner and grouped feedback for `type: sequence`.
- **Scope of continuity:** Preserve the existing live-page conversation behavior. A process restart opens a new review
  from saved Plan state; this change does not promise durable sidebar chat history.
- **Failure and cancellation:** Reuse current review error and recovery paths. Do not turn a timeout, stopped Agent, or
  chat failure into approval, decomposition, or user abandonment.
- **Compatibility:** No Plan schema migration, new injection seam, or new public chat endpoint is needed. Shared setup
  may also repair the same omission for saved Planner reviews; it must not change their workflow.
- **Execution style:** Autonomous implementation is suitable because the owner chose exact parity with the existing
  panel. Browser checks remain required; no new visual design decision is needed.
