---
planId: "29d8ff70-d038-4925-9b46-7c6237ad071b"
classification: "PROJECT"
complexity: "HIGH"
summary: "Implement concurrent execution isolation using git worktrees, with explicit execution-root plumbing for agent sessions, validation, recovery, registry tracking, and merge-back."
affectedPaths:
    - "src/constants.js"
    - "src/shared/session/session.js"
    - "src/shared/session/session-state.js"
    - "src/shared/workflow/workflow.ts"
    - "src/shared/workflow/project-executor.js"
    - "src/shared/workflow/validation.js"
    - "src/shared/workflow/plan-lifecycle.js"
    - "src/shared/workflow/git-snapshot.js"
    - "src/plan-store.js"
    - "src/cmd/load-plan/index.js"
    - "src/cmd/plans/index.js"
    - "docs/plan-lifecycle.md"
    - "docs/adr/005-concurrent-worktree-isolation.md"
createdAt: "2026-06-15T13:30:00.000Z"
updatedAt: "2026-06-16T02:58:57.961Z"
archivedAt: "2026-07-01"
status: "implemented"
origin: "internal"
failureReason: "Semantic validation did not approve after 3 cycles."
executionBaselineTree: "0ed7bf56d4a9c1f31af2264b791959990d1767a9"
---

# Concurrent Worktrees & Execution Isolation

## Context

Harns currently executes all plan work in the primary working tree (`CWD = Deno.cwd()`). That single-tree constraint
means:

- Two Harns instances executing plans in the same repository can interfere with each other's file changes.
- Failed execution recovery uses `restoreWorktreeTree(CWD, ...)`, which can reset unrelated primary-checkout edits.
- PROJECT task conflict detection serializes overlapping write scopes, but every task still writes to the same checkout.
- Workflow Validation runs CI and computes semantic-review diffs in the primary checkout, so execution isolation must
  include validation, not just implementation.

The feature request asks for git-worktree-based isolation: each plan execution gets a linked working tree, Harns tracks
the worktree durably, and recovery can inspect, continue, merge, or discard that isolated checkout without touching the
primary one.

## Objective

1. **Execution-root isolation** - Each plan execution runs in its own explicit `executionCwd`, backed by a git worktree.
2. **Session CWD plumbing** - Agent sessions, built-in file tools, custom edit tools, local CI, git diffs, and
   validation repair agents operate against `executionCwd` instead of module-level `CWD`.
3. **Project-root metadata** - Durable Harns metadata remains anchored to the primary project root: plan front matter,
   `.hns/worktrees.json`, `.hns/worktrees.lock`, settings, and command state.
4. **Tracking** - A durable registry records worktree id, plan name, base branch/ref, base tree, branch, path, status,
   and timestamps.
5. **Recovery** - `load-plan` recovery for `in_progress`, `failed`, and `implemented` plans is worktree-aware: inspect,
   continue, reset/recreate, merge, abandon, or prune stale worktrees.
6. **Validation-before-merge** - Implementation and Workflow Validation run in the worktree. Merge back to the primary
   checkout only after validation passes.
7. **Safety** - Registry writes are locked and atomic. Merge-back refuses or clearly prompts on a dirty primary
   checkout. Stale worktrees can be detected and pruned.

See `docs/adr/005-concurrent-worktree-isolation.md` for the accepted architecture. This plan intentionally tightens a
few ADR details discovered during review.

## Review Findings To Incorporate

1. **The current plan under-scoped CWD plumbing.** `src/shared/session/session.js` builds all pi file tools,
   `edit_with_fallback`, `multi_replace_file_content`, `DefaultResourceLoader`, and `createAgentSession` with `CWD`.
   Passing `worktreePath` through workflow code is not enough.

2. **Validation must be isolated.** `src/shared/workflow/validation.js` runs local CI with `cwd: CWD`, computes diffs
   via `getWorkflowDiff(CWD, baselineTree)`, and launches repair/reviewer sessions without an execution cwd. If
   validation stays in the primary checkout, isolated execution validates the wrong tree.

