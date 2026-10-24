---
planId: "e2a486a0-11a6-4284-adbe-b0272f860ce8"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/coordinator.ts"
    - "src/shared/attached/operations.ts"
    - "src/shared/attached/presentation.ts"
    - "src/shared/attached/record-store.ts"
    - "src/shared/attached/role-instructions.ts"
    - "src/shared/attached/review-host.ts"
    - "src/shared/workflow/plan-review-actions.ts"
    - "src/shared/workflow/validation-merge-repair.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/workflow/validation-host-state.ts"
    - "src/shared/workflow/validation-supervisor.ts"
    - "src/attached/claude/mcp.ts"
    - "src/attached/claude/plugin/commands/"
    - "src/cmd/attached/index.ts"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/adr/014-attached-workflow-coordination-boundary.md"
    - "docs/user-documentation/connect-claude-code.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-24T16:45:50.909Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 10
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
status: "implemented"
---

# Repair integration findings

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at
`9c743f7dda5017cdb9dfd407d92327113af8fd26` and reported 10 findings. The full report is
`docs/plans/attached-mode-claude-feature-preview/integration-report.md` in the primary checkout. After this child is
delivered, the integration gate runs again on the whole Epic.

Planning sorted the findings into three groups:

| Finding                                        | Decision              | Reason                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Project checks fail                         | **Dismissed here**    | Environmental. The gate's temporary checkout had no `node_modules` and no initialized `third_party/plannotator` submodule ("Cannot find package 'typescript'", "Submodule is not initialized"). With dependencies installed, `bun run ci` passes on this branch (1318 s). The user fixes the gate separately.                                                       |
| #2 No Planning Gate                            | **Dismissed**         | Owner decision: RunWield adds no hooks or tool restrictions in Connect, as in Core ([Connect: Compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability), ADR-014). The gate reviewed main's old copy of the Epic, which still has the removed Planning Gate text. The user fixes that gate defect separately. |
| #3 Unknown and untested host versions continue | **Dismissed**         | Intended behavior: "Newer or unreported host versions continue with a visible notice" ([Connect PRD](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability)). The user confirmed that no code change is needed.                                                                                                                                   |
| #4 Two workflows can implement the same Plan   | **Dismissed**         | Owner decision: an Attached Workflow Record references its Plan and does not own it. Nothing in Core stops one Plan from running in two places, and `execution-start.ts` reuses an active worktree in the same way. Leave it as is.                                                                                                                                 |
| #5–#10                                         | **Fix in this child** | Real defects in the Epic's Attached code, described below.                                                                                                                                                                                                                                                                                                          |

The fixes keep these PRD requirements:

- [Workspace PRD](../../prd/runwield-workspace-prd.md) and `docs/domain-language.md`: **Approve for Later** makes the
  Plan Ready For Work and starts no execution.
- [Connect: Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery):
  activation and Triage write nothing to the repository; recovery repairs internal state without user machinery.
- [Connect: Shared Plan and verification outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes):
  review decisions check the current Plan; Attached delivery uses shared publication recovery and Claude-owned repair.
- ADR-014: the CLI is the canonical boundary, and MCP is a thin adapter over the same operations.

## Objective

Fix findings #5–#10 on the Epic branch so that:

- Approve for Later stops at Ready For Work in an Attached Workflow.
- A crash between approval and readiness does not block execution.
- A stale Attached review decision cannot overwrite a newer Core review decision.
- A repairable publication merge conflict asks Claude for a repair worker.
- Every MCP read tool is also a `wld attached` CLI operation.
- Without `HOME`, Attached operations reject and write nothing to the repository.

## Approach

Each fix goes through the module that already owns the behavior. No new workflow state, ownership model, or seam.

### #5 Approve for Later

The coordinator already saves `review.outcome.approvalAction`. It records readiness for every approval, as Core does in
`src/tools/plan-written.ts`. Only the next action is wrong. `nextActionFor` gives start guidance only for an explicit
Approve & Run.

```diff
 if (record.state === "plan_ready" && record.plan)
-  return { kind: "plan_ready", guidance: "Call start_execution now" }
+  if (record.review?.outcome?.approvalAction === "run")
+    return { kind: "plan_ready", guidance: "Call start_execution now" }
+  return { kind: "plan_saved", guidance: "Ready For Work, saved for later. /runwield:implement starts it." }
```

