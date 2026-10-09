---
planId: "e81c84ba-087d-40ec-8c4a-e9ce6c311993"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/tools/task-completed.ts"
    - "src/shared/session/background-tasks.ts"
    - "src/shared/session/runtime/turns.ts"
    - "src/shared/session/hosted-session.js"
    - "src/tools/__tests__/task-completed.test.js"
    - "src/shared/session/background-task-stop.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-28"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "5be1259b7142d27873e80d5d60cdb7c5c110b4ec"
workRecord:
    status: "generated"
    recordId: "3307f365-4b4b-4dee-ba39-49fb7d3f7f06"
    path: "docs/work-records/2026-09-28-stopped-background-results-after-task-completion.md"
    lastAttemptAt: "2026-09-28T23:02:58.893Z"
archivedAt: "2026-10-08T19:26:17.522Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/task-completion-background-cleanup.md"
---

# Stop Background Results After Task Completion

## Context

Late Background Task results currently reach Agents after `task_completed`. The owner reports that these results confuse
models and spend tokens after the assigned work is complete.

`createTaskCompletedTool` accepts completion without checking `HostedSession.backgroundTasks`. That registry survives
normal turns. `RuntimeTurns` delivers finished results through root steering or a generated result turn. Stop and host
shutdown already cancel tasks and suppress pending results, but Task Completion does not.

The owner approved **warn once, then cancel and complete on retry**. A normal turn ending is not Task Completion.

Owning requirements:

