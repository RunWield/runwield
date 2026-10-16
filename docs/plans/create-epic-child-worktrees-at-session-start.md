---
planId: "4b5a0ce0-d604-4c4f-808a-f7c720e5410a"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/plan-location.ts"
    - "src/shared/workflow/planning-worktree.ts"
    - "src/shared/workflow/execution-start.ts"
    - "src/shared/workflow/epic-continuation.ts"
    - "src/cmd/load-plan/index.ts"
    - "src/cmd/load-plan/plan-epic-flow.ts"
    - "src/shared/session/runtime/workflows.ts"
    - "src/ui/workspace/routes/owner-session-api.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/005-concurrent-worktree-isolation.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-14"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "plan/create-epic-child-worktrees-at-session-start"
validatedCommit: "dd611d5924fc0ce01ab6cfb4e58755aa2e7d2b9c"
workRecord:
    status: "generated"
    recordId: "a91edc69-e3ee-4ef8-8bfb-84fdb182ad25"
    path: "docs/work-records/2026-10-16-create-plan-worktrees-only-at-session-start.md"
    lastAttemptAt: "2026-10-16T15:21:47.702Z"
status: "verified"
---

# Create Epic Child Worktrees Only When a Session Starts

## Context

RunWield creates planning worktrees for Epic children that nobody has started. On 2026-09-25, children 03 to 08 of
`remote-ssh-development` got worktrees about 10 seconds apart, from the same base commit, right after child 01 published
and before any agent ran. Those worktrees then sit on an old Epic commit.

The cause is a side effect in a lookup. `resolveWorkflowPlanLocation` (`src/shared/workflow/plan-location.ts`) answers
"where does this Plan's document live?". When the answer is an unfinished child on its target branch with no worktree, it
calls `preparePlanningWorktreeForPlan` and creates one (line 147). Only callers that pass `readOnly: true` skip this, and
most of the ~40 callers do not. So a lifecycle event, collaboration push or share, Workspace action, or Epic check that
touches a child creates that child's worktree.

Two load paths also create the worktree too early. They create it when the user **selects** a child, before the user
picks an action:

- `src/cmd/load-plan/index.ts:373-391` — `wld load-plan <child>` and every child load.
- `src/cmd/load-plan/plan-epic-flow.ts:417,440` — the Epic child picker.

### Decisions from planning

The user decided this rule:

```text
lookup (resolveWorkflowPlanLocation)          → never creates anything
a session is about to start in the Plan       → create the worktree from the latest Epic branch,
                                                or refresh the existing one
a write with no session on an unstarted child → refuse: "Start planning this child first." Nothing changes.
```

"A session is about to start" means exactly these actions:

| Action                                                       | Session                |
| ------------------------------------------------------------ | ---------------------- |
| Resume planning                                              | Planner                |
| Send back to Planner for re-review                           | Planner                |
| Review plan / Re-open for review                             | Planner review         |
| Proceed with execution                                       | Engineer               |
| Automatic Epic continuation (plan or execute the next child) | Planner, then Engineer |

For execution, review, and re-review, the worktree normally exists already because Planner worked on the child. These
actions still create it when it is missing. For example, approved Sequence children can reach execution without a
planning session.

Selecting, viewing, cancelling, holding, user-verifying, pushing, or sharing never creates a worktree.

The rule applies to **every Plan**, not only Epic children. The user decided that all Plans use one general way to
start a workflow and prepare its worktree. A standalone Plan with a recorded delivery branch follows the same rule.

Worktrees that were already created early stay as they are. The user decided that no cleanup is part of this change.

### Owning requirements

- [Core Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold):
    - **Each child starts with the preceding children's published code** — strengthened. New worktrees start from the
      newest Epic branch head because creation now happens at session start.
    - Add a named requirement: a child's worktree exists only after a session starts in it.
    - Preserve: fetch-before-prepare, refresh of existing unstarted worktrees, sibling scope synchronization,
      continuation behavior, and the primary checkout staying intact.
