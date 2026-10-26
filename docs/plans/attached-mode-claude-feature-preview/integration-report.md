# Integration Gate Report: attached-mode-claude-feature-preview

RunWield checked the Epic branch `epic/attached-mode-claude-feature-preview` at `fc1ad7ea6f2e9617bc1dc521aa80fb4dd67d281d`, diffed from `7bef10a1ef4b075a5484c6d4a44c56cf2791fed0`.

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

## Findings

### 1. Project checks fail on the Epic branch

Source: Project checks

Exit code 1.

```text
$ bun scripts/check-bun-runtime.ts && bun scripts/run-ci.ts
ci workspace:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-check-failure-0bce5656-8498-485a-a2f3-51d0a4893441.log
ci lint failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-lint-failure-7f58f9a2-c4d9-4ff3-9eb1-16804331aa87.log
ci check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-check-failure-b6c3abce-7945-492d-9d04-192200af9c60.log
ci workspace:build failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-build-failure-aab804ff-11ea-4eb6-ab91-49099ab7d0e6.log
ci docs:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-docs-check-failure-499ea936-cfcf-43cc-ad66-6728bec0594f.log
ci submodules:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-submodules-check-failure-8de96de1-026c-4bc0-adca-659b62d444e2.log
CI failed tasks:
- submodules:check: exit 1
- check: exit 1
- workspace:check: exit 1
- lint: exit 1
- docs:check: exit 1
- workspace:build: exit 1
error: script "ci" exited with code 1
```

### 2. The promised deterministic Planning Gate is absent

Source: Integration review

Requirement: The supplied Epic requires pre-tool denial of implementation mutations during planning, with Git inspection as defense in depth. It explicitly excludes prompt-only enforcement.

Evidence: src/attached/claude/plugin/commands/request.md:70 and implement.md:35–36 explicitly permit normal tools without hooks or restrictions. src/shared/attached/compatibility.ts:68–69 declares instruction-only boundaries. The activation and Plan submission paths in coordinator.ts save no planning baseline and check no implementation mutations. Thus edits and mutating shell commands remain available before approval.

### 3. Two Attached workflows can receive ownership of the same implementation worktree

Source: Integration review

Requirement: One workflow must have one consequential owner. Concurrent host sessions must not obtain competing authority over the same Plan.

Evidence: coordinator.ts:717–834 permits two workflows to submit the same draft Plan. After workflow A approves it, openAttachedReviewRound at 1134–1138 can persist workflow B as plan_ready through reconciliation. Start A, then start B: lines 374–379 retain B's ready state for an in-progress Plan, and recoveredAttempt at 937–951 accepts the active worktree without checking its originating workflow. execution-start.ts:477–484 reuses that worktree. coordinator.ts:992–1009 then gives B another implementation action. Per-workflow CAS does not prevent both workers from editing the same files.

### 4. Planning recovery does not return the saved user request

Source: Integration review

Requirement: Pending host actions must support fresh-process continuation without importing the host transcript or asking the user to reconstruct durable internal state.

Evidence: coordinator.ts:638 saves request.text, but projectedViewOf at 462–478 omits it. presentation.ts:108–126 also removes triageOutcome from MCP responses. readAttachedAction at 1790–1885 returns generic role instructions and action context, neither of which contains the request. After host loss before the first Plan exists, a new conversation can restore the action ID but cannot recover what it must triage or plan through the operation surface.

### 5. Resumed implementation can start before compatibility preflight

Source: Integration review

Requirement: Compatibility preflight must reject an unsupported host or adapter before relying on its worker capabilities.

Evidence: plugin/commands/implement.md:12–24 restores an implementation action through status and dispatches a worker through get_instructions. mcp.ts:115–128 omits host evidence for both operations. coordinator.ts:1756–1785 bypasses compatibility assessment for reads and status. A below-floor Claude version or incompatible adapter can therefore receive instructions and edit the worktree; the first rejection occurs later at task_completed.

### 6. Recovery can discard a pending CI decision and rerun checks without an answer

Source: Integration review

Requirement: Host waits must survive Core exit. Recovery must preserve pending user decisions and must not repeat accepted effects blindly.

Evidence: After repair completion exhausts CI retries, validation-mechanical.ts saves pendingCiDecision and pendingHostDecision. If Core settles that completion but loses the final Attached write, coordinator.ts:2017–2018 calls reconcileConsumedHostResume. validation-host-turn.ts:215–216 drops the settled task_completed resume. This bypasses the pending-decision replay guard in validation-supervisor.ts:461–468. Mechanical validation then receives no decision resume and clears both pending decisions before running CI again at validation-mechanical.ts:201–218. Recovery must restore the saved wait instead of treating the absent answer as permission to retry.
