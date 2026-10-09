---
planId: "6f657be4-18bc-4942-acb2-8aa4abe50c6e"
classification: "FEATURE"
complexity: "MEDIUM"
summary: "Persist typed human gates and structured interactions so feedback, approvals, recovery decisions, and cross-surface prompts can survive process loss and be consumed exactly once."
affectedPaths:
    - "src/shared/session/"
    - "src/shared/workflow/"
    - "src/shared/session/session-runtime-interactions.js"
    - "src/ui/workspace/server/"
    - "src/ui/tui/"
createdAt: "2026-07-22T03:56:51.473Z"
updatedAt: "2026-07-22T03:56:51.473Z"
status: "draft"
origin: "internal"
parentPlan: "personal-remote-workspace-v1"
order: 8
dependencies:
    - "07c-fenced-session-mutation-families"
---

# Durable Workflow Checkpoints and Interactions

## Context

Current interactions and workflow continuations rely on in-memory promises and nested call stacks inside `HostedSession`
or workflow execution. That works inside one process but cannot support phone review, process handoff, browser
disconnect, or crash-safe continuation. Personal Workspace v1 needs durable typed checkpoints: state transitions with
expected generations and continuation policies, not serialized function stacks.

## Objective

Implement durable checkpoints and interaction persistence:

- checkpoint records with Session, optional Plan, expected Session/Plan/lease generations, pending decision type,
  outcome, and continuation policy;
- state machine transitions for Pending, Resolved, Canceled, Uncertain, Resuming, and Consumed;
- compare-and-set resolution and consumption so retries or stale owners cannot apply an outcome twice;
- Runtime APIs for publishing, resolving, claiming, consuming, and reconciling checkpoints;
- durable support for Plan review, Feedback, Approve & Run, Approve for Later, Plan Recovery, human code review, and
  generic structured interactions.

## Approach

Add checkpoint schema and shared coordination APIs below adapters. Integrate with `SessionRuntime` interaction seams
first, then workflow modules. Keep continuation policies typed and conservative: if the original Runtime is alive it may
consume the outcome; if gone, a later owner validates expected evidence and resumes only supported workflow
continuations. Arbitrary interrupted model/tool/command stacks are not replayed.

## Files to Modify

- `src/shared/session/session-runtime-interactions.js` — persist structured interaction requests and correlate outcomes
  with semantic events.
- `src/shared/session/session-runtime.js` — add checkpoint publication/resolution/consumption APIs and event emission.
- `src/shared/session/hosted-session.js` — coordinate active in-memory interactions with durable checkpoint records.
- `src/shared/workflow/` — add durable workflow checkpoint helpers and typed continuation dispatch scaffolding.
- `src/ui/workspace/server/` — expose authenticated checkpoint query/resolve APIs for later browser flows.
- `src/ui/tui/` — surface durable pending/recovered interactions where applicable.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `src/shared/session/session-runtime-interactions.js` — reuse existing interaction request/response semantics.
- `src/shared/session/session-runtime-events.js` — emit stable semantic interaction/checkpoint events.
- `src/shared/workflow/guided-review.js` and `src/shared/workflow/decisions.ts` — reuse structured workflow decision
  concepts.
- Owner DB migration utilities from earlier slices — add checkpoint tables with the same transaction conventions.

## Implementation Steps

- [ ] Add checkpoint and durable interaction schema migrations, indexes, and state constraints.
- [ ] Implement checkpoint creation, resolution, cancellation, claim-for-resume, consume, and mark-uncertain operations
      with CAS/fencing checks.
- [ ] Integrate `SessionRuntime.requestInteraction` with durable request records while preserving existing adapter
      behavior.
- [ ] Add typed continuation policy definitions for Plan review, Feedback, Approve & Run, Approve for Later, Plan
      Recovery, human code review, and generic structured interactions.
- [ ] Add reconciliation behavior for resolved-but-not-consumed, resuming-but-lost, duplicate submission, and stale
      generation cases.
- [ ] Add tests for duplicate browser submissions, reconnect retries, stale fencing, process restart, and exact-once
      consumption.

## Verification Plan

- Automated: run `deno task ci`.
- Automated: tests should prove Pending-to-Resolved-to-Resuming-to-Consumed transitions are fenced and exact-once,
  duplicate resolution is rejected/idempotent as appropriate, and uncertain states require explicit recovery.
- Automated: crash-point tests should cover checkpoint resolution before consumption and owner loss during Resuming.
- Manual: create a pending structured interaction, resolve it from a simulated Workspace call, restart the owning
  process where practical, and verify the outcome is either consumed once or remains visibly recoverable.

## Edge Cases & Considerations

- A checkpoint is a typed state transition, not a serialized call stack.
- Browser disconnect never resolves or cancels a checkpoint by itself.
- Resolved outcomes must be scoped to the expected Session, Plan, and generation evidence.
- Uncertain states should be conservative and visible rather than auto-replayed.
