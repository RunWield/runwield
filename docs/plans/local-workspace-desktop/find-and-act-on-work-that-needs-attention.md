---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/server/owner-dashboard.ts"
    - "src/ui/workspace/components/OwnerDashboard.astro"
    - "src/ui/workspace/static/workspace-shell.ts"
    - "src/ui/workspace/browser/workspace-notifications.ts"
    - "src/ui/workspace/browser/session-tab-notifications.ts"
    - "src/shared/session/notification-content.ts"
    - "src/acp/"
    - "src/ui/desktop/"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:36.383Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 7
dependencies:
    - "open-projects-and-configure-providers"
    - "continue-saved-sessions-in-desktop"
    - "run-plans-through-integrated-code-review"
targetBranch: "epic/local-workspace-desktop"
planId: "fe3fbe94-49b8-4e22-bb6f-11a496511b80"
---

# Find and Act on Work That Needs Attention

## Context

The current dashboard streams updates through Astro/HTTP, and the sidebar uses browser-specific navigation and refresh logic. Desktop needs the same orientation and attention journey through its shared client.

This child implements dashboard/attention parity under [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace) and [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access). Existing dashboard and notification requirements remain applicable.

## Objective

The owner can identify current work and required decisions across Projects, navigate to the correct Session/Plan/review, and receive useful native notifications without stale-state regression or unnecessary private content disclosure.

## Approach

Move reusable dashboard queries/subscriptions to the runtime owner and render shared composition from semantic client models. Electron supplies native notifications and local navigation only.

Keep progressive per-Project results. Waiting for every Project before rendering would simplify aggregation but would let one unavailable root hide unrelated work.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `server/owner-dashboard.ts`, dashboard stream routes, and `src/acp/` — runtime-owned queries and bounded observations.
- `components/OwnerDashboard.astro`, `DashboardSection.astro`, `static/workspace-shell.ts`, and shared navigation — replace host coupling with reusable composition.
- `browser/workspace-notifications.ts`, `browser/session-tab-notifications.ts`, `src/shared/session/notification-content.ts` — retain policy while adapting the host.
- `src/ui/desktop/`, Workspace/ACP requirements, and inventory — native notification/navigation integration and parity evidence.

## Reuse Opportunities

- `loadOwnerSidebar`, `loadOwnerDashboard`, and `subscribeOwnerDashboard` semantics.
- Existing four dashboard sections, ordering, Plan-associated Session rows, diagnostics, and sidebar preferences.
- Notification event policy, content rules, focus suppression, and design-system status presentation.

## Implementation Steps

1. All existing dashboard sections and sidebar navigation render through shared client queries/subscriptions rather than Astro server data or owner HTTP APIs.
2. Progressive loading keeps slow/unavailable Projects independent. Loading, empty, incomplete, failed, and verified results remain distinct; current generation/snapshot data wins over stale updates.
3. Attention actions navigate inside desktop to the correct Project, Session, Plan, or integrated review. Sidebar ordering, pagination, expansion/resize state, warnings, and last-location behavior remain usable.
4. Native notifications retain existing event/privacy policy and focused-window suppression. Clicking one reopens or focuses the appropriate desktop destination without granting an action or starting execution.
5. The owning requirements/scenarios and inventory rows match delivered dashboard/notification behavior. Browser service-worker mechanics are not copied into the desktop runtime contract.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.ts src/ui/workspace/owner-dashboard-stream.test.ts src/ui/workspace/owner-dashboard-loading.test.tsx src/ui/workspace/owner-dashboard-zero-projects.test.ts src/ui/workspace/owner-dashboard-ui.test.ts src/ui/workspace/browser/session-tab-notifications.test.ts`.
- Planner defines new real-process dashboard observation tests. Exercise two Projects with one delayed/unavailable, state changes during navigation, stale snapshots, large sidebar lists, and reconnect without duplicate attention items.
- Headed verification uses desktop Dashboard -> each section's destination -> return, plus sidebar pagination and native notification click while the window is closed. Discover and record the desktop dev command and URL/origin.
- Confirm keyboard/screen-reader orientation, distinct loading/empty/error states, focused-window notification suppression, and private-content policy. Platform-native delivery is qualified on each OS in the final child.
- Preserve existing dashboard/notification behavior while changing transport; no display projection becomes runtime authority.

## Edge Cases & Considerations

- Project removal/disable or a Session becoming unavailable between notification and click must produce a safe explanation.
- OS notification denial cannot block in-app attention state.
- A reconnect must not create a notification storm from historical events.
- Existing browser workbench remains temporary migration support until the retirement child.
