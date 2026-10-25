---
planId: "08032c37-cfaf-4b45-baa9-0711248f9423"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/coordinator.ts"
    - "src/ui/workspace/react/CodeReviewSurface.tsx"
    - "src/attached/claude/mcp.ts"
    - "src/cmd/attached/index.ts"
    - "src/shared/workflow/validation-host-turn.ts"
    - "src/shared/workflow/validation-host-contract.ts"
    - "src/shared/workflow/validation-mechanical.ts"
    - "src/shared/workflow/validation-supervisor.ts"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/adr/014-attached-workflow-coordination-boundary.md"
    - "docs/user-documentation/connect-claude-code.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-24T23:33:01.175Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 11
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
status: "reviewed"
---

# Repair integration findings 2

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at
`001e8d985b39ecef20edacbd03adbbbfc9b1686f` and reported 7 findings. The full report is
`docs/plans/attached-mode-claude-feature-preview/integration-report.md` in the primary checkout. After this child is
delivered, the integration gate runs again on the whole Epic.

Planning sorted the findings:

| Finding                                      | Decision              | Reason                                                                                                                                                                                                                                               |
| -------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Project checks fail                       | **Dismissed**         | Environmental, as in child 10. The gate's temporary checkout had no `node_modules` ("Cannot find package 'typescript'", "Cannot find module '@astrojs/check'") and no initialized `third_party/plannotator` submodule. No source defect is reported. |
| #2 No deterministic planning mutation gate   | **Dismissed**         | Owner decision (2026-10-07, repeated in child 10): Connect adds no hooks or tool restrictions, as in Core. ADR-014 and the Epic on this branch say so. The gate reads main's old Epic copy, which still contains the removed Planning Gate text.     |
| #3 Two Attached workflows implement one Plan | **Dismissed**         | Owner decision (child 10 #4): an Attached Workflow Record references its Plan and does not own it. The Epic on this branch puts single-Plan ownership out of scope. Main's old Epic copy still has "One workflow has one consequential owner".       |
| #4–#7                                        | **Fix in this child** | Real defects in the Epic's Attached code, described below.                                                                                                                                                                                           |

> [!NOTE]
> **The gate can raise #1–#3 again**
>
> Until the user's separate gate fixes land (dependencies in the gate checkout, Epic read from the Epic branch), the next
> gate run can report these findings again. They are dismissed on purpose.

The fixes keep these PRD requirements:

- [Connect: Shared Plan and verification outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes):
  "Browser Feedback becomes a `human_feedback` action for a fresh Claude repair worker" and "Only structured browser
  decisions approve or reject."
- Connect, **Keep review chat temporary**: raw chat never persists past the round. Only Claude's short change summary
  is stored. This child extends that rule to Plan changes, which today store nothing.
- [Connect: Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery):
  "Closing Claude or the review page does not abandon delivery." Process loss keeps work resumable.
- The Epic's coordination contract: "Repeated submission returns the recorded result without repeating effects."

## Objective

Fix findings #4–#7 on the Epic branch so that:

- **#4** Send Annotations on the Attached code review page records a structured Feedback decision.
- **#5** A Plan change requested in review chat keeps its change summary on the pending Planner action until a revised
  Plan is submitted.
- **#6** When Claude closes the MCP stdin, the MCP process stops its running Core checks and exits. The workflow stays
  resumable, and the next resume runs the checks again.
- **#7** A retried `review_reply` with the same `operationId` returns the saved result and repeats no effect.

## Approach

Each fix goes through the module that already owns the behavior. No new workflow state, record field, or seam.

### #4 Send Annotations records Feedback in Attached mode

The Oct 8 Core change "Improve Code Review repair flow" (`3fef18522`) sends annotations to the review conversation when
chat is enabled. In Core, that conversation agent repairs code live. In Attached mode, the chat is answered by the
coordinating Claude session and can only reply, so the annotations become a queued chat turn and no decision is saved.

The review page already knows who owns agent turns: `review-host.ts` passes `agentTurnOwner: "host"`, and
`review-launcher.ts` puts it in the page payload.

