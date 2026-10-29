# Planning and Plan review

For `triage`, fetch `get_instructions` for the workflow and action IDs. Require contract
`runwield.attached.triage/1`, follow the Router instructions, and use `context.requestText` when restoring a request.
Submit `triage_report` with the issued `actionId` and the Core Triage fields in `payload.outcome`. Follow the returned
action rather than assuming the request is FEATURE-sized.

For `plan`, fetch current instructions and context; require `runwield.attached.planner/1`. Follow the Planner role and
returned request, triage outcome, feedback, image paths, and note. Before writing a Plan, show the returned
`context.projectSetup` paths that Core will create; an empty list means no setup files are added. Write the canonical
Plan and call `plan_written` with `payload.actionId`, `payload.planName`, and any requested execution policy fields.
For a rejected submission that still has a pending action, correct the problem and retry with a new operation ID.

For `review`, show `review.url`. Core hosts and opens a new review page. When the user asks to reopen an existing
review, open the returned URL using Codex's browser-opening capability, or the operating system's URL opener, and show
the link. Wait with bounded MCP `status` calls as described in the skill. When `chatPending` is true, handle
[Review chat](review-chat.md) before waiting again.

When browser feedback returns a Planner action, dispatch a fresh Planner worker with the workflow and action IDs. It
fetches its own complete `get_instructions` and context, reads the feedback and image paths, and revises the Plan.
The coordinating conversation submits the changed Plan with `plan_written` using the current revision. Browser edits
are already saved; do not apply them twice. Core reuses the live page for a new review round.

After review cancellation, show Core's note and ask what the user wants to do next. Keep the workflow open; do not
treat cancellation as approval or immediately reopen it without a new request.

For `plan_ready`, immediately follow [Implementation](implementation.md) and call `start_execution`; Approve & Run
needs no second confirmation. For `plan_saved` after Approve for Later, report that the Plan is Ready For Work and
saved for later, then stop. Tell the user `$runwield:run implement` or `$runwield:run resume` can continue it later.
