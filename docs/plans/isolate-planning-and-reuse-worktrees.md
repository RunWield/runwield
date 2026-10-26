---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/planning-worktree.ts"
    - "src/shared/session/agent-switching.js"
    - "src/shared/session/session-runtime.js"
    - "src/shared/worktree-registry.js"
    - "src/tools/plan-written.ts"
    - "src/shared/workflow/execution-start.ts"
    - "src/shared/workflow/epic-continuation.ts"
    - "src/cmd/load-plan/"
    - "docs/adr/005-concurrent-worktree-isolation.md"
    - "docs/prd/runwield-core-prd.md"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-09-16"
status: "draft"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
planId: "abc23a86-17d0-47cb-bcf7-b6cd65a88ea2"
---

# Isolate Planning and Reuse Its Worktrees

## Context

Planner reads changing files when the user switches branches or works on another request in the primary checkout.
Preserving the conversation does not preserve the source context. This affects standalone Planned Changes, Sequences,
and Epic continuation.

Current source provides only partial protection. `preparePlanningWorktreeForPlan` requires an identified Plan already on
its target branch. Some child-loading paths use it; ordinary Planner entry and PROJECT container loading do not.
`switchActiveAgent` can change tool directories, but does not durably record that directory. `plan_written` captures the
old HostedSession directory during tool construction. Execution promotes a planning worktree but does not refresh its
branch first. These are source findings, not a reproduced end-to-end test result.

The owner confirmed:

- Start planning in an isolated worktree before a Plan exists. Associate it with the durable Session, without a fake
  Plan.
- At `plan_written`, bind that same worktree to the real Plan ID. Sessions remain associated with the Plan.
- Immediate and deferred execution reuse the selected Plan's worktree.
- Refresh against the agreed `targetBranch`, not specially against `main`. Without an explicit target, capture the
  checked-out branch when planning starts. A later checkout switch cannot change that choice.
- Keep an Epic's planning worktree separate from child worktrees. Refresh the Epic context on continuation; each child
  plans and executes in its own worktree and publishes to the Epic branch.
- Apply isolation to Sequences too, including joint review and ordered child execution.

Owning Core PRD capabilities and proposed changes:

- [Plan authoring and external adoption](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption): add stable
  isolated planning; preserve **The user owns the Plan body** and **External Markdown Plans are first-class**.
