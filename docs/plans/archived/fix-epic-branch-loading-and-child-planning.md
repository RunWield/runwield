---
planId: "ab125720-250b-47c6-8ca2-10e052058d28"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/shared/worktree-registry.js"
    - "src/shared/worktree.js"
    - "src/shared/workflow/plan-location.ts"
    - "src/shared/workflow/plan-family.ts"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/workflow/controller-state.ts"
    - "src/shared/workflow/planning-agent.ts"
    - "src/shared/workflow/epic-continuation.ts"
    - "src/shared/workflow/execution-start.ts"
    - "src/shared/workflow/state-transition.ts"
    - "src/shared/session/session-runtime.js"
    - "src/cmd/load-plan/"
    - "docs/adr/004-concurrent-worktree-isolation.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-10"
status: "validated"
origin: "internal"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
archivedAt: "2026-09-24T04:25:52.023Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/fix-epic-branch-loading-and-child-planning.md"
---

# Load Epic Progress and Plan Children from the Epic Branch

## Context

An Epic can publish its children to a branch while the user keeps the primary checkout on another branch. Today the user
must switch that checkout to see current child statuses with `/load-plan`. Automatic continuation can select a child
before publication cleanup, then reload it and start Planner in the primary checkout. Planner sees old statuses and
cannot see code delivered by earlier children.

The reported example is child 04 of `consolidate-project-runtime-state`. Its planning text said child 03 was not yet
delivered and warned the Engineer to inspect the execution branch later. That warning does not fix the workflow: Planner
needs the current code and current Plans before it writes the next Plan.

`plan-packages-and-independent-validation` proposes default Epic branches and integrated validation, but does not fully
specify branch-independent loading or preparing the child checkout before planning. The user approved this separate fix
before that larger Epic. This change keeps the current single-file Plan format and validation/publication rules.

Owner decisions:

- Before a new Epic child starts, prepare its own worktree from the latest Epic target branch. Planner works there.
- Treat `main` exactly like any other target branch. It has no special document authority.
- Ignore Plan copies and edits on other branches. Do not reconcile them, copy them, or report warnings about ignoring
  them.
- Keep saved child planning and its edits in that worktree across reload. Use its approved document for execution.
- Do not switch, stage, stash, reset, or overwrite the user's primary checkout to load or plan a child.

## Objective

From any checkout of a known Epic's repository, the user can see current Epic progress, load a child, plan it against
previously delivered code, save and resume it, then execute it without manual branch switching. Manual loading and
automatic child continuation use the same branch and document rules.

A child worktree exists before Planner's first turn, but planning does not mark the Plan `in_progress` or create an
active execution workflow. Approval promotes that retained worktree into execution without replacing its Plan from
another branch. Existing execution attempts retain their current authority and recovery behavior.

## Approach

### One branch source and one selected child document

Keep `loadPlan(cwd, name)` as a local-file reader. Extend shared workflow/catalog resolution rather than making every
file read fetch Git or silently change directories.

For a known Epic, resolve its recorded target, inspect its branch documents, then select child documents by stable Plan
identity. Read the target branch as a consistent Git revision for each catalog operation. Registered planning,
execution, or retained reopened documents override only the Plan they own; incidental sibling copies in those
directories do not become the whole Epic's catalog.

```text
/load-plan OR automatic child continuation
  -> resolve known Epic target and current branch documents
  -> overlay individually registered child documents
  -> select next child using current status, order and dependencies
  -> prepare/reuse that child's worktree
  -> reload child and rebuild Agent tools in that directory
  -> Planner, review, save/resume
  -> promote the same worktree at approved execution start
  -> existing validation and publication to the recorded target
```

The Epic branch owns its family definition and published documents. Registered child work owns the selected child's
current edits and lifecycle state. The controller still owns runtime and delivery evidence. A branch status is not proof
of publication: retain target-ancestry and delivery checks for actions that require delivered predecessors.

Use catalog metadata, registered document contexts and recorded delivery targets to locate known Epics from any
checkout. Keep enough of that branch location in the existing controller records to resolve them after execution
cleanup. Such a reference locates the authoritative Markdown; it is not a second copy of status or a second authority
for target policy. Reconcile existing known Epics from their recorded `targetBranch` and delivery facts without
requiring another checkout switch. Do not discover unrelated Epics by scanning every Git branch or by guessing from an
`epic/` name prefix.