```diff
 async function submitFeedback() {
-    if (conversationEnabled) {
+    if (conversationEnabled && initialPayload.agentTurnOwner !== "host") {
         setRightSidebarView("agent");
         await sendAgentMessage(true);
         return;
     }
     submit("feedback", { approved: false, ...buildReviewPayload() })
```

The structured path already works: `applyAttachedCodeReviewDecision` turns `approved: false` plus annotations into a
`validation_decision` Feedback and a `human_feedback` repair (`delivery-review.test.ts` covers it). The Plan review page
already behaves this way. Users can still ask Claude about annotations through the existing "attach to conversation"
control (`attachReviewContextToConversation`).

Set aside: removing the redirect for everyone. It would change Core's live-repair review flow, which is not in scope.

### #5 Keep the Plan change summary

`reviewReply` (`coordinator.ts`, Plan round with `change`) saves a Planner action with the fixed note "Revise the Plan
as discussed in this Claude session…" and drops `change.summary`. A fresh Claude conversation then has nothing to
revise from.

```diff
 pendingAction: {
     actionId, role: "planner", contractVersion,
-    note: "Revise the Plan as discussed in this Claude session, then call plan_written. No Feedback decision was recorded.",
+    note: "The user requested this Plan change in review chat: <change.summary>. Revise the Plan, then call plan_written. No Feedback decision was recorded.",
 }
```

`get_instructions` already returns the pending action as `context`, and the Planner role instructions already say to
read its note. `reconcilePlanPosition` leaves `awaiting_planning` records unchanged, so the note survives until
`plan_written` replaces the pending action. The summary is Claude-written, short, and bounded by `MAX_SUMMARY_LENGTH`.
It is not chat text, so the privacy rule holds. **Assumption (reviewable):** the summary goes in `note`, not
`feedback`, because no Feedback Plan Event exists for a chat change.

### #6 Stop owned Core work on MCP shutdown

Today stdin EOF closes the transport and review pages. `runAttachedMcpServer` then returns, but the process keeps
running in-flight operations. CI runs in its own process group (`foreground-process.ts`, `detached: true`), so even a
process exit would leave it running.

`runValidationCommand` already accepts an `AbortSignal` and returns `{ kind: "canceled" }`. The fix carries one
shutdown signal from the MCP carrier to that call:

```text
mcp.ts  shutdown = new AbortController()
  runAttachedOperation(name, root, text, { signal })
    runParsedOperation / readStatus
      runValidationOperation(..., signal)
        continueHostTurnValidation({ ..., signal })
          engine hostTurn: { resume, signal }
            validation-mechanical: runValidationCommand({ cwd, settingsPolicy, signal })
```

When CI is canceled because `hostTurn.signal` aborted, the mechanical phase throws a new `ValidationHostShutdown`
before it records CI evidence, a metric, a repair attempt, or a user pause. Recovery then works like process loss:

```text
on stdin EOF / transport close
  closing = true
  stop hosted review pages
  shutdown.abort()            -> CI process group is killed
  wait for in-flight operations to settle (grace period, then give up)
  return -> runAttachedCommand exits the process

in the in-flight operation
  mechanical: CI canceled and hostTurn.signal aborted -> throw ValidationHostShutdown
  supervisor: rethrow; do not settle it as an operational failure
  coordinator catch: restore the claimed record with holder cleared (existing path)
next resume (status or start_validation in a new process)
  dead Plan claim owner is reclaimed -> CI runs again
```

The progress interval is already muted by `closing`, and it is cleared when the operation settles. The `status` wait
loop also stops when `closing` is true.

> [!TIP]
> **Why throw instead of using the canceled branch**
>
> The existing canceled branch asks the user to Retry or Stop. Closing Claude is not a user choice to stop the tests,
> so asking would be wrong. The coordinator's generic error path already restores a resumable claim.

**Assumption (reviewable):** the grace period is 10 seconds. An operation still running after that (for example a slow
push) is cut off like a crash. The publication state machine reconciles that case on restart (ADR-016).

Set aside: exiting the process at once. On macOS, process-group termination is asynchronous (`stopAndKillMacProcessGroup`
takes up to 1 second), so an immediate exit can leave CI running.