3. **Merge should happen after validation, not after `implementation_finished`.** The existing lifecycle distinguishes
   `implemented` from `verified`. With worktrees, `implemented` should mean "worktree implementation finished";
   `verified` plus successful merge should be the primary-tree success path.

4. **Plan metadata should not depend on worktree plan-file writes.** The canonical plan front matter should be updated
   in the primary project root so `hns load-plan` and `hns plans` see current state even while execution is isolated.

5. **Dirty primary checkout is a merge-back risk, not necessarily a worktree-creation blocker.**
   `git worktree add <path> <ref>` can create a linked worktree from `HEAD` even when the primary checkout has
   uncommitted changes. The dangerous operation is merging an execution branch back into a dirty primary checkout.

6. **The ADR needs a small follow-up.** It currently says no task-executor changes are needed because tasks receive CWD
   implicitly. In the current code, CWD is captured by imports and tool construction, so this is false for
   implementation.

## Vertical Slice Findings

1. **`src/constants.js`** - `CWD` is a module-level constant. It should remain the primary project root, not be mutated
   or replaced globally. Add separate naming for worktree registry paths and branch/path conventions.

2. **`src/shared/session/session.js`** - `buildAgentSession()` and `runAgentSession()` need an optional `cwd` or
   `executionCwd` parameter. Tool construction and `createAgentSession({ cwd })` must use that value for execution.
   Project configuration lookup can still use the primary `CWD`.

3. **`src/shared/workflow/workflow.ts`** - `executePlan()` currently loads plans and records lifecycle events in `CWD`,
   then runs single-engineer or PROJECT execution in `CWD`. It should create/reuse a worktree, capture the baseline
   inside that worktree, store worktree context in session state, and pass `executionCwd` to all execution and
   validation calls.

4. **`src/shared/workflow/project-executor.js`** - `executeProjectTasks()` launches transient sub-sessions with no cwd
   override. Add an execution context/options parameter and pass `executionCwd` to each task agent.

5. **`src/shared/workflow/validation.js`** - Local CI, workflow diff, reviewer sessions, and repair sessions must run in
   the active workflow's `executionCwd`. `recordPlanEvent()` still writes to primary `CWD`.

6. **`src/shared/workflow/git-snapshot.js`** - Snapshot functions already accept explicit `cwd`; they can operate inside
   worktrees. Consider exporting or sharing `runGit()` instead of duplicating git command wrappers in new worktree
   modules.

7. **`src/plan-store.js`** - `PlanFrontMatter` has `executionBaselineTree` but no worktree fields. Add
   parsing/formatting for `worktreeId`, `worktreePath`, `worktreeBranch`, and `worktreeStatus`.

8. **`src/shared/workflow/plan-lifecycle.js`** - Existing events cover plan status, but not worktree status. Extend
   event details and updates so existing events can set/clear worktree fields, and add narrowly scoped worktree events
   only where needed.

9. **`src/cmd/load-plan/index.js`** - Recovery currently inspects and resets primary `CWD`. It needs to resolve the
   plan's current worktree from front matter or registry, run diffs/status there, and never baseline-reset the primary
   checkout for worktree-backed plans.

10. **`src/cmd/plans/index.js`** - Plan listing can show concise worktree state when `worktreeStatus` is active, failed,
    validation_failed, completed, or merge_conflict.

## Files To Modify / Create

### New Files

- **`src/shared/worktree.js`** - Git worktree operations:
  - `createExecutionWorktree({ projectRoot, planName, baseRef })`
  - `getWorktreeStatus({ projectRoot, path, branch, baseTree })`
  - `mergeExecutionWorktree({ projectRoot, branch })`
  - `removeExecutionWorktree({ projectRoot, path, branch, force })`
  - `pruneMissingWorktrees({ projectRoot })`

- **`src/shared/worktree-registry.js`** - Registry and lock management:
  - Registry path: `<projectRoot>/.hns/worktrees.json`
  - Lock path: `<projectRoot>/.hns/worktrees.lock`
  - `withWorktreeRegistryLock(projectRoot, fn)`
  - `addEntry`, `updateEntry`, `removeEntry`, `findByPlanName`, `findById`, `listEntries`, `pruneStaleEntries`
  - Atomic JSON writes using temp-file + rename.

### Modified Files

