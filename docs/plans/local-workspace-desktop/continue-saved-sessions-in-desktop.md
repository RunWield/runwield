---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/acp/"
    - "src/shared/session/"
    - "src/shared/owner-coordination/"
    - "src/ui/workspace/server/session-continuation.ts"
    - "src/ui/workspace/islands/SessionSurface.tsx"
    - "src/ui/workspace/components/SessionTimeline.tsx"
    - "src/ui/desktop/"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:33.658Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 3
dependencies:
    - "open-projects-and-configure-providers"
targetBranch: "epic/local-workspace-desktop"
planId: "0bd5524a-7424-482c-ad59-a7dd0ec851b2"
---

# Continue Saved Sessions in Desktop

## Context

`WorkspaceSessionContinuationService` currently constructs `SessionRuntime` and owns live operations, retained Sessions, listeners, and background work. Moving rendering alone would preserve the wrong ownership boundary.

This child implements Session parity under [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access) and [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace). [Core Session continuity](../../prd/runwield-core-prd.md#session-continuity) remains authoritative.

## Objective

Desktop users discover and continue the same saved Sessions used by TUI, with current history/configuration, supported interactions, attachments, and background results. Desktop main and shared UI do not host Core execution.

## Approach

Use standard ACP discovery and Session methods where the negotiated baseline supports them. Versioned extensions supply richer bounded history, observations, and workbench behavior only where necessary.

Move reusable orchestration from the UI server to its shared Core owner. Preserve receipts, writer admission, and canonical stores instead of copying them into Electron or retaining a second desktop runtime service.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/acp/`, `src/shared/session/`, `src/shared/owner-coordination/` — discovery, observations, interaction delivery, and authoritative continuation.
- `src/ui/workspace/server/session-continuation.ts`, `routes/owner-session-api.ts` — reusable orchestration moves behind ACP while old workbench compatibility remains until cutover.
- `src/ui/workspace/islands/SessionSurface.tsx`, Session list/timeline/question components, and shared client — host-independent composition.
- `src/ui/desktop/` — semantic client wiring and bounded image selection/paste/drop.
- Core/Workspace/ACP owning capability scenarios and contract inventory — delivered Session evidence.

## Reuse Opportunities

- `createSessionRuntime`, ACP live-operation/event/interaction mapping, and canonical file Session stores.
- Session timeline reduction/merge and existing configuration, question, image-preview, and attachment-limit behavior.
- Existing managed Session fixtures, background-continuation tests, and writer-exclusion checks.

## Implementation Steps

1. Discovery uses the supported standard Session-list capability rather than a redundant private method. Existing history is bounded and retains stable persisted Session IDs, ordering, and actual committed configuration.
2. Creation/resumption, Agent/model/thinking configuration, questions/approvals, queued input, steering, cancellation, archive/unarchive, and background-result continuation work through the negotiated runtime boundary.
3. Runtime services own Project checks, request identity, durable receipts, generation checks, single-writer admission, retained/background operations, and layered settings. Neither main nor shared UI imports their implementations.
4. Images from selection, clipboard, and drag/drop use validated bounded transfers, preview, and existing limits. Resource references stay scoped to the runtime; renderer filesystem access is not a shortcut.
5. Shared Session composition and subscriptions have no Astro data loaders or HTTP-owner assumptions. Snapshot/generation reconciliation is bounded and does not duplicate transcript entries when observations are refreshed.
6. An idle TUI and desktop can continue the same Session in either direction under normal Core writer rules. Source/test changes preserve standalone ACP and browser-question compatibility.
7. Contract rows and owning PRD requirements/scenarios match this behavior. Reconnect/process-failure hardening remains owned by the next child.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.ts src/acp/server.test.ts src/acp/managed-session.integration.test.ts src/ui/workspace/workspace-session-ux.test.tsx src/ui/workspace/session-continuation.integration.test.ts src/ui/workspace/background-continuation.integration.test.ts` and `bun run seams:check`.
- Planner assigns exact new real-process Session parity tests. Prove wrong-Project, duplicate request, stale generation, oversized image, busy writer, unknown capability, and archived/unarchived outcomes against real Core stores and locks.
- Existing tests may change transport/import location, but committed history, writer exclusion, configuration hydration, background delivery, and interaction semantics remain protected.
- Headed verification uses desktop Session discovery/detail and new-Session flows. Discover and record the normal desktop dev command and URL/origin. Exercise long history, keyboard interaction, image preview, a question, steering, cancellation, and a background result after the original prompt returns.
- Continue the same persisted Session from desktop and an idle TUI, then reverse direction. Confirm exact identity, no duplicated input/output, and current settings rather than cached projections.

## Edge Cases & Considerations

- One runtime serves explicit multiple Project contexts; cwd/home cannot become module-cached authority.
- Cancel/decline/expired interactions must settle under Core rules, not make uncertain work look complete.
- Slow consumers require bounds/backpressure and snapshot recovery rather than unlimited event retention.
- No new lock/lease or injection seam replaces Core-owned machinery.
