---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
  - "src/ui/desktop/"
  - "src/acp/"
  - "src/shared/session/"
  - "src/shared/owner-coordination/"
  - "src/ui/workspace/browser/"
  - "src/ui/workspace/static/workspace-shell.ts"
  - "docs/prd/runwield-core-prd.md"
  - "docs/prd/runwield-workspace-prd.md"
executionAgent: "engineer"
createdAt: "2026-11-06T04:04:34.474Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 4
dependencies:
  - "continue-saved-sessions-in-desktop"
targetBranch: "epic/local-workspace-desktop"
planId: "9a64116e-8711-4de1-a192-8fba319d23c8"
---

# Keep Work Safe Across Window and Process Changes

## Context

The desktop Session journey must survive presentation changes without changing runtime ownership. Window close is not Quit; a crashed view is not failed or completed Agent work.

Owning requirements are [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace), [Core Session continuity](../../prd/runwield-core-prd.md#session-continuity), [execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery), and [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access).

## Objective

One desktop supervisor keeps local work alive across window close/reopen and renderer failure. Explicit Quit settles owned cancellation before disposal. Main/runtime failure offers truthful recovery without automatically repeating uncertain actions.

## Approach

Main owns application/process lifetime; Core owns operation lifetime and durable truth. Reopening a renderer loads a fresh snapshot and generation before applying observations.

```text
window close -> detach view; keep supervisor/runtime
Quit with work -> stay open OR cancel, await durable settlement, dispose
unexpected exit -> inspect Core evidence; offer safe continuation; never replay
```

An always-on service after explicit Quit would need different requirements and is excluded.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/desktop/` — per-user instance/supervisor, window restoration, native menus/shortcuts, preferences, Quit and crash paths.
- `src/acp/`, `src/shared/session/`, `src/shared/owner-coordination/` — bounded observation snapshots and authoritative cancellation/recovery integration.
- Existing renderer-lifecycle/operation-memory coverage and `static/workspace-shell.ts` preferences — preserve current user state without using projections as authority.
- Core/Workspace/ACP owning scenarios and ADR-020 — actual lifetime and recovery evidence.

## Reuse Opportunities

- Core cancellation, Session writer locks, operation evidence, and committed history hydration.
- Existing navigation/sidebar preferences and design-system confirmation controls.
- Real-process lifecycle fixtures and existing operation-memory checks.

## Implementation Steps

1. A single per-user desktop supervisor owns its local runtime connection. Closing all windows leaves active work running, and reopening reconstructs current state without creating another writer or duplicate runtime.
2. Separate Projects progress independently. Native menus, keyboard shortcuts, window state, and project/navigation preferences work across restart without changing canonical Project/Session authority.
3. Quit with active work offers staying open or stopping and quitting. Stop awaits Core cancellation and durable settlement before process disposal; failed settlement remains recoverable instead of silently becoming success.
4. Renderer crash does not kill Agent work. Main/runtime loss leaves truthful interrupted state and a safe restart/resume route based on canonical evidence, with no uncertain prompt, workflow decision, review decision, or publication replay.
5. Reconnection uses bounded snapshots/generations to reconcile gaps, late events, pending interactions, and configuration. It neither appends a second transcript nor regresses newer state.
6. The supervisor exposes the same settlement boundary for later updater integration. Current PRD/ADR requirements and contract rows match proven behavior without claiming unattended service or remote-worker semantics.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.js src/ui/workspace/workspace-renderer-lifecycle.test.ts src/ui/workspace/workspace-operation-memory.test.ts src/acp/managed-session.integration.test.ts` and `bun run seams:check`.
- Planner defines built-host process tests for window close/reopen, renderer kill, main kill, runtime kill, two simultaneous Projects, a blocked cancellation, and observation overflow/gaps. Actual process death is required; a mocked transcript cannot prove survival.
- Assert uncertain accepted actions are not resubmitted on restart. Inspect canonical records and effect counts, not only labels. Verify cancellation settles before owned process exit and ordinary idle TUI continuation still works.
- Use headed Electron verification for close/reopen, native Quit choices, restored navigation, shortcuts, and interrupted-state recovery. Discover and record the normal desktop dev command and renderer URL/origin.
- Preserve the behavior protected by existing lifecycle tests while moving ownership; the old HTTP workbench is not yet removed. Platform-specific lifetime evidence must be collected during final three-platform qualification.

## Edge Cases & Considerations

- OS shutdown or forced termination may prevent graceful settlement; report interruption from evidence rather than inventing cancellation completion.
- Client preferences are projections, never execution authority.
- No global Session lease or replacement cross-process lock is introduced.
- Update installation and migration compatibility belong to packaging; this child supplies the safe stop boundary.