- **`src/constants.js`**
  - Add `.hns` registry filenames and worktree branch/path prefixes.
  - Keep `CWD` documented as the primary project root.

- **`src/shared/session/session.js`**
  - Add `cwd?: string` to `buildAgentSession()` and `runAgentSession()`.
  - Use `sessionCwd = opts.cwd || CWD` for pi built-in tools, edit-with-fallback, multi-replace,
    `DefaultResourceLoader`, and `createAgentSession`.
  - Keep prompt templates, local `.hns` overrides, settings, memory startup, and project guidance anchored to primary
    `CWD` unless a test proves they must follow the worktree.
  - Avoid `Deno.chdir()` because parallel PROJECT tasks would race process-wide cwd.

- **`src/shared/session/session-state.js`**
  - Extend `activeExecutionWorkflow`:
    - `planName`
    - `triageMeta`
    - `baselineTree`
    - `projectRoot`
    - `executionCwd`
    - `worktreeId`
    - `worktreeBranch`
  - Add a helper to read active workflow cwd with fallback to `CWD`.

- **`src/plan-store.js`**
  - Add front matter fields:
    - `worktreeId: string | null`
    - `worktreePath: string | null`
    - `worktreeBranch: string | null`
    - `worktreeStatus: "none" | "active" | "completed" | "execution_failed" | "validation_failed" | "merge_conflict" | "merged" | "abandoned" | null`
  - Preserve and clear those optional fields through `injectFrontMatter()`, `parsePlanFrontMatter()`, and
    `updatePlanFrontMatter()`.

- **`src/shared/workflow/plan-lifecycle.js`**
  - Extend `PlanEventDetails` with worktree fields.
  - On `execution_started`: set `executionBaselineTree`, `worktreeId`, `worktreePath`, `worktreeBranch`,
    `worktreeStatus: "active"`.
  - On `execution_failed`: set `worktreeStatus: "execution_failed"`.
  - On `implementation_finished`: set `worktreeStatus: "completed"` and keep plan status `implemented`.
  - On `validation_failed`: set `worktreeStatus: "validation_failed"` and keep plan status `implemented`.
  - Add `worktree_merge_failed` from `implemented` to `implemented` to set `worktreeStatus: "merge_conflict"` and
    `failureReason`.
  - On successful merge after validation: record `validation_passed` with `worktreeStatus: "merged"` and clear stale
    failure fields.
  - On abandon/review reset: set `worktreeStatus: "abandoned"` and optionally clear path/branch/id after removal.

- **`src/shared/workflow/workflow.ts`**
  - Create or resume a worktree before recording `execution_started`.
  - Load the plan from primary `CWD`; pass plan body to agents rather than relying on the worktree's plan copy.
  - Capture `executionBaselineTree` inside `executionCwd`.
  - Pass an execution context to `executeStructuredProjectPlan()`, `executeSingleEngineerPlan()`, and downstream
    validation.
  - Use primary `CWD` for all `recordPlanEvent()` calls.
  - Do not merge at `implementation_finished`; leave the worktree branch intact for validation and recovery.

- **`src/shared/workflow/project-executor.js`**
  - Add options object for `executionCwd`.
  - Pass `cwd: executionCwd` into every task `agentSessionRunner()` call.
  - Write debug logs to `executionCwd` when debugging a worktree execution.

- **`src/shared/workflow/validation.js`**
  - Resolve `executionCwd` from `activeExecutionWorkflow`.
  - Run local CI with `cwd: executionCwd`.
  - Compute workflow diff via `getWorkflowDiff(executionCwd, baselineTree)`.
  - Pass `cwd: executionCwd` to reviewer, operator repair, and engineer repair sessions.
  - If validation passes, attempt merge-back from primary `CWD`; only then record `validation_passed` with
    `worktreeStatus: "merged"`.
  - If merge conflicts, leave the worktree intact and record `worktree_merge_failed`.

