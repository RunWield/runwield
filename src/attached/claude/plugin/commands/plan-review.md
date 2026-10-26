---
description: Restore RunWield Triage, planning, or Plan review
disable-model-invocation: true
---

Restore RunWield Triage, planning, or Plan review in this project.

Show any returned `compatibility` notice to the user before continuing. On `unsupported_host`, show Core's
compatibility message and stop. On `incompatible_adapter` or `unsupported_host_version`, show Core's update message and stop.
Core owns host and version compatibility.

1. Call MCP `status`. Include this conversation's `workflowId` when known; otherwise use `{}` to find the most recent
   open workflow. Status is compact by default.
2. If `review.url` is returned, open that URL with Claude Code's shell and the operating system's URL opener, then show
   the URL. The MCP server already opens a newly hosted review. Wait with MCP `status` using
   `{ workflowId, waitForRevision: <current revision>, timeoutMs: 30000 }` while the review is pending. Core returns on a
   revision/action change or timeout; repeat with the returned revision if still pending. Do not use shell sleep or fetch
   full status.
3. For a `triage` action, fetch `get_instructions` with the workflow and action IDs, use `context.requestText` as the
   user's request, follow the Router instructions, and call `triage_report`. Continue with the `/runwield:request` flow
   from its returned action; do not activate another request.
   For a `plan` action, fetch its current instructions with `get_instructions` using `workflowId` and `actionId`, then
   follow the Planner instructions and returned `context` (feedback, image paths, project setup, and note). Use
   `context.requestText` and `context.triageOutcome` when the conversation does not contain the request. After a
   cancellation, tell the user that review was canceled and ask what to do next; the workflow remains open.
   For feedback, revise and call `plan_written` with the new
   action ID and current workflow revision.
4. For `plan_saved`, report that the Plan is Ready For Work, saved for later, and stop. Tell the user
   `/runwield:implement` starts it. For `plan_ready`, immediately call `start_execution` with the current workflow ID and revision, a new operation ID,
   and `payload: {}`. Then follow the Implementation flow in `/runwield:request`: ask any plain-text consent question,
   disclose the execution directory and branch, dispatch a fresh host subagent without host worktree isolation, and
   submit its bullet report as `task_completed.message` from this conversation. After a decline, stop; do not restart.
5. For `implementation`, restore the worker with `/runwield:implement`. For `implemented`, `validation`, or
   `validation_recovery`, follow `/runwield:validate`. Publication remains pending after validation. An absent workflow
   does not create a new request.

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

Stay in Claude Code and the browser. Use no RunWield CLI or TUI commands. RunWield owns durable review decisions; Claude
Code owns every model call.
