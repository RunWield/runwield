---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths: []
executionAgent: "engineer"
createdAt: "2026-10-24T16:45:50.909Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 10
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "e2a486a0-11a6-4284-adbe-b0272f860ce8"
---

# Repair integration findings

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at `9c743f7dda5017cdb9dfd407d92327113af8fd26` and found the problems below.
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
ci lint failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-lint-failure-411fe701-ddb4-4982-92f5-64a441af6d7b.log
ci workspace:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-check-failure-a36b3801-a522-4985-b9ce-8d014d9e2854.log
ci check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-check-failure-b57355e7-5a9a-4e10-9550-584b0d52ddef.log
ci workspace:build failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-build-failure-9260b5bc-186e-4522-b4a6-580a7f35f227.log
ci docs:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-docs-check-failure-18a2a678-ee39-42f0-93ff-d91ad20cd98d.log
ci submodules:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-submodules-check-failure-7ba92baf-9096-4d5b-aef1-155084f7d677.log
CI failed tasks:
- submodules:check: exit 1
- check: exit 1
- workspace:check: exit 1
- lint: exit 1
- docs:check: exit 1
- workspace:build: exit 1
error: script "ci" exited with code 1
```

### 2. The Preview has no deterministic Planning Gate

Source: Integration review

Requirement: Planning must deny implementation edits and mutating commands before approval, with working-tree inspection as defense in depth. Prompt-only enforcement is not accepted.

Evidence: src/attached/claude/plugin/commands/request.md explicitly permits normal tools and states that no hooks or restrictions exist. src/shared/attached/compatibility.ts lists the same limitation. The coordinator advances from activation through plan_written without capturing or checking a planning baseline. Thus implementation edits in the invoking checkout can occur during planning without rejection.

### 3. Compatibility preflight accepts unknown and untested host versions

Source: Integration review

Requirement: Preview preflight must use the frozen compatibility matrix and stop before relying on unsupported host capabilities.

Evidence: src/shared/attached/compatibility.ts:96–116 returns version_not_reported or untested_newer with instructions to continue. src/shared/attached/coordinator.ts runAttachedOperation rejects only incompatible_adapter and unsupported_host_version. An unreported version can therefore bypass even the minimum-version check and proceed through execution.

### 4. Two Attached workflows can receive implementation actions for the same worktree

Source: Integration review

Requirement: One Plan must have one consequential owner. Concurrent host conversations must not both advance the same work.

Evidence: src/shared/attached/coordinator.ts planWritten stores a Plan reference without a unique ownership claim. Two workflows can submit the same draft. After one approves, reconciliation can put both in plan_ready. startExecution:891–900 treats any matching active registry entry as a recovered attempt, then issues a new action at :946–966. src/shared/workflow/execution-start.ts reuses that entry without an Attached owner check. Both workflows can remain implementing with different action IDs and the same execution directory.

### 5. Approve for Later immediately requests execution

Source: Integration review

Requirement: The Preview must preserve existing Plan review and lifecycle semantics, including the user's decision to defer execution.

Evidence: The shared PlanReviewSurface exposes Approve for Later. src/shared/attached/coordinator.ts:1204–1250 records readiness and sets plan_ready for every approved decision, including approvalAction: later. nextActionFor then directs immediate start_execution, as does plugin/commands/request.md. The deferred approval is therefore converted into execution.

### 6. Process loss between approval and readiness leaves the workflow unable to continue

Source: Integration review

Requirement: Fresh-process recovery must reconcile internal effects and continue without blind replay or unnecessary user intervention.

Evidence: src/shared/attached/coordinator.ts applies approval through applySharedPlanReviewDecision, then separately writes readiness_passed at :1204–1212. If the process stops between these writes, reconcilePlanPosition maps canonical approved to plan_ready (:366–368), and review reopening is refused. But startExecution rejects approved at :909–910 because it requires ready_for_work. Status repeatedly directs the host to an operation that cannot succeed.

### 7. A stale Attached review can overwrite a concurrent Core lifecycle advance

Source: Integration review

Requirement: Review decisions must check current canonical Plan state, and concurrent owners must reject stale work.

Evidence: src/shared/attached/coordinator.ts applyAttachedReviewDecision checks reconcilePlanPosition before calling the shared decision authority, but does not pass the saved controller revision or a lifecycle-state precondition. In src/shared/workflow/plan-review-actions.ts:259–281, the locked decision compares document meaning, excludes runtime fields, and can apply review_reopened. If Core advances after the coordinator check, stale Attached feedback or approval can reopen and replace that newer lifecycle state.

### 8. Publication conflicts cannot request a Claude-owned repair worker

Source: Integration review

Requirement: Attached delivery must preserve shared publication recovery and host-owned repair turns.

Evidence: src/shared/workflow/validation-publication.ts:445–453 calls dispatchMergeRepair for a repairable conflict. src/shared/workflow/validation-merge-repair.ts:258 calls session.runIndependentRepairTurn without a host-turn branch. The new src/shared/workflow/validation-host-turn.ts binds that method to an exception. The conflict becomes an operational failure instead of a durable host repair request; retries cannot dispatch the required worker.

### 9. The CLI cannot retrieve the action content exposed by MCP

Source: Integration review

Requirement: The CLI must remain the canonical boundary, with every MCP operation reachable through wld attached.

Evidence: src/attached/claude/mcp.ts adds get_instructions, get_artifact, and get_pending_chat directly through readAttachedAction. They are absent from ATTACHED_OPERATIONS, and src/cmd/attached/index.ts rejects commands outside that list. The CLI also uses compactStatus/compactResult; src/shared/attached/presentation.ts removes validation prompts, decision details, and worker instructions. A CLI caller can receive instructionsAvailable or requestAvailable but cannot fetch that content to continue.

### 10. No-home activation creates repository state before the setup preview

Source: Integration review

Requirement: Lazy onboarding must preview material repository-local changes and protect internal workflow records from publication.

Evidence: src/shared/attached/record-store.ts:115–125 falls back to .wld/internal/attached, and transactAttachedWorkflowRecord creates it during activation (:335). The saved record includes the explicit request. The setup preview runs only after Triage; coordinator.ts projectSetupFor omits the internal directory because it already exists. Ignore setup waits until submitPlanDocument calls enterProjectRuntime. Stopping before Plan submission leaves undisclosed, unignored request records in an otherwise uninitialized repository.