- **`src/cmd/load-plan/index.js`**
  - Resolve worktree context from plan front matter first, then registry.
  - Recovery report shows plan status, worktree status, path, branch, base tree, git status, and diff from baseline in
    the worktree.
  - Continue execution by rehydrating `activeExecutionWorkflow` with `executionCwd` and registry data.
  - Reset means remove/recreate the worktree from the recorded base ref/tree; it must not call
    `restoreWorktreeTree(CWD, ...)` for worktree-backed plans.
  - Add recovery options for "Merge worktree changes" and "Delete/abandon worktree" where appropriate.
  - Keep legacy baseline reset only for older plans with no worktree fields.

- **`src/cmd/plans/index.js`**
  - Show `Worktree: <status> (<branch or path>)` for plans with non-empty worktree metadata.

- **`docs/plan-lifecycle.md`**
  - Document worktree front matter fields, status values, validation-before-merge behavior, and recovery semantics.

- **`docs/adr/005-concurrent-worktree-isolation.md`**
  - Follow-up edit: clarify that session/tool cwd plumbing is required, and correct the dirty-primary-tree note so it
    applies to merge-back rather than worktree creation.

## Implementation Sequence

1. **Add front matter and lifecycle support**
   - Add worktree fields to `PlanFrontMatter`.
   - Update plan lifecycle event handling and tests.
   - Update docs.

2. **Add worktree registry and git operations**
   - Implement registry locking/atomic writes.
   - Implement worktree create/status/remove/merge helpers.
   - Unit test with temporary git repositories.

3. **Make sessions cwd-aware**
   - Add `cwd` option to `buildAgentSession()` and `runAgentSession()`.
   - Ensure all file-writing tools bind to that cwd.
   - Add focused tests that inject a temp cwd and verify tool/resource construction receives it.

4. **Wire execution to worktrees**
   - Create/reuse worktree in `startActiveExecutionWorkflow()`.
   - Capture baseline in `executionCwd`.
   - Pass execution context through FEATURE and PROJECT execution.
   - Keep plan metadata updates in primary `CWD`.

5. **Wire validation to worktrees**
   - Run CI, diff, review, and repair in `executionCwd`.
   - Merge back only after validation passes.
   - Handle merge conflicts without deleting the worktree.

6. **Update recovery and plan listing**
   - Make inspect/continue/reset/merge/delete worktree-aware.
   - Keep legacy reset behavior for pre-worktree plans.
   - Add plan list display for worktree state.

## Verification Plan

**Automated tests:**

1. `src/plan-store.test.js`
   - Worktree front matter fields round-trip.
   - Optional worktree fields can be cleared.

2. `src/shared/workflow/plan-lifecycle.test.js`
   - `execution_started` records baseline and active worktree metadata.
   - `execution_failed`, `implementation_finished`, `validation_failed`, `worktree_merge_failed`, and
     `validation_passed` update `worktreeStatus` correctly.
   - Invalid transitions are rejected.

3. `src/shared/worktree.test.js`
   - Worktree creation uses unique branch/path names.
   - Status reports clean/dirty/missing worktrees.
   - Merge succeeds into a clean primary checkout.
   - Merge conflict leaves the worktree and branch intact.
   - Remove can preserve or delete branch as configured.

4. `src/shared/worktree-registry.test.ts`
   - Add/update/remove/list/find entries.
   - Atomic write preserves existing registry on failure.
   - Stale lock cleanup works.
   - Prune detects missing worktree paths.

5. `src/shared/session/session*.test.js`
   - `runAgentSession({ cwd })` constructs file tools and agent session with the provided cwd.
   - Default behavior still uses primary `CWD`.

6. `src/shared/workflow/project-executor.test.js`
   - Task sub-sessions receive `cwd: executionCwd`.
   - Debug logging uses execution cwd.

7. `src/shared/workflow/validation.test.js`
   - Local CI, diff, reviewer, and repair sessions use `executionCwd`.
   - Validation pass triggers merge-back and records `validation_passed`.
   - Merge conflict records `worktree_merge_failed` and keeps plan status `implemented`.

8. `src/cmd/load-plan/index.test.js`
   - Worktree-backed inspect reports worktree status/diff.
   - Continue rehydrates `activeExecutionWorkflow` with execution cwd.
   - Reset removes/recreates the worktree instead of restoring primary `CWD`.
   - Legacy no-worktree plans keep the old baseline reset path.

