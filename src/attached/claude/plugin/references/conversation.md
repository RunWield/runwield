# Host-owned role conversation

Use this procedure for a dedicated Ideator or Guide command and for Router's `role_handoff`. Keep the original user
request and the selected `ideator` or `guide` role in this Claude conversation.

1. Call the RunWield MCP tool `get_role_instructions` with only `{ role: "ideator" }` or `{ role: "guide" }` for the
   selected role. The MCP server supplies host and adapter evidence. Do not send workflow IDs, request text, or history.
2. Require `ok: true`, `operation: "get_role_instructions"`, matching `instructions.role`, contract
   `instructions.contractVersion: "runwield.attached.conversation/1"`, and complete `instructions.text`. Follow the full
   current text, including its resolved Agent Definition, Skills, and conversational guidance; do not substitute a
   copied role or a summary.
3. Answer the original user request as that role now. Give a substantive answer or ask the role's next relevant
   question, not an acknowledgement that instructions loaded. Continue the role's questions, answers, and requested
   artifact work across subsequent user replies in this same Claude conversation.

A dedicated entry does not call `activate`, `status`, or Router. A routed entry closes only its routing record; it is
not a completed answer or delivery. After the handoff, make no workflow lifecycle calls for this conversation. Core
stores no conversation, offers no conversation resume, and needs no completion report. Use Claude's own conversation
continuation and resume.

On a missing or unknown `get_role_instructions` tool, unsupported role or contract, incomplete response, or incompatible
host/adapter result, show the diagnostic and stop. Tell the user to update local RunWield Core and the Claude Code
RunWield plugin to compatible versions, then retry the original command. Do not fall back to another role, ordinary
implementation, or lifecycle instructions. Continue quietly on nonblocking compatibility notices.

## Explicit planning handoff

Only an explicit user request to plan starts planning. Invoke the normal `/runwield:request` flow as a fresh request
containing the agreed task and relevant artifact paths, not the host transcript. Preserve Router, Core's
`start_planning` preparation boundary, Plan review, and execution gates. An Ideator or Guide answer, a saved PRD, or a
requested Markdown explanation does not start planning, implementation, or a commit.
