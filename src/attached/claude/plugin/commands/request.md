---
description: Plan and implement one FEATURE request with RunWield
argument-hint: <request>
disable-model-invocation: true
---

Start RunWield only for this request: $ARGUMENTS

1. Call the RunWield MCP tool `activate`. Use a new unique `operationId` and put the user's request in
   `payload.requestText`. Use `${CLAUDE_SESSION_ID}` as `payload.hostRequestId`. If that variable is not substituted,
   generate a unique identifier instead. The MCP server supplies host and adapter version evidence.
2. Follow the returned `instructions` for the pending role. Use `workflow.workflowId`, `workflow.revision`, and
   `workflow.nextAction.actionId` in each lifecycle call. Check that the action contract is `runwield.attached.triage/1`
   for the Router or `runwield.attached.planner/1` for the Planner. If another contract is returned, stop and tell the
   user the plugin and Core contract versions do not match.
3. Call `triage_report` after Triage. For a FEATURE Plan, show the setup preview before writing the Plan, then call
   `plan_written` with the Plan name. Follow the next result. A rejection with a pending action lets you repair the
   input and retry with a new `operationId`; reuse an ID only when retrying a call that returned no result.
4. When `workflow.nextAction.kind` is `review`, show `review.url`. Poll `status` with a short 2-second shell sleep
   between calls while the browser review is pending. Feedback returns a new Planner action: read its feedback, image
   paths, and note, revise the Plan, then call `plan_written` with the new action ID and current revision. The live
   browser page is reused for the next round. Browser edits are already saved; do not apply them twice.
5. After cancellation, tell the user review was canceled and ask what to do next. The workflow remains open.
   `/runwield:plan-review` restores it in a fresh conversation. For `plan_ready`, immediately call `start_execution`
   with a new `operationId`, current `workflowId` and `expectedRevision`, and `payload: {}`. No separate confirmation is
   needed after approval. Follow the implementation flow below. Answer unrelated requests as ordinary Claude Code.

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

Use Claude Code's tools and other MCP servers normally. RunWield adds no hooks or tool restrictions. Stay in Claude Code
and the browser; use no RunWield CLI or TUI commands. Claude Code owns all model calls. This plugin supports FEATURE
planning, review, isolated implementation, validation, and durable handoff recovery. Installation and full preflight are
separate capabilities.
