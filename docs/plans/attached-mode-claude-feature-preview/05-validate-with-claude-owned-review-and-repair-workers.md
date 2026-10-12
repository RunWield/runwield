## diffstat only, patch not produced. Full patch: git show -p <rev>

## planId: "31b97384-eb6c-4c98-8c54-578755ab80da" classification: "PLANNED_CHANGE" workKind: "FEATURE" complexity: "MEDIUM" affectedPaths: - "src/shared/attached/" - "src/cmd/attached/" - "src/attached/claude/" - "src/shared/attached/role-instructions.ts" - "src/attached/claude/plugin/commands/" - "docs/prd/runwield-connect-prd.md" - "docs/plans/attached-mode-claude-feature-preview/manual-qa.md" executionAgent: "engineer" collaborationRecommendation: "autonomous" createdAt: "2026-10-07T03:22:47.915Z" origin: "internal" parentPlan: "attached-mode-claude-feature-preview" order: 6 dependencies: - "05a-run-workflow-validation-without-a-core-session" targetBranch: "epic/attached-mode-claude-feature-preview" userVerifiedAt: null status: "in_progress"

# Validate with Claude-owned review and repair workers

## Context

Child 04 leaves an Attached Workflow at `implemented`. Child 05a supplies a Session-free validation entry point
(`continueHostTurnValidation` or its final name). It runs the shared supervisor and engine and returns typed reviewer,
repair, and decision requests. A fresh process resumes it from the Validation Checkpoint and an accepted outcome, and it
stops at `reviewed` with `awaiting_delivery`. This child connects that entry point to Claude. It covers the Attached
record, coordinator operations, the MCP `review_diff` operation, the plugin commands, and the Connect documentation. It
owns no validation policy. Owning capabilities:

- [Connect: Shared Plan and verification outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes)
  — validation continuation becomes delivered for the Preview subset. Code review and publication remain targets.
- [Connect: Host-owned reasoning](../../prd/runwield-connect-prd.md#host-owned-reasoning) — independent reviewer and
  repair workers are fresh Claude subagents.
- [Connect: Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery) — host
  or Core loss during validation.
- Core [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) and
  [Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair) stay authoritative and
  unchanged. Decisions already made (child 05/05a planning session):

1. **The reviewer worker calls RunWield MCP `review_diff` directly.** Core records each read against the pending ...
   more lines (truncated by snip)
