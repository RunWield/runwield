---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/acp/"
    - "src/shared/workflow/"
    - "src/ui/workspace/server/owner-plan-actions.ts"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/components/"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/desktop/"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:35.102Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 5
dependencies:
    - "open-projects-and-configure-providers"
    - "continue-saved-sessions-in-desktop"
targetBranch: "epic/local-workspace-desktop"
planId: "1322aa43-f8de-48cd-8021-141862cf313f"
---

# Review and Edit Plans Inside Desktop

## Context

Desktop must carry the existing Plan-centered workbench, not just Session chat. `runOwnerPlanAction` currently combines Project checks, receipts, generation checks, writer admission, and Core actions behind HTTP.

This child implements Plan navigation/edit/review under [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace) and [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access). Core lifecycle and storage owners remain authoritative. Execution and Code Review arrive in the following child.

## Objective

Users navigate Plan and Epic boards, edit Plan content, review the current version inside desktop, and approve for later without starting execution. Stale or mis-scoped decisions are refused by Core.

## Approach

Extract shared board/review composition and give it structured runtime payloads and versioned decisions. Reuse existing Core Plan actions and review rules behind ACP rather than reproducing HTTP handlers in desktop.

Desktop renders the review directly. Launching or embedding the standalone review page would preserve the wrong host coupling; external clients must still retain that page independently.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/acp/`, existing Plan-store and `src/shared/workflow/` owners — scoped Plan reads, revision-checked edits and review decisions.
- `src/ui/workspace/server/owner-plan-actions.ts`, Plan adapters, and relevant `session-continuation.js` behavior — move reusable authority out of UI server code.
- `src/ui/workspace/components/Board.tsx`, `PlanDetail.jsx`, Epic/Plan cards, and `react/PlanReviewSurface.tsx` — shared composition and navigation.
- `src/ui/desktop/` and shared client — integrated Plan destinations and resources.
- Workspace/ACP/Core applicable scenarios, contract inventory, and ADR references — same-change synchronization.

## Reuse Opportunities

- `executePlanAction` and canonical Plan-store revision/write APIs.
- Existing receipts/admission semantics in `runOwnerPlanAction`, moved to the authoritative shared owner.
- Shared review/editor, annotations, saved conversations, version display, and design-system primitives.

## Implementation Steps

1. Plan/Epic boards and details read current canonical state through ACP, preserving relationships, status, filtering, and Plan-associated Sessions without assuming Plans live in a checkout directory.
2. Shared body editing and integrated Plan review carry resource identity, actual reviewed revision, and versioned decisions. Edits, feedback, saved conversation, and relevant review preferences retain existing semantics.
3. Runtime services retain Project admission, request hash/identity, durable receipts, expected revision/generation, and single-writer rules. A duplicate completed request returns its recorded outcome; uncertain requests cannot repeat effects.
4. Approval for later leaves execution stopped. A stale, wrong-Project, replaced, or ineligible review is refused by Core and refreshes the desktop honestly rather than granting approval locally.
5. Desktop review uses structured payloads through its client, without launching or embedding the standalone host. Existing standalone Plan review for TUI, Connect, and ACP clients continues working.
6. Relevant contract rows and owning PRD requirements/scenarios reflect delivered Plan behavior; execution and Code Review remain target scope until their child lands.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.js src/ui/workspace/owner-plan-actions.test.ts src/ui/workspace/workspace-plan-review.integration.test.ts src/ui/workspace/workspace-plan-review-ux.test.tsx src/ui/workspace/plan-review-cross-surface.integration.test.ts` and `bun run seams:check`.
- Planner names new real-process Plan read/save/review checks. Assert duplicate request, reused request ID with different input, stale generation/revision, wrong Project, competing writer, and approval-for-later behavior against real stores/locks.
- Headed verification uses desktop Plan/Epic board -> detail -> edit -> review -> approve for later. Discover and record the normal desktop dev command and renderer URL/origin. Exercise annotations, saved conversation, version changes, keyboard access, and a large Plan.
- Assert no standalone browser page opens for desktop review. Separately verify standalone Plan review remains functional without Electron; changing imports/transport must not delete its behavioral coverage.
- Verify PRD/ADR links and current-versus-target wording match evidence.

## Edge Cases & Considerations

- The external Plan-store Epic is a separate owner. Consume its current services; do not recreate checkout copies or expand its scope here.
- Ordinary Plan body saves must not reset protected lifecycle/controller state.
- Retained browser review and desktop share rules/components, not a loopback URL dependency.
- A Plan disappearing or changing during review must remain a visible conflict, not an implicit retry.
