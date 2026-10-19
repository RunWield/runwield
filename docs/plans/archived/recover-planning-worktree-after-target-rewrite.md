---
planId: "f8e5ab69-b8ab-4879-8b44-bf8565a1593c"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/planning-worktree-refresh.ts"
    - "src/shared/workflow/planning-worktree.test.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-17"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "Plan Registry Recovery"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "362b246204fa39b37d3cc8b7508ed5ebe6aa926c"
workRecord:
    status: "generated"
    recordId: "62a4e02c-ea11-43ad-a637-110bb2470ef5"
    path: "docs/work-records/2026-10-17-recover-planning-worktrees-after-epic-history-rewrites.md"
    lastAttemptAt: "2026-10-17T17:51:39.009Z"
status: "verified"
archivedAt: "2026-10-19T02:52:33.109Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/recover-planning-worktree-after-target-rewrite.md"
---

# Recover a planning worktree after its Epic branch is rewritten

## Context

Continuing the Epic `reliable-usage-dashboard-and-langfuse-export` stops at child 09 with this error:

```text
Cannot refresh planning for reliable-usage-dashboard-and-langfuse-export/09-workspace-export-settings-and-delivery-status:
this worktree already contains implementation changes.
```

**The registry is not corrupt.** The child 09 registry entry is correct. The error is a false positive in the
target refresh. It occurs when the Epic branch history is rewritten after a child's planning worktree was created.

### Root cause, from the real repository state

1. On 2026-10-11 21:56, child 08 was published. RunWield created the child 09 planning worktree on the new Epic
   tip `6e65ffbd9` ("Record delivery for …/08"). The registry recorded `baseCommit: 6e65ffbd9`.
2. On 2026-10-13 and 2026-10-14, the Epic branch was rebased onto the Bun migration and force-pushed
   (`origin/epic/…` reflog shows `forced-update`). The child 08 delivery commits were rewritten with identical
   patches: `6e65ffbd9` became `7e0956229` (same `git patch-id`).
3. The Epic tip is now `057f5cb91`. It does not contain `6e65ffbd9`.
4. The child 09 worktree has **no commits of its own**. HEAD is still `6e65ffbd9`. Its only change is an uncommitted
   edit to its own Plan (336 insertions, 104 deletions). That edit is planning work that must survive.
5. `refreshPlanningWorktree` measures "implementation" from `git merge-base HEAD <target>`, not from the recorded
   base. After the rewrite, that merge base is the old commit `c65b1b7fe`. The diff from it to HEAD contains the
   pre-rewrite copy of `main` (1149 files). The check calls that published code "implementation changes" and refuses.

```text
           c65b1b7fe ── 8b29b926c ── 4c3ef3d79 ── 6e65ffbd9   ← old history, child 09 HEAD = registered base
               │          (old main merge, 1149 files)
               └── … 4242c8390 ── 7e0956229 ── … ── 057f5cb91 ← rewritten Epic branch (target)
```

**Fixing the check alone is not enough.** The next step merges the target into the planning branch. Merging a
rewritten history into its old copy produces conflicts in non-Plan files, so the refresh would still fail with a
different error.

### Scope of the pattern

A scan of all `planning` registry entries found two entries whose base is not in the local target branch:

| Entry                       | Cause                                                          | Affected?                                          |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `reliable-usage…/09`        | Epic branch rewritten after worktree creation                  | **Yes**, stuck                                     |
| `remote-ssh-development/07` | Local branch is behind `origin`; base is newer than the target | No. The existing "newer base" check returns early. |

### PRD capability

[Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold) owns this behavior:

- **Requirement: Each child starts with the preceding children's published code.** The planning worktree "starts
  from, or imports, that commit while keeping its saved scope and status." This Plan makes that true when the Epic
  branch was rewritten.
- Existing scenario that must survive: "Given the next child already has a planning worktree with saved edits,
  continuation imports the published code and keeps those edits."
- [Execution validation and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery): RunWield repairs
  its own metadata and synchronization without user operation. This is the reason recovery is automatic.

## Objective

When the Epic branch is rewritten after a child's planning worktree was created, continuation rebuilds the planning
branch on the new Epic tip, keeps every saved planning edit, and updates the registry base. The user does nothing.

Real implementation in a planning worktree is still never discarded. The refusal stays for that case, with a message
that names the real cause.

## Approach

Make `refreshPlanningWorktree` choose its path from how the recorded base relates to the target and to HEAD, and
measure child-owned changes from the right commit for each path.