- [ADR-005 concurrent worktree isolation](../adr/005-concurrent-worktree-isolation.md), Lifecycle step 1 says "when a
  targeted Epic child is opened for planning". This change makes the trigger exact: a session start, not a lookup or a
  load.

The `ready_for_work` Plan [Side-Effect-Free Plan Reads](side-effect-free-plan-reads.md) has the same direction for
catalog reads. This Plan does not depend on it, and it does not conflict with it.

## Objective

`resolveWorkflowPlanLocation` is a pure lookup. A planning worktree is created only at the start of a session in that
Plan, from a fresh fetch of its target (Epic) branch. Any write to an unstarted child with no session stops with a clear
message and changes nothing.

## Approach

### 1. The lookup stops creating

Remove the `preparePlanningWorktreeForPlan` call from `resolveWorkflowPlanLocationInScope`. The branch that used to
create a worktree now does this:

```diff
 if targetPlan is unfinished and has no worktree
-  planning = preparePlanningWorktreeForPlan(...)
-  return { documentRoot: planning.entry.path, plan: planning.plan }
+  if options.readOnly
+    return { documentRoot: cwd, plan: plan || targetPlan, publishedSnapshot: !plan, planningNotStarted: true }
+  throw new PlanningNotStartedError(planName)
```

`PlanningNotStartedError` says: "Start planning <planName> first: load it and choose Resume planning. Nothing was
changed."

> [!TIP]
> **Refuse by default**
>
> Callers without `readOnly` expect a writable document root. If they got the primary copy instead, a write could land
> in a stale primary file. A clear error is safer than a silent write to the wrong copy.

The same branch also covers an unfinished standalone Plan that has a recorded `deliveryBranch` but no worktree. That
recovery also moves to session start, so the lookup is pure for every Plan and every Plan starts its workflow the same
way.

### 2. One function owns "a session is about to start"

A new module, `src/shared/workflow/session-planning-worktree.ts`, exports `prepareSessionPlanningWorktree(projectRoot,
planName)`. It:

1. Resolves the location with `readOnly: true`.
2. If the Plan needs a planning worktree (it is missing, or it exists for an unstarted child), runs `ensureEpicBranch` for
   the parent Epic. Then it runs `preparePlanningWorktreeForPlan`. That function already fetches the latest target and
   rebases a reused worktree.
3. Returns `{ documentRoot, plan }` for the session to use.

The test "does this Plan need a planning worktree" is one exported predicate in `plan-location.ts`. The lookup and this
function both use it. Today the same condition is copied in `index.ts:375-378` and `epic-continuation.ts:271-274`, and
those copies go away.

It is a new module and not part of `planning-worktree.ts` because `epic-branch.ts` imports `plan-location.ts`, which
imports `planning-worktree.ts`. Putting `ensureEpicBranch` there would create an import cycle.

### 3. The callers

```diff
 load-plan (index.ts)
-  on load: ensureEpicBranch + preparePlanningWorktreeForPlan + bind session cwd
   menu → Resume / Re-review / Review / Proceed / forced review
+    prepareSessionPlanningWorktree → bind session cwd → start session

 Epic child picker (plan-epic-flow.ts)
-  preparePlanningWorktreeForPlan before loadChildPlan
   loadChildPlan

 startActiveExecutionWorkflow (execution-start.ts)
+  prepareSessionPlanningWorktree when the Plan needs one
   resolveWorkflowPlanLocation → promote planning worktree

 runEpicChildContinuation (epic-continuation.ts)
-  inline condition + ensureEpicBranch + preparePlanningWorktreeForPlan
+  prepareSessionPlanningWorktree
   Planner / executePlan
```

Execution start owns creation for every execution surface: TUI Proceed, Workspace Run, and continuation. load-plan
still prepares before **Proceed** because `prepareApprovedPlanForWork` records `readiness_passed`, and that is a write.
Preparing twice is harmless: the second call reuses the worktree.

