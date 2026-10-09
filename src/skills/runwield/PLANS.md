# Plans and workflows

Use this file for Plan lifecycle questions. Link to these docs for depth:

- https://docs.runwield.dev/workflows/
- https://github.com/gandazgul/runwield/blob/main/docs/plan-lifecycle.md
- https://docs.runwield.dev/collaboration/

## Plan files

Plans are Markdown files with YAML Front Matter under `docs/plans/`. Child FEATURE Plans for a PROJECT Epic live under
`docs/plans/<epic-name>/` and point back with `parentPlan`. RunWield owns Front Matter lifecycle metadata; the user owns
the Plan body and review content.

## FEATURE review and execution

A normal FEATURE flow is:

1. Planner writes the Plan.
2. Plannotator opens in the browser for user review.
3. Feedback returns the Plan to Planner; Approve records execution metadata and marks it ready for work.
4. RunWield dispatches the recorded `executionAgent`.
5. Workflow Validation runs.
6. The Plan becomes RunWield Verified only after delivery evidence and, for worktree execution, proof of merge-back.

Plannotator is the browser review surface RunWield opens for Plan review. Outcomes are Approve, Approve for Later, and
Feedback. FEATURE Plan Review exposes `executionAgent` and `collaborationRecommendation` controls so the user can select
the execution owner and autonomous or Pair collaboration recommendation.

## Validation, review, and repair

Workflow Validation is local CI plus Semantic Review. Semantic Review runs in narrowing rounds, carries findings in a
Review Issue Ledger, and repairs findings in independent Engineer sessions. It does not run an automatic Plan Amendment
gate and does not silently adopt execution-worktree Plan edits. `QUICK_FIX` runs Mechanical Validation only: no
Reviewer, no Plannotator Code Review, no Plan status changes, and no merge-back.

In every Plan execution style, including restored Sessions and validation repairs, explicit user feedback that replaces
an effective Plan requirement must be confirmed through `record_plan_deviation`. The confirmed entry is saved in
`planDeviations` on the authoritative execution Plan. Semantic Review uses it over conflicting original Plan text. Work
Records list confirmed entries under `## Deviations from Plan`. Canceled, stale, unsupported, or inferred feedback does
not change the Plan. If the session is lost before the write, ask for confirmation again. If it is lost after the write,
retrying the same tool call recovers the saved entry by tool-call identity and does not replay transcript approval.

`codereview` controls the Code Review gate after local validation and Semantic Review pass and before merge-back: `none`
skips the gate, `ask` prompts the user, and `always` requires it.

## Statuses users see

- `draft`: Plan exists but review is not complete.
- `feedback`: user feedback or interrupted feedback handling returned it to planning.
- `approved`: user approved it, but preparation is not complete.
- `ready_for_decomposition`: approved PROJECT Epic is ready for Slicer.
- `ready_for_work`: FEATURE can execute, or PROJECT Epic can offer child selection.
- `in_progress`: execution started.
- `failed`: implementation did not finish; recovery may continue or reset it.
- `implemented`: implementation finished and waits for validation or repair restart.
- Mechanical check progress is durable controller state; the Plan remains `implemented` until review passes.
- `reviewed`: review passed; human review follows the configured policy and delivery is pending.
- `validation_passed`: validation success event that moves the Plan to `verified` after required proof.
- `verified`: the reviewed work reached its target branch, or passed verification in place for a non-Git project.
- `user_verified`: User Verified; the user attested acceptance without RunWield Workflow Validation proof.
- `done_enough`: user-facing Epic outcome meaning remaining child work is intentionally deferred.
- `closed_without_verification`: terminal manual closure without validation success.
- `on_hold`: paused and resumable.

RunWield Verified means RunWield collected validation and delivery evidence. User Verified means the user recorded an
attestation note; it does not set `verifiedAt` or claim Workflow Validation passed.

## `wld load-plan`, Epics, and Slicer

`wld load-plan <name-or-path>` loads a saved Plan, resumes work, reopens review, or starts recovery based on status. It
is Epic-aware: loading an approved or decomposing PROJECT opens Slicer; loading a ready Epic offers child FEATURE
selection; loading a child follows the normal FEATURE path.

A PROJECT is an Epic container. Slicer is the interactive PM/lead-engineer pseudo-Agent that helps split it into child
FEATURE Plans under `docs/plans/<epic-name>/`. After a child FEATURE verifies, RunWield can continue the parent Epic in
strict child order. The chain stops at the first child that is on hold, needs recovery, has unmet dependencies, has an
unsupported status, or needs user planning/approval.

## Recovery

Use `wld plans doctor` to fix safe Plan and worktree problems. It repairs by default and repeats until no more safe fix
is available. `--repair` is a compatible alias. Use `--check` for a read-only report. Doctor does not delete an unmerged
worktree or reset working changes. It asks before either action. Plan loading and validation use the same safe repair
rules before they ask the user.

## Work Records

Work Records are repo-local Markdown generated at supported Plan completion under `docs/work-records/`. Use `wld wr` to
list, search, read, backfill missing records, or rebuild the derived index. They summarize completed work for future
planning; failed generation does not undo a terminal Plan outcome.

## Shared Spaces

`wld plans share|pull|push|unshare` use remote-canonical encrypted Shared Spaces for collaborative planning. Sharing
takes a Shared Plan Lock that blocks normal local mutation. `share` prints reviewer and maintainer URLs once. `pull`
imports remote revisions or comments, `push` publishes the accepted local revision, and `unshare` destructively deletes
the remote Shared Space and clears local sharing metadata.
