---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths: []
executionAgent: "engineer"
createdAt: "2026-10-25T01:49:30.675Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 12
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "0a23b8e6-c2f3-4304-90b4-4246818948a8"
---

# Repair integration findings 3

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at `2c6765e026328e54e7781b9986907f09c439a10f` and found the problems below.
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
ci workspace:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-check-failure-16cf8f9e-608d-4605-8802-b2cf5e664472.log
ci lint failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-lint-failure-337a3ed0-1d04-4506-b287-f3493d13d17a.log
ci check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-check-failure-6b957276-c618-4a52-bc45-aaf14c1e82df.log
ci workspace:build failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-build-failure-81cb3567-a092-42f1-bfa3-aad020064363.log
ci docs:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-docs-check-failure-441515a8-6b18-4c81-8031-350f474f8240.log
ci submodules:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-submodules-check-failure-c323cae7-fa82-49b8-87e0-b1fa69d88ca3.log
CI failed tasks:
- submodules:check: exit 1
- check: exit 1
- workspace:check: exit 1
- lint: exit 1
- docs:check: exit 1
- workspace:build: exit 1
error: script "ci" exited with code 1
```

### 2. The required Planning Gate is not implemented

Source: Integration review

Requirement: Planning must deny implementation edits and mutating commands through deterministic host controls, with baseline inspection as defense in depth.

Evidence: src/attached/claude/plugin/commands/request.md explicitly permits normal tools and states that RunWield adds no hooks or restrictions. The installed plugin has no hook configuration. src/shared/attached/compatibility.ts lists instruction-only boundaries as supported limits. The coordinator's activation and Plan submission paths do not capture or inspect a planning baseline. Thus a planning turn can modify implementation files before approval without denial or detection.

### 3. Changed code can reach publication without repeat CI or Semantic Review

Source: Integration review

Requirement: Verified must apply to the candidate that passed Mechanical Validation, configured CI, and independent Semantic Review.

Evidence: After code changes during the human-review wait, validation-interactions.ts rejects the old decision identity but does not invalidate completed validation. coordinator.ts clears the rejected resume; start_validation then opens a new human review while the Plan remains reviewed. validation-semantic.ts:531–538 routes that status directly to human review and publication. validation-publication.ts:637–666 seals the current files as the validated candidate. publication-revalidation.ts:133–138 cannot reset this case because no publication attempt exists yet. delivery.test.ts:182–203 confirms that changed code returns directly to code_review. Approving that refreshed review can therefore publish code that never passed CI or Semantic Review.

### 4. Two Attached workflows can receive implementation authority for the same worktree

Source: Integration review

Requirement: One workflow must have one consequential owner; two host sessions must not advance the same Plan concurrently.

Evidence: coordinator.ts:717–820 lets workflow B submit the same ready Plan already held by workflow A. openAttachedReviewRound and reconcilePlanPosition persist B as plan_ready from the canonical approval. After A starts implementation, B's plan_ready state survives the in_progress reconciliation. startExecution at lines 938–1018 treats any matching active registry entry as a recovered attempt and issues B a new implementation action. execution-start.ts:478–489 and 563–570 reuse that worktree without checking Attached ownership. A and B can now dispatch workers into the same directory. Per-workflow CAS and short-lived Plan locks do not prevent these concurrent worker turns.

### 5. Plan-page polling can deadlock the transition to code review

Source: Integration review

Requirement: The assembled review journey must continue from Plan review to code review, and closing Claude must stop its review resources.

Evidence: In review-host.ts:113–126, a Plan conversation refresh awaits ensureReviewHosted when it sees the new code-review action. ensureCodeReviewHosted then awaits the old Plan surface's stop at line 289. This refresh runs inside the old server's GET /api/review/conversation handler (server.js:650–654). Its stop awaits graceful server shutdown (server.js:1575–1584; http-server.ts shutdown uses stop(false)), which waits for that same GET to finish. If the Plan page remains open and polls during the transition, hosting cannot finish. stopHostedAttachedReviews also waits for this opening promise, so MCP shutdown can hang.

### 6. The Plan approval button starts execution while saying execution is deferred

Source: Integration review

Requirement: Structured approval and consequential execution choices must retain their intended meaning across the browser and host adapter.

Evidence: PlanReviewSurface.tsx:371–382 changes Attached review labels to 'Approve & Ready' and says execution is a later Preview step. The split button still submits the primary 'run' action. coordinator.ts:203–216 and plugin/commands/request.md:25–28 interpret that receipt as permission to start execution immediately, without another confirmation. The browser therefore presents a ready-only action but authorizes implementation.

### 7. Compatibility preflight accepts non-Claude hosts as tested Claude Code

Source: Integration review

Requirement: The Preview must make honest host-specific compatibility claims and reject unsupported capabilities before use.

Evidence: src/shared/attached/compatibility.ts:83–123 never checks evidence.host. operations.ts accepts any host identifier, and mcp.ts:119–128 supplies the client's reported name. Evidence such as host='codex', hostVersion='2.1.303', adapterContract=1 receives status='compatible' and a tested-Claude claim. runAttachedOperation then permits activation. The Claude version entry cannot establish compatibility for another host.

### 8. Claude workers do not receive the effective RunWield Skills

Source: Integration review

Requirement: Claude assets must project canonical layered roles and Skills, including project and user overrides.

Evidence: role-instructions.ts:87–100 returns agent.rolePrompt and transport instructions only. It does not load the canonical Skill catalog or provide selected Skill paths. Core Sessions provide that catalog through listSkills and {{SKILLS}} expansion in session.js:1705–1736, but Attached does not use that path. The marketplace installs src/attached/claude/plugin, which contains no Skills, and its MCP operations expose no Skill discovery. Thus bundled Skills and .wld/skills or home Skill overrides are not supplied to workers, even though the canonical Engineer prompt requires them.
