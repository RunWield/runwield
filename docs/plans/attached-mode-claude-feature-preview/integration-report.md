# Integration Gate Report: attached-mode-claude-feature-preview

RunWield checked the Epic branch `epic/attached-mode-claude-feature-preview` at `6e35106ef0dddca5856a81e7ef693ea02c73baec`, diffed from `7bef10a1ef4b075a5484c6d4a44c56cf2791fed0`.

## Delivered Children

- attached-mode-claude-feature-preview/01-activate-and-resume-an-attached-workflow (validated)
- attached-mode-claude-feature-preview/02-plan-one-feature-request-inside-claude-code (validated)
- attached-mode-claude-feature-preview/03-review-and-approve-plans-through-durable-plannotator-decisions (validated)
- attached-mode-claude-feature-preview/04-implement-approved-plans-in-runwield-worktrees (validated)
- attached-mode-claude-feature-preview/05a-run-workflow-validation-without-a-core-session (verified)
- attached-mode-claude-feature-preview/05-validate-with-claude-owned-review-and-repair-workers (verified)
- attached-mode-claude-feature-preview/06-publish-validated-work-and-record-the-outcome (verified)
- attached-mode-claude-feature-preview/07-answer-review-chat-from-the-claude-session (verified)
- attached-mode-claude-feature-preview/08-prove-and-document-the-supported-claude-preview (verified)
- attached-mode-claude-feature-preview/10-repair-integration-findings (verified)
- attached-mode-claude-feature-preview/11-repair-integration-findings-2 (verified)
- attached-mode-claude-feature-preview/12-repair-integration-findings-3 (verified)
- attached-mode-claude-feature-preview/13-repair-integration-findings-4 (verified)
- attached-mode-claude-feature-preview/14-repair-integration-findings-5 (verified)

## Findings

### 1. Project checks fail on the Epic branch

Source: Project checks

Exit code 1.

```text
$ bun scripts/check-bun-runtime.ts && bun scripts/run-ci.ts
ci workspace:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-check-failure-5e34e08a-b2ac-4afb-b88e-40029699c81f.log
ci lint failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-lint-failure-a51fcfa8-0985-4490-929c-343710bc5def.log
ci check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-check-failure-c2307e73-ca21-40e3-857e-444ce575907e.log
ci workspace:build failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-build-failure-92c2ec40-d177-4f87-902c-d03af9741269.log
ci submodules:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-submodules-check-failure-35aafefd-4910-4302-85cc-ff15891963a9.log
ci docs:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-docs-check-failure-df0a0482-3964-4941-9c46-0834cccf9541.log
CI failed tasks:
- submodules:check: exit 1
- check: exit 1
- workspace:check: exit 1
- lint: exit 1
- docs:check: exit 1
- workspace:build: exit 1
error: script "ci" exited with code 1
```

### 2. The Preview does not enforce the Planning Gate

Source: Integration review

Requirement: Planning must deny implementation edits and mutating commands before approval, with working-tree inspection as defense in depth. Prompt-only enforcement must not be accepted.

Evidence: src/attached/claude/plugin/commands/request.md:71–73 explicitly permits normal tool use with no hooks or restrictions. src/shared/attached/compatibility.ts lists this restriction-free configuration as compatible. The plugin has no planning hook, and coordinator.ts activation and Plan submission do not capture or check a planning baseline. Claude can therefore edit implementation files in the invoking checkout before Plan approval without Core detecting or blocking those edits.

### 3. Two workflows can dispatch workers into the same execution worktree

Source: Integration review

Requirement: One Plan must have one consequential owner. Two host conversations must not both receive execution authority for the same Plan.

Evidence: coordinator.ts planWritten allows two workflow records to reference the same Plan. After one approves it, openAttachedReviewRound can reconcile the other to plan_ready (1138–1142). Once the first starts execution, startExecution accepts the active registry entry as recoveredAttempt (930–940), reuses it, and issues another action ID (977–997). execution-start.ts:477–591 reuses the worktree without an Attached owner check. record-store.ts locks each workflow separately. Both workers can then edit the same execution directory under distinct valid handoffs.

### 4. Completion recovery returns a validation action that Core rejects

Source: Integration review

Requirement: After process loss, fresh-process continuation must reconcile completed internal effects and return a usable next action.

Evidence: If finalizePlanImplementation completes but the Attached record write is lost, the saved record remains implementing. coordinator.ts:388–398 projects it as implemented. readStatus:1640–1663 normally returns that projection without saving it because an approved review has no pending chat. The response instructs the host to call start_validation, but runValidationOperation:1939–1952 reloads implementing and rejects it as action_superseded. Repeated status and validation calls cannot continue. The existing completion-retry test retries task_completed directly and does not cover this fresh-process status path.
