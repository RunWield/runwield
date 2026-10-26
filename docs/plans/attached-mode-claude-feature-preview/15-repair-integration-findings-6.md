---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
  []
executionAgent: "engineer"
createdAt: "2026-10-26T20:36:00.308Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 15
dependencies:
  []
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "f1562dd5-70d7-4561-8679-abafc1631e12"
---

# Repair integration findings 6

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at `6e35106ef0dddca5856a81e7ef693ea02c73baec` and found the problems below.
The full report is `docs/plans/attached-mode-claude-feature-preview/integration-report.md`. This draft was created by RunWield; plan the repair from these
findings and the Epic. After this child is delivered, the integration gate runs again on the whole Epic.

## Objective

Resolve every finding below on the Epic branch.

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
