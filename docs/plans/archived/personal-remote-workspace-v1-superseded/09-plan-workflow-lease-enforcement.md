---
planId: "f8c4bb27-964d-46ac-b51c-22510569d953"
classification: "FEATURE"
complexity: "MEDIUM"
summary: "Add Session-owned Plan Workflow Leases around lifecycle, validation, worktree, recovery, and manual Plan actions so one Session owns a Plan workflow even when the active process changes."
affectedPaths:
    - "src/shared/workflow/"
    - "src/shared/worktree-registry.js"
    - "src/plan-store.js"
    - "src/cmd/load-plan/"
    - "src/ui/workspace/server/"
    - "src/ui/tui/"
createdAt: "2026-07-22T03:56:51.473Z"
updatedAt: "2026-07-22T03:56:51.473Z"
status: "draft"
origin: "internal"
parentPlan: "personal-remote-workspace-v1"
order: 9
dependencies:
    - "08-durable-workflow-checkpoints-and-interactions"
---

# Plan Workflow Lease Enforcement

## Context

Session activation prevents concurrent transcript writers, but Plan execution and lifecycle effects also need ownership.
Today `recordPlanEvent()` writes canonical Plan front matter and is called from CLI workflows, validation, and Workspace
handlers. The worktree registry lock serializes registry writes but does not know which Session is entitled to drive a
Plan.

Personal Workspace needs a Plan Workflow Lease keyed by Project and durable Plan ID, owned by a stable RunWield Session
ID, and fenced by lease generation. The active process may change while the Session remains the workflow owner.

## Objective

Implement Plan Workflow Lease enforcement around consequential Plan/worktree effects:

- acquire/hold/release/takeover Plan Workflow Leases with fenced generations;
- enforce lease compatibility below all adapters for lifecycle transitions, validation, execution, recovery, and manual
  actions;
- preserve canonical Plan markdown and worktree registry as sources of truth while recording expected revisions/evidence
  in checkpoints;
- reject different Sessions until workflow end, explicit hold/release, takeover, or Plan Recovery;
- keep existing Plan Lifecycle state machine behavior intact.

## Approach

Add lease state to the owner coordination DB and enforce it in shared workflow/lifecycle modules, not only Workspace
routes. Wrap or augment `recordPlanEvent()` and worktree/validation entry points with ownership checks. Expose Plan
revision and worktree evidence helpers so checkpoints can distinguish committed transitions, safe retries, and uncertain
recovery.

## Files to Modify

- `src/shared/workflow/plan-lifecycle.js` — enforce compatible Plan Workflow Lease ownership around `recordPlanEvent()`
  and lifecycle transitions.
- `src/shared/workflow/workflow.ts`, `validation.js`, and `workflow-results.js` — carry Session/lease identity through
  execution, validation, and recovery paths.
- `src/shared/worktree-registry.js` — expose worktree evidence and enforce or verify lease-compatible consequential
  registry changes.
- `src/plan-store.js` — expose canonical Plan revision/status evidence needed for expected-state checks.
- `src/cmd/load-plan/` and `src/cmd/` — ensure CLI Plan actions participate in the same lease checks.
- `src/ui/workspace/server/` and `src/ui/tui/` — show lease owner/compatibility and route incompatible actions to
  recovery or takeover.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `src/shared/workflow/plan-lifecycle.js` — keep the canonical Plan state machine; add authorization around use rather
  than duplicating status logic.
- `src/shared/worktree-registry.js` — reuse registry locking and evidence patterns.
- `src/shared/workflow/validation.js` — reuse validation/result flow while adding lease context.
- Durable checkpoint APIs from slice 8 — reuse expected generation and exact-once continuation semantics.

## Implementation Steps

- [ ] Add owner DB schema for Plan Workflow Leases keyed by Project ID and durable Plan ID with owner Session ID, lease
      generation, status, and timestamps.
- [ ] Implement acquire, validate, hold, release, takeover-request, and recovery-compatible lease operations.
- [ ] Expose canonical Plan revision/status and worktree evidence helpers without moving artifact ownership into SQLite.
- [ ] Enforce lease checks in `recordPlanEvent()`, execution start/finish, validation, merge/recovery, worktree registry
      mutation, and Workspace manual Plan actions.
- [ ] Ensure the same Session can continue a Plan workflow after its active process moves from TUI to Workspace or ACP.
- [ ] Add tests for same-Session process handoff, different-Session rejection, manual edit detection, stale lease
      generation, validation bypass prevention, and recovery routing.

## Verification Plan

- Automated: run `deno task ci`.
- Automated: prove Plan Workflow Lease ownership persists when the same Session moves from TUI to Workspace, rejects a
  different Session, and cannot be bypassed through CLI, Workspace lifecycle handlers, ACP, validation, or recovery.
- Automated: crash-point tests should cover Plan front matter written before checkpoint publication, registry update
  failures, stale worktree evidence, and explicit recovery.
- Manual: start a Plan workflow in TUI, view/continue compatible actions from Workspace under the same Session, then
  attempt an incompatible action from another Session and verify rejection/recovery guidance.

## Edge Cases & Considerations

- Direct repository edits cannot be prevented; expected Plan revision/status checks must detect them.
- SQLite cannot atomically commit with markdown/worktree files; write canonical artifacts before publishing coordination
  state.
- Do not duplicate Plan Lifecycle status logic in Workspace.
- Existing non-Git and QUICK_FIX behaviors must remain compatible where possible.
