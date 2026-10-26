---
planId: "aa89b924-c36c-45fa-8df6-b156586a1fc4"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/agent-handler.ts"
    - "src/shared/session/agent-switching.js"
    - "src/shared/session/hosted-session.js"
    - "src/shared/session/session-runtime.js"
    - "src/shared/session/session.js"
    - "src/shared/workflow/workflow-tool-events.ts"
    - "src/tools/triage-report.ts"
    - "src/shared/session/agent-handler.test.ts"
    - "src/shared/session/session-runtime.test.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-22"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
workRecord:
    status: "generated"
    recordId: "c2c2d43c-223e-425b-954a-89a13157b230"
    path: "docs/work-records/2026-09-23-deliver-steering-to-replacement-agents.md"
    lastAttemptAt: "2026-09-23T16:07:59.874Z"
status: "validated"
validatedCommit: "c2f4c30b1ca146b20dc943e609bb27e0ead72a61"
archivedAt: "2026-10-26T13:31:54.743Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/fix-steering-across-agent-handoffs.md"
---

# Deliver Steering to the New Agent After Handoff

## Context

The user reports that a Steering Message sent after the Triage Report makes Router report triage again, even as the
Session announces Planner. The message must reach the new Agent instead.

Current source shows two gaps; the exact failure still needs a failing regression test:

- `runRootTurnUntilRootWorkflowEvent` returns on an accepted terminal event without stopping or awaiting the old turn.
- `steerSession` buffers input only while `switchActiveAgent` builds the replacement. This excludes the interval between
  tool acceptance and switching. Undelivered steering already in the old Pi queue is not transferred.

Pi 0.85.1 can continue for pending steering even when a tool returns `terminate: true`. Also, `triage_report` displays
its report before awaiting metrics and publishing acceptance. The test must include input sent from that visible
boundary, not only input during root construction.

Owning requirements:

