---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/"
    - "src/ui/review/review-launcher.ts"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/"
    - "src/shared/workflow/plan-review-actions.ts"
    - "src/shared/workflow/plan-lifecycle.js"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/014-attached-workflow-coordination-boundary.md"
executionAgent: "engineer"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review"
devServerHmr: true
createdAt: "2026-10-07T03:22:46.617Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 3
dependencies:
    - "02-plan-one-feature-request-inside-claude-code"
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "1ca7097b-65e1-4fff-a878-937c19a6c103"
---

# Review and approve Plans through durable Plannotator decisions

## Context

Child 2 can submit a canonical FEATURE Plan from Claude. Review currently exposes process-local decision promises; an
Attached Workflow must survive loss of the command, MCP server, or browser review process.

This child implements
[Connect shared Plan outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes) and its
planning/review recovery scenarios. [Core Plan review](../../prd/runwield-core-prd.md#plan-review) and
[Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle) retain approval and readiness authority. Existing TUI,
Workspace, and ACP review behavior must remain intact.

## Objective

The user can give Feedback, receive a Claude-owned revision, resubmit, approve the actual reviewed semantic revision,
and pass canonical readiness. A fresh process can restore pending review or retrieve an accepted decision without
inventing approval or repeating transitions.

## Approach

Reuse Plannotator and shared Plan review actions. Make pending identity, waiting reason, reviewed revision, and accepted
decision durable before reporting success to the browser. Preserve the existing promise interface for Core Session
consumers where needed; it must no longer be the sole authority for Attached review.

The Claude-owned MCP server starts and stops its review resources. It may stay alive across calls, but no independent
daemon survives Claude shutdown. Formatting-only normalization preserves approval under shared comparison rules;
meaningful changes reject stale decisions. No review redesign is planned.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/review/review-launcher.ts` and `src/ui/workspace/` review routes/handlers — durable decision acknowledgment
  and resumable review identity.
- `src/shared/workflow/plan-review-actions.ts`, Plan Lifecycle, and Plan Store — canonical Feedback, approval, semantic
  revision, and readiness.
- `src/shared/attached/` and thin CLI/MCP carriers — polling, pending review restoration, and owned resource lifetime.
- Connect/Core PRDs and ADR-014 — delivered review/recovery behavior and host-owned review lifetime.

## Reuse Opportunities

- `applySharedPlanReviewDecision` and `reviewSourceStillMatches` — canonical actions and reviewed-content protection.
- `startPlanReviewSurface` and Workspace review endpoints — existing Plannotator UI.
- Child 1 action identity, expected revisions, and accepted-result handling — durable callback acceptance.

## Implementation Steps

1. A review request persists its identity, actual reviewed Plan revision, and waiting reason before opening a browser.
   Feedback and approval become canonical structured decisions before browser success acknowledgment.
2. Feedback returns to a durable Claude Planner action; resubmission creates the appropriate current review round.
   Canonical approval and readiness services reject stale or unsupported lifecycle positions and preserve
   formatting-only normalization semantics.
3. A fresh process retrieves accepted decisions or restores pending review. Browser/CLI/server loss, repeated callbacks,
   and delayed approval cannot lose Feedback or approve superseded meaningful content.
4. The MCP server owns review endpoints across tool calls and closes them when Claude exits. Explicit reactivation can
   reopen pending review on another port while durable state remains unchanged. No shutdown implies abandonment.
5. Existing Session consumers retain their interaction outcomes and review experience. The review mechanism can support
   candidate-bound code review later without claiming that publication review is delivered here.
6. Connect and Core capability scenarios and ADR process-lifetime statements match delivered behavior; remaining
   execution/validation/publication outcomes stay targets.

## Verification Plan

- Automated: run
  `deno run -A scripts/run-tests.js src/shared/attached/ src/ui/review/review-launcher.test.ts src/ui/workspace/plan-review-decision-route.test.ts src/shared/workflow/plan-review-actions.test.ts src/shared/workflow/plan-review-recovery.test.ts`.
- Automated: terminate the review-owning process before a decision, after accepted Feedback, and after approval
  persistence but before reply. Resume fresh; test duplicate callbacks, changed semantic content, formatting-only
  normalization, readiness denial, and port conflict.
- Headed browser: use the real Attached review URL at `/review/plan?token=...` to submit Feedback, see resubmission,
  approve, stop Claude, and explicitly restore pending review. Confirm the old endpoint closes and no decision is
  fabricated.
- UI baseline: `deno task workspace:dev` serves `http://127.0.0.1:5173/dev/plan-review` with HMR. This fixture is not
  proof of durable Attached behavior; verify the production review flow too. Use `docs/design-system.md` and existing
  shared tokens/primitives if visible changes are necessary.
- Expected: browser success means durable acceptance, approval applies to reviewed content, and existing Core Session
  review behavior remains protected. In-memory-only Attached decisions must stop being an accepted implementation.
- Verify owning PRD scenarios and affected references match the tested behavior without implying code-review/publication
  completion.

## Edge Cases & Considerations

- Closed browser tabs are not user abandonment. Persist pending review and restore it after explicit activation.
- Identity and revision checks protect against two browsers or host conversations racing the same review.
- The primary change is review durability, not browser design. If substantial visual/interactive scope emerges, Planner
  should assign that work to Frontend Engineer with headed verification.
- Endpoint tokens and saved review references must not expose raw host conversation data.
