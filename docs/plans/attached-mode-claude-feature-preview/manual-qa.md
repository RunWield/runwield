# Manual QA for attached-mode-claude-feature-preview

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="attached-mode-claude-feature-preview/01-activate-and-resume-an-attached-workflow" -->

## Activate and resume an Attached Workflow

Manual verification steps for attached-mode-claude-feature-preview/01-activate-and-resume-an-attached-workflow

- [ ] In a project, activate an Attached Workflow and confirm the JSON reports a new workflow, revision 1, and a pending
      Triage action.
- [ ] Confirm activation creates no repository files and does not change `.gitignore`.
- [ ] In a fresh process, submit a valid PLANNED_CHANGE Triage outcome and confirm status reports `awaiting_planning` at
      revision 2 with the next action to plan.
- [ ] Repeat the same submission and confirm it returns the saved result without changing the record.
- [ ] Submit an unsupported Routing Intent and confirm the workflow closes with an unsupported-in-preview result.

<!-- runwield:manual-qa:end child="attached-mode-claude-feature-preview/01-activate-and-resume-an-attached-workflow" -->

<!-- runwield:manual-qa:start child="attached-mode-claude-feature-preview/02-plan-one-feature-request-inside-claude-code" -->

## Plan one FEATURE request inside Claude Code

Manual verification steps for attached-mode-claude-feature-preview/02-plan-one-feature-request-inside-claude-code

- [ ] Load the plugin with `claude --plugin-dir src/attached/claude/plugin` and run
      `/runwield:request add a dark-mode toggle`; confirm Claude shows the setup preview before it writes the Plan.
- [ ] Confirm Claude writes the Plan under `docs/plans/` and submits it; run `wld` and confirm the Plan appears in
      `draft` with a Plan ID.
- [ ] Ask Claude an unrelated question after submission; confirm it answers normally.

<!-- runwield:manual-qa:end child="attached-mode-claude-feature-preview/02-plan-one-feature-request-inside-claude-code" -->

<!-- runwield:manual-qa:start child="attached-mode-claude-feature-preview/03-review-and-approve-plans-through-durable-plannotator-decisions" -->

## Review and approve Plans through durable Plannotator decisions

Manual verification steps for
attached-mode-claude-feature-preview/03-review-and-approve-plans-through-durable-plannotator-decisions

- [ ] In Claude Code, submit a plan and confirm the Plannotator review opens in the browser.
- [ ] Submit feedback, confirm Claude receives it, revises the plan, and opens the next review round in the same browser
      page.
- [ ] Approve a reviewed plan and confirm its status becomes `ready_for_work`.
- [ ] With a review pending, stop the MCP server; start a fresh Claude conversation and run `/runwield:plan-review`.
      Confirm the review reopens and the old browser endpoint is no longer active.

<!-- runwield:manual-qa:end child="attached-mode-claude-feature-preview/03-review-and-approve-plans-through-durable-plannotator-decisions" -->

<!-- runwield:manual-qa:start child="attached-mode-claude-feature-preview/04-implement-approved-plans-in-runwield-worktrees" -->

## Implement approved Plans in RunWield worktrees

Manual verification steps for attached-mode-claude-feature-preview/04-implement-approved-plans-in-runwield-worktrees

- [ ] Record the Claude Code version. Load the plugin, request a small FEATURE, and approve its Plan. Confirm Claude
      calls `start_execution` immediately without asking for another execution confirmation.
- [ ] Confirm Claude reports the RunWield worktree path, branch, and managed `.gitignore` block. Compare the invoking
      branch, HEAD, dirty files, and untracked files before and after; only the disclosed ignore block may change.
- [ ] Confirm a fresh host subagent receives the execution directory, Plan path/name, and engineer or frontend-engineer
      instructions. Confirm it uses that directory and does not request host worktree isolation or call RunWield.
- [ ] Confirm the worker returns a bullet report, then the coordinating conversation submits `task_completed.message`.
      Inspect Core Plan status (`implemented`), registry (`completed`), baseline, and Git implementation checkpoint.
      Confirm the result does not claim validation, Verified, publication, or workflow closure.
- [ ] Stop the worker or MCP process during implementation. In a fresh conversation, run `/runwield:implement` and
      confirm the same worktree, action, Plan, and current role instructions return; no second attempt is created.
- [ ] In a non-Git project, confirm Claude asks the reduced-recovery disclosure in plain text. Decline and confirm it
      stops without automatically asking again or restarting. In a separate request, proceed and confirm Core remembers
      consent and the worker edits only the disclosed current directory.
- [ ] Submit stale revision/action evidence or change the execution Plan body before completion. Confirm Core rejects
      the result without a completion checkpoint. Confirm a transport retry of an accepted operation repeats no effects.
- [ ] Confirm Claude owns every model call and RunWield starts no Claude/Pi model process. Validation and publication
      remain child 05/06 scope, not part of this checklist's implementation result.

### Live acceptance evidence

