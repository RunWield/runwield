---
description: Continue or restore RunWield validation and delivery with fresh Claude workers
disable-model-invocation: true
---

Continue the project's open RunWield workflow. Do not activate a new request.

Show any returned `compatibility` notice to the user before continuing. On `unsupported_host`, show Core's
compatibility message and stop. On `incompatible_adapter` or `unsupported_host_version`, show Core's update message and stop.
Core owns host and version compatibility.

1. Call MCP `status` with the known workflow ID, or `{}`. Status is compact by default. For `implemented` or
   `validation_recovery`, call `start_validation` with a new operation ID, the current workflow ID and revision, and
   `payload: {}`. Core runs the configured checks. Do not run the complete command yourself. Keep waiting while Core sends
   progress.
2. For `validation`, read the action kind, ID, revision, cwd, and artifact references. Core owns all validation policy.
   Never change rounds, finding identities, budgets, or gate outcomes yourself. For a worker, check contract
   `runwield.attached.validation/1`.
3. For `reviewer`, dispatch a **fresh** Claude Task/Agent subagent with the workflow ID, revision, action ID, and request
   cwd. Do not copy, condense, or summarize Core instructions in this conversation. Tell the reviewer to call MCP
   `get_instructions` with its workflow ID and action ID before acting; it receives the complete current instructions
   itself. Use `get_artifact` for bounded prompt or report reads: select `prompt`, `execution_report`, or `repair_report`,
   and continue with `nextOffsetBytes` until `truncated` is false. The reviewer must have RunWield MCP access and use
   `review_diff` directly to read every required byte. List is
   not inspection. Each read returns a new revision; the reviewer uses that revision for its next call. No edits, commits,
   or lifecycle calls are allowed in the reviewer. It returns its structured outcome and latest revision to this
   conversation. If MCP access is unavailable, stop and report the missing capability; do not fabricate read receipts or
   relay reads from the coordinating conversation.
4. This conversation calls `review_complete` with the pending action ID, the reviewer's latest revision, and its
   structured outcome unchanged. Keep stable finding IDs. Do not map or reinterpret fields. If Core requests a correction,
   dispatch another fresh reviewer with the new action ID and revision; it fetches its own complete instructions. Core
   alone accepts coverage and candidate freshness.
5. For `repair`, dispatch a fresh repair subagent with the action ID and request cwd. Tell it to fetch complete current
   instructions with `get_instructions`. Do not enable host worktree isolation. Use only Core's handed-off checkout. The
   worker makes no RunWield lifecycle calls and returns its per-item Markdown bullet report. Submit completed repair with
   `task_completed`, the current action ID and revision, and `payload.message`. A blocker is not completion: show it to
   the user and leave the workflow open.
6. For `decision`, call `get_instructions` with the workflow and action IDs to fetch the exact Core prompt and options.
   show the exact Core prompt and options to the user in plain text before submitting any answer. If the user's request or approved Plan already supplied
   the answer, show where it came from and the exact answer you will submit.
   Otherwise, ask the user and wait. Submit only the user's supplied answer through `validation_decision` with the current
   action ID and revision. For a `text` request, use `payload.answer: { outcome: "text", value: "the user's text" }`. For a
   `select` request, use `payload.answer: { outcome: "selected", value: "the chosen option value" }`. Do not guess or
   answer silently.
7. For `code_review`, show `review.url`. Wait with MCP `status` using
   `{ workflowId, waitForRevision: <current revision>, timeoutMs: 30000 }`. It returns on a revision/action change or
   timeout with compact status. Repeat with the returned revision if approval or feedback is still pending; do not poll
   with shell sleep or fetch full status. Core saves approval or feedback for the exact diff. Feedback returns a fresh
   repair action; follow step 5, then review the new diff after Core re-verifies it. Closing the page or Claude does not
   abandon the workflow.
8. For `recorder`, dispatch a fresh Claude Recorder subagent with the action ID, request cwd, and artifact references.
   Tell it to fetch complete current instructions with `get_instructions`. Do not send the Claude conversation. The worker
   returns structured sections, not files. This conversation submits them unchanged through `work_record_completed` with
   the current action ID and revision. On validation errors, send the errors to a fresh Recorder with the new action ID;
   it fetches its own complete instructions for the one retry. After the second invalid submission, Core records failure
   and continues publication.
9. Follow each returned next action, including on a rejected call. After process loss or rejection, call `status`, then
   `start_validation` to recover. Never bypass a stale action or candidate rejection. Do not claim Verified until
   `delivered`. Do not commit, push or merge; Core owns publication.
10. For `delivered`, report Core's proven delivery and Work Record outcome. Supersession proposals are deferred; name
    `wld wr supersede` for later use. Suggest manual checks from the Plan in this Claude conversation. Do not save the
    checks as a document, memory or Work Record.

## Review chat

When compact `status` reports `chatPending`, call `get_pending_chat` with the workflow ID and action ID to fetch the
oldest pending turn. Answer its `turnId` before waiting again. Use the current workflow ID and revision, a new operation
ID, and `review_reply` with `payload: { turnId, text }`. Read `message` and `selections` in this conversation. Answer
questions directly; do not dispatch a worker or make a review decision.

For a Plan change, add `change: { summary }`, fetch the Planner instructions with `get_instructions`, revise the Plan,
and call `plan_written`. For a code change, add `change: { summary }`, then dispatch the fresh repair subagent that Core
requests and submit its report. Core re-verifies the repair and opens the new diff. Write `summary` as a short description
of the change, not a quote of the user's message. Never put raw chat in the Plan, a worker report, or recording evidence.

Chat cannot approve or reject. The revised artifact needs a new browser decision. On a stale reply, read compact `status`;
do not apply the reply again to a different turn. Turns stay queued in order. Wait with `status` using the latest revision
and bounded timeout between replies. A process restart restores pending turns, not a permanent transcript.

Stay in Claude Code and the browser. Core owns the gates; Claude owns every model call. To allow slow checks, start
Claude Code with `MCP_TOOL_TIMEOUT=600000` (milliseconds), or a higher timeout for the project's configured command.
RunWield sends MCP progress every 30 seconds during an active operation and stops it when the operation ends.
