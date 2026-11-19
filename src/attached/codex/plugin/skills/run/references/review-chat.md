# Review chat

When compact status reports `chatPending`, call `get_pending_chat` with the workflow and action IDs. Answer the
oldest returned `turnId` before waiting again. Read its `message` and `selections` in this coordinating conversation.
Answer questions directly with `review_reply`, using a new operation ID, current workflow ID and revision, and
`payload: { turnId, text }`. A reply is not a browser decision and does not require a worker by itself.

When the user requests a Plan change, add `change: { summary }` to the reply, fetch current Planner instructions and
context with `get_instructions`, revise the Plan, and submit `plan_written`. For a code change, add the same concise
change summary, then dispatch the fresh repair worker requested by Core. Core re-verifies the repair and opens the
new diff. Write the summary in your own words; do not copy the raw chat into the Plan, worker report, or recording
evidence. Browser edits are already saved and must not be applied again.

Chat cannot approve or reject. A revised artifact requires a new browser decision. On a stale reply, read `status`
and do not replay the reply against another turn. Turns stay queued in order. Continue bounded status waits for the
same review action between replies. A process restart restores pending turns, not a permanent transcript.
