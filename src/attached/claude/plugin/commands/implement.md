---
description: Restore or start approved RunWield implementation
disable-model-invocation: true
---

Restore RunWield implementation in this project. Claude Code owns every model call.

Show any returned `compatibility` notice to the user before continuing. On `incompatible_adapter` or
`unsupported_host_version`, show Core's update message and stop. Core owns version compatibility.

1. Call MCP `status` with the known `workflowId`, or `{}` for the most recent open workflow. Status is compact by default.
2. For `plan_ready`, immediately call `start_execution`. For `plan_saved`, this user command also starts execution:
   call `start_execution`. For either action, use a new operation ID, the current workflow ID and revision,
   and `payload: {}`. For `consent`, ask the disclosure question in plain text and resubmit `start_execution` with
   `actionId` and `consent: "proceed"` or `"decline"`. After decline, stop; do not automatically restart.
3. For `implementation`, check `runwield.attached.implementation/1` and send a user-visible message before dispatch with
   the directory, branch, and disclosure, including the RunWield-owned `.gitignore` block. Do not put this only in
   thinking or the worker prompt. Dispatch a fresh host Task/Agent subagent. If this action came from compact `status`, tell
   the worker to fetch its complete instructions with `get_instructions` using the workflow and action IDs. Otherwise pass
   the returned instructions unchanged. Include `role`, `executionCwd`, `planPath`, and `planName` in its prompt. All edits and
   shell commands must use that directory. Do not enable host worktree isolation, create another worktree, or change the
   invoking checkout. The worker follows the Plan, makes no RunWield lifecycle calls, and returns a Markdown
   bullet-point report.
4. This coordinating conversation submits completed work with MCP `task_completed`: a new operation ID, the issued
   action ID, current workflow revision, and `message` with the worker's bullet report. A blocker is not completion. Use
   `status` after interruption to restore the same authority, not another `start_execution` call. Repair rejections
   through the reported recovery path; never bypass guards.
5. For `implemented`, report Core's saved Git checkpoint for worktree execution, not the worker's earlier uncommitted
   state. Mention the disclosed `.gitignore` exception. Implementation is recorded, not Verified. Immediately follow
   `/runwield:validate` to run Core validation with fresh Claude review and repair workers. Publication remains pending.
   For planning or review actions, follow `/runwield:plan-review`. If no workflow exists, report that fact; do not
   activate a new request.

Stay in Claude Code and the browser. Use no RunWield CLI or TUI commands. Use host tools normally; no permission hooks
or tool restrictions are added.
