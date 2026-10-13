# Plan Lifecycle

Plan status is the durable state machine for saved Plans. Workflow code records facts as Plan Events, and the Plan
Lifecycle decides the next status and front matter updates.

The [Core completion requirement](prd/runwield-core-prd.md#execution-validation-and-recovery) distinguishes workflow
conclusions from implementation statuses: delivery ends only after confirmed publication or deliberate user abandonment.
Failed or blocked states and cancelled turns do not conclude an undelivered workflow. User acceptance is terminal but
does not claim automated validation or publication. RunWield must automatically reconcile its own state while preserving
the workflow. The statuses and mechanisms below describe implementation; their existence does not prove every recovery
path meets this requirement.

## Plan body ownership and external adoption

The owning product requirements are
[Plan authoring and external adoption](prd/runwield-core-prd.md#plan-authoring-and-external-adoption). RunWield owns
front matter; the user owns the body and can edit it at any time with any tool. The body does not need to parse as
RunWield data.

- Metadata lifecycle decisions compare `getPlanFrontMatterRevisionForText()` / the loaded `frontMatterRevision`, not
  whole-file Plan bytes. Changed product intent still requires the applicable review.
- Whole-file compare-and-set protects writers that would replace the body, including review Markdown apply, Workspace
  body saves, and Agent file edits.
- Failed metadata transitions restore only their owned front matter onto the latest body, never an older whole file.
- Malformed front matter diagnostics identify the leading block between `---` markers. User prose is not metadata and
  cannot be the reason that block is invalid.

A plain Markdown file in `docs/plans/` is a valid external Plan. Passive reads and listings use defaults without
modifying bytes, assigning identity, or reporting absent metadata as corruption or drift. Deliberate `/load-plan`
adoption calls `onboardExternalPlan()` in [plan-store.js](../src/plan-store.js), persists identity and defaults, and
preserves the body exactly.

Adoption defaults are a generated `planId`, `classification: PLANNED_CHANGE`, `complexity: MEDIUM`, `summary: ""`,
`affectedPaths: []`, `status: draft`, and `origin: external`. Record `updatedAt` as now in its owning state store.
Capture `createdAt` from the file's creation time before writing: atomic replacement changes birthtime. The current
implementation falls back to modification time, then the current time, when creation time is unavailable. Leave
`workKind`, `executionAgent`, and `collaborationRecommendation` unset so unknown intent stays unknown and policy
supplies applicable defaults.

Adoption is idempotent. Existing front matter is not reinitialized; identity can be ensured without resetting lifecycle
decisions or age. Recheck under the lock so concurrent adoption cannot replace an identity already established.

## State ownership

Before execution starts, Plan lifecycle metadata is canonical in the target project's Plan file. Once RunWield activates
an execution worktree, that worktree's Plan file is authoritative for the attempt through execution, recovery,
validation, and publication. The corresponding file in the user's checkout may remain behind and must never be used to
move the active attempt backward. Plan Markdown stores the definition, lifecycle status, and human-facing history. The
controller stores execution mode, validation checkpoints and counters, review decisions, and delivery proof in
`.wld/internal/controller/plans/<planId>.json`. The worktree registry owns attempt identity, path, branch, baseline, and
publication state. These facts are not copied into Plan Front Matter and are never compared against obsolete copies
there.

PROJECT Plans are non-executable containers. `type: epic` (or absent) uses Architect design and Slicer decomposition;
`type: sequence` uses a brief Planner-authored overview and complete child Plans reviewed together. Both store children
under `docs/plans/<container-name>/`, linked with `parentPlan`, ordered with `order`, and connected by sibling
`dependencies` (stable Plan IDs or legacy names).

Planner submits a Sequence through `plan_written({ planName, plans: [{ planName }, ...] })`. The optional `plans` list
must match the complete child set in order; omitting it reloads that set for a later review. One tab per document
retains its edits, annotations and child execution policy. Approve & Execute readies the complete group and starts its
first child; Approve for Later saves the same ready group. Epics retain Approve & Slice. Unsupported PROJECT types
require correction. Sequence children use ordinary validation and delivery targets; the container adds no aggregate gate
or publication step.

Grouped approval locks every member and journals all before/after documents before writing. A stale member invalidates
the decision. Failed writes restore only revisions owned by that decision; interrupted or conflicting writes remain
blocked with complete recovery evidence. Recovery can close a journal once every document matches its full before or
after set. The live first-child handoff is published only after the acceptance transition commits. If the process exits
before publication, or publication fails, the group stays saved and can be reopened for execution. Child continuation
follows the existing PROJECT order, dependency, hold and recovery rules.

## Statuses

`draft`: A Plan exists but has not completed a Review Loop.

`feedback`: The Review Loop returned user feedback, or the planning agent was interrupted while handling feedback.

`approved`: The Review Loop ended with user approval, but pre-execution preparation may still be unfinished.

`ready_for_decomposition`: An Epic PROJECT Plan has been approved and can be opened by the Slicer. This is not an
executable status.

`ready_for_work`: The executable status for PLANNED_CHANGE Plans (including legacy FEATURE). For a PROJECT Epic, it
means decomposition has been finalized and child Planned Changes can be selected; the Epic itself is still a container,
not executable implementation work.

`in_progress`: Execution has started. For executable plans, implementation work runs in the recorded execution worktree.

`failed`: Execution started from `ready_for_work` but implementation work did not finish. The worktree is left in place
when one is recorded.

`implemented`: Implementation work finished in the execution worktree and is ready for the next Mechanical Validation
phase. CI failure or Semantic Review or Code Review feedback returns here so the next validation call restarts at CI
with durable retry counters. For an Epic with its own branch, `implemented` means every included child is delivered to
the Epic branch and the integration gate has not passed on the current branch head.

Mechanical validation progress is controller state, not a new public Plan status. The Plan stays `implemented` when CI
passes; `validationPhase: semantic` ensures a fresh process resumes review without rerunning passed CI.

`reviewed`: Semantic Review passed for the current implementation. Human Code Review follows the configured policy. The
Plan remains reviewed while artifacts are prepared or publication is pending. The sealed execution candidate never
claims delivery.

`verified`: The reviewed work reached its recorded landing branch, including a default Plan branch, and publication
was confirmed. This does not prove an onward merge to the intended target. The delivery commit
contains the verified Plan and any successfully prepared Work Record in approved state; the checked candidate and
published commit remain separate identities. Non-Git projects reach verified after their in-place checks and review.
Runtime receipts preserve this outcome when a remote delivery leaves the primary checkout behind.

Legacy `validated_reviewer` reads as reviewed. Legacy `validated_ci` reads as implemented with the semantic phase ready.
Legacy `validated` and verified describe the same completed outcome only when delivery is proven; an unfinished attempt
or Epic integration pass reads as reviewed. A missing attempt alone is not publication proof.

An Epic integration pass is reviewed until its checked work reaches its recorded final target. A code change on the Epic
branch invalidates the pass. Deliberate “done enough” is closed without verification with
`epicCompletionMode: done_enough`; it does not fabricate a merge or automated verification. A branchless parent can
complete after every included child's delivery is proven.

`closed_without_verification`: A terminal manual closure outcome. The user intentionally ended the Plan without Workflow
Validation passing. It is distinct from `verified` and does not create `verifiedAt` or code review proof. Explicit Epic
done-enough closure also uses this status and retains its separate completion-mode metadata.

`on_hold`: A paused-but-resumable Plan. Holding preserves the previous status in `heldFromStatus` plus hold metadata so
callers can run a Resume Check before restoring the Plan. Holding a Plan mutates only that Plan file; Epic/child
visibility and blocking are listing/UI behavior.

## Physical Archival

Archival is not a Plan Status. Archived Plans keep their last durable lifecycle status and move on disk from
`docs/plans/` to `docs/plans/archived/`, preserving nested relative paths. Normal active listings hide
`docs/plans/archived/`, while explicit archive commands can list, read, and restore those plaintext markdown files.

`verified`, `user_verified`, and `closed_without_verification` are terminal outcomes that can be archived without
`--force`. Other statuses, including `on_hold`, require `--force` because they may represent unfinished or resumable
work. Even with `--force`, Plans with recoverable worktree states (`active`, `completed`, `execution_failed`,
`validation_failed`, or `validated`) remain blocked until the user resolves or abandons that worktree state through a
dedicated flow.

Archive metadata (`archivedAt`, `archiveReason`, `archivedFromStatus`, `archivedFromPath`) and restore metadata
(`restoredAt`, `restoredFromPath`) explain the physical move without changing the status state machine.

## Worktree Statuses

Worktree status is stored separately from Plan Status so RunWield can describe recoverable execution state without
changing the Plan state machine.

| Worktree status     | Meaning                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `none`              | No execution worktree is associated with the plan.                                                  |
| `active`            | The execution worktree exists and implementation is in progress or ready to resume.                 |
| `completed`         | Implementation finished in the worktree; validation and merge-back have not completed.              |
| `execution_failed`  | Implementation halted before completion; the worktree remains available for inspection/retry.       |
| `validation_failed` | Implementation finished, but Workflow Validation failed; the worktree remains available.            |
| `validated`         | Legacy registry value read as completed; the publication attempt separately owns delivery progress. |
| `abandoned`         | The user chose to abandon/delete the execution worktree instead of continuing or merging it.        |

## Events

| Event                                | From                                                                                                        | To                                                       | Notes                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review_feedback`                    | `draft`, `feedback`, `approved`                                                                             | `feedback`                                               | The user returned Feedback from Plannotator.                                                                                                                                                                                   |
| `review_approved`                    | `draft`, `feedback`, `approved`                                                                             | `approved`                                               | User approval is durable before the Readiness Gate runs.                                                                                                                                                                       |
| `epic_readiness_passed`              | `approved`                                                                                                  | `ready_for_decomposition`                                | PROJECT Epics pass approval into decomposition; they are not executable yet.                                                                                                                                                   |
| `decomposition_finalized`            | `approved`, `ready_for_decomposition`                                                                       | `ready_for_work`                                         | Slicer finalized at least one child FEATURE Plan, so the Epic can offer child selection.                                                                                                                                       |
| `readiness_passed`                   | `approved`                                                                                                  | `ready_for_work`                                         | FEATURE Plans pass without an LLM call.                                                                                                                                                                                        |
| `execution_started`                  | `ready_for_work`                                                                                            | `in_progress`                                            | Captures `executionBaselineTree` and records active worktree metadata before executable Plan work begins.                                                                                                                      |
| `execution_failed`                   | `in_progress`                                                                                               | `failed`                                                 | Sets `failureReason`, `failedAt`, and `worktreeStatus: "execution_failed"` when a reason is available.                                                                                                                         |
| `implementation_finished`            | `in_progress`                                                                                               | `implemented`                                            | Sets `implementedAt` and `worktreeStatus: "completed"`; Workflow Validation still needs to run.                                                                                                                                |
| `mechanical_validation_failed`       | `implemented`                                                                                               | `implemented`                                            | Increments `validationCiAttempts`, resets semantic rounds, records CI failure context, and returns for a later validation call.                                                                                                |
| `mechanical_validation_passed`       | `implemented`                                                                                               | `implemented`                                            | Saves `validationPhase: semantic`; a restart continues at review.                                                                                                                                                              |
| `semantic_review_feedback`           | `implemented` with passed CI (legacy `validated_ci`)                                                        | `implemented`                                            | Records feedback and resets the phase to mechanical for the repaired implementation.                                                                                                                                           |
| `semantic_review_passed`             | `implemented` with passed CI (legacy `validated_ci`)                                                        | `reviewed`                                               | Review passed; human review and delivery remain.                                                                                                                                                                               |
| `validation_failed`                  | `implemented`, `validated_ci`, `reviewed`                                                                   | `implemented`                                            | Records a failed validation attempt while preserving recoverable execution ownership; resets phase counters on implemented re-entry.                                                                                           |
| `validation_passed`                  | `reviewed`                                                                                                  | `reviewed` during preparation; `verified` after delivery | Git publication finalizes the committed target metadata only after merge. Non-Git verification completes in place.                                                                                                             |
| `recovery_continue`                  | `in_progress`, `failed`                                                                                     | `ready_for_work`                                         | Records the retry in the authoritative execution Plan before the normal execution-start transition returns it to `in_progress`; the primary-checkout copy is not read or rewritten.                                            |
| `recovery_reset`                     | `in_progress`, `failed`, `implemented`                                                                      | `ready_for_work`                                         | Records that recovery abandoned the current attempt before retrying.                                                                                                                                                           |
| `review_reopened`                    | `ready_for_decomposition`, `ready_for_work`, `in_progress`, `failed`, `implemented`, `reviewed`, `verified` | `feedback`                                               | The user chose to revise the Plan instead of continuing execution.                                                                                                                                                             |
| `epic_done_enough`                   | `ready_for_work`, `implemented`, `reviewed`, `verified`                                                     | `closed_without_verification`                            | Deliberate closure retains the explicit done-enough completion mode and child visibility.                                                                                                                                      |
| `epic_children_delivered`            | `ready_for_work`                                                                                            | `implemented`                                            | Every included child of an Epic with its own branch is delivered: its delivered commit is contained in the Epic branch, or the user closed or accepted it. Sets `implementedAt`.                                               |
| `epic_integration_passed`            | `implemented`                                                                                               | `reviewed`                                               | Records the checked Epic commit and final target; does not merge.                                                                                                                                                              |
| `epic_integration_failed`            | `implemented`                                                                                               | `implemented`                                            | The integration gate found problems. Records `failureReason` and the report path in `epicIntegrationReport`; RunWield adds a draft repair child for Planner.                                                                   |
| `epic_integration_stale`             | `reviewed`                                                                                                  | `implemented`                                            | Implementation changes invalidate the checked Epic commit.                                                                                                                                                                     |
| `epic_publication_confirmed`         | `reviewed`                                                                                                  | `verified`                                               | Git proves the checked Epic commit is on its final target.                                                                                                                                                                     |
| `manual_status_change`               | Board-safe non-terminal statuses                                                                            | Dynamic target                                           | User-driven board movement among `draft`, `feedback`, `approved`, `ready_for_work`, `in_progress`, `implemented`; `ready_for_decomposition` is included only for Epics. Records an event instead of editing `status` directly. |
| `manual_closed_without_verification` | Board-safe non-terminal statuses                                                                            | `closed_without_verification`                            | Terminal manual closure without Workflow Validation; does not set `verifiedAt` or review metadata.                                                                                                                             |
| `manual_user_verified`               | Board-safe non-terminal statuses                                                                            | `user_verified`                                          | Terminal user attestation with required `userVerificationNote`; sets `userVerifiedAt`, never sets `verifiedAt`, and preserves failure, execution, review, Delivery Evidence, and worktree facts as history.                    |
| `plan_held`                          | Any non-terminal, non-closed status                                                                         | `on_hold`                                                | Records `heldFromStatus`, `heldAt`, optional `holdReason`, and optional `holdStalenessBaseline`; preserves recovery/worktree metadata.                                                                                         |
| `hold_resumed`                       | `on_hold`                                                                                                   | `heldFromStatus`                                         | Caller must run the Resume Check first and provide/read the held-from status; clears hold metadata.                                                                                                                            |
| `hold_reset_to_draft`                | `on_hold`                                                                                                   | `draft`                                                  | Clears hold and execution/recovery/validation fields while preserving identity/context fields and Plan body.                                                                                                                   |

## Transaction Inventory

Every lifecycle writer must fit one of these transition inventory rows. The table is intentionally operational: it names
caller inputs, locked resources, owned effects, success proof, rollback limit, and recovery action.

| Event/writer                                                | Required inputs                                                 | Locked resources                                                     | Owned effects                                                                      | Success proof                                                              | Rollback limit                                                            | Recovery action                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `review_feedback`                                           | Review feedback payload                                         | Plan                                                                 | Feedback metadata                                                                  | Status `feedback`                                                          | None                                                                      | Review retry                                           |
| `review_approved`                                           | Approved Plan markdown                                          | Plan                                                                 | Approval metadata                                                                  | Status `approved`                                                          | None                                                                      | Review retry                                           |
| `readiness_passed`                                          | FEATURE approved Plan                                           | Plan                                                                 | Ready-for-work metadata                                                            | Status `ready_for_work`                                                    | None                                                                      | Review reopen                                          |
| `epic_readiness_passed`                                     | PROJECT approved Plan                                           | Plan                                                                 | Ready-for-decomposition metadata                                                   | Status `ready_for_decomposition`                                           | None                                                                      | Review reopen                                          |
| `decomposition_finalized`                                   | Slicer child Plan set                                           | Catalog, Epic, child Plans                                           | Child drafts and Epic ready state                                                  | Children persisted                                                         | CAS-written child drafts only                                             | Slicer retry                                           |
| `execution_started` / `execution_preparation`               | Worktree creation facts                                         | Catalog, Plan, worktree registry, target ref                         | Plan `in_progress`, registry attempt, optional worktree                            | Baseline/worktree facts                                                    | Owned new worktree and registry entry only                                | Load-plan recovery                                     |
| `execution_failed`                                          | Engineer failure report                                         | Plan, attempt                                                        | Failed status and reason                                                           | Failure reason/timestamp                                                   | None                                                                      | Recovery reset/continue                                |
| `implementation_finished` / `implementation_checkpoint`     | Checkpoint commit                                               | Plan, attempt                                                        | Implemented status and completed attempt                                           | Implementation commit                                                      | None                                                                      | Validation retry                                       |
| `validation_failed`                                         | CI/review failure proof                                         | Catalog, Plan, attempt, target ref                                   | Validation failure metadata                                                        | Failure reason                                                             | None                                                                      | Validation retry                                       |
| `validation_passed` / publication preparation               | Reviewed Plan, candidate evidence, human review decision        | Catalog, Plan, parent/siblings when applicable, exact attempt        | Reviewed candidate metadata and pending delivery artifacts; non-Git verified state | Recorded review/evidence and sealed artifact commit, or non-Git completion | Preserve sealed implementation; restore only proven owned metadata writes | Resume preparation or publication from durable attempt |
| Publication failure annotation                              | Typed Git or bookkeeping failure and exact attempt              | Publication owner and registry revision                              | Failure attached to current publication phase; candidate retained                  | Saved phase and failure evidence                                           | Never reset published target or discard unmerged source                   | Reconcile phase, repair merge, retry publication       |
| Mechanical and semantic validation events                   | Check result, review decision, current phase and attempt        | Plan and controller revision                                         | Implemented phase progress, reviewed status, or repair metadata                    | Saved CI phase or review decision                                          | Preserve implementation and accepted repair receipts                      | Resume saved validation phase                          |
| `direct_delivery_publication`                               | Sealed artifact identities, target and attempt                  | Publication owner, exact attempt registry revision, target CAS/lease | Verified target metadata, approved prepared records, publication receipt           | Final artifact state plus target ancestry                                  | Never rewind published target; preserve recoverable candidate             | Reconcile Git and retry publication/cleanup            |
| `recovery_continue`                                         | Resume decision                                                 | Plan, attempt                                                        | Ready-for-work retry metadata                                                      | Current attempt retained                                                   | None                                                                      | Recovery retry                                         |
| `recovery_reset` / `recovery_recreate` / `recovery_abandon` | Recovery action                                                 | Plan, attempt                                                        | Attempt reset/recreate/abandon metadata                                            | Exact attempt identity                                                     | Owned registry/worktree cleanup only                                      | Recovery retry/manual recovery                         |
| `review_reopened`                                           | Reopen decision                                                 | Plan                                                                 | Feedback metadata                                                                  | Status `feedback`                                                          | None                                                                      | Review loop                                            |
| `epic_done_enough`                                          | Explicit user closure decision and summary                      | Epic Plan                                                            | Closed-without-verification state and done-enough completion mode                  | Saved closure decision and metadata                                        | No rollback of child implementation or delivery                           | Reopen Epic or load remaining children                 |
| Epic integration and publication events                     | Settled child evidence, checked Epic commit, final target proof | Epic Plan and controller revision; Git target read                   | Implemented/reviewed state, stale-pass reset, or verified completion               | Exact reviewed implementation and final-target ancestry                    | Do not merge or rewind Epic/target on a status update                     | Rerun stale gate or reconcile external delivery        |
| `manual_status_change`                                      | Workspace lifecycle action                                      | Plan                                                                 | Board-safe status metadata                                                         | Requested status/timestamp                                                 | None                                                                      | Workspace retry                                        |
| `manual_closed_without_verification`                        | Closure reason                                                  | Plan                                                                 | Terminal closure metadata                                                          | Closure reason/timestamp                                                   | None                                                                      | Manual reopen                                          |
| `manual_user_verified`                                      | User attestation                                                | Plan and parent/siblings when child                                  | User-verified metadata                                                             | Attestation note/timestamp                                                 | None                                                                      | Manual reopen                                          |
| `plan_held`                                                 | Hold reason/baseline                                            | Plan                                                                 | Hold metadata                                                                      | `heldFromStatus` and `heldAt`                                              | None                                                                      | Resume/reset hold                                      |
| `hold_resumed`                                              | Resume Check result                                             | Plan                                                                 | Held status restored                                                               | Hold fields cleared                                                        | None                                                                      | Hold reset                                             |
| `hold_reset_to_draft`                                       | Reset hold decision                                             | Plan                                                                 | Draft reset metadata                                                               | Hold/execution fields cleared                                              | None                                                                      | Review loop                                            |
| `plan_review_write`                                         | Review markdown/front matter                                    | Plan                                                                 | Plan review write                                                                  | Written revision                                                           | None                                                                      | Review retry                                           |
| `plan_front_matter`                                         | Front Matter updates                                            | Plan                                                                 | Metadata update                                                                    | CAS revision                                                               | None                                                                      | Caller retry                                           |
| `plan_archive` / `plan_restore`                             | Archive/restore action                                          | Catalog, Plan                                                        | Physical move metadata                                                             | Archive/active path                                                        | Rename CAS only                                                           | Restore/archive retry                                  |

The code-side inventory in `src/shared/workflow/state-transition.test.js` checks that its semantic writer rows have
inputs, locks, effects, proof, rollback limits, and recovery actions. Publication uses its dedicated attempt record and
Git reconciliation rather than the retired merge-failure transition journal.

## Epic Branches and the Integration Gate

Every new Epic starts and ends on its own branch, recorded as the Epic's `targetBranch`. Architect names it, and Slicer
or RunWield fills in `epic/<epic-name>` when it is missing. Children inherit it and deliver to it.

When the Epic first needs the branch, RunWield creates it from the latest primary branch (origin's default branch, then
origin's `main`, then local `main`) and records that commit as `epicBaseCommit`. The Epic and its children record the
branch only after it exists; when an Epic nobody named a branch for cannot get one, it keeps the legacy behavior. An
existing branch is used as it is and is never reset. Child drafts missing from the branch are committed onto it with Git
plumbing, so no checkout is changed; a branch that is checked out somewhere is never moved under that checkout. A draft
committed before it had a `planId` is replaced by its identified copy. An Epic whose children already started without a
branch keeps the legacy behavior below.

While planning one child, Planner may reshape any sibling that has not started. Those edits travel to the Epic branch in
the child's preparation commit, and a reshaped sibling that was `approved` or `ready_for_work` returns to `draft` so its
own Planner session can reshape it again. A sibling that has started stays as it is.

Each child's Semantic Review judges only that child's correctness, with the Epic's objective and siblings as context.
Its Integration Notes are written to a RunWield-managed `### Integration Notes` subsection of the Epic's Verification
Plan; the Integration Reviewer reads them as places to look. The Integration Reviewer is its own subagent: it reads
selectively from the Epic outcomes and notes instead of reading every line again, and can hand large areas to read-only
delegates.

Reading or archiving an Epic child never prepares a planning worktree for it: archive, restore, and Work Record
generation resolve the local document read-only. Planning worktrees start only when Planner or execution starts the
child.

```mermaid
stateDiagram-v2
    ready_for_work --> implemented: epic_children_delivered
    implemented --> reviewed: epic_integration_passed
    implemented --> implemented: epic_integration_failed (repair child added)
    reviewed --> implemented: epic_integration_stale
    reviewed --> verified: epic_publication_confirmed
    reviewed --> closed_without_verification: epic_done_enough
```

Child status alone never completes an Epic with its own branch. A reviewed child whose publication is pending does not
count; its delivered commit must be contained in the Epic branch. RunWield reconciles after a child is delivered and
whenever the Epic is loaded.

The integration gate runs on the exact Epic branch head in a temporary detached checkout that it removes afterwards. It
runs the project's checks, then an integration review of the whole Epic diff from `epicBaseCommit` against the Epic, and
then Code Review per the `codereview` setting. A pass records `epic_integration_passed`. Findings write
`docs/plans/<epic>/integration-report.md`, record `epic_integration_failed`, and add a draft repair child under the Epic
that Planner starts from. The repair child is reviewed and run like any other child, and its delivery runs the gate
again. The user can mark the Epic done enough at any point. RunWield never merges the Epic branch into the primary
branch; the user merges it or opens a pull request. A later load verifies the checked Epic commit against its recorded
final target before recording `epic_publication_confirmed`. Plan-only completion metadata does not invalidate the
reviewed implementation.

For branchless Epics and Sequences, the container can become verified after all included children have confirmed
delivery. This automatic completion is distinct from a user choosing done enough without verification. A Sequence gets a
branch only when the user names one.

## Manual Board Movement and Closure

Board actions are lifecycle events, not direct Front Matter edits. Generic board movement uses `manual_status_change`
and may move both directions only within the safe board set: `draft`, `feedback`, `approved`, `ready_for_work`,
`in_progress`, and `implemented`. For PROJECT Epics, `ready_for_decomposition` is also board-safe.

Generic board movement cannot enter or leave `failed`, cannot produce `verified` or `user_verified`, cannot enter
`closed_without_verification`, and cannot enter or resume from `on_hold`. Those states remain behind recovery, Workflow
Validation, publication reconciliation, manual closure, or hold-specific events. `verified` requires confirmed delivery
or completed non-Git validation; explicit `epic_done_enough` produces `closed_without_verification`.

`manual_closed_without_verification` records that the user intentionally closed a Plan without Workflow Validation. This
is not an archive, not a validation pass, and not a merge-back signal; evidence/worktree fields are preserved unless a
separate recovery action changes them.

### Workspace manual actions

The browser Workspace board and detail controls call the token-protected lifecycle action API for every status mutation.
They never directly write `status` front matter. Button/menu actions use the same lifecycle intent shape that future
keyboard shortcuts or drag-and-drop drop handlers must use, so drag gestures are only an input layer over the existing
lifecycle path.

Workspace Resume from hold runs a conservative Resume Check before recording `hold_resumed`. If recorded worktree or
staleness metadata cannot be proven safe, the API returns a warning that requires explicit user confirmation; hard
failures block the resume. Full pointer/touch drag-and-drop gestures are not required for the current Workspace slice.

## On-Hold Plans

`plan_held` can pause any non-terminal, non-closed status, including `failed` and `implemented`. It sets:

- `heldFromStatus`: the status before the hold
- `heldAt`: when the hold was recorded
- `holdReason`: optional free text
- `holdStalenessBaseline`: optional caller-provided baseline for the Resume Check

`hold_resumed` restores `heldFromStatus` and clears all hold fields. The Resume Check itself is caller-owned and must
run before recording `hold_resumed`.

`hold_reset_to_draft` clears hold fields plus stale execution/recovery/validation fields: `worktreeId`, `worktreePath`,
`worktreeBranch`, `worktreeStatus`, `executionBaselineTree`, `failureReason`, `failedAt`, `implementedAt`, `verifiedAt`,
`humanReviewMode`, `humanReviewDecision`, `humanReviewedAt`, and `publicationReceipt`, and resets `validationPhase` to
mechanical. It preserves identity/context fields such as `classification`, `complexity`, `summary`, `affectedPaths`,
`createdAt`, `origin`, `parentPlan`, and `dependencies`.

## Readiness Gate

The Readiness Gate is classification-aware.

For PLANNED_CHANGE Plans (including legacy FEATURE), the gate does not call an LLM. It promotes `approved` to
`ready_for_work`.

For PROJECT Epics, the gate records `epic_readiness_passed` and promotes `approved` to `ready_for_decomposition`. The
Slicer then runs as an interactive decomposition agent. When the user explicitly finalizes the decomposition seams, the
Slicer materializes child PLANNED_CHANGE Plans as `draft`, records `decomposition_finalized`, and the Epic becomes
`ready_for_work` for child selection. That status does not mean the Epic itself can be executed, and draft child Planned
Changes still go through Planner/Plannotator review before execution.

## Execution Worktrees

Before executable implementation starts, RunWield creates or reuses a git worktree for the Plan and records its attempt
metadata in that worktree's Plan file and `.wld/internal/worktrees.json`. From that point forward, Agent sessions,
built-in file tools, custom edit tools, lifecycle transitions, local CI, workflow diffs, reviewer sessions, and repair
sessions all use the execution worktree. RunWield does not use `Deno.chdir()` for this because workflow operations stay
scoped to their explicit execution context.

The user's primary checkout remains the discovery root for settings and local runtime files, but its copy of an active
Plan is only a possibly stale checkout. `wld load-plan` resolves a live attempt through its recorded worktree evidence
and reads lifecycle truth there. It must not compare the execution status with the primary copy, synchronize the active
Plan backward, or dirty the user's checkout. Registry and lock files remain ignored local runtime state.

Each worktree-backed execution must also contain the canonical Plan Markdown at `docs/plans/<plan-name>.md` before the
execution baseline is captured. If the execution worktree was created from a commit that did not yet contain that Plan
file, RunWield copies the full primary-checkout Plan into the absent execution path first; the copied Plan then becomes
part of the baseline given to implementation and validation. After recording `execution_started`, RunWield creates a
preparation commit on the execution branch containing the materialized Plan and any other RunWield-owned preparation
files. The target `baseCommit` remains unchanged and `executionBaselineTree` remains the pre-implementation comparison
tree; the preparation commit exists so the Plan is tracked, durable Git evidence before the execution Agent begins.

Before accepting `task_completed`, RunWield verifies the execution Plan again. If the Agent deleted it, RunWield
restores the exact Plan from `executionBaselineTree` before recording `implementation_finished` and checkpointing the
work. An existing malformed, non-regular, or conflicting Plan is preserved and blocks completion rather than being
overwritten.

During Workflow Validation or `wld load-plan` recovery, a missing execution Plan file is repairable only after RunWield
proves the recorded registry entry, linked worktree path, repository common directory, checked-out branch, target
branch, and baseline tree all match the primary Plan identity. When those proofs pass and only
`docs/plans/<plan-name>.md` is absent, RunWield restores it from the canonical Project Plan, emits a non-error notice
naming the relative path, and continues validation. Existing evidence is never overwritten: malformed Front Matter,
unreadable files, symlinks, directories or other non-regular paths, symlinked parents, and conflicting Plan IDs all
block with an exact path and reason so the user can inspect or recover the worktree manually.

## Workflow Validation and Merge-Back

Workflow Validation applies only to executable Plan work. It advances using the public status and durable controller
phase: `implemented` with `validationPhase: mechanical` runs Mechanical Validation; passed CI records
`validationPhase: semantic` while keeping `implemented`; review approval records `reviewed` and the delivery phase.
Reviewed Plans handle configured Code Review and publication. Operational retries and pauses preserve the last valid
phase. Feedback that changes the implementation clears passed checks and returns to mechanical validation.
Worktree-backed Plans become `verified` only when the target contains the finalized publication. The publication
registry record owns intermediate Git progress. FEATURE Plans fail closed when execution mode or publication context is
unknown; missing Session state never authorizes validation in the primary checkout.

Normal owner-facing progress uses shorter labels for these same phases. Mechanical Validation appears as **tests and
CI**. Semantic Review appears as **AI review**. Code Review appears as **code review**. Raw Plan Status values stay in
technical details and diagnostics.

For worktree-backed plans:

1. Implementation runs in the execution worktree.
2. Before `implementation_finished` can record Plan Status `implemented` and worktree status `completed`, RunWield
   checkpoints every tracked and untracked execution-worktree change in a branch commit and requires the checkout to be
   clean. The controller reads the attempt baseline and worktree identity from the registry, never from Plan metadata. A
   stale Plan copy cannot reset that state. A missing execution context or failed checkpoint leaves the Plan
   `in_progress` and the worktree recoverable. The registry keeps the immutable worktree creation tree separate from the
   execution-attempt baseline, which may advance when a failed worktree is reused. Completion does not merge into the
   primary checkout.
3. Workflow Validation reads `validationCiAttempts` and `validationSemanticRounds` from the current controller record,
   runs the next lifecycle phase from the current Plan Status and durable `validationPhase`, records its result, and
   returns. Repeated calls resume from those saved facts rather than Session memory.
4. The semantic phase, after passed CI, computes one full proposed branch patch from the common ancestor of the recorded
   target and execution HEAD to all current execution-worktree files, then starts Semantic Review rounds. One shared
   function supplies that patch to AI review, repair context, and Code Review, including reload and continuation.
   Target-only changes are absent; current committed and uncommitted execution changes are present. The separate repair
   patch still compares the pre-repair tree with current files. A missing target, missing HEAD, or absent ancestry fails
   the comparison without falling back to `main`, an alternate diff, the recovery baseline, or an empty patch.

   Review narrows as rounds progress: rounds one and two review the implementation against the whole Plan, and rounds
   three and above only verify the open findings and check the latest repair for regressions. Two full sweeps give a
   requirement overlooked in round one a second independent look; narrowing after that is what lets the loop terminate
   instead of rediscovering the implementation indefinitely.

   The Reviewer never receives an inlined diff — it reads changes through the bounded `review_diff` tool in every round,
   so there is one delivery path regardless of size. A decision reached without inspecting the diff is not accepted.

   Findings carry stable identities in a Review Issue Ledger that lives for the attempt. Later rounds resolve items,
   keep them open, and append newly discovered ones; identities are never reused or renumbered. Code smells are reported
   as non-blocking advisories rather than as findings, so an accumulating maintainability backlog cannot stall the loop.
5. A rejection dispatches the Reviewer-Feedback Engineer, which repairs the open findings in a fresh isolated session
   seeded with the Plan, the findings, and diff access. It does not inherit the execution transcript, and it reports a
   per-item disposition that the next round independently verifies — a repair claim is evidence, never resolution.
6. After three automatic rounds without approval, RunWield stops and asks whether to run another verification round or
   open Code Review now. There is no dead end: the work is never left with nowhere to go.
7. If `codereview` is `ask` or `always`, RunWield opens or offers Plannotator Code Review after Semantic Review passes
   and before merge-back. The optional `guidedReview` setting can generate a Guided Review Explainer inside that
   already-open Code Review, but it does not create a Plan Status, Plan Event, or Front Matter field. User feedback goes
   to the Reviewer-Feedback Engineer in the same fresh-session way, along with the annotations and images, and Code
   Review then reopens. Code Review always sees the same full proposed branch patch as AI review, never a repair-scoped
   one. Reload resolves the recorded target and execution HEAD again and includes current committed and uncommitted
   files. User approval reached through the round-limit escape hatch is authoritative and permits merge-back even though
   Semantic Review never approved; the record distinguishes that case.

   Once the change is in a human's hands the loop belongs to them: CI reruns and code review reopens after every
   feedback round, for as many rounds as they give, and automatic Semantic Review rounds do not resume. **The only exits
   are approval or quitting the review.** Feedback never exhausts a budget, and the three-round semantic cap does not
   apply—it counts automatic rounds, not user rounds. Interrupting and resuming mid-cycle returns to Code Review rather
   than restarting Semantic Review.
8. If validation fails, RunWield keeps Plan Status `implemented`, records the failure and mechanical restart phase, and
   leaves the completed execution attempt and worktree available for recovery.
9. After review passes, RunWield seals the implementation candidate and records its commit in candidate Delivery
   Evidence. Artifact preparation leaves the execution Plan `reviewed`, prepares QA and an eligible pending Work Record,
   and seals the artifact commit. The source branch stays at that artifact boundary throughout publication. A failed
   Recorder run is recorded for later retry and does not block code delivery.
10. With a remote, RunWield merges the sealed artifact candidate with the configured upstream target in an isolated
    publication clone. After integration, it finalizes the owned Plan as `verified` and prepared Work Record as
    approved, commits those metadata changes, pushes with a lease, and confirms target ancestry. The execution Plan
    remains reviewed until publication proof. Without a remote, it merges into the selected local target, finalizes the
    same metadata, and proves the resulting commit locally. Exact interrupted owned writes are recoverable; unrelated
    primary edits remain protected.
11. The execution attempt retains its monotonic publication record: `candidate_sealed`, `artifacts_committed`,
    `target_integrated`, `target_published`, `publication_verified`, then `cleanup_complete`. Each phase carries Git
    evidence. Push failure preserves the reviewed source, candidate, pending artifacts, worktree, and branch for retry.
    Recovery verifies the intended final Plan and Work Record state as well as ancestry before treating integration as
    complete.
12. Confirmed delivery stores a permanent controller `publicationReceipt` and `verifiedAt`. These preserve the effective
    verified state when the user's primary checkout trails the remote. Work Record indexing retries durably from the
    published artifact if it fails. Once bookkeeping and safe cleanup settle, RunWield removes the execution checkout,
    branch, temporary clone, and attempt registry entry. Cleanup or index failure does not revoke delivery or remove the
    receipt. Later target commits do not invalidate proof that the publication commit is an ancestor.

Publication recovery is defined by [ADR-016](adr/016-proof-bearing-publication-state-machine.md). Legacy lifecycle
labels are interpreted using saved validation and delivery evidence; status strings alone do not prove publication.

Code Review has no separate public status. An offer, cancellation, or pending decision keeps the Plan `reviewed`; user
feedback returns it to `implemented` for fresh CI and then back to human review. Final review metadata records whether
Code Review was not required, skipped, or approved. Recovery preserves canonical human-review mode, decision, and
timestamp when no newer result exists. Restarting execution, resetting recovery, or reopening the Plan clears stale
review and completion evidence.

After confirmed publication, registry updates, indexing, metrics, and cleanup are bookkeeping. Failures retain the
receipt and necessary retry state. Inconclusive publication proof retains the reviewed execution work and attempt.

For PROJECT Epics, child FEATURE Plans run their own Workflow Validation. The Epic can be marked done enough for now,
but it does not run a validation loop as if it were an implementation diff.

For executable FEATURE Plans, the workflow diff must contain implementation changes. An empty scoped diff, or a diff
that only changes Plan documents under `docs/plans/`, is a validation failure. OPERATION and QUICK_FIX are not saved as
executable Plans. OPERATION ends after Operator self-verification and `task_completed`. QUICK_FIX runs no-plan
Mechanical Validation after Engineer `task_completed`, without Plan lifecycle state.

## Front Matter Fields

Front Matter contains document and planning fields, not the workflow controller's working state. Optional fields are
omitted when unused; empty runtime placeholders are never written.

`planId`: Stable identity joining this document to its controller record.

`classification`, `workKind`, `complexity`, `affectedPaths`, `executionAgent`, and `collaborationRecommendation`:
Planning and execution policy. `targetBranch` names the source and intended destination, not a description or `HEAD`.
For a standalone Planned Change without an authored target, execution preparation records the repository default branch
(origin's default, then configured local default, `main`, or `master`), not the current checkout branch.
`deliveryBranch` records the actual landing separately. With `plans.autoMergeIntoTargetBranch` off (default), RunWield
creates or reuses `plan/<plan-name>` from `targetBranch`, bases the worktree on it, and merges back into it. With the
setting on, it skips Plan Branch creation and uses `targetBranch` for both execution and delivery. A recorded landing
survives setting changes and retries. Epic and Sequence children keep their existing branch behavior; QUICK_FIX and
non-Git execution do not use this setting. Confirmed Plan Branch delivery makes the Plan Verified and creates its Work
Record; it does not claim delivery to the intended destination. The completion card says **Ready for your merge/PR**,
names the landing branch, and guides the user's onward merge.

`createdAt`, `origin`, `userVerifiedAt`, `userVerificationNote`, archive metadata, supersession links, and Epic
completion notes: durable human-facing history. Dev-server hints and child ordering remain planning metadata when
applicable.

There is no stored `summary`: lists and prompts derive it from the first paragraph of the Plan's `## Context` section.

`status`: Current Plan Status.

`parentPlan`: Child Planned Change pointer to the parent Epic plan name.

`dependencies`: Optional sibling FEATURE Plan identifiers that should be complete first. Loading a child FEATURE warns
when dependencies are missing or neither RunWield Verified nor User Verified, but the user may choose to proceed. User
Verified dependencies are satisfied but labeled distinctly.

`heldFromStatus`, `heldAt`, `holdReason`: the user's hold decision and the status to return to.

## Controller Fields

The following fields are controller state, **not Plan Front Matter**. Loaded workflow views join them with the document
for callers; serializers always remove them from Markdown. Existing documents are imported once, then any obsolete
runtime fields left in those files are ignored. Controller updates use their own revision and OS lock; checkpoint-only
updates do not change Plan bytes. Failed lifecycle transitions restore only writes they can prove they own.

`failureReason`: Optional concise reason for `failed` status, validation failure, or merge-back failure.

`failedAt`: Timestamp set when execution fails before implementation finishes.

`implementedAt`: Timestamp set when execution work finishes.

`verifiedAt`: Timestamp of confirmed target delivery, proven Epic publication, or completed non-Git validation. Explicit
done-enough closure does not create this proof.

`validationPhase`: Durable next validation phase: `mechanical`, `semantic`, or `delivery`. Passed CI advances it to
semantic without changing the public implemented status; implementation feedback resets it.

`publicationReceipt`: Retained confirmed-publication identity: checked candidate commit, published commit, and target
branch. It survives attempt cleanup and supports a primary checkout that trails the remote. Reopening or restarting
execution invalidates the previous receipt.

`recordingSource`: Retained immutable Plan input for a failed Work Record retry after execution-worktree cleanup.
Publication proof supplies delivery eligibility; retry does not reimplement or remerge the Plan.

`humanReviewMode`: Code review mode used for final validation: `none`, `ask`, or `always`.

`humanReviewDecision`: Code review outcome included in final validation: `not_required`, `skipped`, or `approved`.
`changes_requested` is the one non-final value: the user read the diff and asked for changes. It makes the user the
owner of this Plan's review, so the repair round runs the tests and hands the diff straight back to them instead of
sweeping it with the Semantic Reviewer again.

`humanReviewedAt`: Legacy-named timestamp set when the user approves Code Review.

`executionMode`: Explicit execution publication mode. `worktree` means implementation must be validated and published
through a Git-backed execution worktree. `non_git_in_place` means validation ran against the primary checkout by an
explicit non-Git path. Missing mode is unknown for FEATURE validation, not an implicit primary-checkout fallback.

`deliveryEvidence`: Versioned candidate or non-Git evidence recorded with `validation_passed`. Worktree evidence records
`mode: "worktree_merge"`, the sealed `executionCommit`, the concrete landing in `targetBranch`, and
`targetHeadBeforeMerge` so Git ancestry can later prove the candidate reached the target. These candidate fields alone
are not publication proof; the publication record and retained receipt identify the finalized delivered commit. Non-Git
evidence records only `{ version: 1, mode: "non_git_in_place" }`; it must not contain absolute paths.

`executionBaselineTree`: Git tree captured in the execution worktree at `execution_started`.

`worktreeId`: Durable id of the matching `.wld/internal/worktrees.json` registry entry.

`worktreePath`: Filesystem path to the linked execution worktree.

`worktreeBranch`: Git branch checked out in the execution worktree, usually under `worktree/`.

`worktreeStatus`: Worktree lifecycle state. See [Worktree Statuses](#worktree-statuses).

`holdStalenessBaseline`: Optional baseline used by caller-owned Resume Check logic before `hold_resumed`.

## Recovery

Loading an `in_progress`, `failed`, or `implemented` executable Plan starts Plan Recovery. For worktree-backed plans,
RunWield resolves worktree context from the controller registry, then reads the Plan in that worktree. Inspect/report
shows plan status, worktree status, path, branch, base commit/ref when available, git status, and changes since the
execution baseline.

Recovery actions are deliberately scoped to the execution worktree:

- **Continue execution from current worktree**: Rebuilds a missing registry entry when the Plan and Git attachment prove
  the same attempt, records the retry against the execution-worktree Plan, rehydrates active execution state, and
  resumes there. A stale primary-checkout Plan status is ignored.
- **Retry Workflow Validation**: For `implemented` plans, reruns validation in the recorded execution worktree and only
  merges after validation passes.
- **Merge worktree changes**: For worktree-backed `implemented` plans, attempts to merge the recorded worktree branch
  into the primary checkout. Merge failure records `worktreeStatus: "merge_conflict"` and leaves the worktree intact.
- **Restore worktree record and continue**: Rebuilds RunWield's missing worktree registry entry from imported recovery
  hints and `git worktree list` evidence when the recorded path, branch, and target branch still agree. It does not
  delete the worktree or reset the user's work.
- **Delete/recreate worktree and start over**: Verifies the recorded path and branch, resolves the Plan id and starting
  commit, and creates the replacement before discarding the old checkout. It records `recovery_reset` and retries from
  `ready_for_work`.
- **Delete/abandon worktree**: Verifies the exact recorded checkout against Git, removes it, settles the registry,
  clears active controller references, and reloads the surviving Plan. The primary checkout is never an execution
  worktree. Held-Plan delete/reset uses the same cleanup rules.
- Cleanup deletes branches proven merged into the current checkout or unchanged from their recorded starting commit,
  including missing-path attempts based on another target branch. Unique commits remain on a named rescue branch with an
  abandoned registry record. The result says which artifacts remain. Incorrect identity or partial cleanup preserves
  recovery evidence; each completed Git and registry effect is recorded for retry. Publication cleanup remains governed
  by ADR-016.
- **Re-open for review**: Moves the plan back to `feedback` so it can be revised instead of continued.

Legacy plans that have an `executionBaselineTree` but no worktree metadata keep the older baseline-tree reset path. That
path checks that the current checkout already matches the recorded snapshot and refuses to overwrite newer changes.

## Plan List Visibility

`wld plans` shows Epic hierarchy for PROJECT Plans. Child FEATURE Plans are grouped under their parent Epic using
`parentPlan`, and Epics show verified/active/remaining/failed progress. Child FEATURE Plans whose `parentPlan` does not
match an existing Epic are shown as orphaned child plans.

`wld plans` also shows concise worktree state for plans with worktree metadata:

```text
Worktree: validation_failed (worktree/example-plan-1234abcd)
```

The parenthesized value is the recorded worktree branch when available, otherwise the path.

## Invariants

- `ready_for_work` is the executable status for FEATURE Plans.
- `ready_for_work` on a PROJECT Epic means child FEATURE selection is available, not that the Epic executes directly.
- `ready_for_decomposition` is not executable.
- `approved` is durable but not executable.
- `failed` only occurs after work started from `ready_for_work`.
- `implemented` means implementation finished in the execution worktree, even if validation or merge-back later fails.
- `verified` requires successful checks/review and confirmed target delivery, or completed non-Git validation. An Epic
  integration pass stays reviewed until final-target proof; explicit done-enough is closed without verification.
- `user_verified` is terminal user attestation and never implies RunWield Workflow Validation passed.
- `closed_without_verification` is terminal manual closure and never implies validation passed.
- `on_hold` is a pause state; resume/reset must clear hold metadata.
- Code review is optional Workflow Validation metadata, not a separate Plan Status.
- Executable FEATURE validation cannot pass with an empty or Plan-document-only workflow diff.
- Workflow code should record Plan Events instead of directly mutating Plan Status.

## User Verified Plans

`user_verified` is a terminal Plan Status for outcomes the user personally verified outside RunWield Workflow
Validation. The canonical event is `manual_user_verified`; it requires a trimmed, non-empty `userVerificationNote` and
records `userVerifiedAt`. The event itself does not set `verifiedAt`, synthesize Delivery Evidence, erase prior
`failureReason`, or relabel code review/validation history.

The `/load-plan` User Verification flow carries the accepted document and note into the primary checkout, then confirms
before removing the execution worktree and clearing its records. Declining removal preserves the checkout for later
cleanup, while the Plan remains terminal in the primary checkout. Unmerged branch commits are retained. The terminal
menu is the same as for RunWield Verified Plans: Archive, Re-open for review, View, and Cancel. Archive retries pending
cleanup with confirmation. Work Record generation uses the accepted document and writes its backlink in the same place.

User Verified Plans satisfy child dependencies and Epic completion accounting, but reports must keep them separate from
proof-bearing RunWield `verified` Plans. A mixed Epic can advance when every child is either RunWield Verified with
mode-appropriate Delivery Evidence or User Verified. The manual action does not start automatic next-child execution.
Re-opening from `user_verified` returns to `feedback` and clears stale user attestation fields.

Canonical domain term follow-up: `User Verified Plan` should be added to `docs/domain-language.md` by Ideator/Init in a
separate context update; this feature intentionally leaves `docs/domain-language.md` and ADRs unchanged.

## Transactional lifecycle writes

Lifecycle-changing code must request one semantic transition instead of sequencing Plan writes, registry writes, Git
commands, and cleanup in the caller. The transition re-reads the canonical Plan, holds the same-Plan mutation lock while
it applies the change, writes through atomic Plan persistence, verifies the requested postconditions, and either
commits, rolls back, or leaves a recovery record under `.wld/internal/plan-transitions/`.

The lock protects the logical transition, not just the final file rename. Different Plans may still execute at the same
time. Shared resources, such as a parent Epic, sibling set, target branch, or registry entry, are acquired only when
that transition depends on them. The worktree registry file itself is locked only for brief targeted read-modify-write
updates.

Malformed Front Matter is fail-closed. RunWield distinguishes a missing Plan from malformed YAML, preserves the original
bytes, blocks mutation, and reports the Plan path and parse error. Repair must be explicit; ordinary lifecycle updates
do not rebuild unknown or conflicted Front Matter.

Git-backed transitions record proof before and after worktree or branch operations. If Git state is uncertain after an
interruption, RunWield does not replay the command blindly. It either proves the already-completed outcome or asks the
user to inspect/retry/abandon the exact recorded worktree or branch.

Non-Git Projects remain supported. When a repository has no Git/VCS metadata and the user has allowed in-place FEATURE
execution, lifecycle transactions still protect Plan metadata, but Git worktree, branch, registry, and merge-back steps
are skipped. The FEATURE executes in the current checkout and validation records non-Git delivery evidence rather than
worktree merge evidence.

## Transaction boundary matrix

| Workflow action                     | Inputs                                                                     | Locked resources                                                                  | Durable effects                                                                                | Success proof                                                            | Rollback limit                                                                         | Recovery actions                                                                |
| ----------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Review approved/feedback            | Plan name, opened revision, reviewed markdown, decision                    | Plan lock; catalog lock when parent/child state can change                        | Reviewed Plan bytes and review lifecycle status are written in one revision-checked transition | New Plan revision contains both reviewed content and expected status     | Never overwrite a newer revision; stale review must reload                             | Reload review, inspect unresolved transition journal                            |
| Execution preparation               | Plan id/name, expected ready status, target branch or non-Git consent      | Plan lock, exact attempt id, registry file, target ref when Git exists            | Controller execution mode and registry attempt identity/baseline                               | Registry attempt matches actual Git identity and baseline                | If Git/registry facts are uncertain, do not delete by default                          | Retry prepare, inspect worktree, abandon explicit attempt                       |
| Implementation checkpoint           | Plan id/name, attempt id, execution report                                 | Plan lock and exact attempt lock                                                  | Attempt checkpoint and implemented/failed lifecycle metadata                                   | Registry attempt and Git checkpoint prove the implementation             | Do not roll back implementation files after checkpoint uncertainty                     | Resume implementation, reset attempt, inspect worktree                          |
| Validation passed / Direct Delivery | Child Plan, attempt id, delivery evidence, parent/siblings when applicable | Catalog, child Plan, parent Epic, complete sibling set, exact attempt, target ref | Child verified metadata, eligible parent advancement, publication evidence                     | Lifecycle status, controller delivery proof, and Git effects are settled | Final child and parent must settle together; uncertain publication remains recoverable | Retry validation publication, inspect target ref, recover/abandon exact attempt |
| Validation failed / retry           | Plan id/name, attempt id, failure reason                                   | Plan lock and exact attempt lock                                                  | Failure metadata preserving retryable worktree identity                                        | Controller failure saved; registered attempt remains retryable           | Do not discard worktree without explicit abandon/reset                                 | Retry validation, continue repair, abandon explicit attempt                     |
| Hold/resume/reset                   | Plan id/name, expected status, hold/resume data                            | Plan lock; exact attempt lock when attempt metadata is present                    | Held-from state or restored lifecycle state                                                    | Plan revision has expected status and hold fields                        | Stale caller state aborts before write                                                 | Resume with staleness confirmation, reset to draft                              |
| Archive/restore                     | Plan id/name, expected terminal/recoverable state                          | Catalog, Plan path, archived path, exact attempt when recoverable                 | Physical move plus archive/restore metadata                                                    | Active/archived path and Plan metadata agree                             | Existing target or malformed source aborts without overwrite                           | Restore, force archive after explicit confirmation                              |
| Doctor/repair                       | Plans, registry, journals, Git facts                                       | Registry lock only for proven metadata repair; no destructive lockless action     | Report issues; apply only mechanically proven safe repair                                      | Repair result is re-read and reported                                    | Missing paths/branches are not abandonment proof                                       | Inspect, retry, explicit abandon/delete with evidence                           |