The workflow state stays `plan_ready`, so `start_execution` stays legal. `/runwield:implement` starts the Plan from
either next-action kind. **Assumption (reviewable):** when the approval action is unknown, the coordinator treats the
Plan as saved and does not start execution. This covers a Core or Workspace approval found by reconciliation, and a
crash before the outcome was saved. RunWield never starts execution without evidence of Approve & Run.

### #6 Crash between approval and readiness

`startExecution` rejects canonical `approved` with "Execution requires ready_for_work approval/readiness."
`startActiveExecutionWorkflow` (`execution-start.ts:325-334`) already completes readiness from `approved`, and Core's
`plan-executor.ts` uses the same path. The coordinator accepts `approved` and lets the shared start complete readiness.
`reconcilePlanPosition` stays read-only.

### #7 Stale Attached review

The race: the coordinator checks `reconcilePlanPosition` under the Attached record lock, not under the Plan lock. A
Core decision that keeps the document status unchanged, for example a second `review_feedback` on a `feedback` Plan,
changes only stripped controller fields. The stale Attached decision then commits over it.

```diff
 SharedPlanReviewActionOptions {
   ...
+  expectedControllerRevision?: number
 }
 decide (under the Plan lock):
+  if expectedControllerRevision is set and differs from beforePlan.controllerRevision
+    reject as stale_plan_review
```

The coordinator passes `saved.controllerRevision`, which `openAttachedReviewRound` already pins.

### #8 Publication merge-conflict repair

Today a repairable conflict in Attached mode reaches a function that throws, ends as a "publication blocked" pause, and
retries into the same throw. The existing durable host `repair` request can carry it:

```text
attemptPublication -> content_conflict -> dispatchMergeRepair
  if hostTurn: requestHostRepair(kind "publication", cwd = repairCwd,
                                 nextPhase "delivery", expectedStatus = current status)
     -> ValidationHostWait (rethrown, not normalized into a failure)
host worker resolves and stages files in repairCwd -> task_completed
  recordValidationRepairCompletion keeps nextPhase "delivery" for publication repairs
  runLockedPublicationPhase finds failure.repairRoot -> finalizeMergeRepair -> retry publication
```

The coordinator, `task_completed` resume, presentation, and `reviewer-feedback-engineer` role are generic, so no new
action kind is needed. The merge-repair budget must survive process loss, because each host turn is a new process.

### #9 CLI parity

`get_instructions`, `get_artifact`, and `get_pending_chat` move from a side path in `mcp.ts` into `ATTACHED_OPERATIONS`
and are routed through `runAttachedOperation` to `readAttachedAction`. Like `status`, they need no host evidence. The
CLI dispatch then accepts them without other changes, and MCP loses its special branch.

### #10 No `HOME`