Workspace Run reads the Plan before execution starts in `owner-session-api.js:419` and `workflows.ts:456`. Those reads
pass `readOnly: true`, so execution start can create the worktree.

Set aside: **create on write** (writes still create, lookups do not). That keeps the bug for `wld plans push`/`share` and
Workspace events on every child, which the user rejected.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/plan-location.ts` — remove creation; add `planningNotStarted`, `PlanningNotStartedError`, and the
  shared "needs a planning worktree" predicate; update the `readOnly` doc comment.
- `src/shared/workflow/session-planning-worktree.ts` (new) — `prepareSessionPlanningWorktree`, the only path that
  creates a planning worktree for a session.
- `src/cmd/load-plan/index.ts` — move preparation from load time to each session-start action.
- `src/cmd/load-plan/plan-epic-flow.ts` — remove both eager `preparePlanningWorktreeForPlan` calls.
- `src/shared/workflow/execution-start.ts` — prepare before resolving the source location.
- `src/shared/workflow/epic-continuation.ts` — replace the inline preparation with the shared function.
- `src/shared/session/runtime/workflows.ts`, `src/ui/workspace/routes/owner-session-api.js` — pre-execution reads use
  `readOnly: true`.
- Other `resolveWorkflowPlanLocation` callers that only read a Plan that can be an unstarted child — switch to
  `readOnly: true`. Writers stay as they are and get the refusal.
- Tests in `src/shared/workflow/` and `src/cmd/load-plan/` — see the Verification Plan.
- `docs/prd/runwield-core-prd.md`, `docs/adr/005-concurrent-worktree-isolation.md` — record the session-start rule.

Not changed: `preparePlanningWorktreeForPlan` and `planning-worktree-refresh.ts`. Their fetch, rebase, and scope
preservation already do what the user asked. `ensureEpicBranch` and Epic branch seeding are also not changed. They write
through the Epic's own document root, not through the lookup. The domain language is not changed:
`docs/domain-language.md` already says Epic children _can_ have a planning worktree before execution.

## Reuse Opportunities

- `src/shared/workflow/planning-worktree.ts` `preparePlanningWorktreeForPlan` — creates or reuses the worktree, fetches
  the target, and rebases. Do not duplicate any of this.
- `src/shared/workflow/epic-branch.ts` `ensureEpicBranch` — creates the Epic branch and seeds child drafts when needed.
- `src/shared/workflow/planning-worktree.ts` `findTargetBranchPlan` / `findTargetBranchPlansByParent` — pure reads of
  branch copies.
- Existing fixtures: `journeyFixture` in `epic-branch-planning.integration.test.ts`, `fixture` and
  `remotePublication` in `planning-worktree.test.ts`, and `defineGitFixture`. Use these, not new seams.

## Implementation Steps

- `resolveWorkflowPlanLocation` never calls `preparePlanningWorktreeForPlan` or anything else that adds a registry entry,
  Git worktree, or branch. `plan-location.ts` no longer imports `preparePlanningWorktreeForPlan`.
- For an unfinished Plan whose authoritative copy is on its target or delivery branch and that has no registered
  worktree, the lookup with `readOnly: true` returns the existing snapshot result plus `planningNotStarted: true`.
  Without `readOnly`, it throws `PlanningNotStartedError`. The message names the Plan, says to load it and choose
  Resume planning, and says nothing was changed.
- `plan-location.ts` exports one predicate that decides whether a Plan needs a planning worktree. The lookup and
  `prepareSessionPlanningWorktree` both use it. No other module repeats the status, `targetBranch`, `parentPlan`, or
  `deliveryBranch` condition for this decision.
- `src/shared/workflow/session-planning-worktree.ts` exports `prepareSessionPlanningWorktree(projectRoot, planName)`. For
  a Plan that needs a planning worktree, it runs `ensureEpicBranch` for a child's parent. Then it calls
  `preparePlanningWorktreeForPlan` and returns that worktree's path and Plan. For any other Plan, it returns the existing
  location unchanged and creates nothing.
- In `src/cmd/load-plan/index.ts`, loading a Plan and choosing View, Cancel, Put on hold, or Mark as User Verified
  creates no registry entry or worktree. Resume planning, Send back to Planner for re-review, Review plan or Re-open for
  review (both menus), Proceed with execution, and the forced-review path each call `prepareSessionPlanningWorktree`
  before they start the session or record an event. Each then binds the session and `planDocumentRoot` to the returned
  root and refreshes `plan.path`, `attrs`, `markdown`, `body`, and `revision` from the returned Plan.
- `src/cmd/load-plan/plan-epic-flow.ts` has no `preparePlanningWorktreeForPlan` call. Selecting a child only calls
  `loadChildPlan`.
- `startActiveExecutionWorkflow` calls `prepareSessionPlanningWorktree` before it resolves the source location. An
  approved or ready child with no worktree, executed from any surface, is promoted from a worktree created from the
  newest Epic branch head.
- `runEpicChildContinuation` uses `prepareSessionPlanningWorktree` in place of its inline condition and preparation. It
  still creates or refreshes the worktree before it launches Planner or execution.
- Callers that only read and can see an unstarted child pass `readOnly: true`. This includes
  `owner-session-api.js:419` and the `prepareExecutePlan` lookup in `workflows.ts`. Writers without a session (hold,
  user verification, collaboration push/share/metadata, Workspace lifecycle events) refuse on an unstarted child with
  `PlanningNotStartedError` and leave the Plan, registry, and branches unchanged.
- Bulk collaboration commands that iterate over Plans report an unstarted child as not pushed or shared, with the
  refusal message. They continue with the other Plans, and they create no worktree.
- `docs/prd/runwield-core-prd.md#epic-decomposition-and-hold` has a named requirement that says a child's planning
  worktree is created only when a session starts in it (planning, review, re-review, execution, or continuation), from
  the latest fetched Epic branch. Lookups, loads, and session-less writes never create one. It adds the acceptance
  scenarios listed under PRD checks below.