- [Core: Session continuity](../prd/runwield-core-prd.md#session-continuity), **Run bounded background work** and
  **Receive task results without another user message**: add the completion warning and cleanup boundary. Change the
  unconditional later-result promise to exclude results suppressed by accepted Task Completion.
- [Core: Execution, validation, and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve
  accepted completion as the handoff to validation and delivery. Background cleanup must not abort that workflow or
  count cancelled checks as passed.
- Preserve normal-turn delivery, read-only delegation, process-local task ownership, task limits, status/log access,
  Stop/shutdown behavior, and pending interaction authority.

These are proposed changes, not claims of delivered behavior.

## Objective

An eligible first `task_completed` call with running Background Tasks rejects completion and identifies those tasks. The
next eligible call cancels any remaining tasks and accepts completion. Every accepted completion also suppresses
undelivered background results, even when no tasks remain running.

No result from the completed work may cause a later steering delivery or generated model turn. Later work in the same
Session must still be able to use Background Tasks.

## Approach

Keep the policy in the shared completion and Session owners, not in TUI, Workspace, or ACP adapters.

```text
eligible task_completed
  existing execution-owner and Pair checks
  running tasks + no prior warning for this completion cycle
    return rejection, list tasks, explain retry cancellation
  otherwise
    suppress old pending results and stop new delivery of them
    cancel remaining tasks and await settlement
    remove undelivered background steering
    record and emit accepted Task Completion
    continue the existing workflow
```

Place the background gate immediately before `recordAcceptedTaskCompletion`, after existing checks and final Pair
assent. A rejected owner check or a final Pair checkpoint is not an eligible completion attempt. It must not arm the
retry or cancel tasks.

Reuse `BackgroundTasks.cancelAllAndSuppress`, extending its lifecycle behavior only as needed. Keep task records and
logs available. Use the registry as the authority for whether a result can still be delivered. Recheck that authority
after asynchronous waits and before a generated turn reaches the model.

The runtime must also handle a result already queued for root steering. Clearing the registry alone cannot retract that
queue entry. Reuse the queue-preservation patterns in `runtime/queues.ts`; remove only background-owned input and its
subscription. Preserve user steering, images, and queued follow-ups. Do not call the broad Stop path, which also aborts
foreground work.

Use process-local, completion-owner-scoped warning state, not a new tool argument or durable Plan field. A retry can use
a different tool-call ID and report. Ordinary polling or waiting must not rearm the first warning.

Define a completion cycle through existing ownership: for active workflows, use the execution owner, Plan/attempt
identity, and validation generation or repair invocation; for no-Plan work, use the accepted user request. Preserve the
cycle across backend retries, tool reconstruction, and generated result turns. Reset on accepted completion, explicit
Stop, or entry into a different cycle, not on workflow metadata refresh. Reopen delivery only when new non-generated
work is accepted, including automatic validation repair, rather than on a rejected user submission. Old task records
remain ineligible after reopening.

Immediate cancellation on the first call was set aside because the warning gives the Agent a chance to inspect
unfinished tests or research. Repeated rejection was set aside because it could block completion indefinitely.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/tools/task-completed.ts` — warning response, retry policy, and cleanup before completion publication.
- `src/shared/session/background-tasks.ts` — running-task snapshots, suppression, cancellation settlement, and safe
  delivery for later tasks.
- `src/shared/session/hosted-session.js` and `task-completion-session.ts` — existing completion ownership and
  process-local state; preserve durable accepted-completion handoff.
- `src/shared/session/runtime/turns.ts`, `runtime/queues.ts`, and `session.js` — prevent stale steering and
  generated-result delivery through real runtime queues, without clearing user input.
- `src/tools/__tests__/task-completed.test.js` and Session background-task tests — prove warning, cancellation, result
  suppression, and later reuse.
- `src/agent-definitions/frontend-engineer.md` and `subagent-definitions/reviewer-feedback-engineer.md` — qualify
  existing “exactly once” instructions so a rejected completion can be retried. Inspect other completion guidance for
  the same conflict; do not duplicate runtime policy in every prompt.
- `docs/prd/runwield-core-prd.md`, `docs/domain-language.md`, and `docs/sessions.md` — align requirements, scenarios,
  Background Task, and Task Completion definitions with the delivered boundary.
- `docs/adr/010-session-runtime-sibling-adapters-and-acp.md` — clarify the existing shared-runtime decision: normal-turn
  survival does not permit delivery after accepted Task Completion. No new architecture document is needed.

No dashboard, new browser behavior, cross-process control, persisted task recovery, or Plan lifecycle state is added.
Surface adapters should need no policy changes.

## Reuse Opportunities

- `BackgroundTasks.status`, `cancel`, `wait`, `cancelAllAndSuppress`, and `pendingCompletions` already own task state
  and settlement.
- `RuntimeTurns.drainBackgroundResults` and the `generatedTaskId` eligibility check already control automatic result
  delivery.
- `runtime/queues.ts` preserves other queued input while removing a selected message; use this established behavior
  rather than clearing all input.
- `recordAcceptedTaskCompletion` already publishes accepted completion only after eligibility checks. Keep rejection
  outside its journal, event, and metric effects.
- `withRuntimeCommandFixture` provides real SessionRuntime execution with a controlled model boundary. Existing
  background tests use actual shell processes and isolated delegation.

## Implementation Steps

1. **The regression is observable through the runtime.** A focused new
   `src/shared/session/background-task-completion.test.ts` drives `background_task`, `task_completed`, and model
   requests through `withRuntimeCommandFixture`. Before the fix, it demonstrates the missing warning or a late result
   request. The fixture does not replace task ownership, completion, or delivery with stubs.
2. **Completion warns exactly once per eligible completion cycle.** `createTaskCompletedTool` returns
   `outcome: "rejected"`, reason `background_tasks_pending`, and `terminate: false` on the first eligible call with
   running tasks. Its text lists current task IDs and kinds, points to status/cancel, and states that another eligible
   call cancels remaining work. It emits no accepted completion record, workflow message, completion metric, or
   validation handoff. Existing invalid-owner, execution-not-started, paused-Pair, and final-checkpoint paths retain
   precedence and do not arm the warning.
3. **A retry settles background work before acceptance.** The next eligible call suppresses old results, cancels all
   remaining tasks in the owning Session registry, and waits for task settlement before calling
   `recordAcceptedTaskCompletion`. If tasks finished or were cancelled between calls, it accepts without another
   warning. With no running tasks on the first call, it accepts directly but still suppresses undelivered results.
   Cancellation retains truthful task outcomes and logs; it never becomes evidence of a passed check. Cleanup failure
   cannot publish successful completion.
4. **Accepted completion prevents late background input.** `BackgroundTasks` and `RuntimeTurns` prevent suppressed
   results from entering root steering or a generated model request, including completion during cancellation, a
   finished pending result, unconsumed steering, and an in-flight result acquisition. In `promptSession`, recheck
   eligibility after `alignActiveExecutionWorkflowOwner` and immediately before turn acceptance; also protect model
   dispatch after asynchronous preparation. Remove background queue entries and subscriptions without losing user
   steering or follow-ups. Previously consumed result history stays intact. Cancellation must not abort the foreground
   completion or its validation/publication continuation.
5. **Later work remains independent.** Warning state follows the completion-cycle definition in Approach rather than a
   process-global flag or tool-call ID. Recreated tools, backend retries, normal turn settlement, generated results, and
   workflow metadata refresh do not lose an outstanding warning. Accepted completion, Stop, and a different cycle reset
   it. Use existing workflow attempt/generation facts and request dispatch identity, without adding persisted retry
   metadata. Accepted non-generated user work and automatic validation repair reopen delivery for fresh tasks; rejected
   submissions do not. Old task IDs remain suppressed after reopening. Other Hosted Sessions are unchanged. Ordinary
   turn settlement still permits delivery.
6. **Guidance matches behavior.** The tool description explains warning and retry, and conflicting “exactly once” Agent
   instructions permit this rejected-call retry. Update the two named Core Session continuity requirements and their
   acceptance scenarios in the same change. Update `docs/sessions.md`, ADR-010, and the Background Task and Task
   Completion glossary entries, including their relationship and avoided aliases. Keep unresolved unrelated requirements
   marked target or deferred.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

**Focused automated commands** (use the sandboxed runner, never direct `deno test`):

- `deno run -A scripts/run-tests.js src/tools/__tests__/task-completed.test.js src/shared/session/task-completion-session.test.ts src/shared/session/background-task-completion.test.ts`
- `deno run -A scripts/run-tests.js src/shared/session/background-tasks.test.ts src/shared/session/background-tasks-extra.test.ts src/shared/session/background-task-process.test.ts src/shared/session/background-task-busy-delivery.test.ts src/shared/session/background-task-delivery.test.ts src/shared/session/background-task-stop.test.ts`
- If queue code changes:
  `deno run -A scripts/run-tests.js src/shared/session/managed-queue-lifecycle.test.ts src/shared/session/agent-handler.test.ts`
- `deno task seams:check`

**Required behavior assertions:**

- A live shell task produces one warning with its ID and kind. It remains running after rejection; no completion event,
  journal acceptance, metric, or workflow handoff exists yet. A retry cancels it, reaches zero active tasks, and
  publishes one accepted completion.
- An active read-only background delegate is also cancelled and releases its reader capacity. Neither its late result
  nor a delayed shell result adds a model request after accepted completion.
- Tasks that finish or are explicitly cancelled after the warning do not cause a second warning. A no-running-task call
  accepts immediately. A completed but undelivered result is suppressed even on that first successful call.
- Exercise both delivery paths: queue a result while the root is busy; separately hold generated-result acquisition
  **after its initial pending-result check but before `beginTurn`**. Accept completion, then release the delayed work.
  Assert no old task input reaches another model call, no generated result turn is emitted for it, and pending delivery
  is empty. A hold before the initial check does not prove this race is fixed.
- Separately cover suppression after generated-turn acceptance but during asynchronous preparation before the model
  handler. Assert no model request is made for that task; do not require removal of events already emitted before
  suppression. Use controlled external model/process progress and real runtime events instead of relying only on a short
  sleep.
- Queue user steering, including an image, and a follow-up alongside background steering. Cleanup removes only the
  background input. User input is still delivered once with its content and order preserved.
- Start fresh tasks after completion in the same Session, including a validation-repair continuation. They deliver
  normally and the next completion cycle warns once again. Previously suppressed task results never reappear. A separate
  Session continues unaffected.
- Recreate the completion tool between warning and retry. Repeat existing rejected-owner and Pair-final-checkpoint cases
  with active tasks; they neither cancel tasks nor consume the first warning. Preserve durable consume-once completion
  handoff and legitimate validation continuation.

The live-task warning test must fail on the current implementation; implementation must record that regression result
before the fix. Tests were not run during planning. The model-request and queue assertions must reject a counterfeit
that only calls `cancelAllAndSuppress`, only clears a counter, or disables all future delivery.

**Preservation and manual checks:**

- Keep existing busy-root, idle-result, root-not-child delivery, task limits, log/status, Stop/shutdown, and Pair
  authority tests. Only automatic delivery after accepted Task Completion is expected to stop existing.
- In a local Session, ask an execution Agent to start a harmless delayed command and then complete. Observe the warning,
  retry, cancellation, and normal completion. Wait past the command's intended finish time: no unsolicited result
  conversation starts. Send new work that starts a short task and confirm its result arrives.
- Inspect PRD scenarios, glossary, Session guide, and ADR-010 against tests. They must distinguish normal turn end from
  accepted completion and must not claim that cancellation verifies unfinished work.
- AI review must check cleanup ordering and the final model-dispatch boundary, not only visible tool output or passing
  old tests. No new browser UI needs a visual review.

## Edge Cases & Considerations

- **Task finishes during cleanup:** preserve its actual final status but suppress its automatic result. A cancellation
  request is not proof that the task ended as cancelled.
- **Warning is not completion:** results may still arrive while the Agent checks or cancels work after the first
  rejection. Suppression starts when the call proceeds toward accepted completion.
- **Queued is not consumed:** clearing pending registry entries does not remove an already queued steering message.
  Verify both owners and preserve user input.
- **Later workflow stages still run:** the requirement blocks old background-driven turns, not legitimate validation,
  repair, review, or publication work.
- **Reviewable scope assumption:** retry state is process-local and follows the completion owner/assignment. It is not
  restored on Session resume because the tasks themselves do not survive process exit. No new durable retry metadata is
  needed.
- **Failure reporting:** if cleanup cannot settle owned work, report the concrete cleanup failure and leave completion
  unaccepted; never silently report the assignment as complete.