`locateAttachedWorkflows` no longer falls back to `<repo>/.wld/internal/attached`. Without a home directory, every
Attached operation returns a new rejection code, `home_unavailable`, with a message telling the user to set `HOME`.
Nothing is written. Set aside: a per-user temporary directory outside the repository. It keeps the workflow going, but
records can disappear on reboot, which conflicts with durable recovery.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/attached/coordinator.ts`: `nextActionFor` (#5); `startExecution` accepts `approved` (#6);
  `applyAttachedReviewDecision` passes the pinned controller revision (#7); `runAttachedOperation` /
  `runParsedOperation` route the read operations and map `home_unavailable` (#9, #10).
- `src/shared/attached/operations.ts`: the `plan_saved` next-action kind, the three read operations in
  `AttachedOperationName` and `ATTACHED_OPERATIONS` with their input parser, and the `home_unavailable` rejection code.
- `src/shared/attached/presentation.ts`: compact output for `plan_saved` and for read results.
- `src/shared/attached/record-store.ts`: no in-repository fallback; the module doc is updated.
- `src/shared/attached/role-instructions.ts`, `src/shared/attached/review-host.ts`: host guidance for `plan_saved`.
- `src/attached/claude/plugin/commands/request.md`, `plan-review.md`, `implement.md`: stop and report on `plan_saved`.
  `implement.md` starts execution from `plan_ready` or `plan_saved`.
- `src/attached/claude/mcp.ts`: the read-tool special branch is removed, and the read tools use the shared operation
  surface.
- `src/cmd/attached/index.ts`: `USAGE` and the module doc list every operation, including `review_reply` and
  `work_record_completed`.
- `src/shared/workflow/plan-review-actions.ts`: `expectedControllerRevision` precondition (#7).
- `src/shared/workflow/validation-merge-repair.ts`, `validation-publication.ts`, `validation-host-state.ts`,
  `validation-supervisor.ts`, `validation-types.ts` (or the checkpoint type owner): host-turn merge repair, rethrow
  of host waits, durable publication-repair budget (#8).
- `docs/prd/runwield-connect-prd.md`, `docs/user-documentation/connect-claude-code.md`,
  `docs/adr/014-attached-workflow-coordination-boundary.md`: delivered behavior for #5, #8, #9, and #10. The ADR loses its
  self-contradicting fallback sentence.
- Tests named in the Verification Plan.

The Core Session path and the Workspace review UI are out of scope. Core's Approve for Later and merge repair already
behave correctly.

## Reuse Opportunities

- `startActiveExecutionWorkflow` (`src/shared/workflow/execution-start.ts`): completes readiness from `approved` (#6).
- `requestHostRepair` (`src/shared/workflow/validation-host-state.ts`), `ValidationHostWait`, and
  `recordValidationRepairCompletion`: the durable host repair path that CI and semantic repair already use (#8).
- `failStoredPublication` / `runLockedPublicationPhase` `failure.repairRoot` handling and `finalizeMergeRepair`:
  already resume a saved merge repair in a fresh process (#8).
- `readAttachedAction` (`coordinator.ts`): the single read implementation for both carriers (#9).
- `src/shared/workflow/testing/validation-host-fixture.ts`, `attachedValidationFixture`
  (`src/shared/attached/validation-test-fixture.ts`), `toDelivery` (`src/shared/attached/delivery-test-fixture.ts`),
  `defineGitFixture`: real-Git fixtures for the conflict test.
- `withProcessGlobalTestLock` (`src/testing/process-global-lock.ts`): required for the no-`HOME` test.

## Implementation Steps

### Approve for Later (#5)

- `AttachedNextAction` in `src/shared/attached/operations.ts` includes `{ kind: "plan_saved"; planName; guidance }`.
- `nextActionFor` returns `plan_ready` with start guidance only when `record.review?.outcome?.approvalAction === "run"`.
  Every other `plan_ready` record, including one with no saved outcome, returns `plan_saved`. Its guidance says the
  Plan is Ready For Work, saved for later, and `/runwield:implement` starts it.
- `startExecution` accepts a workflow in state `plan_ready` whatever its next-action kind is. Execution starts only when
  the host calls it.
- `request.md` and `plan-review.md` tell the host to report `plan_saved` to the user and stop. `implement.md`,
  `role-instructions.ts`, and the `review-host.ts` guidance start execution for `plan_ready` and for `plan_saved` when
  the user runs `/runwield:implement`. The phrase "immediately call `start_execution`" stays for `plan_ready`, because
  `execution-plugin.test.ts` requires it.
- `presentation.ts` compact output keeps `plan_saved` with its guidance.

### Readiness recovery (#6)

- In `startExecution`, a Plan whose canonical status is `approved` passes the status guard and reaches
  `startActiveExecutionWorkflow`. That function records `readiness_passed` before preparation. Other statuses keep the
  current rejection. `reconcilePlanPosition` writes nothing.
- The coordinator source still contains `event: "readiness_passed"` (`execution-boundary.test.ts`).

### Stale review decision (#7)

- `SharedPlanReviewActionOptions` has `expectedControllerRevision?: number`. Inside the locked decision in
  `plan-review-actions.ts`, a defined value that differs from the current `controllerRevision` throws the same stale
  error as a changed document, and the result has `cancellationReason: "stale_plan_review"`. Callers that do not set
  the value keep their current behavior.
- `applyAttachedReviewDecision` passes `saved.controllerRevision`. A stale result throws, and the Attached record and
  the Plan are unchanged.

### Publication merge repair (#8)

- `requestHostRepair` accepts options `{ cwd, nextPhase, expectedStatus }`. Its defaults keep the current CI and
  semantic repair behavior.
- `dispatchMergeRepair` with `args.hostTurn` calls `requestHostRepair` with kind `"publication"`, `cwd` set to the
  repair cwd (the publication root, not `executionCwd`), `nextPhase: "delivery"`, and `expectedStatus` set to the
  current Plan status. It uses the same prompt that the Session path builds.
- In `validation-publication.ts`, the catch around `dispatchMergeRepair` rethrows `ValidationHostWait` and
  `ValidationHostRejected` unchanged.
- `recordValidationRepairCompletion` resumes a `"publication"` repair at the checkpoint's `nextPhase`, not
  `"mechanical"`. CI does not rerun, and the recorder and review state are kept.
- The number of publication repairs is stored on the validation checkpoint and counts toward
  `MAX_AGENT_MERGE_REPAIRS` across processes. When the budget is spent, publication follows the existing non-repair
  failure path and does not issue another repair request.

### CLI parity (#9)

- `AttachedOperationName` and `ATTACHED_OPERATIONS` include `get_instructions`, `get_artifact`, and
  `get_pending_chat`. They are added last so the MCP tool order stays stable. Their input schemas and strict field
  checks live in `operations.ts`.
- `runAttachedOperation` routes them to `readAttachedAction` without host evidence or compatibility checks, as it does
  for `status`. Each result carries `operation`.
- `src/attached/claude/mcp.ts` has no direct `readAttachedAction` call. The read tools go through the same operation
  entry point as the CLI. Invalid read arguments return `{ ok: false, rejection: { code: "invalid_input" } }`.
- `wld attached get_instructions|get_artifact|get_pending_chat` with a JSON envelope on stdin print the same content
  that MCP returns. `USAGE` lists every operation.

### No `HOME` (#10)

- `AttachedRejectionCode` includes `home_unavailable`.
- When `getHomeDir()` is empty, `locateAttachedWorkflows` does not return a path under the project root. Every Attached
  operation, including `status` and the read operations, returns a `home_unavailable` rejection that tells the user to
  set `HOME`, and creates no file or directory under the project root.
- The `record-store.ts` module doc and ADR-014 no longer describe an in-repository fallback.

### Documentation

- The [Connect PRD](../../prd/runwield-connect-prd.md) states, in the owning capabilities and acceptance scenarios:
    - Approve for Later leaves the Plan `ready_for_work` and starts nothing, and `/runwield:implement` starts it later
      (Shared Plan and verification outcomes).
    - A repairable publication conflict gets a fresh Claude repair worker in the publication root.
    - Every MCP operation is also a `wld attached` operation.
    - Attached activation needs a home directory and rejects without writing when none exists (Lazy project setup and
      recovery).
- `docs/user-documentation/connect-claude-code.md` describes Approve for Later and the `HOME` requirement.
- `docs/domain-language.md` needs no change. `plan_saved` is an operation value, not a domain term, and Approve for
  Later already has the correct definition.

## Verification Plan

Run the focused tests with `bun scripts/run-tests.js <paths>`. RunWield runs the full `bun run ci` after implementation.

Each new test fails on the current Epic branch:

- **#5:** in `src/shared/attached/review-decision.test.ts`, apply `{ approved: true, approvalAction: "later" }`.
    - Expect the Plan is `ready_for_work`, `status` reports `nextAction.kind === "plan_saved"`, and no worktree registry
      entry exists.
    - Then `start_execution` returns an `implementation` action.
    - A second case with `"run"` still reports `plan_ready`.
    - Fails today because the kind is `plan_ready`.
- **#5 recovery:** a workflow whose Plan Core approved outside the Attached review (no saved outcome) reports
  `plan_saved`.
- **#6:** in `src/shared/attached/execution-recovery.test.ts` (or `review-write-recovery.test.ts`):
    - Submit a review round, then record `review_approved` through `recordPlanEvent` without `readiness_passed`.
    - `status` reports a ready next action, and `start_execution` returns `implementation` with the Plan `in_progress`.
    - Fails today with `invalid_outcome` "Execution requires ready_for_work…".
- **#7:** in `src/shared/workflow/plan-review-actions.test.ts`:
    - Take a `feedback` Plan and save its `controllerRevision`.
    - Core records `review_feedback`.
    - `applySharedPlanReviewDecision` with the old `expectedControllerRevision` and an approval returns
      `cancellationReason: "stale_plan_review"`, and the status stays `feedback`.
    - Fails today because the approval commits.
- **#8:** in `src/shared/attached/delivery.test.ts`:
    - Bring a `humanReviewMode: "none"` fixture to the `recorder` action.
    - Commit a conflicting `implementation.ts` on the target branch, then call `work_record_completed`.
    - Expect `nextAction.kind === "validation"` with `request.kind === "repair"`, and a `request.cwd` that is not the
      execution cwd and contains conflict markers.
    - Resolve and stage the file there, then call `task_completed`. Expect `delivered`, the resolved content on the
      target branch, the published commit is an ancestor of the target, and the CI run count is unchanged.
    - A budget case: two completions without a resolution end in a non-repair recovery or decision, not a third repair
      request.
    - Fails today with `validation_recovery` "could not finish adding…".
- **#9:** in `src/attached/claude/mcp-validation.test.ts`, `spawnAttachedCli("get_instructions" | "get_artifact", …)`
  output equals the MCP `structuredContent` for the same action. In `src/cmd/attached/index.test.ts`,
  `get_pending_chat` returns the pending turn. Fails today because the CLI exits 1 with usage text.
- **#10:** in `src/shared/attached/coordinator.test.ts`, inside `withProcessGlobalTestLock`, unset both `HOME` and
  `WLD_TEST_SANDBOX_HOME`.
    - `activate` returns `home_unavailable`.
    - `<projectRoot>/.wld` does not exist, and `git status --porcelain --ignored` is empty.
    - Fails today because the record is written under `.wld/internal/attached`.

Existing coverage:

- **Must still pass unchanged:** `review-round.test.ts`, `review-host.test.ts`, `review-write-recovery.test.ts`,
  `execution-handoff.test.ts`, `execution-plugin.test.ts`, `delivery*.test.ts`, `validation-host-turn*.test.ts`,
  `validation-publication.test.ts`, `publication-machine.failure-matrix.test.ts`, `mcp.test.ts` (including tool
  order), `plan-written.test.ts`, and `src/cmd/attached/index.test.ts`. These protect the Approve & Run handoff, CI and
  semantic host repair, Session-path merge repair, and activation with a home directory that writes nothing to the
  repository.
- **Expected to stop existing:** the `coordinator.test.ts` case "without a home directory records fall back…" (about
  lines 306–322). Rewrite it as the #10 rejection test. Do not delete it.
- **Expected to change:** MCP read-tool argument errors become `invalid_input` rejections, not `McpError
InvalidParams`. Update any assertion of the old form.

Documentation check: the Connect PRD, Claude guide, ADR-014, and `record-store.ts` doc describe the delivered
behavior, and no document still describes the in-repository record fallback.

## Edge Cases & Considerations

- **Consent decline:** a declined non-Git consent returns `plan_ready` with the saved `"run"` outcome. The current
  instructions already say to stop after a decline. Keep that wording so the host does not restart execution.
- **Saved approval with no outcome:** treating it as saved needs one `/runwield:implement` from the user after a crash
  during an Approve & Run. RunWield cannot prove which action the user chose, so it does not start work.
- **Controller revision on drafts:** `reconcilePlanPosition` ignores `controllerRevision` for `draft`. If an ordinary
  operation changes a draft's controller revision between review open and decision, #7 rejects a legitimate decision.
  The existing approval tests in `review-decision.test.ts` must stay green to show this does not happen.
- **Local publication conflict:** the `local_publication_conflict` path clears `repairCwd`, so the repair runs in the
  execution cwd. This is current behavior and out of scope.
- **Re-raised findings:** the next gate run can raise #1–#4 again until the user's separate gate fixes land. Those
  findings are dismissed here on purpose.