```text
refresh(entry, target)
  if target is an ancestor of entry.baseCommit         → nothing to do            (unchanged)
  if entry.baseCommit is not an ancestor of HEAD       → refuse: planning branch history was rewritten
  if target is an ancestor of HEAD                     → retry settlement: changes measured from target,
                                                         no merge, update registry (unchanged behavior)
  measure child changes from entry.baseCommit (committed + working tree)
  if any change is not preparation                     → refuse (clearer message when target was rewritten)
  checkpoint saved planning edits                                                  (unchanged)
  if entry.baseCommit is an ancestor of target         → merge target, three-way Plan merge   (unchanged)
  else (target was rewritten)                          → replant on target          (NEW)
  update registry base, mark effect                                                (unchanged)
```

**Replant** builds one new commit on the target that carries only the child's planning changes:

```text
replant(entry, head, target)
  save head at refs/runwield/planning-replaced/<worktreeId>
  for each path changed between entry.baseCommit and head:
    original = file at entry.baseCommit, current = file at head, incoming = file at target
    incoming == original          → take current
    current == original           → take incoming (nothing to carry)
    all three exist and path is a Plan under docs/plans
                                  → mergePlanningDocument (same lifecycle-owner rule as today)
    otherwise                     → refuse; nothing is changed
  reset the planning branch to target (worktree is clean after the checkpoint)
  write the carried files, commit "Refresh <plan> onto rewritten <branch>"
```

All carried contents are computed before the branch moves. A conflict therefore refuses with the worktree untouched.

> [!TIP]
> **Why the retry path still works**
>
> If the process stops after the replant commit but before the registry update, HEAD now contains the target. The
> next run takes the existing "target is an ancestor of HEAD" path, finds only planning changes since the target, and
> settles the registry. No new retry machinery is needed.

**Option set aside:** merge the rewritten target into the old planning branch with a "theirs" strategy for
non-Plan files. It would keep duplicate pre-rewrite commits in the child's history, and that history then flows into
the child's delivery. Replanting gives the child the same history a fresh planning worktree would have.

