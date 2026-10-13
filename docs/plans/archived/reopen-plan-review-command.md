---
planId: "4576bb13-1e2d-4af1-a32c-2ef682973314"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/cmd/registry.js"
    - "src/cmd/load-plan/plan-review-flow.ts"
    - "src/shared/session/file-session-store-types.ts"
    - "src/shared/session/file-session-control.ts"
    - "src/shared/session/session-runtime-interactions.js"
    - "src/shared/session/runtime/"
    - "src/shared/workflow/sequence-review.ts"
    - "src/ui/tui/slash-dispatch.ts"
    - "src/acp/server.js"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/islands/SessionSurface.jsx"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev"
devServerHmr: true
createdAt: "2026-09-24"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "1d62eac5494cbf5065827e689ec4ffd7b55ac5a6"
workRecord:
    status: "generated"
    recordId: "c306922c-8c08-42d2-851e-ee9b408b2778"
    path: "docs/work-records/2026-09-25-reopened-plan-reviews-across-all-session-surfaces.md"
    lastAttemptAt: "2026-09-25T20:34:50.680Z"
archivedAt: "2026-09-27T17:01:01.189Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/reopen-plan-review-command.md"
---

# Reopen the Last Plan Review with a Slash Command

## Context

An interrupted Plan Review currently requires another request to the model or selection through `/load-plan`. The user
wants a direct command to reopen the review just invoked.

The owner confirmed that this must work after quitting, resuming, or a crash, in the terminal, Workspace, and Agent
Client Protocol (ACP) clients. After restart, reopen the latest saved Plan, not the exact old page, review chat, or
unsent browser edits.