**Manual integration test:**

1. Start with a clean primary checkout and one uncommitted throwaway edit in an unrelated file. Verify worktree creation
   still succeeds from `HEAD`.
2. Execute a FEATURE plan. Verify implementation files change only in the worktree before validation/merge.
3. Verify local CI and semantic review run in the worktree.
4. After validation passes, verify merge-back updates the primary checkout and plan front matter records
   `worktreeStatus: "merged"`.
5. Force a merge conflict in the primary checkout. Verify Harns reports the conflict, leaves the worktree intact, and
   keeps the plan recoverable.
6. Start two plans concurrently. Verify each gets a unique branch/path and that registry locking prevents duplicate ids.

## Edge Cases & Considerations

- **Dirty primary checkout** - Worktree creation can start from `HEAD` even if the primary checkout is dirty, but
  merge-back should refuse or prompt when the primary checkout has uncommitted changes.

- **Untracked local config** - `.hns/` may not exist inside linked worktrees if it is ignored. Session configuration
  should use primary project root for Harns config and `executionCwd` for file tools.

- **Plan-file drift** - Plan front matter is canonical in the primary checkout. Execution agents receive the plan body
  directly, so they should not need to edit the worktree's copy of the plan. If a worktree changes `plans/<plan>.md`,
  merge may conflict with primary lifecycle metadata and recovery should surface that normally.

- **Merge conflict after validation** - Keep plan status `implemented`, set `worktreeStatus: "merge_conflict"`, preserve
  the worktree branch/path, and offer recovery actions.

- **Crash during creation or registry update** - Startup/prune should compare registry entries with
  `git worktree list --porcelain` and path existence.

- **Stale lockfile** - Lock contains PID, hostname if available, and timestamp. If the PID no longer exists and the lock
  is older than the timeout, it can be replaced.

- **Branch/path collisions** - Use a sanitized plan slug plus timestamp or short random id. Branch pattern:
  `harns/worktree/<slug>-<id>`. Path pattern: adjacent to primary repo, e.g. `../<repo>-harns-<slug>-<id>`.

- **Git base ref** - Record both `baseBranch` and exact `baseRef`/`baseCommit`. Merge should explain if the primary
  branch moved since creation; this is expected and may still merge cleanly.

- **Legacy recovery** - Existing plans with only `executionBaselineTree` and no worktree fields should continue to offer
  the current baseline-tree reset path, with the existing destructive warning.

## Tasks

| Task | Assignee   | Dependencies | Write Scope                                                                                                                                                                                                                       | Description                                                                                                                                          |
| ---- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | engineer   | none         | src/constants.js, src/plan-store.js, src/shared/session, src/shared/workflow/workflow.ts, src/shared/workflow/project-executor.js, src/shared/workflow/plan-lifecycle.js, src/shared/worktree.js, src/shared/worktree-registry.js | Establish isolated execution worktrees end-to-end so plan implementation agents run in an execution cwd and primary checkout files remain untouched. |
| 2    | engineer   | 1            | src/shared/workflow/validation.js, src/shared/workflow/workflow.ts, src/shared/workflow/plan-lifecycle.js, src/shared/worktree.js, src/shared/worktree-registry.js, src/plan-store.js                                             | Run Workflow Validation inside the execution worktree and merge the worktree branch back only after validation passes.                               |
| 3    | engineer   | 1, 2         | src/cmd/load-plan/index.js, src/cmd/plans/index.js, src/shared/session/session-state.js, src/shared/worktree.js, src/shared/worktree-registry.js                                                                                  | Add worktree-aware plan recovery and plan-list visibility for inspect, continue, reset, merge, abandon, and stale-state cases.                       |
| 4    | doc-writer | 1, 2, 3      | docs/plan-lifecycle.md, docs/adr/005-concurrent-worktree-isolation.md                                                                                                                                                             | Document the final worktree lifecycle, validation-before-merge behavior, and recovery semantics.                                                     |
| 5    | tester     | 1, 2, 3, 4   | none                                                                                                                                                                                                                              | Integration Point: run `deno run ci` and report any cross-slice failures explicitly.                                                                 |

### Slice Details

#### Task 1 — Isolated implementation execution

