# Ideator and Guide conversations

Use this procedure for `$runwield:ideator`, `$runwield:guide`, and `run` results with
`workflow.nextAction.kind: "role_handoff"`. Keep the original user request in host context. A routed entry selects
`workflow.nextAction.role`; a dedicated entry selects its named role. Require `ideator` or `guide`.

## Fetch current instructions

Call the RunWield MCP tool `get_role_instructions` with only `{ role: "ideator" }` or `{ role: "guide" }` for the selected
role. The MCP server supplies host and adapter evidence. Send no workflow identity, request text, or conversation
history. Require `ok: true`, `operation: "get_role_instructions"`, matching `instructions.role`, contract
`instructions.contractVersion: "runwield.attached.conversation/1"`, and complete `instructions.text`.

Apply the dispatch procedure below before doing role work. In the selected context, follow the full current text,
including the resolved Agent Definition, Skills, and conversational guidance. Do not use copied role definitions or
replace the returned text with a summary. Answer the original user request substantively or ask the role's next
relevant question; an acknowledgement that instructions loaded is not an answer.

A dedicated entry never calls `activate`, `status`, or Router. A routed handoff closes only its routing record, not the
user's discussion or a delivery. Make no lifecycle calls or completion reports for the conversation. Core has no
conversation storage or resume; use Codex's own conversation continuation and resume.

## Resolve Codex dispatch for both entry paths

Read `instructions.dispatch` from this fresh stateless response, not the closed Router action or a cached preference.
Require `host: "codex"` and the selected `role`.

- For `status: "invalid"`, show `diagnostics` and stop before doing role work or spawning.
- For `status: "ready"`, require `model` and `thinkingLevel`. With both equal to `"inherit"`, converse in this current
  Codex context using the full returned instructions.
- If either value is explicit, spawn a fresh Codex worker before doing role work. Pass explicit `model` as the native
  spawn `model` and explicit `thinkingLevel` as native `reasoning_effort`; omit each argument whose value is
  `"inherit"`. Use the host tool's actual controls, not text in a prompt. Do not translate or substitute values.
  Disable inherited context (`fork_turns: "none"` when available). If fresh context cannot be guaranteed, stop.

Give that fresh worker only the selected role, current user request, working directory, and relevant artifact
references. It must fetch its own `get_role_instructions({ role })` through native RunWield MCP, validate the same role
and conversation contract, and follow the full current text. It is the conversation worker, not another dispatcher:
if its fresh dispatch preferences differ from the accepted native controls, report the discrepancy and stop rather
than recursively spawning or ignoring the change. Do not proxy instructions to bypass missing worker MCP access.

Keep this same worker for subsequent user answers. Relay its questions and substantive replies to the user, then send
the user's answer and relevant new artifact references back to that worker through Codex's continuation tool. Do not
restart a worker per reply or treat a question as completion. Do not save these turns in Core. If worker continuation
is unavailable, report that limitation; do not silently restart or claim Core can restore the discussion.

If the host lacks or rejects a requested native model/effort control, cannot disable inherited context, or lacks the
required worker/MCP/continuation capability, show the exact limitation and stop. Tell the user to update Codex and the
RunWield plugin/Core as applicable, or change the role preference to supported controls, then retry. Never silently
ignore, downgrade, substitute, or switch roles. Claim only native arguments actually accepted.

On a missing/unknown tool, missing dispatch metadata, unrecognized dispatch status, unsupported role/contract, or
incomplete response, show the diagnostic, tell the user to update local RunWield Core and the Codex RunWield plugin to
compatible versions, and stop. Do not fall back to lifecycle instructions or implementation. For compatibility
rejections, show Core's explanation and update guidance; continue quietly on nonblocking notices.

## Explicit planning handoff

Only an explicit user request to plan starts a fresh normal `$runwield:run` request with the agreed task and relevant
artifact references, not the host transcript. Keep Router, `start_planning`, Plan review, and execution gates. A saved
PRD, Markdown explanation, or conversational answer does not start planning, implementation, or a commit. Do not submit
an Ideator or Guide outcome to `plan_written`.
