---
description: Restore or start approved RunWield implementation
disable-model-invocation: true
---

Restore RunWield implementation in this project. Claude Code owns every model call.

Show any returned `compatibility` notice to the user before continuing. On `unsupported_host`, show Core's
compatibility message and stop. On `incompatible_adapter` or `unsupported_host_version`, show Core's update message and stop.
Core owns host and version compatibility.

1. First call MCP `status` with `{ workflowId, inspectOnly: true }` when the workflow ID is known, or
   `{ inspectOnly: true }` to inspect the most recent open workflow in this repository without advancing it.
   Show `workflow.plan.planName` (or `workflow.requestSummary` before a Plan exists), the current step from
   `workflow.nextAction`, and the originating host from `workflow.originHost` before continuing. If no workflow exists,
   report that result and stop; do not activate a new request. If the user requested only inspection, stop after this
   summary. The explicit resume authorizes continuing a workflow started in Codex without another host-switch
   confirmation. Preserve its Plan, action, revision, and execution directory; do not import the other host's transcript.
   Only after showing this summary, call ordinary `status` with that `workflowId` to continue. Do not fetch role
   instructions, start checks, or dispatch a worker before the summary. Status is compact by default.
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

## Canonical document access

When the workflow has a selected Plan, workers read it with `read_plan({ workflowId, actionId })` before acting. Use `resource` for a separate
Plan document. Search canonical Work Records with `work_record_search({ workflowId, actionId, query })`, then read a
result with `work_record_read({ workflowId, actionId, recordId })`. Core scopes these tools to the workflow Project
and current action; Recorder can read all statuses, while other roles read current usable records.

These tools supply content through Core without host filesystem access to home. Continue `nextOffsetBytes` until
`truncated` is false, carrying `documentRevision` on every continuation page. Restart from zero after
`revision_conflict`; do not combine pages from different revisions. Search pages contain JSON; parse only after all
pages arrive. Host denial of these tools is still denial: stop dependent work if no authorized route remains. Do not
create a repository copy or symlink, request broad home access, or treat a path as a grant.
