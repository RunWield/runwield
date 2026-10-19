---
description: Reopen the last RunWield Plan review
disable-model-invocation: true
---

Reopen the RunWield Plan review in this project.

1. Call the RunWield MCP tool `status`. Include this conversation's `workflowId` when known; otherwise use `{}` to find
   the most recent open workflow.
2. If `review.url` is returned, open that URL with Claude Code's shell and the operating system's URL opener, then show
   the URL. The MCP server already opens a newly hosted review. Poll `status` with a short 2-second shell sleep between
   calls while `workflow.nextAction.kind` is `review`.
3. For a `plan` action, follow the returned Planner instructions, feedback, image paths, and note. After a cancellation,
   tell the user that review was canceled and ask what to do next; the workflow remains open. For feedback, revise and
   call `plan_written` with the new action ID and current workflow revision.
4. For `plan_ready`, immediately call `start_execution` with the current workflow ID and revision, a new operation ID,
   and `payload: {}`. Then follow the Implementation flow in `/runwield:request`: ask any plain-text consent question,
   disclose the execution directory and branch, dispatch a fresh host subagent without host worktree isolation, and
   submit its bullet report as `task_completed.message` from this conversation. After a decline, stop; do not restart.
5. For `implementation`, restore the worker with `/runwield:implement`. For `implemented`, `validation`, or
   `validation_recovery`, follow `/runwield:validate`. Publication remains pending after validation. An absent workflow
   does not create a new request.

## Review chat

When `review` or `code_review` has `chat`, answer its oldest pending `turnId` before polling again. Use the current
workflow ID and revision, a new operation ID, and `review_reply` with `payload: { turnId, text }`. Read `message` and
`selections` in this conversation. Answer questions directly; do not dispatch a worker or make a review decision.

For a Plan change, add `change: { summary }`, then follow the returned Planner instructions, revise the Plan, and call
`plan_written`. For a code change, add `change: { summary }`, then dispatch the fresh repair subagent that Core requests
and submit its report. Core re-verifies the repair and opens the new diff. Write `summary` as a short description of the
change, not a quote of the user's message. Never put raw chat in the Plan, a worker report, or recording evidence.

Chat cannot approve or reject. The revised artifact needs a new browser decision. On a stale reply, read `status`; do
not apply the reply again to a different turn. Turns stay queued in order. Continue polling the same review action
between replies. A process restart restores pending turns, not a permanent transcript.

Stay in Claude Code and the browser. Use no RunWield CLI or TUI commands. RunWield owns durable review decisions; Claude
Code owns every model call.