- [Core: TUI conversation](../../prd/runwield-core-prd.md#tui-conversation): **Keep follow-ups with their active
  specialist** and **Announce real Agent changes once**.
- [Core: Request routing](../../prd/runwield-core-prd.md#request-routing): **Match planning and checks to the request**,
  including no duplicate triage.
- [Core: Plan review](../../prd/runwield-core-prd.md#plan-review): preserve feedback in the planning conversation.

Proposed clarification: undelivered Steering Messages at an Agent handoff go to the replacement Agent once, in order,
with their images. No routing choices or review outcomes change. Existing
[ADR-006](../../adr/006-uniform-agent-handler-workflow-tools.md) event authority and
[ADR-010](../../adr/010-session-runtime-sibling-adapters-and-acp.md) runtime ownership remain in force.

## Objective

After a successful handoff, the previous Agent cannot consume pending steering or continue its workflow. The selected
Agent receives that input once. Router produces one Triage Report and the Session produces one switch notice.

## Approach

Repair the shared Session path, not the Router prompt or TUI renderer:

```text
Terminal workflow decision accepted
  hold new steering for the handoff
  preserve undelivered steering from the old Agent
  stop and settle the old turn
  switch Agent through switchActiveAgent
  deliver held steering to the new Agent
```

Use the existing HostedSession transition buffer and SessionRuntime queue ownership. Extend their coordination to cover
the full handoff, including the replacement's first prompt preparation. Do not create a durable queue or a second
workflow dispatcher.

The accepted event remains the reason to advance. Stop the captured outgoing Agent Session, not whichever root happens
to be current later. Reuse the internal `WorkflowStepCompleted` shutdown pattern from `runValidationAgentUntilEvent`
where appropriate. Do not convert successful handoff cleanup into user cancellation or a failed request. Preserve the
accepted tool result and wait for old-turn settlement before starting the replacement's provider work.

Transfer only messages not yet delivered. Preserve Runtime message identity, text, images, order, and notification
destination. Clearing the old backend queue is a transfer, not consumption: current queue-length reconciliation must not
publish a false consumed event. Recheck the target after asynchronous image preparation so an in-flight steering
submission cannot enqueue into a retired Agent.

Keep `plan_written` feedback as a same-Agent continuation. Apply the shared fix to real root handoffs; do not redesign
execution, validation, or isolated Agent workflows. Source attribution must remain tied to the Agent that made the tool
call, not a later foreground target.

Suppressing duplicate Triage display is not a fix: it would hide old-Agent work and could lose the user's message.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/agent-handler.ts` — terminal-event cleanup and old-turn settlement before dispatch.
- `src/shared/session/{hosted-session.js,agent-switching.js,session.js}` — handoff lifetime, held steering delivery, and
  request settlement.
- `src/shared/session/session-runtime.js` — queue transfer, target rechecks, and truthful queued/consumed events.
- `src/tools/triage-report.ts`, `src/shared/workflow/{workflow-tool-events.ts,orchestrator.ts}` — close the
  report/acceptance/dispatch timing gap where needed; preserve event ownership and consume-once handling.
- Session handler, Runtime, switching, and workflow-event tests — real provider-boundary regression plus focused queue
  cases.
- `docs/prd/runwield-core-prd.md` — add the handoff steering requirement and acceptance scenarios to the owning
  capabilities.
- `docs/domain-language.md` — clarify Steering Message delivery across a handoff; preserve existing aliases and
  foreground-Agent meaning. Do not change unrelated tool-batch policy.

No browser design, adapter-specific routing, new storage, or dependency fork is planned. The Core PRD has unrelated
working-tree changes; preserve them.

## Reuse Opportunities

- `withRuntimeCommandFixture` in `src/cmd/testing/runtime-command-fixture.ts` provides real Pi Sessions, workflow tools,
  and controllable provider responses.
- `agent-handler.test.ts` already routes a real Triage Report through a specialist.
- HostedSession transition steering methods already retain text and images for the replacement turn.
- SessionRuntime queue records and semantic events already own visible pending-message state.
- `WorkflowStepCompleted` distinguishes internal successful shutdown from user cancellation.

## Implementation Steps

1. A deterministic regression drives a real Router-to-Planner handoff through SessionRuntime and the actual
   `triage_report` tool. Steering sent when the report appears reaches Planner once; the test fails on the current code
   because of wrong delivery, old-Agent continuation, or lost input. Provider responses and event barriers control
   ordering without sleeps or injected workflow implementations.
2. Terminal root handoffs stop and settle the outgoing turn before replacement provider work starts. Accepted events
   still advance once without requiring a final assistant response. Outgoing work cannot publish new workflow decisions
   as the replacement Agent. Normal turns and Plan Review feedback still continue as before.
3. Undelivered old-Agent steering and new handoff input reach the replacement once, in order, with images. The protected
   interval includes asynchronous prompt/image preparation. Queue transfer does not claim consumption, lose recall
   support, or duplicate user-message events. Input already consumed before the handoff is not replayed.
4. Failed replacement construction preserves the previous root/handler pair and retains undelivered input without
   automatically restarting Router's accepted triage. Cancellation does not start replacement work or leak buffered
   input into an unrelated later turn; existing explicit cancellation/queue cleanup behavior remains intact.
5. Regression and preservation tests cover the timing cases below. Replace the test that requires dispatch while the old
   root is still running with a test that proves accepted-event authority plus safe shutdown and settlement. Keep its
   original protection against waiting for another model answer.
6. The owning Core requirements and scenarios describe delivered handoff behavior. The Steering Message glossary
   includes this rule, with no new alias or unrelated behavior changes. Unmet requirements stay marked as target;
   preserve unrelated document edits.

## Approval Confirmation

No Work Records are proposed for supersession.

## Verification Plan

### Automated

Run focused tests through the sandboxed runner, never `deno test` directly:

```sh
deno run -A scripts/run-tests.js src/shared/session/agent-handler.test.ts src/shared/session/session-runtime.test.js src/shared/session/agent-switching.test.js src/shared/session/hosted-session.test.js src/shared/workflow/workflow-tool-events.test.ts
deno task seams:check
```

Include these cases in those tests or a dedicated handoff test file included in the command:

- **Reported failure:** submit steering from the real Triage status event, before the old tool returns. Assert one
  accepted Triage Report, one Planner switch, and Planner's first provider context containing the steering. Router must
  not receive it in a later provider request or produce another accepted report.
- **Already pending:** hold Router's provider response, queue two messages (one with an image), then release a real
  `triage_report`. The replacement receives both in order, with the image; neither is lost or delivered twice.
- **Timing boundaries:** input after acceptance, during replacement construction, and during replacement prompt
  preparation goes to the replacement. Use existing events and provider/network barriers, not new public test seams.
  Cover an asynchronous image check overlapping handoff.
- **Real consumption:** queue events retain identity; transfer alone does not emit `consumed`. Successful replacement
  delivery emits one consumption and one visible user message per input. Verify the saved conversation does not contain
  a second Router continuation or duplicate steering delivery.
- **No duplicate dispatch:** inspect actual workflow events and captured provider contexts/tools, not only rendered
  notices. A patch that only suppresses Triage output or discards steering must fail these assertions.
- **Preservation:** ordinary active-Agent steering and foreground isolated-Agent steering still work; already-consumed
  input is not replayed; next-turn messages remain separate; recall and cancellation cleanup retain their existing
  meaning; failed switch construction retains the usable root/handler pair and pending input.
- **Shared root handling:** Plan Review feedback continues planning, while a terminal Plan Review outcome stops
  old-Agent continuation. Accepted tool outcomes still dispatch without an extra provider answer, and stale transcript
  text cannot authorize a workflow.

Use the existing provider fixture and real Session/workflow owners. Keep HOME/cwd mutations under
`withProcessGlobalTestLock`. No new injection seams for owned workflow machinery.

### Manual and semantic review

In the TUI, request a planned change and send an extra instruction immediately after the Triage Report appears. Confirm
one report and one switch notice; Planner acts on the extra instruction. Repeat with an instruction pending before the
report. Inspect the saved Session for duplicate reports or steering messages.

Review the call order: accepted decision, old-turn settlement, replacement activation, input delivery. Verify there is
no unobserved old prompt left running, no false cancellation/error from internal cleanup, and no UI-only workaround.
Check the Core PRD and glossary against the tested behavior.

## Edge Cases & Considerations

- Acceptance and visible report are currently separate moments. Cover both; changing display order alone cannot fix
  already queued steering.
- Pi's terminal tool flag alone does not block steering continuation. Test the real loop rather than a fake Agent that
  stops automatically.
- Image-only input must survive handoff. Unsupported image handling must remain explicit and must not silently discard
  accepted input.
- Queue clearing emits backend updates. Suppress false consumption during transfer through the queue owner, not through
  the renderer.
- Internal shutdown must not interrupt a tool before its accepted result is safely recorded or release the managed
  operation while old work remains active.
- Pending messages remain Session-local and in memory. Persistence across process failure or surface changes is outside
  this fix.