> [!NOTE]
> **The safety ref is a planning-only record**
>
> `refs/runwield/planning-replaced/<worktreeId>` keeps the replaced planning head reachable, so a bad carry is
> recoverable from Git. It is overwritten by a later replant of the same worktree. Nothing reads it automatically.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/planning-worktree-refresh.ts` — path selection, change measurement from the recorded base, and
  the new replant path. This module already owns planning refresh inside `runExecutionPreparationTransition`.
- `src/shared/workflow/planning-worktree.test.ts` — rewritten-target scenarios using the existing real-Git
  `remotePublication` and `publishPreviousChild` fixtures.
- `docs/prd/runwield-core-prd.md` — one acceptance scenario under Epic decomposition and hold.

Deliberately unchanged: `src/shared/worktree-registry.js` (`refreshPlanningWorktreeBase` already accepts any new base
for a `planning` entry), `src/shared/workflow/planning-worktree.ts` (callers already route every refresh through
`refreshPlanningWorktree`), and execution worktrees (they never refresh their base).

## Reuse Opportunities

- `mergePlanningDocument` in `planning-worktree-refresh.ts` — three-way Plan merge with the lifecycle-owner rule.
- `hasExecutionChangesSince` and `isPreparationChange` in `src/shared/worktree.js` — the preparation-path boundary.
- `checkpointExecutionPreparation` with `PLANNING_CHECKPOINT_GIT_OPTIONS` — commits saved planning edits without hooks.
- `refreshPlanningWorktreeBase` in `src/shared/worktree-registry.js` — compare-and-set registry base update.
- Test fixtures `fixture`, `remotePublication`, `publishPreviousChild` in `planning-worktree.test.ts`.

## Implementation Steps

- In `refreshPlanningWorktree`, when the target is an ancestor of HEAD, child changes are measured from the target
  commit and no merge or replant runs; the registry base is updated to the target. This keeps the current retry
  behavior.
- In `refreshPlanningWorktree`, when HEAD does not contain the target, child changes are measured from
  `entry.baseCommit` (committed and working tree), not from `git merge-base HEAD <target>`.
- When `entry.baseCommit` is not an ancestor of HEAD, the refresh refuses with a message that says the planning branch
  history no longer contains its recorded base. No files, refs, or registry fields change.
- When `entry.baseCommit` is an ancestor of the target, the refresh uses the existing merge path. Its behavior and
  error messages are unchanged.
- When `entry.baseCommit` is not an ancestor of the target and the child has only preparation changes, the refresh
  replants: the replaced head is stored at `refs/runwield/planning-replaced/<worktreeId>`, the planning branch HEAD's
  first parent is the target commit, every planning change since `entry.baseCommit` is present in the new commit, and
  no other path differs from the target.
- Replant computes every carried file before it moves the branch. If a path cannot be carried by the rules in Approach,
  the refresh refuses with a message naming that path, and HEAD, the working tree, the safety ref, and the registry are
  unchanged.
- When `entry.baseCommit` is not an ancestor of the target and the child has non-preparation changes, the refusal
  message says the Epic branch was rewritten after planning started and that the files are preserved.
- After a successful replant, `refreshPlanningWorktreeBase` records the target as `baseRef`, `baseCommit`, and
  `baseTree`, and the transition marks `planning_target_refreshed`.
- `planning-worktree.test.ts` has a test "planning refresh replants saved edits after the target branch is rewritten":
  it prepares a child with a saved Plan edit, rewrites and force-pushes the published Epic history, prepares the child
  again, and asserts the Plan edit is kept, HEAD's first parent is the new target, `git diff <target> HEAD` lists only
  the child's Plan, the registry `baseCommit` is the new target, and the safety ref points to the old head.
- `planning-worktree.test.ts` has a test "rewritten target with a conflicting Plan edit refuses without changes": the
  rewrite also changes the same lines of the child's Plan, and preparation fails while HEAD, the saved file, and the
  registry `baseCommit` stay unchanged.
- `planning-worktree.test.ts` has a test "rewritten target keeps implementation and explains the rewrite": a
  non-Plan file is saved in the planning worktree before the rewrite, and preparation fails with a message naming the
  rewrite, while the file and the registry are unchanged.
- `planning-worktree.test.ts` has a test that calls preparation twice after a rewrite; the second call returns the
  same entry and makes no new commit.
- `docs/prd/runwield-core-prd.md`, Epic decomposition and hold, has the scenario: "Given the Epic branch was rewritten
  after the next child's planning worktree was created, continuation moves that worktree onto the new Epic branch and
  keeps its saved planning edits; saved implementation is kept and stops continuation with the reason."

## Verification Plan

- Automated: `bun scripts/run-tests.js src/shared/workflow/planning-worktree.test.ts src/shared/worktree-registry.test.js`
- The replant test fails against today's code (it throws "already contains implementation changes"). It also fails
  if the fix only changes the measurement and keeps the merge, because the merge of rewritten history conflicts in
  non-Plan files or adds old commits that `git diff <target> HEAD` would show.
- Behavior that must still be protected (existing tests stay and pass unchanged):
    - "planning refresh does not overwrite implementation already in the checkout" — untracked implementation still
      blocks a normal refresh.
    - The "planning scope conflicts" test — conflicting Plan edits on the normal merge path keep both versions.
    - "next child already has a planning worktree with saved edits" behavior — normal continuation still merges.
- No behavior is expected to stop existing.
- Manual: with the fix built, continue the Epic `reliable-usage-dashboard-and-langfuse-export` (`pick_child` →
  next child). Child 09 opens in Planner. In its worktree, `git log -1 --format=%P` names `057f5cb91` (or the
  current Epic tip), the child 09 Plan keeps the saved edits, and the registry entry `4309c5f0` has the new
  `baseCommit`.
- PRD: the new scenario sits under Epic decomposition and hold and describes only delivered behavior.

## Edge Cases & Considerations

- **Rewrite with real implementation in a planning worktree** — still refused. Planning worktrees do not normally
  hold implementation, and moving code across a rewritten history needs a user decision.
- **Rewrite that also changed the child's own Plan** — merged with the same three-way rule and lifecycle-owner
  rule as the normal path. A real conflict refuses and keeps the worktree as it was.
- **New draft Plans created during planning** — carried as new files (original and incoming are absent).
- **Local Epic branch behind `origin`** — `resolveExistingTargetSnapshot` already prefers `origin/<branch>`, and the
  existing "target is an ancestor of base" check returns early. Not changed.
- **Interrupted replant** — before the branch moves, nothing changed. After the commit, the next run settles the
  registry through the retry path.
- **Assumption:** one overwrite-on-repeat safety ref per worktree is enough. The branch reflog also keeps the old head.
- **Assumption:** no domain-language change. "Replant" is an internal implementation word, not a user-facing term.