At an explicit Epic/child load, refresh the recorded target once before selecting the child or deciding that a
dependency blocks it. Preparation must also ensure it uses the latest target before starting a new child; an earlier
catalog read must not pin the code base. Fetch through the existing target/publication Git policy, then create the child
branch from that exact target commit. Use the remote target when present and the local target when there is no remote.
Never silently create a missing target from hard-coded `main`. A failed fetch or missing target stops preparation before
Planner starts; do not substitute another branch. The selected child Plan must exist on the target or in its already
registered document context. A missing child is an actionable error, not permission to restore another branch's copy.

Uncommitted Plan edits in the user's checkout are not inputs to first preparation, even when that checkout happens to be
on the target branch. The target branch's committed content is the initial source. Do not change those uncommitted edits
or emit a notice about ignoring them.

Preserve existing explicit child target overrides; use the child's recorded effective execution target for its code
checkout and publication. Do not introduce new default branches or change target inheritance in this fix. When a child
has a different explicit target, its delivery must satisfy the existing dependency/assembly checks; do not silently
merge other targets into it. An Epic targeting `main` follows the same preparation path as one targeting any named
branch.

### Retained planning worktree, not early execution

Extend the existing worktree registry with a distinct `planning` status and use the controller's existing
`documentWorktreeId` reference. The registry owns worktree path, branch and Git base. Markdown retains its real Plan
status. This is a document context, not an active execution attempt.

Creation must register `planning` directly. Do not briefly register an active attempt and roll it back, populate an
active execution workflow, or emit `execution_started`. Fix controller lookups that currently treat every non-abandoned
registry entry as execution. Document discovery includes planning entries; execution lookup does not.

Use the current primary-project runtime layout for shared registration and selected-document roots for document locks.
Under the existing resource locks and transition journal, recheck Plan identity and prior registration before creation.
Concurrent loads of one child must converge on one retained directory; different children keep separate directories.
Record enough preparation effects for restart to finish registration or remove only a proven untouched preparation.
Never delete a directory with user or Planner work to recover a failed transition.

Before the first Planner turn, rebuild the Agent Session with the explicit worktree cwd. Reads, edits, searches,
commands, project instructions and any index must use that directory. A correct prompt with tools still on the primary
checkout is not a fix. Pass the directory explicitly through `runActiveAgentTurn` / `switchActiveAgent`: changing only
`hostedSession.cwd` with `rebindProjectRoot` leaves an existing Agent root's tools on its old path. Do not change the
process-global cwd to route operations. Review and Plan writes select that same document.

Save, feedback, cancellation, hold and Session restart retain the selected planning directory and its edits. Resuming
that same child is not starting a new child: reuse the saved directory rather than replacing it from the target. Each
new child fetches the current target before its own preparation. This preserves saved planning while ensuring ordered
continuation sees every previously delivered child. Do not add automatic rebasing of ongoing planning or execution.

### Promotion and publication

At normal approved execution start, resolve the registered planning document, lock it, check identity/target/review
preconditions, preserve its planning documents in the branch, capture the execution baseline, and promote the same
registry entry and directory to active execution. Only then record the normal execution-start event and dispatch the
chosen Engineer. Do not copy the selected child from primary, and do not use path-change heuristics to infer that
Planner already started execution.

Keep the original target base for publication evidence. Capture `executionBaselineTree` once at promotion for recovery
and execution review. Preserve authored planning documents in preparation commits so publication and branch-based
recovery retain them; exclude runtime files. Do not relax source-change safety checks or blanket-exclude arbitrary
production changes merely because they occurred before promotion. On execution resume, retain the established baseline
so Engineer changes remain visible to validation and review.

A failed promotion leaves the planning directory and document usable, with no phantom active execution. Existing
publication cleans up the promoted worktree only after delivery proof. Catalog and continuation then read delivered
Plans from the recorded target, not the now-deleted directory or an older primary copy. Recompute next-child eligibility
against the target after delivery instead of trusting a stale pre-cleanup selection.