Claude Code **2.1.293**, macOS, autonomous execution, 2026-10-08:

- Loaded the local plugin and reopened Plannotator in a headed browser. Browser approval caused Claude to call
  `start_execution` without another confirmation, dispatch a fresh host `Agent` worker in the issued directory, and
  submit its report through `task_completed` from the coordinating conversation.
- Core recorded `implemented`, a completed registry entry, and a Git implementation checkpoint. The greeting assertion
  passed. The invoking checkout's status, branch, and HEAD matched the before snapshot.
- Stopped another host while its worker waited in the issued worktree. A fresh `/runwield:implement` restored the same
  worktree and action, dispatched another worker with the returned role instructions, and completed through Core.
- The first host summary used the worker's earlier uncommitted state. Command instructions now require Core's checkpoint
  state and the `.gitignore` exception; the restored host reported both correctly.
- Evidence: `/tmp/runwield-attached-live.u1sXM9/` contains host JSONL, review screenshots, before snapshots, and durable
  record snapshots. Non-Git proceed/decline and stale completion guards have automated real-environment coverage.

<!-- runwield:manual-qa:end child="attached-mode-claude-feature-preview/04-implement-approved-plans-in-runwield-worktrees" -->

<!-- runwield:manual-qa:start child="attached-mode-claude-feature-preview/05a-run-workflow-validation-without-a-core-session" -->

## Run Workflow Validation without a Core Session

Manual verification steps for attached-mode-claude-feature-preview/05a-run-workflow-validation-without-a-core-session

- [ ] Start validation for an implemented Plan with a failing verification command. Confirm it returns a repair request
      and leaves the checkpoint in `awaiting_repair`.
- [ ] Complete the repair and resume validation. Confirm CI runs again and validation returns a reviewer request.
- [ ] Resume the review with complete coverage of the diff and an accepted outcome. Confirm the Plan becomes `reviewed`
      and validation stops before delivery.
- [ ] Repeat a completed repair resume. Confirm it does not run CI or add delivery evidence again.
- [ ] Start validation through a Core Session. Confirm its review, repair, and decision behavior remains unchanged.

<!-- runwield:manual-qa:end child="attached-mode-claude-feature-preview/05a-run-workflow-validation-without-a-core-session" -->

<!-- runwield:manual-qa:start child="attached-mode-claude-feature-preview/05-validate-with-claude-owned-review-and-repair-workers" -->

## Validate with Claude-owned review and repair workers

- [ ] Record the Claude Code version. Launch with `MCP_TOOL_TIMEOUT=600000` and the local plugin. After implementation,
      confirm Claude calls `start_validation` without claiming Verified or publication.
- [ ] Make the configured CI command fail. Confirm Core returns a repair request and Claude dispatches a fresh repair
      worker in the existing execution checkout, not another host worktree. The worker returns a per-item bullet report;
      the conversation submits `task_completed`, then Core independently reruns CI.
- [ ] Confirm a fresh reviewer receives Core's full instructions and RunWield MCP access. Confirm the reviewer itself
      calls `review_diff` and uses the returned revision on each read. The conversation must not relay reads or invent
      coverage. Missing subagent MCP access must produce an explicit capability blocker.
- [ ] Submit approval after only listing files or reading part of a diff. Confirm Core requests a correction. Submit a
      stale action or change the candidate after review. Confirm Core rejects the outcome and validation can recover.
- [ ] Reject a semantic review with a named finding. Confirm a fresh focused repair worker preserves its ID, and Core's
      next reviewer confirms or rejects that fix under the same identity. No implementation worker is reused for review.
- [ ] Stop Core during CI. In a fresh conversation run `/runwield:validate`; confirm the saved claim resumes with no
      competing worker. Repeat an accepted operation ID and confirm CI and evidence are not repeated.
- [ ] Run a real configured CI check longer than five minutes (for example, 310 seconds). Confirm MCP progress arrives
      at 30-second intervals and ends with the call.
- [ ] Confirm user decisions are asked in Claude and sent back exactly, not automatically selected by the coordinator.
- [ ] Confirm validation ends at Plan `reviewed` and Attached `awaiting_delivery`. No commit, push, merge, or Verified
      claim is made by this validation handoff. Confirm the invoking checkout remains preserved.

Live acceptance evidence: Claude Code 2.1.296 waited 320 seconds on one `start_validation` call without retrying. After
the MCP server stopped during review, a fresh conversation restored the same workflow with `/runwield:validate`. Fresh
reviewers read the diff directly through MCP, a fresh repair worker fixed the blocking value requirement, and an
independent reviewer confirmed the fix. Core returned `reviewed` and `awaiting_delivery`, not Verified. A second live
workflow exercised the explicit outcome schema and a correction with a fresh reviewer; worker outcomes were submitted
without coordinator rewrites. Logs are in `/tmp/runwield-child05-live/` on the acceptance machine.

<!-- runwield:manual-qa:end child="attached-mode-claude-feature-preview/05-validate-with-claude-owned-review-and-repair-workers" -->
