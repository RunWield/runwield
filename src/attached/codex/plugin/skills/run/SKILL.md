---
name: run
description: Start or resume one RunWield Connect workflow in Codex, including planning, browser review, implementation, validation, and delivery.
---

# RunWield Connect

Use the RunWield MCP tools for this explicitly requested workflow. Codex owns every model call; RunWield Core owns the
Plan, execution directory, workflow gates, recovery, and publication. Stay in Codex and the browser. Do not operate the
RunWield CLI or TUI for the user. Ordinary Codex tools and permissions remain available and unchanged.

## Start or resume

Use the user's intent to choose:

- **New work**, such as `$runwield:run add CSV export`: call `activate` with a new unique `operationId` and
  `payload: { requestText, hostRequestId }`. Put only this request in `requestText`. Use a request identifier supplied
  by Codex when available, otherwise generate a UUID. Keep those IDs when retrying an activation that returned no
  result. The installed MCP server supplies host and adapter evidence; do not construct or override it.
- **Continue existing work**, such as `$runwield:run resume` or `$runwield:run implement the saved Plan`: first call `status`
  with `inspectOnly: true` and the known `workflowId`, or only `{ inspectOnly: true }` to inspect the most recent open
  workflow in this repository without continuing it. Do not activate a new
  request when a resume finds no workflow or the conversation has lost context. Report the result.
- **Ambiguous intent**: ask whether the user wants new work or to resume the open workflow before calling `activate`.
  Do not require an internal workflow ID for an ordinary resume; use one only when necessary to disambiguate or
  diagnose a specific workflow.

On resume, show the Plan name from `workflow.plan.planName`, the current step from `workflow.nextAction`, and the
originating host from `workflow.originHost` before proceeding. Before a Plan exists, use `workflow.requestSummary` to
identify the request. If the user asked only to inspect status, stop after this summary. Otherwise call ordinary
`status` with that `workflowId` to continue. Do not fetch role instructions,
start checks, or dispatch a worker before showing this summary. A workflow started in Claude Code can continue
in Codex with the same Plan, action, revision, and execution directory. The explicit resume already authorizes that
handoff; no additional host-switch confirmation is needed. Do not import the other host's conversation.

Show any returned `compatibility` notice before continuing. For `unsupported_host`, `incompatible_adapter`, or
`unsupported_host_version`, show Core's explanation and update guidance and stop. Never claim a host version is tested
when Core describes it as untested.

## Follow Core's current action

After every tool result, follow `workflow.nextAction`, including a result that rejects a stale call. Read the relevant
reference before handling its actions; move to another reference when the returned action changes.

| Current action                                                                             | Reference                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `triage`, `plan`, `review`                                                                 | [Planning and Plan review](references/planning.md)  |
| `plan_ready`, `plan_saved`, `consent`, `implementation`                                    | [Implementation](references/implementation.md)      |
| `implemented`, `validation_recovery`, `validation`, `code_review`, `recorder`, `delivered` | [Validation and delivery](references/validation.md) |

For `return_to_host`, report Core's outcome and return to ordinary Codex work. Unsupported request types do not become
FEATURE workflows by changing their classification. An unrecognized action or role contract is a recoverable
compatibility problem: report it and leave the workflow open.

## Operation identity and recovery

- Lifecycle calls use a new `operationId`, `workflowId` from the last result, and `expectedRevision` equal to its
  `workflow.revision`. Action-scoped payloads use the issued `actionId`. Reuse an operation ID only for a retry whose
  original call returned no result.
- Fetch role instructions with `get_instructions({ workflowId, actionId })`. Follow the returned current instructions
  and context. Core resolves project overrides and Skill references at runtime; do not replace them with copied roles.
- For bounded `get_artifact` reads, select `prompt`, `execution_report`, or `repair_report`, then continue from
  `nextOffsetBytes` until `truncated` is false. Truncated content is not a complete instruction or review artifact.
- After interruption, a stale action, or a revision conflict, read `status` and continue its saved action. Do not edit
  lifecycle metadata, fabricate completion, or start another execution to bypass recovery.
- For browser waits, use `status({ workflowId, waitForRevision, timeoutMs: 30000 })`, repeat with the returned revision,
  and handle `chatPending` through [Review chat](references/review-chat.md). Do not poll with shell sleep or repeatedly
  request full status. Closing a page or Codex does not abandon the workflow.

## Fresh Codex workers

Before every role dispatch, read `workflow.nextAction.dispatch`, available even in compact status without reviewer
instructions. It reflects saved `connect.codex.roles` preferences for the current Codex caller. Apply these rules to
Router, Planner, implementation, independent review, repair, and Recorder workers:

- For `status: "ready"`, pass `model` as the native spawn `model` and `thinkingLevel` as `reasoning_effort`.
  For each value equal to `"inherit"`, omit that spawn argument. Do not translate Core provider IDs or presets.
  Missing dispatch metadata from older compatible Core means both fields inherit.
- For `status: "invalid"`, show `diagnostics` and stop before spawning. Keep the current action resumable.
- Use a fresh Router or initial Planner worker when either field is explicit. Both inherited permits the coordinating
  conversation's existing Router/initial Planner flow. Feedback Planner and all workers below always use fresh contexts.
- Use the host tool's actual model and effort controls; text in a prompt does not apply a preference. Disable context
  inheritance (`fork_turns: "none"` when available), including for explicit overrides. If the host rejects a model or
  effort, lacks either requested control, or cannot guarantee applying it, report the exact limitation and stop before
  doing that role's work. Preserve the preference and action; do not silently ignore, downgrade, substitute, or activate
  another workflow. Resume after the user changes the preference or host capability.

Preferences are resolved on the next dispatch, including after resume. Do not restart a running worker after a file
edit. Inheritance delegates to Codex's native resolution: a model override without an effort override can use that
model's default effort. Claim only the native arguments actually accepted, not an unobserved model selection.

Dispatch each implementation, review, repair, and Recorder action to a new Codex subagent with a fresh context. Do not
reuse a previous worker or inherit this conversation's history; disable context inheritance when the host exposes that
option. Give only its current action identity, required directory and canonical artifact references, plus the full
issued role instructions when the handoff requires them. Use the available Codex subagent tool; do not create a new
user-facing chat or invoke another model provider.

Use Core's supplied execution directory for every worker command and edit. Do not enable host-created worktree
isolation, create another worktree, or move the invoking checkout. If the host cannot provide a fresh worker, or a
reviewer cannot access RunWield MCP directly, report the missing capability and keep the workflow resumable. Do not
substitute a review in this coordinating conversation.