Keep existing recovery rules for live executions and reopened Plans. Archive, restore, rename, close and Doctor must
recognize a planning document without treating it as failed execution or deleting its only saved copy. Missing
registered documents never fall back to another branch. Restore committed content only through proven branch/identity
recovery; report when uncommitted content cannot be recovered.

The alternative of a permanent Epic worktree adds a shared checkout and coordination between children. Per-child
retained worktrees fit existing isolation and let the primary checkout remain available for unrelated work.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store.js`, `src/shared/workflow/plan-location.ts`, `plan-family.ts` — shared branch-backed family discovery,
  selected-document lookup, progress and dependency reads. Preserve local-file readers for callers that need exact
  files.
- `src/shared/worktree-registry.js`, `worktree.js`, `workflow/controller-state.ts`, `controller-registry.ts` — retain
  planning directories separately from execution, remember known branch locations, and promote without losing identity.
- `src/shared/workflow/state-transition.ts` and recovery helpers — journal planning preparation and safe promotion using
  existing locks; protect source and destination documents during the authority transfer.
- `src/shared/workflow/planning-agent.ts`, `epic-continuation.ts`, `execution-start.ts`, `execution-plan-file.js`,
  `validation-publication.ts` — prepare before Planner, use the approved branch document, and continue after delivery.
- `src/cmd/load-plan/`, `src/shared/session/session-runtime.js`, agent-switching/session-context helpers — manual and
  automatic entry rebuild the actual Agent tools at the selected child path, including after restart.
- Existing Plan Board and Workspace server catalog/action consumers — use the same selected documents and progress; fix
  direct primary-only reads where needed. No browser redesign or new action workflow is intended.
- `src/cmd/plans/doctor.ts`, Plan archive/restore and recovery paths — retain planning work and avoid false
  failed-execution reports, missing-document fallback or stale primary resurrection.
- Workflow, registry, load-plan, catalog and Session integration tests — prove the complete journey with real Git
  branches.
- `docs/adr/004-concurrent-worktree-isolation.md`, `docs/domain-language.md`, `docs/usage.md` — document the new
  pre-execution document ownership and branch-independent loading. Do not change unrelated lifecycle meanings.

Plan Packages, integrated Epic validation, Epic-to-primary publication, Sequence-specific features, non-Git planning,
and generic isolation of every standalone planning Session remain out of scope. Existing standalone and non-Git behavior
must continue to work. Do not rewrite the user's example Plan as a substitute for fixing the runtime.

## Reuse Opportunities

- `resolveWorkflowPlanLocation`, `listPlans` and `listControllerDocumentWorktrees` already join selected documents.
- `documentWorktreeId` already separates retained documents from active execution; extend it rather than adding a store.
- `prepareTargetBranchRef`, `createWorktreeGitArtifacts`, registry locks and atomic writes provide Git preparation.
- `materializeEpicPlanFamily` already avoids overwriting target siblings from stale primary copies. Extend the same
  protection to selected branch-owned child preparation instead of restoring the primary-copy rule.
- `withOrderedTransitionResources`, existing transition journals and controller revision tracking protect multi-owner
  operations and interrupted preparation.
- Explicit-cwd Agent switching and publication handoff already rebuild Session tools without process-global chdir.
- `defineGitFixture` and the sandboxed test runner support real target movement, worktree deletion and restart
  scenarios.

## Implementation Steps

- [ ] Shared Epic catalog and action resolution read current target-branch family documents plus individually registered
      child documents from any checkout. Delivered state remains visible after worktree cleanup. Primary copies cannot
      overwrite, hide, reparent or resurrect those branch-owned Plans. Delivery-required actions still check real
      evidence.
- [ ] Registry/controller handling represents retained planning explicitly and exposes it as document ownership, never
      active execution. Preparation is locked, recoverable and duplicate-safe; existing entries remain compatible.
- [ ] Manual loading and automatic continuation prepare each new child's directory from the latest recorded target
      before Planner's first turn. Agent tools, review and Plan saves use that directory. Target `main` has no special
      branch path.
- [ ] Saved planning, feedback, hold and restart reuse the same document context without losing edits or manufacturing
      execution state. Missing/renamed/archived documents use existing identity and recovery rules rather than primary
      fallback.
- [ ] Execution promotes the planning directory only after approval, uses its Plan and execution policy, captures the
      proper baseline and retains planning documents for publication. Failed promotion preserves planning; execution
      resume preserves Engineer changes and the original baseline.
- [ ] Publication cleanup and continuation retain enough target location to rediscover delivered Plans, reload
      eligibility, and prepare the next draft child on the newly advanced target. No Session uses a removed directory.
- [ ] Existing Plan actions, Workspace/catalog consumers and Doctor use the new document selection without treating
      planning as an execution failure or deleting the sole saved Plan. No new browser layout is required.
- [ ] Real-Git regression tests prove the journeys below and retain existing authority, validation, recovery and
      publication protections. The new full-journey test fails on the current implementation before the runtime fix.
- [ ] ADR-004 and usage guidance explain retained child worktrees before execution and branch-owned Epic progress. The
      glossary's Epic, Child PLANNED_CHANGE Plan, In-Progress Plan and Plan Action Evidence Check definitions and
      relationships agree: a worktree can exist during planning without making the child In-Progress, and actions select
      its authoritative document. Avoid aliases that imply active execution or a permanent Epic worktree. Do not add
      Plan Package terminology.

## Approval Confirmation

No Work Records are proposed for supersession.

## Verification Plan

### Behavioral proof

Use real repositories through `defineGitFixture`, not injected Plan stores, registries, lifecycle transitions or locks.
External model turns may be test-controlled; the callback must exercise actual Agent tool cwd and document writes.

1. **Reported journey:** primary checkout stays on a different branch with staged and unstaged unrelated changes and a
   stale child Plan. Publish child 01 to the Epic target and remove its execution worktree. From primary, `/load-plan`
   and the catalog show child 01 delivered and child 02 eligible. Automatic continuation also reaches draft child 02.
   Its first Planner turn reads a source symbol added by child 01 and the target's child Plan through real bound tools.
   A marker present only in the stale primary Plan never reaches Planner or execution. Primary HEAD, index and working
   files are unchanged. This test fails if the implementation only changes prompts or status display.
2. **Target parity and latest code:** run preparation with target `main` and a differently named target. Advance the
   target after the prior catalog read, including through a bare remote fixture with a stale local tracking ref. Before
   the new child starts, assert its base includes the new commit. Confirm the sibling Plan from that commit is used, not
   the creation-time snapshot of an older child. Also make the old local ref show an unmet dependency which the remote
   target has delivered: explicit load must refresh before deciding to block, then select the next child correctly. A
   failed fetch stops before any Planner turn; a local-only target works.
3. **Other copies are irrelevant:** give primary a different Plan body, lifecycle status, parent relationship and
   uncommitted edits for the same identity; target documents still determine the Epic family. Repeat with primary
   checked out on the target itself but dirty. There is no merge, prompt or warning about ignored copies. A child
   missing on the target is not restored from primary. Known target-backed children absent from primary still appear in
   load/list.
4. **Save and resume:** Planner edits its Plan, receives feedback or saves for later, and the Session/process is
   recreated. Loading from another checkout finds the same directory and exact edits. No `execution_started` event,
   active execution context, `in_progress` status or validation run exists before execution approval. An ordinary
   read-only list creates no child worktree and performs no fetch per Plan. Catalogs read the latest locally resolved
   target snapshot and refresh after publication or explicit load, not a stale creation-time base; explicit
   load/preparation refresh remote targets before selecting or starting new work.
5. **Approval to delivery:** approve the saved Plan, execute with its selected policy, and assert the same path/branch
   and registry identity are promoted. Main's stale body never replaces it. Planning documents survive the preparation
   commit and delivery. Engineer code changes are included in validation/review against the correct baseline. After
   publication removes the directory, reload still shows delivered state and the next Planner sees the delivered code.
6. **Failure and concurrency:** two starts for one child produce one context and at most one Planner dispatch per
   accepted operation. A preparation/promotion failure or process restart cannot leave false execution state or delete
   saved edits. Independently prepared siblings get different directories. Use deterministic real filesystem/Git failure
   inputs or the existing transition-recovery harness, not a new RunWield-owned dependency seam.
7. **Document actions:** hold/resume, close, archive/restore, rename, missing-directory recovery and Doctor retain
   planning documents and never expose older primary copies. Registered execution and reopened document precedence still
   works. Same-name/different-ID documents cannot be mistaken for the registered Plan.

Extend `epic-continuation.test.js`, `authority-continuation.integration.test.ts`,
`plan-document-authority.integration.test.ts`, `plan-location.integration.test.ts`,
`validation-tool-continuation.integration.test.ts`, `workflow.test.js`, registry/controller tests and
`src/cmd/load-plan/plan-authority.integration.test.ts` as appropriate. Add a focused
`src/shared/workflow/epic-branch-planning.integration.test.ts` for the first five journeys. Keep assertions at
manual-load and post-publication Session boundaries, not just a new resolver helper.

Run focused checks, then the complete gates:

```sh
deno run -A scripts/run-tests.js src/shared/workflow/epic-branch-planning.integration.test.ts
deno run -A scripts/run-tests.js src/shared/workflow/epic-continuation.test.js src/shared/workflow/authority-continuation.integration.test.ts src/shared/workflow/plan-location.integration.test.ts src/shared/workflow/validation-tool-continuation.integration.test.ts src/cmd/load-plan/plan-authority.integration.test.ts
deno task seams:check
deno task test
deno task ci
```

Never run `deno test` directly. Use `getHomeDir()`/`getCwd()` and `withProcessGlobalTestLock` where tests change process
state. Follow the repository's named JSDoc/TypeScript type rules; do not add a test-only injection seam.

### Protected and retired behavior

Protect active execution and reopened document authority, real target ancestry and publication proof, execution policy,
strict child order and dependencies, hold/recovery stops, review before execution, independent concurrent worktrees,
standalone latest-primary-Plan preparation, and existing non-Git consent. Preserve the existing no-remote publication
policy; this fix does not authorize unsafe writes to a checked-out target.

Retire primary-copy precedence for targeted Epic families, primary-to-target reconciliation of the selected child,
planning a targeted child before its worktree exists, and treating target publication as invisible once execution
cleanup finishes. Rewrite tests that expect those behaviors; do not delete their unrelated safety assertions.

### Semantic and manual review

Review the call path from manual load and post-publication continuation through Agent creation, review, promotion and
cleanup. Confirm the selected Plan, tools cwd and Git base agree at every handoff. Confirm no renamed wrapper around
primary-only loading can pass the journey tests. Check all non-abandoned registry filters distinguish planning from
execution. Confirm docs describe implemented ownership, not the proposed Plan Package architecture.

In a disposable repository, keep a dirty primary checkout open, load an Epic on another target, deliver one child,
continue into draft planning, edit/save/restart, approve and execute. Inspect current progress through the terminal and
existing Workspace Plan Board; both must show the same child state. Confirm no manual branch switch is needed and no
warning about ignored primary edits appears. Record the target commit and Planner directory as evidence.

## Edge Cases & Considerations

- Known Epic discovery is bounded to recorded targets and identities. Arbitrary undiscovered branch-only projects do not
  become searchable through a scan of all Git history. After this fix first loads a known Epic, reload must not depend
  on its older primary copy remaining present.
- A parent/child definition that exists only as edits on another branch is intentionally not imported. It must reach the
  chosen target before first branch-based loading. This follows the owner's explicit instruction, not a merge heuristic.
- A saved child's branch can fall behind while planning is paused. Reuse preserves its work; every new child starts from
  the latest target. Normal publication still handles later target movement. Automatic refresh of ongoing planning is
  not part of this fix.
- Target changes after preparation must use normal review/recovery rather than silently switching a retained directory.
  Never reset an existing target or fetch into a checked-out local branch as a shortcut.
- Runtime bookkeeping may change under the shared ignored runtime root. “Primary unchanged” means its Git HEAD, index,
  tracked files and unrelated untracked user files; do not add an owned `.gitignore` block there merely to prepare
  planning.
- Existing live execution worktrees are not converted to planning. Existing reopened documents retain their distinct
  new-attempt-on-approval behavior; only a never-executed planning context is promoted in place.
- Concurrent source work was present during planning. Modify only this Plan now; the executing Engineer must inspect the
  current source and use the then-current runtime layout and shared Session handoff code.