- [Plan review](../prd/runwield-core-prd.md#plan-review): extend **Apply the user's review decision to the saved Plan**
  with same-document Run/Later behavior, including Sequence families.
- [Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold): extend **Deliver independent
  children and preserve paused work** with branch-independent container and child continuation.
- [Execution, validation, and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery): extend
  **Validate and deliver approved work without losing recoverable changes**; preserve **Replanning preserves the
  existing implementation** and automatic internal recovery.
- [Session continuity](../prd/runwield-core-prd.md#session-continuity) and
  [Work protection](../prd/runwield-core-prd.md#work-protection): preserve saved work across clients and protect user
  files.

Automatic Epic branch creation remains in
[Plan Packages and Independent Validation](plan-packages-and-independent-validation.md). This change uses an existing
recorded Epic target. It does not add Epic publication, integrated validation, or a Sequence release branch. No
requirement is removed.

## Objective

Primary-checkout branch switches and unrelated edits cannot change an ongoing planning Session's files, selected target,
or saved draft. Save/restart/load and immediate execution resolve the same work. First execution refreshes the target
before materializing the approved Plan and recording its execution baseline.

## Approach

Use existing worktree, controller, Session, and lifecycle owners. Do not make Plan YAML a second worktree registry.

```text
first persisted planning turn
  resolve known Plan/container, or capture current target
  restore or create worktree; persist Session association
  build Agent and all tools with explicit worktree cwd
plan_written
  ensure real Plan ID
  bind worktree to Plan; record document location and Session association
  review -> Save / Execute / Decompose
first execution
  locate approved document -> preserve it and working changes
  refresh target -> rebase same planning branch
  materialize approved Plan -> capture baseline -> start Engineer
```

### Ownership and activation

Extend the registry with an explicit Session-owned planning entry: stable worktree ID, Session ID, target/base evidence,
branch and path, but no invented Plan name or ID. Existing Plan-owned entries remain compatible. A locked, repeat-safe
binding operation supplies real Plan identity without changing the worktree ID, branch, or path. Ordinary registry
updates must still reject identity rewrites and duplicate live Plan attempts.

Persist the selected worktree in Session custom-entry evidence under the existing managed-operation writer lock. Resolve
its path through the registry. Preserve that evidence across transcript segments and process restart; the transcript's
storage directory is not the Agent's tool directory. After binding, Plan/controller/registry evidence wins over stale
Session hints. Multiple Sessions can refer to one Plan; this does not grant simultaneous write authority.

Prepare the directory before Agent/tool construction through the shared activation path, not just Router dispatch. Cover
direct Planner selection, routed planning, load-plan, restart, and existing PROJECT planning/decomposition paths. An
empty composer still creates no durable Session or worktree. Preserve the current SessionManager and conversation. Pass
the selected cwd explicitly to `plan_written` and other tools; failed Agent construction must preserve the previous
working Agent and handler. Do not use process-wide `chdir`.

Reuse a registered worktree only for the selected Plan or ongoing unbound planning request. Merely starting inside some
other linked worktree does not make it suitable. Starting a different Plan must not rebind or overwrite a previous
Plan's worktree. Replanning an active implementation keeps its existing worktree and recovery evidence.

### Containers and children

| Work                      | Planning document location                                       | Execution                                             |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Standalone Planned Change | Session worktree, then owned by Plan ID                          | Promote that same worktree                            |
| Epic                      | Retained container worktree based on its Epic target             | Container is not an execution attempt                 |
| Sequence                  | Retained container worktree for complete family and joint review | Container is not an execution attempt                 |
| Selected child            | Its own worktree based on the container target                   | Reuse that child worktree; publish to recorded target |

Container-owned drafts can include children not yet committed to the target. Their controller document references must
resolve them there until each child gets its own worktree. Selection transfers that child's document location, not the
container's ownership. Keep the approved child bytes and ID. Sequence children need no extra planning or review merely
to enter their worktrees. Each later child starts from the updated target containing prior child publication.

Epic continuation first leaves the completed child's directory, restores and refreshes the retained Epic context, then
selects the next child and prepares that child's directory before Planner or Engineer starts. Sequence continuation uses
the same location rules without changing its joint approval or order. Child cleanup must not remove the container or a
sibling's work. Document discovery must enumerate controller references, not only the registry entry's owning Plan name.
Stale primary copies never override registered drafts or published target progress. Container refresh uses the same
loss-safe preservation as execution preparation. Restore unpublished drafts, but do not restore an old child draft over
its proven published revision. Use existing delivery evidence to distinguish the two.

### Target refresh and safe preparation

Use the explicit agreed target, inherited container target, or branch captured at planning entry, in that order for new
work. Persist the effective target with the Plan when identity is established; never infer it later from the primary
checkout. Preserve existing explicit child target policy. Missing or ambiguous targets must not silently become `main`.
Fresh worktrees use committed target files, as existing isolated preparation does; do not import unrelated primary
edits.

Fetch the recorded target when a remote exists; local-only repositories remain supported. Keep local target commits that
have not reached the remote. Resolve ancestry and perform integration only in managed worktrees, never by resetting or
checking out the user's primary directory. The retained container uses a managed branch based on the Epic target; Git
must not require checking out an already-checked-out target branch twice.

For the first execution of a planning entry, durably preserve the approved document and all working changes before Git
refresh. Rebase onto the resolved target before restoring/materializing the approved Plan. If an explicit target changed
during planning, replay only work belonging to the planning branch, not unrelated history from the old base. Record the
new base evidence through a guarded operation, then capture the execution baseline after Plan materialization. Incoming
target changes must not appear as implementation changes. Planning preparation commits do not mean execution has
started.

Use existing transition journals and Git snapshots for restart recovery. Preserve staged/unstaged distinctions and
untracked files. Reconcile an interrupted preparation from its recorded evidence before retrying. A conflict keeps the
same work recoverable and must not launch Engineer with a partial rebase or claim execution started. RunWield repairs
its own metadata; ask only when a real content decision or external prerequisite is needed. Never overwrite a newer Plan
edit with an older saved snapshot.

Do not automatically rebase an already-started execution or recapture its baseline when it returns to Planner. Its
implementation, review invalidation, and recovery rules remain unchanged.

Keeping planning in primary until approval was rejected: it leaves the reported failure intact. Separate databases and
runtime worktree fields in Markdown would duplicate existing authority and are not needed.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/planning-worktree.ts`, `src/shared/worktree.js`, `src/shared/worktree-registry.js` — unnamed
  Session ownership, binding, retained container/child worktrees, and safe target refresh.
- `src/shared/session/agent-switching.js`, `session.js`, `session-runtime.js`, `hosted-session.js`, Session persistence
  helpers — restore working-directory evidence before constructing tools while preserving transcript continuity.
- `src/tools/plan-written.ts`, `src/shared/workflow/sequence-review.ts` — real identity binding before review and saved
  container/child document references; all tools use the selected cwd.
- `src/shared/workflow/plan-location.ts`, `controller-registry.ts`, `plan-executor.ts`, `execution-start.ts`,
  `execution-plan-file.js` — authoritative document discovery and refresh-before-materialization for first execution.
- `src/cmd/load-plan/`, `src/shared/workflow/epic-continuation.ts`, `workflow-slicer.ts`, and post-publication handoff —
  correct container/child cwd for manual and automatic continuation, including unpublished child drafts.
- Real-Git workflow, tool, registry, and Session tests — prove composed behavior, not only helper results.
- `docs/prd/runwield-core-prd.md`, `docs/adr/005-concurrent-worktree-isolation.md`,
  `docs/adr/015-file-authoritative-session-bundles.md`, `docs/plan-lifecycle.md`, `docs/domain-language.md` —
  synchronize planning ownership, Session working context, Sequence and child rules, and affected references. Keep
  ADR-017's runtime layout unchanged. Update bundled Planner guidance only where it contradicts automatic runtime
  behavior.

No browser redesign or external-host cwd protocol change is required. TUI, Workspace, ACP, and headless managed Sessions
share the runtime fix. Connect hosts that own their tools are not silently redirected by this change.

## Reuse Opportunities

- `preparePlanningWorktreeForPlan`, `resolveWorkflowPlanLocation`, and controller `documentWorktreeId` already separate
  document ownership from execution.
- `switchActiveAgent` / `ensureRootAgentSession` rebuild tools while retaining the conversation.
- Session Plan Associations and file-backed custom entries provide durable Session evidence without Workspace SQLite.
- `runExecutionPreparationTransition`, Git snapshots, and `checkpointExecutionPreparation` provide guarded preparation.
- `enterProjectRuntime` / `resolveProjectRuntimeLayout` keep shared runtime state under primary `.wld/internal/`.
- `defineGitFixture` and `makeValidationProjectRoot` support real Git and Plan tests without new injection seams.

## Implementation Steps

1. Regression fixtures demonstrate the current failure through managed Planner entry: primary branch switches change
   Planner-visible content, and a fresh Session reload cannot recover an unbound planning worktree. Tests fail on the
   current behavior before the implementation changes.
2. Registry and Session persistence support Session-owned planning without fake Plan identity. Repeated activation and
   restart resolve the same worktree; different Sessions starting independent work resolve different worktrees. Existing
   Plan entries still load, and unbound entries are not misclassified as legacy corrupt Plans.
3. All managed planning entry paths build file, shell, search, and workflow tools in the selected worktree before the
   first planning turn. Transcript continuity, model selection, empty-composer behavior, and failed-switch rollback
   survive.
4. `plan_written` binds the real Plan and authoritative document before review advances. Binding retries are idempotent;
   feedback, cancel, Save, restart, and Run preserve the worktree. Binding failure cannot report successful durable
   review handoff. Loading from another Session resolves the same Plan-owned directory, not a stale primary copy.
5. Epic and Sequence containers retain isolated family drafts. Manual load and automatic continuation refresh the
   container context and prepare separate child worktrees. Unpublished children remain discoverable, joint Sequence
   approval remains valid, and child publication/cleanup cannot destroy the container's work.
6. First execution rebases the selected planning worktree onto the recorded target before Plan materialization and
   baseline capture. It retains identity and content through interrupted preparation and retry. Active execution
   reapproval preserves the original implementation and baseline without this initial refresh.
7. Integration tests prove Run and Later, branch switches, target advancement, interruption, container continuation,
   Sequence order, and primary-file preservation through the real owning modules. No new owned-machinery test seam
   exists.
8. Owning PRD requirements/scenarios, ADR-005/015, lifecycle references, and glossary definitions for Session context,
   Plan Association, Epic, Sequence, and Child PLANNED_CHANGE Plan match the delivered behavior. Update stable
   relationships and avoided aliases where affected. Keep automatic Epic branch creation and other unmet requirements
   explicitly deferred.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

Use sandboxed tests only. Add focused cases to existing suites or new adjacent integration files and run them through
`scripts/run-tests.js`.

```sh
deno run -A scripts/run-tests.js src/shared/workflow/planning-worktree.test.ts
deno run -A scripts/run-tests.js src/shared/workflow/epic-branch-planning.integration.test.ts
deno run -A scripts/run-tests.js src/shared/session/agent-switching.test.js
deno run -A scripts/run-tests.js src/shared/session/session-runtime.test.js
deno run -A scripts/run-tests.js src/tools/__tests__/plan-written.test.js
deno run -A scripts/run-tests.js src/shared/workflow/workflow.test.js
deno run -A scripts/run-tests.js src/shared/workflow/execution-plan-file.test.ts
deno task seams:check
deno task ci
```

Required behavioral evidence:

- **Isolation before identity:** start a real managed Planner in a Git fixture without a Plan. Read a source marker via
  its actual tool, switch the primary branch and change primary files, then read/write through Planner tools again.
  Original source remains visible; draft appears only in its worktree. Repeat with direct selection and routed entry.
  Another planning Session and an independent primary-checkout quick fix cannot alter that context.
- **Restart and binding:** restart before `plan_written`, then after Save. Assert stable worktree ID/path/branch,
  transcript history, Agent and target. Call the real tool through its constructed cwd. From a different Session, load
  and execute the saved Plan while primary contains a conflicting stale copy. Engineer's cwd and approved body must
  match the saved worktree. Cover feedback/cancel, repeated binding, and failure/retry between registry and
  controller/Session writes.
- **Refresh order:** advance a local bare remote's target after planning, with a code marker and an older/conflicting
  tracked Plan copy. Execute through the real execution start. Assert target commit is an ancestor, approved Plan body
  survives, worktree identity is unchanged, baseline includes target changes, and implementation diff excludes them.
  Also cover local-only and local-ahead targets. Final Plan equality alone is insufficient: inspect Git preparation
  history/evidence to establish refresh occurred before materialization and baseline capture.
- **Loss protection:** stage one edit, leave a second unstaged, and add an untracked file in the planning worktree.
  Cause a rebase conflict and interrupt preparation in a separate process. Retry uses the same directory, retains all
  work and index distinctions, and never starts Engineer during an unresolved operation. Primary HEAD, index, dirty
  tracked bytes, and untracked bytes stay unchanged throughout, apart from normal RunWield runtime/ignore maintenance.
- **Epic continuation:** primary is on an unrelated branch; Epic and children exist only on its target/container.
  Publish child A using the existing delivery path, permit its cleanup, then continue. Container sees A's publication;
  child B's Planner reads A's code in B's separate worktree. B executes there and publishes to the Epic target. No reads
  or Plan writes use the deleted child directory or substitute primary drafts. Repeat via manual load after restart.
- **Sequence:** write container and two children only in the isolated planning directory; joint review then test Run and
  Save/restart/Run. Child A and B have distinct execution worktrees; B's base includes A's published changes. Approved
  child bodies, order, dependencies, and execution policies survive. The container stays available after either cleanup.
- **Preservation:** active-execution reapproval retains commits, staged changes, untracked files, and prior baseline;
  hold/resume and explicit abandonment retain their current rules. Non-Git planning stays usable with existing execution
  consent. An empty composer creates nothing. Registered missing documents never fall back to stale primary copies.

The isolation, deferred execution, refresh ancestry, and Sequence tests must fail for a stub that merely records a path
without rebinding tools, creates a replacement execution worktree, skips rebase, or handles only Epic children.

Manual: in a disposable repository, start standalone planning, switch branches and make an unrelated edit from another
terminal, save, restart, and execute. Repeat with a two-child Sequence and an existing targeted Epic. Observe unchanged
primary edits, correct target publication, and continuing conversation in the proper retained worktrees. Use the normal
managed Session flow, not direct helper calls.

Semantic Review confirms the PRD scenarios and glossary landed with code; ADRs no longer describe ordinary planning in
primary as the rule. Existing tests for primary-edit preservation, review choices, hold, restart, reapproval, and child
ordering must be retained against the new flow. Tests expecting Planner to remain in primary or ordinary execution to
allocate a second worktree must change: those behaviors intentionally stop.

## Edge Cases & Considerations

- More worktrees remain while Plans are saved. Preserve them; do not add automatic expiry or delete unclaimed work.
- A Session can work on several Plans over time. Its last association is not permission to reuse another Plan's
  worktree. Existing workflow selection must distinguish continuation from a new request before the new draft is
  written.
- Explicit target changes before first execution must preserve approved content and correct base history. Once execution
  starts, retain current target-change/recovery policy rather than silently moving an active attempt.
- Container and child documents can share a directory before child selection, but cannot share execution ownership.
  Controller references and discovery must support this without duplicating or overwriting Plan identities.
- No data migration may discard existing planning or active entries. Runtime data remains ignored and excluded from
  checkpoints. New types follow local named-shape rules; do not add `any`, `unknown`, or `object` declarations.
- Test HOME/cwd through project helpers, with `withProcessGlobalTestLock` when mutating process globals. Never run
  `deno test` directly.
