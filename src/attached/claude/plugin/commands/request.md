---
description: Plan and implement one FEATURE request with RunWield
argument-hint: <request>
disable-model-invocation: true
---

Start RunWield only for this request: $ARGUMENTS

Show any returned `compatibility` notice to the user before continuing. On `unsupported_host`, show Core's
compatibility message and stop. On `incompatible_adapter` or `unsupported_host_version`, show Core's update message and stop.
Core owns host and version compatibility.

1. Call the RunWield MCP tool `activate`. Use a new unique `operationId` and put the user's request in
   `payload.requestText`. Use `${CLAUDE_SESSION_ID}` as `payload.hostRequestId`. If that variable is not substituted,
   generate a unique identifier instead. The MCP server supplies host and adapter version evidence.
2. Fetch current role instructions and `context` with `get_instructions` using the workflow and action IDs. Follow the
   returned instructions, feedback, image paths, project setup, and note. Use `context.requestText` and
   `context.triageOutcome` when the conversation does not contain the request. Use `workflow.workflowId`,
   `workflow.revision`, and `workflow.nextAction.actionId` in each lifecycle call. Check that the action contract is `runwield.attached.triage/1`
   for the Router or `runwield.attached.planner/1` for the Planner. If another contract is returned, stop and tell the
   user that Core returned an unsupported role contract.
3. Call `triage_report` after Triage. For a FEATURE Plan, show the setup preview before writing the Plan, then call
   `plan_written` with the Plan name. Follow the next result. A rejection with a pending action lets you repair the
   input and retry with a new `operationId`; reuse an ID only when retrying a call that returned no result.
4. When `workflow.nextAction.kind` is `review`, show `review.url`. Wait with MCP `status` using `{ workflowId, waitForRevision: <current revision>, timeoutMs: 30000 }` while the browser review is pending. Core returns compact status when the revision or action changes, or when the wait times out; repeat with the returned revision if still pending. Do not poll with shell sleep or request full status. After feedback, dispatch the Planner with the new action ID and tell that worker to fetch its own complete instructions with `get_instructions`; revise the Plan and call `plan_written` with the current revision. The live browser page is reused for the next round. Browser edits are already saved; do not apply them twice.
5. After cancellation, tell the user review was canceled and ask what to do next. The workflow remains open.
   `/runwield:plan-review` restores it in a fresh conversation. For `plan_ready`, immediately call `start_execution`
   with a new `operationId`, current `workflowId` and `expectedRevision`, and `payload: {}`. No separate confirmation is
   needed after Approve & Run. For `plan_saved`, report that the Plan is Ready For Work, saved for later, and stop.
   Tell the user `/runwield:implement` starts it. Follow the implementation flow below only for `plan_ready`.
   Answer unrelated requests as ordinary Claude Code.

## Implementation flow

- For `consent`, ask the user `workflow.nextAction.disclosure` in plain text. Call `start_execution` with the pending
  `actionId` and `consent: "proceed"` or `"decline"`. A decline returns `plan_ready`: stop and return to the user; do
  not automatically restart execution or ask again. Never silently implement in place.
- For `implementation`, send a user-visible message before dispatch with `disclosure`, `executionCwd`, and
  `worktreeBranch`, including the RunWield-owned `.gitignore` block. Do not put this only in thinking or the worker
  prompt. Check contract `runwield.attached.implementation/1`; stop on a mismatch.
- Dispatch a fresh Claude Code subagent using the host's Task/Agent tool. Its task prompt must include the full returned
  `instructions.text` verbatim (do not summarize it), `executionCwd`, `planPath`, `planName`, and implementer `role`.
  Tell it to use that directory for every file edit and shell command, follow that Plan, and return a Markdown
  bullet-point report to this conversation. Do not use the host's worktree isolation option: RunWield already owns the
  worktree. Do not move or change this conversation's invoking checkout. The worker makes no RunWield lifecycle calls
  and needs no RunWield MCP connection.
- When the worker returns completed work, this coordinating conversation calls `task_completed` with the issued
  `actionId`, current `expectedRevision`, and `payload.message` containing its bullet report. Do not submit a blocker or
  a prose claim of "done" as completion. After loss or cancellation, use `status` or `/runwield:implement` to restore
  the same handoff, not `start_execution` again. On rejection, read `status` and repair; do not bypass guards.
- For `implemented`, report the Core result, not the worker's earlier Git state: Core saved the Git checkpoint for
  worktree execution. Do not say changes are uncommitted or that `.gitignore` was untouched. Implementation is recorded,
  not Verified. Immediately follow `/runwield:validate` for Core validation with fresh Claude workers. Publication
  remains pending; the workflow stays open.

## Review chat

When compact status reports `chatPending`, call `get_pending_chat` with the workflow and action IDs. Answer the returned oldest pending `turnId` before waiting again. Use the current
workflow ID and revision, a new operation ID, and `review_reply` with `payload: { turnId, text }`. Read `message` and
`selections` in this conversation. Answer questions directly; do not dispatch a worker or make a review decision.

For a Plan change, add `change: { summary }`, fetch Planner instructions and `context` with `get_instructions`, revise the Plan, and call
`plan_written`. For a code change, add `change: { summary }`, then dispatch the fresh repair subagent that Core requests
and submit its report. Core re-verifies the repair and opens the new diff. Write `summary` as a short description of the
change, not a quote of the user's message. Never put raw chat in the Plan, a worker report, or recording evidence.

Chat cannot approve or reject. The revised artifact needs a new browser decision. On a stale reply, read `status`; do
not apply the reply again to a different turn. Turns stay queued in order. Continue polling the same review action
between replies. A process restart restores pending turns, not a permanent transcript.

Use Claude Code's tools and other MCP servers normally. RunWield adds no hooks or tool restrictions. Stay in Claude Code
and the browser; use no RunWield CLI or TUI commands. Claude Code owns all model calls. This plugin supports FEATURE
planning, review, isolated implementation, validation, and durable handoff recovery.
