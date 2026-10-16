---
planId: "fca9ebb0-e78c-4f04-ba12-2cbd7ded93b8"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/session-runtime.js"
    - "src/shared/session/session.js"
    - "src/shared/session/agent-handler.ts"
    - "src/shared/workflow/"
    - "src/shared/foreground-process.ts"
    - "src/tools/"
    - "src/plan-store.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T02:05:51.352Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 7
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
    - "06-forward-personal-mcp-tools-from-the-laptop"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
---

# Carry Remote Context Through Delivery Workflows

## Context

A remote conversation is not sufficient. RunWield's value depends on planning, isolated execution, validation, AI
review, repair, Code Review state, and confirmed publication using the same project and Session rules. Child Sessions
and subprocesses currently derive much of their context from local cwd and process state, so any lost remote context
could create a remote personal profile, touch the laptop filesystem, or escape connected-only supervision.

This slice delivers the non-browser part of the Remote SSH PRD's **Remote workflows and local review** and **Disconnect
and recovery** capabilities. Existing Plan lifecycle, work protection, validation, AI review, Code Review, and
publication meanings must remain unchanged.

## Objective

Make every Core-created child Session, Agent, project tool, worktree, validation process, repair step, and publication
action inherit the active remote execution context and local personal authority. Stop new effects on connection loss and
reconcile uncertain outcomes from canonical evidence without replay.

## Approach

Carry one explicit remote execution context through existing Session and workflow construction points. Keep workflow
truth, project files, Git, Plans, Work Records, validation, and publication remote. Keep personal models, resources,
Memory, and Session authority local through the existing connection. Register every owned process with the independent
supervisor.

```text
root remote Session
  planning child
  execution worktree and child
  validation and AI review
  repair child
  publication
```

Do not create a parallel SSH-shell workflow implementation; it would bypass existing lifecycle, protection, and recovery
rules.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/session-runtime.js`, `session.js`, and child Agent construction — inherit remote project,
  execution, personal-service, storage, and supervision context.
- `src/shared/workflow/`, Plan storage, and worktree handling — keep lifecycle and canonical evidence on the remote
  project.
- `src/tools/` and `src/shared/foreground-process.ts` — run project tools remotely and register connection-owned
  subprocesses for cancellation outside blocked Agent execution.
- Validation, AI review, repair, Code Review state, and publication paths — reconcile evidence after loss without
  automatic effect replay.
- The owning Core and Remote SSH PRD sections — synchronize delivered workflow and recovery scenarios while local
  browser forwarding remains target behavior.

## Reuse Opportunities

- Existing workflow state machines and Plan lifecycle — preserve them as the only delivery authority.
- Existing Git/worktree protection, validation, AI review, repair, and publication code — run them in the remote context
  rather than reimplementing them.
- `buildExecutionSession`, `runIsolatedAgentSession`, and SessionRuntime child-operation paths — establish context
  inheritance at construction seams.
- Existing foreground process ownership — extend exact tracking to remote helper and workflow processes.

## Implementation Steps

- Child04 admits only a root remote Session with a laptop save bridge. The remaining remote guards in
  `buildAgentSession` (`src/shared/session/session.js`) and `requireLocalSessionWriter` no longer block workflow
  handoffs, child Sessions, write delegation, or Plan review in a connected remote Session.
- Segment rollover at execution and repair handoff runs through `RemoteSessionOwner.rollover` on the laptop. The
  predecessor and successor segments and their lineage are committed on the laptop, and no remote transcript exists.
- Root, planning, execution, repair, delegated, semantic-review, and Guided Review Session construction receives the
  same remote project locator, current remote cwd/worktree, local personal-service handle, local Session ownership, and
  connection supervisor.
- Core file, shell, Git, Cymbal, build, test, Plan, and Work Record operations act only on the remote project or
  isolated remote worktree; no fallback can run them against a same-named laptop directory.
- Plan lifecycle, approval evidence, worktree protection, validation, AI review, Code Review state, repair limits, and
  confirmed publication retain their existing meanings and canonical remote evidence.
- Every RunWield-owned helper, Agent child, tool subprocess, review job, and validation process is tracked precisely
  enough that connection loss stops new effects and terminates owned work without affecting unrelated processes.
- Storage failure blocks dependent workflow completion even if an intermediate caller catches an error; early live UI
  events are not treated as saved success evidence.
- Reconnect inspects local Session commits and remote workflow, Git, Plan, Work Record, and publication evidence before
  continuation; uncertain tool calls, review decisions, and external effects are not replayed automatically.
- Failed attempts, transport loss, retry limits, and internal inconsistency remain recoverable intermediate conditions.
  Delivery concludes only after confirmed publication or deliberate user abandonment.
- The Core and Remote SSH PRD requirements and acceptance scenarios match delivered remote workflow behavior and
  preserve ordinary local TUI, ACP, Workspace, and workflow behavior.

## Verification Plan

- Automated: add cross-context integration tests for planning, execution children, repair children, delegated Agents,
  tools, worktrees, validation, AI review, Code Review state, Work Records, and publication. Assert every project path
  is remote and every personal operation remains local.
- Automated: test connection loss while an Agent, shell tool, validation, review job, repair, and publication operation
  is active. Assert exact owned processes stop, unrelated processes survive, and no action is replayed on reconnect.
- Automated: test storage failure propagation through callers that catch errors and verify workflow completion remains
  blocked until evidence is reconciled.
- Automated: run focused tests through `deno run -A scripts/run-tests.js <test paths>`, then `deno task seams:check` and
  `deno task ci`.
- Live: use a remote-only Plan to perform isolated execution, validation, AI review, repair, Code Review where selected,
  Work Record generation, merge, and confirmed publication. Continuously verify the laptop sentinel tree remains
  unchanged.
- Live (moved from child04): trigger a segment rollover in a remote Session, disconnect, reconnect, and confirm
  `/resume` continues from the successor segment with laptop lineage intact.
- Failure evidence: cut transport during tool execution, validation, repair, generation commit, merge, and publication.
  Reconnect and confirm proven outcomes are retained, uncertain outcomes are reported, and no external effect is
  repeated automatically.

## Edge Cases

- An external action accepted before loss can finish after RunWield stops its own work. Report evidence and uncertainty;
  closing SSH cannot roll it back.
- An arbitrary daemon launched outside RunWield ownership cannot be safely killed by broad matching. Keep process
  ownership explicit and describe the limit.
- Child operations can change worktree cwd while retaining parent project identity and personal Memory mapping.
- Existing local and Workspace workflows must not acquire remote-mode checks throughout their tools; the context should
  be established at construction boundaries.
