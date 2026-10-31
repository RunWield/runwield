# Planning and Plan review

Apply the skill's **Fresh Codex workers** dispatch rules before handling Router or Planner work. With an explicit model
or thinking level, dispatch a fresh worker with the native overrides, workflow ID, revision, action ID, and project
directory. It fetches its own `get_instructions` and context. Before a Planner writes, have it return
`context.projectSetup` paths, disclose them to the user, then continue that worker. It returns Router's structured
`triage_report` outcome or Planner's `planName` and requested execution policy fields; this conversation submits the
result through the matching lifecycle tool. Workers make no lifecycle calls. Relay any question or blocker to the user;
a question is not a completed role result. With both fields inherited, the initial roles can run in this conversation:

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

When browser feedback returns a Planner action, apply its current dispatch preferences and dispatch a fresh Planner worker with the workflow and action IDs. It
fetches its own complete `get_instructions` and context, reads the feedback and image paths, and revises the Plan.
The coordinating conversation submits the changed Plan with `plan_written` using the current revision. Browser edits
are already saved; do not apply them twice. Core reuses the live page for a new review round.

After review cancellation, show Core's note and ask what the user wants to do next. Keep the workflow open; do not
treat cancellation as approval or immediately reopen it without a new request.

For `plan_ready`, immediately follow [Implementation](implementation.md) and call `start_execution`; Approve & Run
needs no second confirmation. For `plan_saved` after Approve for Later, report that the Plan is Ready For Work and
saved for later, then stop. Tell the user `$runwield:run implement` or `$runwield:run resume` can continue it later.
