---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths: []
executionAgent: "engineer"
createdAt: "2026-10-24T23:33:01.175Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 11
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "08032c37-cfaf-4b45-baa9-0711248f9423"
---

# Repair integration findings 2

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at `001e8d985b39ecef20edacbd03adbbbfc9b1686f` and found the problems below.
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
ci lint failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-lint-failure-e11b8b6b-3858-46ce-919f-d08a6eccfa46.log
ci workspace:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-check-failure-310fa153-caf1-42c5-9ec5-cd49ab3f0a3a.log
ci check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-check-failure-8652155f-be08-48c3-8ee1-f0b5b49cb03e.log
ci workspace:build failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-build-failure-7c3c52c2-95ec-4b8b-9b9f-0ec62b621259.log
ci submodules:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-submodules-check-failure-61b7c986-44ab-4579-91db-5ab20936995a.log
ci docs:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-docs-check-failure-06306e14-7bb3-4964-b75c-884b0b74f1b3.log
CI failed tasks:
- submodules:check: exit 1
- check: exit 1
- workspace:check: exit 1
- lint: exit 1
- docs:check: exit 1
- workspace:build: exit 1
error: script "ci" exited with code 1
```

### 2. Planning has no deterministic mutation gate

Source: Integration review

Requirement: The Epic requires deterministic pre-tool controls that block implementation edits during planning, with baseline inspection as defense in depth. Prompt-only enforcement is explicitly excluded.

Evidence: src/attached/claude/plugin/commands/request.md:68 explicitly permits normal tools without hooks or restrictions. The plugin contains no hook configuration. src/shared/attached/coordinator.ts activate() records no planning baseline, and startExecution() only guards the Core handoff. Claude can therefore edit implementation files or run mutating commands in the invoking checkout before approval. Disclosing this limit in compatibility.ts does not deliver the required gate.

### 3. Two Attached workflows can receive implementation actions for the same worktree

Source: Integration review

Requirement: One Plan must have one consequential owner. Concurrent host turns must not receive conflicting execution authority.

Evidence: src/shared/attached/coordinator.ts planWritten() accepts the same Plan in separate workflow records. openAttachedReviewRound() can persist plan_ready for both after canonical approval. After the first workflow starts execution, startExecution() accepts the active attempt as recovered using only Plan ID, path, and registry status (lines 937–947). It does not check the owning workflow. Shared execution-start.ts reuses that attempt, and the coordinator issues another implementation action. record-store.ts locks each workflow separately, so both host workers can edit the same worktree.

### 4. Sending code-review Feedback queues chat instead of recording a decision

Source: Integration review

Requirement: Human code-review Feedback must be a durable structured outcome that enters the shared repair and validation flow.

Evidence: src/ui/workspace/react/CodeReviewSurface.tsx:724–728 redirects submitFeedback() to sendAgentMessage(true) when conversationEnabled is true. Attached review-host.ts always supplies a review conversation. sendAgentMessage() submits conversationTurn: true, so src/shared/attached/code-review-decision.ts:15–18 queues chat and returns without calling validation_decision. The Send Annotations action no longer records Feedback; repair depends on a later model interpretation of the chat.

### 5. Accepted Plan change requests are lost before revision completes

Source: Integration review

Requirement: Accepted outcomes and pending host actions must survive host or Core process loss without requiring the old Claude conversation.

Evidence: src/shared/attached/coordinator.ts:1479–1488 accepts review_reply.change, creates a Planner action, and deletes the review chat. It discards change.summary and saves only 'Revise the Plan as discussed in this Claude session'. If Claude stops before plan_written, fresh-process get_instructions returns neither the requested change nor a revised Plan. Preserve the structured change instruction until the revision is submitted; raw transcript retention is not required.

### 6. MCP shutdown leaves active Core operations running

Source: Integration review

Requirement: Closing Claude must stop its MCP server and owned work while preserving durable continuation.

Evidence: src/attached/claude/mcp.ts:198–213 handles stdin EOF by closing transport and review surfaces only. Active runAttachedOperation calls receive no cancellation signal, and their progress intervals remain live until the calls finish. The status wait loop also ignores closing. validation-host-turn.ts exposes no shutdown signal, while validation-mechanical.ts:213–227 launches CI without one. EOF during a long CI command therefore leaves Core and the command running after the host transport closes.

### 7. Retries of accepted review replies do not return their saved result

Source: Integration review

Requirement: The coordination contract requires repeated operationId submissions to return the recorded result without repeating effects.

Evidence: src/shared/attached/coordinator.ts reviewReply() checks expectedRevision at line 1421 before checking for an accepted receipt. At line 1440 it treats an existing acceptedOperations entry as action_superseded instead of replaying it. After a reply commits but its response is lost, retrying the same envelope returns revision_conflict; updating the revision still returns action_superseded. This differs from the other coordinator operations and breaks the documented retry contract.