- `docs/adr/005-concurrent-worktree-isolation.md` Lifecycle step 1 names a session start as the only trigger. It says
  that Plan location lookups are pure and that session-less writes to an unstarted child are refused.

## Verification Plan

- Automated, focused:
  `bun scripts/run-tests.js src/shared/workflow/plan-location.integration.test.ts src/shared/workflow/planning-worktree.test.ts src/shared/workflow/epic-branch-planning.integration.test.ts src/cmd/load-plan/index.integration.test.ts src/cmd/load-plan/reopen-plan-review-worktree.integration.test.ts src/shared/workflow/plan-document-authority.integration.test.ts src/plan-catalog-isolation.test.ts src/ui/workspace/plan-workflow-review.integration.test.js`
- Also run `bun run seams:check`. The new module must add no injection seam.

### New behavioral tests (real Git fixtures, real registry)

Each test fails if the lookup still creates a worktree, or if creation is replaced by a stub:

- **Pure lookup.** An Epic with three unstarted children on its branch. Call `resolveWorkflowPlanLocation` for each child
  with `readOnly: true`, and `recordPlanEvent` / `updatePlanCollaborationMetadata` for each child. Afterwards,
  `listEntries` is empty and `git worktree list` shows only the primary checkout. The writes reject with
  `PlanningNotStartedError`, and each child's bytes on the Epic branch are unchanged.
- **Load and cancel creates nothing.** `runLoadPlanCommand(["epic/02-next"])` with UI answers ending in `cancel`, `view`,
  or `hold` leaves the registry empty. Hold is refused with the "Start planning" message.
- **Resume creates from the newest Epic head.** Publish a commit to `origin/<epic branch>` after the Epic is seeded.
  Then load the child and choose Resume planning. The new worktree's `baseCommit` equals the new remote head, and the
  session cwd equals the worktree path. This replaces the old assertion in "Epic branch manual load command binds the
  Session to the target child document".
