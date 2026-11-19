# Implementation

For `plan_ready`, immediately call `start_execution` with the current workflow ID and revision, a new operation ID,
and `payload: {}`. A later explicit resume or implementation request also starts a `plan_saved` Plan, unless the user
asked only to inspect or review it. Reaching `plan_saved` through Approve for Later during this invocation means report
the saved Plan and stop; do not undo that choice by automatically starting it.

For `consent`, ask the user the returned disclosure in plain language. Submit `start_execution` with the issued
`actionId` and `consent: "proceed"` or `"decline"`. After a decline, stop and leave the Plan ready; do not restart
execution or repeat the question automatically.

For `implementation`:

1. Require contract `runwield.attached.implementation/1`. Before dispatch, send a user-visible message with Core's
   `disclosure`, `executionCwd`, and `worktreeBranch`, including its RunWield-owned `.gitignore` block. Do not hide this
   only in the worker prompt.
2. Dispatch a fresh Codex implementation worker using the skill's **Fresh Codex workers** dispatch rules and current
   `workflow.nextAction.dispatch`. Include `role`, `executionCwd`, `planPath`, and `planName`. If the
   result includes `instructions.text`, pass it verbatim. If restoring from compact status, tell the worker to fetch
   its complete instructions using `get_instructions` with the workflow and action IDs. It follows the Plan and uses
   only the handed-off directory for every edit and command. Do not use host worktree isolation.
3. The worker makes no RunWield lifecycle calls and does not commit, merge, push, or publish. It returns a concise
   Markdown bullet report with actual outcomes and checks. A blocker or interrupted turn is not completion.
4. This coordinating conversation submits completed work with `task_completed`, using the issued action ID, current
   workflow revision, and `payload.message` containing the report. If a call is rejected, read `status` and repair
   through its current action. After cancellation or process loss, restore the same handoff instead of calling
   `start_execution` again.

For `implemented`, report Core's saved Git checkpoint for worktree execution, including the disclosed `.gitignore`
exception. The worker's earlier uncommitted state is no longer current. Implementation is recorded; delivery is still
pending. Immediately continue [Validation and delivery](validation.md).
