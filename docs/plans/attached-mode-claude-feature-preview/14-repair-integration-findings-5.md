---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
  []
executionAgent: "engineer"
createdAt: "2026-10-26T02:00:35.947Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 14
dependencies:
  []
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "2b9da5c4-bec5-4649-b854-470b5b3bb573"
---

# Repair integration findings 5

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at `c941d2e52e5cf262d80932448f36eda8bc1b1700` and found the problems below.
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
ci lint failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-lint-failure-2e8a26bb-e878-4785-aad8-479e19f2d80f.log
ci workspace:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-check-failure-12b85c01-9af9-4e6f-9460-7bbff6fe58a7.log
ci check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-check-failure-fe95e980-54bc-47c1-92f7-2a602c2648aa.log
ci workspace:build failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-build-failure-0317f074-2671-4473-83b5-4fbae484c591.log
ci submodules:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-submodules-check-failure-f540155e-16d5-4a32-a57e-c40dbdc0dbc4.log
ci docs:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-docs-check-failure-d1cbb626-b9d4-4629-aacd-f77d2c8c7324.log
CI failed tasks:
- submodules:check: exit 1
- check: exit 1
- workspace:check: exit 1
- lint: exit 1
- docs:check: exit 1
- workspace:build: exit 1
error: script "ci" exited with code 1
```

### 2. The installed plugin does not enforce the Planning Gate.

Source: Integration review

Requirement: Planning must block implementation edits and mutating commands through deterministic Claude controls, with Git inspection as defense in depth.

Evidence: src/attached/claude/plugin/commands/request.md explicitly permits normal tool use and states that RunWield adds no hooks or tool restrictions. The installed plugin has no hooks. src/shared/attached/coordinator.ts checks readiness only when start_execution is called; it cannot block Claude edits or shell mutations during planning. Compatibility disclosure does not replace the required gate.

### 3. The required generated Claude Skills and subagents are absent.

Source: Integration review

Requirement: Claude assets must be generated from effective layered Core assets, carry version stamps, and have stale-materialization preflight.

Evidence: src/attached/claude/plugin contains commands and MCP configuration, but no generated Skills or subagents. src/shared/attached/role-instructions.ts instead returns prompt text on each request and explicitly saves or copies nothing into the host. Layered prompt resolution exists, but asset generation, version stamps, and stale-asset rejection do not.

### 4. Compatibility preflight permits untested or unknown host versions.

Source: Integration review

Requirement: Preview preflight must use the tested capability matrix and refuse work before relying on unsupported host capabilities.

Evidence: src/shared/attached/compatibility.ts returns version_not_reported or untested_newer with 'continuing'. isBlockingCompatibility excludes both results. src/shared/attached/coordinator.ts:1781–1791 therefore permits activation and consequential operations without a tested capability entry for that host version.

### 5. Two Attached workflows can issue implementation workers for the same active worktree.

Source: Integration review

Requirement: One Plan must have one consequential owner; concurrent host conversations must not both advance its work.

Evidence: src/shared/attached/coordinator.ts:937–947 treats an active registry entry with matching Plan ID and path as recovered preparation without checking which workflow started it. start_execution then calls startActiveExecutionWorkflow and issues a new action at lines 975–1008. src/shared/workflow/execution-start.ts reuses the active attempt. Locks in record-store.ts are per workflow ID, so two records already bound to the same ready Plan can each issue a worker for the same checkout.

### 6. Process loss can discard an Approve & Run decision.

Source: Integration review

Requirement: Structured review decisions must survive process loss, and internal recovery must continue without asking the user to repeat an accepted choice.

Evidence: src/shared/attached/coordinator.ts:1241–1307 commits canonical approval and readiness before saving the Attached outcome and approvalControllerRevision. If the process stops between these writes, reconcilePlanPosition projects plan_ready, but nextActionFor returns plan_saved because the run decision is missing. The plugin then stops and requires /runwield:implement. review-write-recovery.test.ts recreates this gap and confirms that the recovered outcome is undefined.

### 7. A nonempty diff can pass Semantic Review without any inspected bytes.

Source: Integration review

Requirement: Structured review-pass claims must not bypass required diff inspection or verification guards.

Evidence: With diff.noprefix=true, git-snapshot.ts emits nonempty diff headers without a/ and b/ prefixes. review-diff.ts:95–106 parses these as zero files. The new host-resume branch in validation-semantic.ts:669–709 accepts empty coverage and sets usedDiffTool=true when the parsed file list is empty. Thus a matching review_complete approval can pass without a review_diff(show) receipt, although implementation changes exist.

### 8. A successful start_validation response can have no replay receipt.

Source: Integration review

Requirement: Repeated operation submission must return the recorded result, including after a fresh-process continuation.

Evidence: src/shared/attached/coordinator.ts:1937–1952 returns success directly when start_validation finds a fresh pending request. It does not call accept or save the operation ID. After a later operation advances the workflow revision, retrying that successful operation reaches revision_conflict at lines 1914–1921 instead of returning its original result.

### 9. Publication recovery can change a rejected Recorder submission into success.

Source: Integration review

Requirement: Recovery must preserve accepted outcomes and must not report a failed check as successful.

Evidence: src/shared/attached/coordinator.ts:2163–2176 normally records invalid_outcome when Recorder submission fails, even if publication completes. If publication finishes but the final Attached write is lost, readStatus at lines 1589–1604 reconstructs the original operation receipt through accept without checking the saved Recorder resume or failure. A second invalid Recorder submission can therefore replay as ok:true after a crash.