### #7 Replay review replies

`reviewReply` checks `expectedRevision` before it looks for a saved receipt. It then treats a saved receipt as
`action_superseded`. Every other operation replays first (`checkWorkflowOperation`).

```diff
 reviewReply (inside the record transaction)
   workflow missing -> workflow_not_found
+  saved = current.acceptedOperations[operationId]
+  if saved -> return saved.result as operation "review_reply"
   reconcilePlanPosition ...
   revision check ...
-  if turn mismatch or acceptedOperations[operationId] -> action_superseded
+  if turn mismatch -> action_superseded
```

The code-review `change` path saves its receipt through `runValidationOperation("validation_decision")` under the same
`operationId`. The replay returns that receipt with `operation: "review_reply"`. When the retried payload has a
`change`, the replay adds `reviewReply` from the envelope, as the first call does, so the page can show the answer.
Receipts stay chat-free (`withoutAttachedChat`).

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/react/CodeReviewSurface.tsx` — `submitFeedback` redirects to chat only when Core owns agent turns
  (#4). The payload type may need `agentTurnOwner`.
- `src/shared/attached/coordinator.ts` — `reviewReply` keeps the change summary (#5) and replays saved receipts first
  (#7). `runAttachedOperation`, `runParsedOperation`, `readStatus`, and `runValidationOperation` pass an optional
  shutdown signal to `continueHostTurnValidation` (#6).
- `src/attached/claude/mcp.ts` — owns the shutdown `AbortController`, tracks in-flight operations, stops the status wait
  loop on close, and waits a bounded time for in-flight work (#6).
- `src/cmd/attached/index.ts` — exits the process after `runAttachedMcpServer` returns (#6).
- `src/shared/workflow/validation-host-contract.ts` — `ValidationHostTurn` gains `signal?: AbortSignal`, and
  `ValidationHostShutdown` is defined next to `ValidationHostWait` (#6).
- `src/shared/workflow/validation-host-turn.ts`, `validation-mechanical.ts`, `validation-supervisor.ts` — carry the
  signal to CI, throw `ValidationHostShutdown`, and rethrow it without settling an operational failure (#6).
- `docs/prd/runwield-connect-prd.md`, `docs/adr/014-attached-workflow-coordination-boundary.md`,
  `docs/user-documentation/connect-claude-code.md` — delivered behavior for #4, #5, and #6.
- Tests named in the Verification Plan.

Out of scope: the Core Session review conversation, Core's canceled-CI user pause, and the `wld attached` CLI carrier's
own signal handling (a CLI call is one short process the user controls). `docs/domain-language.md` needs no change; no
term is added or redefined.

## Reuse Opportunities

- `applyAttachedCodeReviewDecision` (`src/shared/attached/code-review-decision.ts`) — the existing structured Feedback
  path (#4).
- `checkWorkflowOperation` (`coordinator.ts`) — the replay-first order to copy (#7).
- `runValidationCommand` `signal` and `spawnForegroundShell` process-group termination
  (`src/shared/workflow/validation-local-ci.ts`, `src/shared/foreground-process.ts`) — CI cancellation (#6).
- The `runValidationOperation` catch block and `ownerIsAlive` dead-owner reclaim (`validation-supervisor.ts`) — resume
  after shutdown (#6).
- `attachedValidationFixture`, `toDelivery`, `spawnAttachedCli`, `CLI_PATH`, `DENO_CONFIG_PATH`,
  `runtimeSourceArgs` — real MCP subprocess fixtures, as in `mcp-validation-progress.slow.test.ts` and the stdin EOF
  tests in `mcp-review-recovery.test.ts`.
- `review-chat-test-fixture.ts` (`reply`, `pendingChat`, `sendChat`) — chat tests (#5, #7).

## Implementation Steps

### Send Annotations (#4)

- In `CodeReviewSurface.tsx`, `submitFeedback` calls `sendAgentMessage(true)` only when `conversationEnabled` is true
  and `initialPayload.agentTurnOwner !== "host"`. Otherwise it submits `{ approved: false, ...buildReviewPayload() }`
  through `submit("feedback", …)` and shows the submitted Feedback state.
- With `agentTurnOwner: "host"`, the Send Annotations click sends no request with `conversationTurn: true`.
- Core review pages (no `agentTurnOwner`, or `"core"`) keep the chat redirect.

### Plan change summary (#5)

- In `reviewReply`, the Planner action created for a Plan-round `change` has a `note` that contains
  `envelope.payload.change.summary` verbatim, says to revise the Plan and call `plan_written`, and says no Feedback
  decision was recorded.
- `get_instructions` for that action, in a fresh process, returns `context.note` containing the summary.
- After `plan_written` accepts the revision, the pending action no longer carries the summary.
- The saved record contains no raw chat text or reply text after the change.

### MCP shutdown (#6)

- `runAttachedOperation` accepts an optional final argument `{ signal?: AbortSignal }`. It passes the signal through
  `runParsedOperation` and `readStatus` to `runValidationOperation`, then to `continueHostTurnValidation`, then into
  `ValidationHostTurn.signal` (`validation-host-contract.ts`). Callers that pass no signal keep today's behavior.
- `validation-mechanical.ts` passes `args.hostTurn.signal` to both `runValidationCommand` calls in host-turn mode.
- `ValidationHostShutdown` (exported next to `ValidationHostWait`) is thrown when host-turn CI returns `canceled` and
  `hostTurn.signal` is aborted. It is thrown before `recordDeliveryEvidence`, `recordMetric`, and
  `pauseForUserAction`.
- `continueValidationAttempt` in `validation-supervisor.ts` rethrows `ValidationHostShutdown` without calling
  `operationalFailureResult` or settling a failure. The coordinator's existing catch restores the claimed record with
  `holder` cleared.
- `runAttachedMcpServer` creates one `AbortController`, passes its signal to every `runAttachedOperation` call, and
  tracks in-flight calls. On transport close it sets `closing`, stops hosted reviews, aborts the controller, waits up to
  10 seconds for in-flight calls to settle, and returns.
- The `status` wait loop ends when `closing` is true.
- `runAttachedCommand` calls `process.exit(0)` after `runAttachedMcpServer` returns.

### Review reply replay (#7)

- In `reviewReply`, a saved `acceptedOperations[envelope.operationId]` is checked after the workflow lookup and before
  `reconcilePlanPosition` and the revision check. It returns the saved result with `operation: "review_reply"`. When
  `envelope.payload.change` is set, the result also carries `reviewReply: { turnId, text }` from the envelope.
- A saved receipt is no longer a reason for `action_superseded`. A different `operationId` for an answered turn still
  returns `action_superseded`.
- A replay writes nothing to the record or the Plan and issues no new `validation_decision`.

### Documentation

- In the [Connect PRD](../../prd/runwield-connect-prd.md):
    - **Keep review chat temporary:** a Plan change stores only Claude's short change summary on the pending Planner
      action until the revised Plan is submitted; it records no Feedback.
    - **Answer review chat:** the acceptance scenario says a Plan change survives a fresh process as the pending
      Planner action with its summary, and a retried reply with the same operation id returns the saved result.
    - **Return saved Code Review decisions:** Send Annotations on the Attached code page records Feedback; chat stays
      for questions and Claude-summarized changes.
    - **Lazy project setup and recovery:** closing Claude stops running Core checks; the next resume runs them again
      and records no failure for the stopped run.
- `docs/user-documentation/connect-claude-code.md` step 6 says Send Annotations sends structured Feedback. The resume
  section says closing Claude stops running checks and `/runwield:validate` runs them again.
- ADR-014's sentence about the MCP process stopping review surfaces on transport close also covers running Core checks.

## Verification Plan

Run focused tests with `bun scripts/run-tests.js <paths>`. RunWield runs the full `bun run ci` after implementation.

Each new test fails on the current Epic branch:

- **#4** — in `src/ui/workspace/standalone-review-refresh.test.tsx` (or a new `CodeReviewSurface` render test using
  the same happy-dom setup):
    - Render `CodeReviewSurface` with `conversationStatusUrl`, `savedConversation: true`, and `agentTurnOwner: "host"`.
      Add one annotation and click Send Annotations.
    - Expect one POST to the decision endpoint with `approved: false` and the annotation, and no body with
      `conversationTurn: true`.
    - The same render without `agentTurnOwner` still sends a conversation turn.
    - Fails today because the host page sends a conversation turn.
- **#5** — in `src/shared/attached/plan-review-chat.test.ts`, extend "a Plan change from chat has no Feedback…":
    - After `reply(…, { change: { summary: "Use a selector" } })`, call `get_instructions` through
      `spawnAttachedCli` (a fresh process). Expect `context.note` to contain "Use a selector".
    - After `plan_written`, the record bytes no longer contain "Use a selector", and they never contain the raw chat or
      reply text.
    - Fails today because the note has no summary.
- **#6** — new `src/attached/claude/mcp-shutdown.test.ts`, modeled on `mcp-validation-progress.slow.test.ts`:
    - The fixture CI command writes its shell pid to an absolute temporary path outside the worktree, then
      `exec sleep 600`.
    - Start `wld attached mcp`, call `start_validation` without waiting, and wait for the pid file.
    - End the MCP stdin. Expect the MCP process to exit within 15 seconds and `process.kill(pid, 0)` to throw `ESRCH`.
    - Change the project validation command to one that exits 0. A fresh `spawnAttachedCli("start_validation", …)`
      runs CI and returns a `validation` action with `request.kind === "reviewer"`. Delivery evidence has no canceled
      CI entry, and no `decision` request was issued.
    - Fails today because the MCP process and `sleep` keep running after EOF.
- **#7** — in `src/shared/attached/plan-review-chat.test.ts` and `code-review-chat.test.ts`:
    - Plan round: a `change` reply succeeds; repeating the same envelope (old `expectedRevision`, same `operationId`)
      returns `ok: true` with the same `nextAction.actionId`, and the record revision is unchanged.
    - Code round: repeating the `change` reply with the same `operationId` returns `ok: true` with the same repair
      `actionId`. The repair prompt does not contain the retried payload's different summary.
    - Fails today with `revision_conflict` or `action_superseded`.

Existing coverage:

- **Must still pass unchanged:** `delivery-review.test.ts` (structured Feedback with images), `review-host.test.ts`,
  `mcp-review-recovery.test.ts` (stdin EOF stops review pages), `mcp-validation-progress.slow.test.ts`,
  `mcp-validation-no-progress.slow.test.ts`, `validation-host-turn*.test.ts`, `validation-loop-core.test.js` and
  `validation-loop-delivery.test.js` (Core canceled-CI pause), `workspace-code-review.integration.test.ts`, and `mcp.test.ts`. These protect Core's chat
  redirect, Core's canceled-CI pause, CI progress, and review-page shutdown.
- **Expected to change:** in `code-review-chat.test.ts`, the `duplicate` reply that reuses `operationId`
  `"code-answer"` and the `replay` reply that reuses `"code-change"` now return the saved `ok: true` result instead of
  `action_superseded`. Rewrite them as replay assertions: no new effect, and the retried text or summary is not applied.
  Do not delete them. The cases that use a new `operationId` for an answered or closed turn keep `action_superseded`.

Documentation check: the Connect PRD, Claude guide, and ADR-014 describe the delivered behavior for #4, #5, and #6.

## Edge Cases & Considerations

- **Retry with a changed payload:** a retry that reuses an `operationId` with different text returns the first result.
  This matches every other operation. The page shows the retried envelope's `reviewReply` text; that is a client bug,
  and the record is not changed.
- **Shutdown outside CI:** an operation in a short Git or record step finishes inside the grace period. A longer step,
  such as a push, is cut off like process loss, and the publication machine reconciles it on restart.
- **Shutdown during a host wait:** no Core work runs while Claude owns a turn, so nothing needs cancellation; the saved
  host request stays.
- **Annotations with chat enabled:** after #4, the host page still lets the user attach annotations to a chat message.
  Only Send Annotations changes.
- **Re-raised findings:** #1–#3 can return on the next gate run until the separate gate fixes land.