**What to build**

Create the first complete execution path where a plan starts in the primary project root, Harns creates or resumes an
execution worktree, records durable metadata, and all implementation agents operate against the worktree cwd. The demo
is an approved plan whose implementation changes appear in the linked worktree while the primary checkout remains
untouched.

**Acceptance criteria**

- [ ] Starting execution for a ready plan creates a unique worktree branch/path, records it in `.hns/worktrees.json`,
      and writes worktree metadata plus `executionBaselineTree` to the primary plan front matter.
- [ ] `runAgentSession({ cwd })` and PROJECT task sub-sessions bind file tools, resource loading, and agent cwd to the
      execution worktree without using `Deno.chdir()`.
- [ ] FEATURE and PROJECT implementation flows pass the execution cwd through to engineer/doc-writer/tester task agents,
      including retry paths.
- [ ] If implementation completes, plan status reaches `implemented` with `worktreeStatus: "completed"`; if
      implementation fails, the worktree remains for inspection with `worktreeStatus: "execution_failed"`.
- [ ] Unit tests cover front matter round-trip, lifecycle updates, registry locking/basic CRUD, worktree
      creation/status, session cwd plumbing, and PROJECT task cwd propagation.

#### Task 2 — Isolated validation and merge-back

**What to build**

Extend the isolated execution path through Workflow Validation and merge-back. Validation must run local CI, workflow
diffs, reviewer sessions, and repair sessions in the execution worktree. Only after validation passes should Harns merge
the execution branch back into the primary checkout and mark the plan verified/merged.

**Acceptance criteria**

- [ ] Workflow Validation resolves the active execution cwd and uses it for local CI, baseline diff computation,
      reviewer sessions, and repair sessions.
- [ ] Passing validation attempts a branch merge into the primary checkout, records `validation_passed`, and sets
      `worktreeStatus: "merged"` only after merge succeeds.
- [ ] Merge conflicts or dirty-primary merge refusal leave the worktree branch/path intact, keep plan status
      recoverable, and record a merge-conflict worktree status/failure reason.
- [ ] Validation failure keeps plan status `implemented`, records `worktreeStatus: "validation_failed"`, and leaves the
      worktree available for recovery.
- [ ] Tests cover validation cwd usage, successful merge-back, validation failure, and merge-conflict handling.

#### Task 3 — Worktree-aware recovery and visibility

**What to build**

Make the user-facing plan recovery and plan listing flows understand execution worktrees. Loading an `in_progress`,
`failed`, or `implemented` plan should show its worktree state and offer deliberate actions against the isolated
checkout instead of resetting the primary working tree.

**Acceptance criteria**

- [ ] `load-plan` resolves worktree context from primary plan front matter first and registry second, then reports path,
      branch, status, git status, and diff from baseline for inspect actions.
- [ ] Continue recovery rehydrates active execution state with project root, execution cwd, worktree id/branch, and
      baseline tree before rerunning execution or validation.
- [ ] Reset for worktree-backed plans removes/recreates the worktree from recorded base metadata and never calls
      primary-checkout baseline restore; legacy no-worktree plans keep the existing destructive reset warning/path.
- [ ] Recovery menus offer merge and abandon/delete actions when appropriate, update registry/front matter consistently,
      and detect stale or missing worktree paths.
- [ ] `hns plans` displays concise worktree status for plans with active or unresolved worktree metadata.

#### Task 4 — Worktree lifecycle documentation

**What to build**

Update project documentation so the implemented behavior is understandable and consistent with the accepted ADR. The
docs should describe the plan statuses, worktree statuses, validation-before-merge rule, and recovery options that
users/operators will see.

**Acceptance criteria**

- [ ] `docs/plan-lifecycle.md` documents the new worktree front matter fields, worktree status values,
      validation-before-merge flow, and worktree-backed recovery semantics.
- [ ] `docs/adr/005-concurrent-worktree-isolation.md` is corrected to reflect explicit session/tool cwd plumbing and to
      distinguish worktree creation safety from dirty-primary merge-back risk.
- [ ] Documentation matches the behavior implemented by Tasks 1–3 and does not describe unsupported commands or flags.
