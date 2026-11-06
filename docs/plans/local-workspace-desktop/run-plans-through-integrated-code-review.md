---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
  - "src/acp/"
  - "src/shared/workflow/"
  - "src/shared/session/"
  - "src/ui/workspace/server/session-continuation.js"
  - "src/ui/workspace/server/owner-plan-progress.ts"
  - "src/ui/workspace/react/CodeReviewSurface.tsx"
  - "src/ui/workspace/react/WorkflowSidebar.tsx"
  - "src/ui/review/"
  - "src/ui/desktop/"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:35.654Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 6
dependencies:
  - "keep-work-safe-across-window-and-process-changes"
  - "review-and-edit-plans-inside-desktop"
targetBranch: "epic/local-workspace-desktop"
planId: "c45c2b1f-0d12-4f10-801b-71eee90feaa3"
---

# Run Plans Through Integrated Code Review

## Context

Plan editing and approval are available in desktop, but the complete planned-work journey also needs execution, progress, interventions, review, and publication/recovery. These must stay Core-owned rather than becoming renderer actions.

Owning requirements are [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace), [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access), and [execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery).

## Objective

A user starts or resumes a Plan workflow, follows progress and required decisions, reviews changes inside desktop, and reaches Core-confirmed publication or deliberate abandonment. Interruptions remain recoverable intermediate states.

## Approach

Expose existing workflow orchestration and structured Code Review through the negotiated client. Core retains lifecycle transitions, execution-directory ownership, review conflict checks, validation, receipts, and publication evidence.

The desktop is another presentation surface for those decisions. A new desktop workflow engine or hosted review-page embedding would duplicate authority and is excluded.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/acp/`, `src/shared/workflow/`, `src/shared/session/` — negotiated workflow and review operations with canonical authority.
- `src/ui/workspace/server/session-continuation.js`, `owner-plan-progress.ts`, relevant continuation routes — reusable orchestration extraction.
- `react/CodeReviewSurface.tsx`, `WorkflowSidebar.tsx`, shared review/resource modules, and desktop navigation — integrated workflow UI.
- `src/ui/review/` and existing standalone handlers — compatibility preserved, not retired.
- Core/Workspace/ACP scenarios and contract inventory — delivered workflow evidence.

## Reuse Opportunities

- Existing start/resume/handoff behavior and Core controller/Plan action owners.
- Code Review diffs, guided review, review conversations, manual AI review jobs, cancellation, and destination-specific actions.
- Core publication/recovery fixtures and real Git repositories.

## Implementation Steps

1. Start, resume, workflow handoff, progress/actions, interventions, cancellation, and relevant Pair checkpoints operate through ACP with explicit Project/Session/Plan identities.
2. Code Review payloads include current resource identity and decision version. Desktop renders diffs, safe file/image resources, review conversation, guided review, AI review jobs, and supported destination actions directly, without browser-page launches or embedding.
3. Authoritative handlers enforce admission, revision/generation, durable receipts, request identity, writer exclusion, review checkout identity, and bounded resource transfers. Duplicate and stale decisions cannot repeat workflow/publication effects.
4. The complete desktop journey continues through validation and recovery to confirmed publication or deliberate abandonment. Failed attempts, retry limits, or lost presentation do not become terminal success/failure substitutes.
5. TUI, Connect, and external ACP clients retain their standalone Plan/Code Review and artifact paths. Desktop-specific negotiation does not force Electron on those clients.
6. The workflow contract rows, owning PRD requirements/scenarios, and affected references match delivered behavior, including completion meaning and unchanged external-client paths.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.js src/ui/workspace/workspace-code-review.integration.test.ts src/ui/workspace/plan-workflow-review.integration.test.ts src/ui/workspace/plan-workflow-gates.integration.test.ts src/ui/workspace/plan-workflow-resume.integration.test.ts src/ui/workspace/standalone-ai-review.test.ts` and `bun run seams:check`.
- Planner names new real-process workflow/review tests using real Git/Plan fixtures. Assert stale review/resource identity, wrong Project, duplicate requests, generation changes, cancellation settlement, publication interruption, and restart without repeated decisions/effects.
- Headed verification uses desktop approved Plan -> explicit Run -> progress -> Code Review -> accepted decision -> publication evidence. Also exercise approval-for-later, feedback, resume, guided review, and AI review cancellation. Discover and record the desktop dev command and URL/origin.
- Confirm long diffs remain bounded and keyboard/screen-reader operation works. No standalone browser window/page supplies desktop review.
- Preserve standalone Code Review behaviors and checks without Electron. Verify actual canonical publication/recovery evidence, not only progress labels or an accepted review response.

## Edge Cases & Considerations

- Host loss during a decision can leave an uncertain receipt; recover from Core evidence without replay.
- Core must repair its own bookkeeping. No Agent/renderer edits protected Plan lifecycle or registry state.
- External publication credentials can be genuine prerequisites; missing credentials cannot justify a false completion claim.
- This completes the planned-work journey, not all workbench parity or platform release gates.