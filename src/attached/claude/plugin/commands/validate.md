---
description: Continue or restore RunWield validation with fresh Claude workers
disable-model-invocation: true
---

Continue the project's open RunWield workflow. Do not activate a new request.

1. Call MCP `status` with the known workflow ID, or `{}`. For `implemented` or `validation_recovery`, call
   `start_validation` with a new operation ID, the current workflow ID and revision, and `payload: {}`. Core runs the
   configured checks. Do not run the complete command yourself. Keep waiting while Core sends progress.
2. For `validation`, read `nextAction.request`. Core owns all validation policy. Never change rounds, finding
   identities, budgets, or gate outcomes yourself. For a worker, check contract `runwield.attached.validation/1`.
3. For `reviewer`, dispatch a **fresh** Claude Task/Agent subagent with the full `instructions.text` verbatim, the
   workflow ID, revision, action ID, and request cwd. Supply the `review_complete` tool's payload schema verbatim from
   its MCP descriptor with that full prompt, including every nested field. Tell the reviewer to return its outcome in
   exactly that schema. Do not invent a schema or field names. Do not reuse the implementation or previous review
   worker. The reviewer must have RunWield MCP access. It calls `review_diff` directly with the envelope and reads every
   required byte. List is not inspection. Each read returns a new revision; the worker uses that revision for its next
   call. No edits, commits, or lifecycle calls are allowed in the reviewer. It returns its structured outcome and latest
   revision to this conversation. If MCP access is unavailable, stop and report the missing capability; do not fabricate
   read receipts or relay reads from the coordinating conversation.
4. This conversation calls `review_complete` with the pending action ID, the reviewer's latest revision, and `payload`
   with `actionId`, `approved`, `feedback`, `findings`, `advisories`, and `integrationNotes` as supplied. Keep stable
   finding IDs. Submit the worker's outcome unchanged; do not map or reinterpret its fields yourself. If Core requests a
   correction, send the complete new instructions and the tool's payload schema verbatim to another fresh reviewer. Core
   alone accepts coverage and candidate freshness.
5. For `repair`, dispatch a fresh repair subagent with the full instructions verbatim and the request cwd. Do not enable
   host worktree isolation. Use only Core's handed-off checkout. The worker makes no RunWield lifecycle calls and
   returns its per-item Markdown bullet report. Submit completed repair with `task_completed`, the current action ID and
   revision, and `payload.message`. A blocker is not completion: show it to the user and leave the workflow open.
6. For `decision`, ask the user the exact `request.interaction.prompt` and options in plain text. Submit their answer
   through `validation_decision` with `payload.answer` (outcome, value, and optional message/valueLabel). Do not choose
   on the user's behalf.
7. Follow each returned next action. After process loss or rejection, call `status`, then `start_validation` to recover.
   Never bypass a stale action or candidate rejection. For `awaiting_delivery`, report that validation passed and
   publication remains pending. Do not claim Verified, commit, push, merge, or start publication.

Stay in Claude Code and the browser. Core owns the gates; Claude owns every model call. To allow slow checks, start
Claude Code with `MCP_TOOL_TIMEOUT=600000` (milliseconds), or a higher timeout for the project's configured command.
RunWield sends MCP progress every 30 seconds during an active operation and stops it when the operation ends.
