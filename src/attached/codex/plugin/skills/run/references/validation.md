# Validation and delivery

For `implemented` or `validation_recovery`, call `start_validation` with a new operation ID, current workflow ID and
revision, and `payload: {}`. Core runs the configured checks; do not start a second copy of the full command. Wait
while Core sends progress. The installed plugin gives each tool up to 3600 seconds; it does not change Codex's normal
permissions. After an interrupted or timed-out call, read `status` before continuing the saved validation attempt.

For `validation`, read the requested kind and current action identity. If compact status returns `requestAvailable`
instead of a request, fetch `get_instructions` to read the decision. Each worker checks its fetched instruction
contract is `runwield.attached.validation/1` before acting. Core owns rounds, findings, budgets, candidate freshness, and gate outcomes.

## Independent review

Dispatch a fresh Codex reviewer with the workflow ID, revision, action ID, request cwd, and artifact references.
Do not read, condense, or summarize its role instructions in this conversation. The reviewer fetches complete current
instructions with `get_instructions` itself, including Core's `review_complete` payload schema. It reads required
artifacts through `get_artifact`, continuing all truncated reads.

The reviewer must have direct RunWield MCP access and call `review_diff` itself for every required diff byte. Listing
files is not inspection. Each read returns a new revision, which it must use for the next read. It makes no edits,
commits, or lifecycle calls. It returns the structured `review_complete` outcome and latest revision to this
conversation. If direct MCP access or the payload schema is missing, report that capability problem and keep the
workflow open. Never relay coordinator reads or fabricate coverage receipts.

This conversation submits `review_complete` with the issued action ID, the reviewer's latest revision, and its
structured outcome unchanged. Preserve finding IDs and field names. If Core requests correction, dispatch another
fresh reviewer with the new action ID and revision; it fetches the current schema and instructions itself.

## Repair

For `repair`, dispatch a fresh Codex repair worker with the action identity, request cwd, and artifact references. It
fetches complete current instructions with `get_instructions` and uses the focused repair packet. Use Core's supplied
checkout, including its publication directory when requested. Do not create host worktree isolation or repeat the
original implementation. The worker may stage conflict resolutions when Core's repair instructions require that, but
does not commit, merge, push, publish, or make lifecycle calls.

Submit its completed per-item Markdown bullet report through `task_completed`, with the current action ID, revision,
and `payload.message`. For a blocked item, show its identity and needed recovery; do not claim completion.

## Decisions and code review

For `decision`, fetch the exact prompt and options with `get_instructions`. Show them to the user before submitting an
answer. If the request or approved Plan already supplied the answer, show that source and the exact answer. Otherwise
ask and wait; do not guess a validation command or other consequential choice. Submit `validation_decision` with the
current action ID and revision. A text request uses `payload.answer: { outcome: "text", value: "the user's text" }`;
a selection uses `payload.answer: { outcome: "selected", value: "the chosen option value" }`.

For `code_review`, show `review.url` and wait with bounded `status` calls. Core saves the browser decision for the
exact diff. Handle `chatPending` through [Review chat](review-chat.md). Feedback starts a fresh repair; Core re-verifies
the changed code before another browser decision. Chat and closing a page cannot approve, reject, or abandon delivery.

## Recording and publication

For `recorder`, dispatch a fresh Codex Recorder with its action identity, request cwd, and canonical artifact
references. It fetches complete instructions with `get_instructions`; do not pass this host conversation. The worker
returns structured sections without editing files. Submit them unchanged through `work_record_completed`. On a
validation error, send the error and new action ID to a fresh Recorder, which fetches its own instructions for the
allowed retry. Core alone decides when to record a failure and continue publication.

Follow each returned action until Core returns `delivered`. Do not commit, push, merge, edit protected metadata, or
announce Verified based on a worker's report. Core owns publication and its recovery. For `delivered`, report Core's
proven delivery and Work Record outcome, then suggest relevant manual checks from the Plan in this conversation.
Do not save those checks as a new document, memory, or Work Record. If Core reports a deferred supersession proposal,
explain that it remains deferred; this plugin does not provide that capability.