- **Execution creates when missing.** An approved Sequence child with no worktree. Call `startActiveExecutionWorkflow`
  with no prior `preparePlanningWorktreeForPlan` call. The execution worktree's base is the newest Epic head, and
  the Plan is promoted.
- **Re-review and Review create when missing.** The same assertion as Resume, for both menu actions.
- **Standalone with a recorded landing.** The lookup without `readOnly` refuses and creates nothing. Resume planning
  creates the worktree from `plan/standalone`. This rewrites "unfinished standalone without an attempt recovers
  planning from its recorded landing".

### Behavior that must still be protected

- All of `planning-worktree.test.ts` about `preparePlanningWorktreeForPlan`: fetch, reuse, preserved edits, fetch
  failure, scope conflicts, serialization, and live execution.
- Epic continuation still creates or refreshes the next child's worktree before it launches Planner or execution:
  "Epic continuation refreshes a preplanned child before execution promotion" and the continuation selection tests.
- A registered planning or execution worktree still wins over a stale primary copy ("planning document is selected by
  load and catalog"). The lookup still refuses a missing execution Plan ("loading the affected Plan still rejects the
  missing execution document").
- Published children still resolve to the local copy or published snapshot without creating anything ("Epic branch
  target child actions select a delivered document after cleanup").
- Sibling scope synchronization into an unstarted sibling still reaches the Epic branch when the child starts.

### Behavior that stops existing

- "target document is selected before stale primary copy" called the lookup without `readOnly` and got the branch copy
  through a created worktree. Rewrite it: without `readOnly`, the lookup refuses. After `prepareSessionPlanningWorktree`,
  the lookup returns the worktree copy with the target body.
- Any test that expects a lookup, load, or session-less write to create a planning worktree tests the removed side
  effect. Rewrite it to call the session-start path. Delete it only when it has no other assertion.

### Manual

On an Epic with several unstarted children, open the Epic, open the child picker, view a child, cancel, and run
`wld plans push`. `~/.wld/worktrees` and the registry gain nothing. Load the next child and choose Resume planning. One
worktree appears. Its `HEAD` is on the current `origin/epic/<name>`.

### PRD checks

These scenarios are added to the Core Epic capability, and the tests above cover them:

- Given an Epic with unstarted children, when the user opens the Epic, browses, views, or cancels, and when lookups or
  collaboration commands touch those children, no child worktree exists.
- Given a child with no worktree and an Epic branch that advanced after decomposition, when the user resumes planning,
  re-reviews, reviews, or executes it, its new worktree starts from the newest fetched Epic head.
- Given an unstarted child, when the user puts it on hold or pushes it without starting a session, RunWield says to
  start planning first and changes nothing.

Existing scenarios in that capability stay unchanged and still pass.

## Edge Cases & Considerations

- **Worktrees already created early** (for example `remote-ssh-development/05`, still in `planning`) are left alone.
  Session start reuses each one and rebases it onto the newest Epic head. The user decided this: no cleanup or
  migration is part of this change.
- **Refusal surfaces as an error in Workspace.** Hold or a lifecycle event on an unstarted child from Workspace shows
  the "Start planning" message. This is the agreed behavior, not a regression.
- **A reader that still lacks `readOnly`** now throws for an unstarted child instead of quietly creating a worktree. The
  error names the cause. Audit every caller listed by `grep resolveWorkflowPlanLocation` for this. A missed reader is
  visible, not destructive.
- **Fetch failure at session start** keeps today's behavior. `preparePlanningWorktreeForPlan` refuses, nothing starts,
  and saved work is unchanged.
- **Unstarted children without a `planId`** do not reach the load-time identity writes. `ensureEpicBranch` assigns IDs
  before it seeds children onto the branch. If one appears, it gets the same refusal.
