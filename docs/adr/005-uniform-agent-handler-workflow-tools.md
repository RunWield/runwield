---
status: accepted
---

# Active Agents Use One Workflow-Aware Handler

## Context

RunWield previously treated Router as both an Agent and a workflow entrypoint.
The runtime had a Router-specific handler that consumed `triage_report`, while
other Agents used a separate handler that consumed `plan_written` and
`task_completed`.

That split made Agent activation shallow and fragile. Boot, `/agent`,
`return_to_router`, `load-plan`, and workflow restores all had to know which
handler to install. If any path activated Router with the normal Agent handler,
Router could call `triage_report` successfully but nothing would dispatch the
workflow afterward.

## Decision

All active Agents use one Agent Handler.

The Agent Handler does not infer workflow transitions from returned messages or
transcript text. Accepted workflow Custom Tools publish typed Workflow Tool
Events. The handler or validation owner claims the event once and settles it
after the durable lifecycle or validation checkpoint is safe to retry.

The message stream is human-readable output, never authority for approval,
execution, or completion. An Agent ending a turn, emitting completion prose, or
failing to call a workflow tool cannot end an active delivery workflow. Typed
tool events advance it under the
[Core completion contract](../prd/runwield-core-prd.md#execution-validation-and-recovery);
tool acceptance alone is not proof of publication.

- `triage_report` publishes routing data and starts post-triage workflow
  dispatch.
- `plan_written` publishes the Plan review outcome and starts execution, starts
  decomposition, or keeps planning active.
- `task_completed` publishes the accepted completion and continues active
  execution or Workflow Validation when execution context exists. During Pair
  Execution, its first final attempt records a durable final checkpoint. Only a
  later accepted user turn and typed checkpoint resolution can authorize a new
  accepted completion.
- `pair_checkpoint` records a durable report that ends the Agent turn, then
  records a typed resolution from a later genuine user turn. Conversation text
  remains context, not workflow authority.
- `review_diff`, `review_complete`, and `qa_checklist_generated` publish
  isolated validation evidence for the current owner and generation.

Router is the default Agent for fresh Triage, but Router has no special runtime
handler. If another Agent is granted `triage_report`, the same post-triage
workflow dispatch runs from that accepted event.

Agent switching is uniform. Boot, `/agent`, `return_to_router`, Plan recovery,
validation restore, and workflow steps activate an Agent by installing the same
Agent Handler for the chosen Agent Name.

Workflow-only Agent Definitions such as Reviewer, Slicer, and Init are still
Agents. They may be hidden from `/agent` selection and may be run as one-shot
workflow Agent Sessions, but they are not special runtime modes. When a
workflow-only Agent remains active for follow-up turns, such as Slicer during
Epic decomposition, RunWield uses the same Agent Handler with explicit session
data for that Agent Definition and its workflow-scoped Custom Tools.

## Consequences

### Positive

- **Locality**: workflow outcome interpretation is concentrated in the Agent
  Handler and validation owner instead of spread across activation call sites.
- **Leverage**: adding a workflow Custom Tool to an Agent preserves the tool's
  semantics through one event contract.
- **Simpler session model**: active Agent identity is data; there is no hidden
  "Router mode."
- **Safer authority**: forged or stale transcript-shaped tool results cannot
  advance workflow state.

### Negative

- The Agent Handler now knows about all first-class workflow Custom Tool
  outcomes. That is intentional: the handler is the seam between Agent Sessions
  and workflow orchestration.
- Callers that previously injected handler factories for tests must use
  `createAgentHandler`; older alternate handler names are intentionally removed.