The owning requirements are [Core Plan review](../../prd/runwield-core-prd.md#plan-review) and
[Session continuity](../../prd/runwield-core-prd.md#session-continuity). Add a named requirement and acceptance
scenarios for reopening the last review without a model call. Preserve direct saved-Plan review, decision handling,
responsive waits, and [execution recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). Add
surface-specific scenarios and links under
[Workspace Browser Sessions](../../prd/runwield-workspace-prd.md#browser-sessions) and
[ACP Session access](../../prd/runwield-acp-protocol-prd.md#acp-session-access). These additions are proposed, not
shipped.

## Objective

`/plan-review` opens the most recently requested Plan Review in the current Session, without a planning turn to locate
or open it. The command works while review is pending and after Session restart. Existing approval, feedback, and
execution decisions retain their normal meaning.

## Approach

Use one shared Core operation, with surface adapters for opening or navigating to the review. Do not create a separate
review workflow.

```text
/plan-review
  live Plan Review -> open its current surface; retain the existing waiter
  no live review + idle Session -> read saved reference -> open current saved Plan
  unrelated active work -> explain that the Session is busy
  no reference or unavailable Plan -> explain; do not guess another Plan
```

Record a small optional `lastPlanReview` reference in the existing Session manifest before the review is presented.
Store Plan identity, its name for location/display, and the planning Agent needed for subsequent feedback. Use the
existing locked, atomic manifest-write path. Do not persist URLs, server tokens, callbacks, or a pending interaction.
This is a bookmark, not evidence of approval or workflow ownership.

The common request boundary is `requestHostedSessionInteraction()`. Plan associations are insufficient: they can remain
unpublished until turn settlement, and Sequence child associations do not identify the reviewed container. The reference
must survive a crash while `plan_written` is still waiting.

Track the live URL on the existing interaction, preserving `onSurfaceReady` callbacks. Reopening a live review must not
call the launcher's `beginReviewRound()` path or start another managed operation. Workspace uses the existing
live-operation connection when another local surface owns the wait.

For a stopped review, reuse the direct decision flow in `reviewLoadedPlanDirectly()` through shared Core orchestration.
The current Sequence branch invokes Planner; replace that branch with `prepareSequenceReview()` and the existing
Sequence decision functions so the complete saved Sequence can open without a model call. Feedback may then call Planner
or Architect; Approve & Run may start execution. The zero-model guarantee applies to opening, not those explicit
decisions.

This follows [ADR-015](../../adr/015-file-authoritative-session-bundles.md). A small clarification will distinguish a
saved review reference from a durable pending interaction. A separate storage service, replay of unfinished tool calls,
and browser-state snapshots are out of scope.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/registry.js` and a new command under `src/cmd/plan-review/` — command discovery, help, argument handling, and
  shared dispatch.
- `src/shared/session/file-session-{store-types,store,control,storage}.ts`, `managed-operation.ts`, and
  `runtime/managed-operations.ts` — durable reference and authorized reads/writes through existing Session storage.
- `session-runtime-interactions.js`, `session-runtime.ts`, `session-runtime-method-policy.ts`, and `runtime/` —
  recording, live surface lookup, and direct reopening without an Agent turn.
- `src/cmd/load-plan/plan-review-flow.ts`, `plan-session-surface.ts`, and `src/shared/workflow/sequence-review.ts` —
  reuse decision continuation, including complete Sequence review. `src/tools/plan-written.ts` remains a caller of the
  same decision rules.
- `src/ui/tui/slash-dispatch.ts` and input tests — allow live reopening instead of queuing behind the pending review.
- `src/acp/server.js` — advertise and dispatch the command, including a narrow live-reopen path during an active prompt.
- `src/ui/workspace/islands/SessionSurface.jsx`, `routes/owner-session-api.js`, and `server/session-continuation.js` —
  execute a command instead of sending model text; navigate to the review and preserve existing request receipts and
  authorization.
- `src/ui/review/` and interaction adapters — publish a usable live surface address without resetting the review.
- Existing storage, Runtime, command, review, and surface tests — prove restart, decision continuation, and duplicate
  prevention.
- The three PRDs linked above, `docs/adr/015-file-authoritative-session-bundles.md`, and
  `src/skills/runwield/COMMANDS.md` — document delivered behavior and its limits. Existing domain terms remain
  unchanged.

No visual redesign, new review controls, Code Review command, external shared-review feature, or general
command-framework rewrite is included. Workspace uses its existing command menu, messages, and review navigation from
`docs/design-system.md`.

## Reuse Opportunities

- `registerSessionArtifact()` and `FileSessionManifestCache.write()` — immediate proof-protected metadata persistence
  and recovery descriptors.
- `HostedSession.getActiveInteractions()`, Runtime snapshots, and Workspace's live-session connection — find the
  existing wait rather than duplicate it.
- `resolveWorkflowPlanLocation()` and existing Plan-ID resolution — locate authoritative current content and reject
  identity substitution.
- `getDirectPlanReviewEligibility()`, `reviewLoadedPlanDirectly()`, `decidePostPlanning()`, and
  `executePostPlanningDecision()` — preserve review eligibility and normal decisions.
- `prepareSequenceReview()`, `snapshotSequenceReview()`, `validateSequenceReviewDecision()`, and
  `applySequenceReviewDecision()` — preserve child order, review evidence, and one application of a decision.
- Real Session storage, Git fixtures, Runtime command fixtures, and existing browser/Agent boundary doubles — no new
  injection seam for owned storage or lifecycle machinery.

## Implementation Steps

1. **The last review is durable before presentation.** A named optional reference type and Session-store accessors
   retain canonical Plan identity and the originating planning Agent. The writer requires the current managed-operation
   proof and writes immediately through `FileSessionManifestCache`. `requestHostedSessionInteraction()` records each
   Plan Review request from `plan_written`, direct loading, and recovery before invoking its adapter. A Sequence records
   its container, not its last child. Cancellation, generation settlement, and ordinary recovery preserve the reference;
   the next review replaces it. Old manifests without the field remain readable.

2. **Live reopening preserves the original review.** Core retains the surface address on the active interaction using a
   composed `onSurfaceReady` callback. TUI, ACP, and Workspace publish their actual usable address. The shared reopening
   operation returns that surface without another interaction, review round, Agent call, writer, or decision handler. If
   the page is still starting, report that state rather than launch a duplicate. Repeated commands and a racing decision
   cannot apply a decision twice. A retry confirmation still owned by the existing workflow cannot create a parallel
   review.

3. **Stopped and resumed reviews use current authority.** A shared Core operation exposed through `SessionRuntime` reads
   the saved reference, resolves the current Plan by identity through existing Plan-location rules, and opens it under
   the normal managed-operation lock without activating a model. It uses current content and current review evidence,
   not cached metadata or an obsolete URL. It reuses or extracts the existing direct-review continuation so feedback
   reaches the correct planning Agent and approval follows readiness and workflow dispatch in the same stable Session.
   Register the Runtime method in its method policy. No reference, missing Plan, mismatched identity, unsupported
   lifecycle status, or unrelated active work produces a clear result without choosing another Plan or resetting
   lifecycle state.

4. **All supported Plan shapes reopen without a model call.** Ordinary Plans, PROJECT Epics, and complete Sequences use
   the shared direct flow. The Sequence-specific Planner call in `reviewLoadedPlanDirectly()` is replaced by
   saved-document preparation and the existing Sequence validation/application logic. Approval for later, feedback with
   document identity and images, execution of the first approved child, and Epic decomposition retain their existing
   meanings. The original live waiter alone handles live decisions; the new direct waiter alone handles restarted
   decisions. Opening never grants approval or starts execution.

5. **The command works through all three real dispatch paths.** `/plan-review` is a slash-only, no-argument built-in
   advertised in terminal, Workspace, and ACP command catalogs. Help explains the current-Session scope and restart
   behavior. TUI treats it as immediate while streaming. ACP permits live reopening before the active-prompt rejection
   without replacing the running prompt, adapter, or subscription; ordinary concurrent prompts remain rejected.
   Workspace handles it as a command through its authorized Session API and existing operation/receipt handling, not
   `promptUserTurn()`. It opens the current surface using normal browser navigation; ACP returns a usable text link.
   Empty Sessions do not create storage merely to report no prior review.

6. **Recovery and surface tests prove the result.** Add focused tests at the boundaries below, including a fresh-process
   crash case and actual command dispatch. A saved-reference-only test or command-catalog assertion is insufficient.
   Preserve existing direct-review decision tests when moving code; tests are rewritten against the shared owner rather
   than deleted. Browser integration proves navigation and a working decision, not only a successful API response.

7. **Documentation matches delivered behavior.** Core owns the new requirement and scenarios; Workspace and ACP link it
   and describe their command behavior. Update command help and `COMMANDS.md`. Clarify ADR-015 that the saved reference
   supports explicit model-free reopening, while pending waits and unsent browser state remain non-durable. Retain
   existing Session lock and Plan authority rules. Keep any unmet intent labeled target or deferred rather than claiming
   completion.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

Run focused tests with the sandboxed runner. Add the named new suites or equivalent focused files and update commands to
their final paths:

```sh
deno run -A scripts/run-tests.js src/cmd/plan-review src/shared/session/file-session-store.test.js src/shared/session/file-session-store-owner.test.ts src/shared/session/session-runtime.test.js
deno run -A scripts/run-tests.js src/cmd/load-plan/index.integration.test.ts src/shared/workflow/sequence-review.test.ts src/shared/workflow/plan-review-recovery.test.js src/ui/review/plan-review.test.ts src/ui/review/review-launcher.test.ts
deno run -A scripts/run-tests.js src/cmd/__tests__/registry.test.ts src/ui/tui/slash-dispatch.test.ts src/ui/tui/chat-input-controller.test.ts src/acp/server.test.js
deno run -A scripts/run-tests.js src/ui/workspace/owner-workspace.test.js src/ui/workspace/browser/session-commands.test.ts src/ui/workspace/workspace-session-ux.test.tsx
deno run -A scripts/run-tests.js src/ui/tui/golden-scenarios/slash-command-coverage.test.ts src/ui/tui/golden-scenarios/slash-command-terminal.test.ts
```

Required behavioral evidence:

- **Crash before settlement:** start a real file-backed Session in an isolated process, request review, and terminate
  that process while the tool/interaction is pending. Resume the stable Session in a fresh process and invoke the
  command. Assert the correct Plan opens and model-call count stays zero until a review decision. Do not pre-seed
  `lastPlanReview` or orderly-close the first Runtime as a substitute for this case. Also cover ordinary quit/resume and
  cancellation.
- **Correct target and content:** invoke reviews for A then B, edit B on disk after interruption, and create a newer
  unrelated C. Reopen B with its latest content. A second Session must not inherit B. Cover direct `/load-plan` entry
  and a Sequence whose children have their own associations.
- **Live reuse:** invoke the command repeatedly through actual terminal, Workspace, and ACP dispatch while the original
  review waits. Assert one interaction and one review round, the same usable surface, no extra model call, and exactly
  one resulting workflow decision. ACP's original request remains valid. Cover a late callback/decision racing with the
  command and the retry-prompt collision.
- **Resumed decisions:** from a reopened ordinary Plan, submit feedback and verify its contents/images reach the proper
  planning Agent in the same Session; separately approve for later and approve/run. For a Sequence, verify all saved
  documents and order, combined feedback, and first-child execution. Verify PROJECT decomposition and cancellation
  remain normal. Model doubles are allowed only at the existing Agent boundary.
- **Safe limits:** no prior reference, old manifest, deleted Plan, same name with a different ID, archived/completed
  Plan, unrelated active turn, and launch failure give truthful messages. They produce no implicit approval, lifecycle
  reset, model request, or fallback to another Plan. Preserve reference across segment rollover and normal
  recovery-descriptor reconstruction.
- **Existing protections:** stale meaningful changes still reject an outdated decision; formatting-only changes retain
  current behavior. Readiness and execution-policy checks remain. No Objective-Failing Checks return. Reopening in one
  surface must not seize another surface's writer lock.

For browser proof, build with `deno task workspace:build`, then use an isolated real owner Workspace and saved Session.
The `/dev` server is useful for component work but is not proof of Session recovery. In a named headed `agent-browser`
session scoped to the execution worktree: select `/plan-review` from the command menu, confirm live navigation, cancel
the review, resume the Session after process restart, type `/plan-review`, inspect the current saved Plan, and submit
feedback. Capture the actual URL, accessibility snapshot, console/network failures, and resulting Session event. Also
exercise the returned ACP link in the browser. Do not use or stop another worktree's server.

Review the changed PRD scenarios, command docs, and ADR against these results. Full project CI is supplied by the normal
workflow, not substituted for this evidence.

## Edge Cases & Considerations

- **Reviewable assumptions for approval:** the public name is `/plan-review`, with no arguments. The command targets the
  current Session only. Existing direct-review eligibility applies; unsupported later lifecycle states get guidance to
  normal Plan actions rather than a silent reset. An unrelated busy Session gets an immediate explanation rather than a
  queued model prompt.
- **Older Sessions:** no best-effort inference from prose or newest files. Without a recorded reference, explain that no
  prior Plan Review is available; `/load-plan` remains the explicit selection route.
- **Changed locations:** use existing identity and worktree authority checks. Do not let a primary-checkout copy shadow
  the editable worktree Plan. Do not open a different Plan because a name was reused.
- **Crash recovery:** a persisted reference is not permission to bypass Session recovery or replay external effects.
  Reuse existing recovery and writer handling; ordinary interrupted review must recover without manual lock or metadata
  repair.
- **Browser state:** a live page retains its current state. After process loss, only saved Plan content is promised.
  URLs and browser tokens stay transient.
- **Concurrent repository work:** planning found unrelated dirty edits in Core review actions, PRDs, and Workspace UI.
  This Plan does not overwrite them. Recheck current source at execution and preserve those changes and their regression
  coverage.
