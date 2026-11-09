---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/server/owner-usage.ts"
    - "src/ui/workspace/server/owner-usage-settings.ts"
    - "src/ui/workspace/react/UsageReport.tsx"
    - "src/ui/workspace/react/UsageSettings.tsx"
    - "src/shared/workflow/"
    - "src/acp/"
    - "src/ui/desktop/"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:37.521Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 9
dependencies:
    - "open-projects-and-configure-providers"
    - "continue-saved-sessions-in-desktop"
targetBranch: "epic/local-workspace-desktop"
planId: "4c65015a-807c-496e-897f-d4a427329057"
---

# Inspect Usage and Control Recording and Export

## Context

Usage and privacy settings are existing capabilities, not placeholder pages. Core owns measurement arithmetic and export machinery; the current Workspace server adds access control, labels, links, and HTTP presentation.

This child implements their desktop parity under [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace) and [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access), preserving the owning Core measurement/export requirements.

## Objective

Desktop shows accurate local usage and lets the owner control recording, approved export destinations, Project grants, credentials, revocation, and selected-history clearing without weakening privacy or duplicating Core logic.

## Approach

Move reusable authorization/orchestration behind the runtime contract and reuse shared report/settings components. Core continues to own aggregation, settings precedence, credentials, grants, delivery, and journals.

Do not replace the existing controls with a smaller mock settings screen or treat installing an exporter as approval to upload.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `server/owner-usage.ts`, `server/owner-usage-settings.ts` and current shared usage/export owners — authoritative runtime adaptation.
- `react/UsageReport.tsx`, `UsageSettings.tsx`, shared client, and desktop navigation — reusable report/settings composition.
- `src/acp/` — advertised typed reads and scoped, receipt-safe mutations; secrets excluded from read payloads.
- Core/Workspace/ACP owning capabilities and inventory — parity and privacy evidence.

## Reuse Opportunities

- `loadOwnerUsageReport`, Core `src/shared/workflow/usage-reporting.ts`, and existing aggregation semantics.
- `loadUsageSettings`, `mutateUsageSettings`, layered settings, metrics grants, credentials, scheduler, and journal owners.
- Existing export-journey, scale, and settings integration fixtures.

## Implementation Steps

1. Desktop usage reports preserve presets/custom periods, backend/model aggregates, excluded Projects, missing-data explanations, ongoing-versus-settled measurements, and links resolved through authorized checkouts.
2. Primary/worktree aliases do not double-count spend; report arithmetic remains Core-owned and agrees with canonical measurements.
3. Recording settings preserve layered overrides. Export setup/editing requires explicit destination approval and selected Project grants, with existing unavailable-Project and remote-personal-resource restrictions intact.
4. Credentials remain write-only and replaceable/clearable, never returned to renderer reads or stored as desktop preferences. Destination changes, insecure loopback permission, revocation, in-flight warnings, and selected-history clearing retain explicit safeguards.
5. Mutations pass runtime admission, request identity/receipt, and applicable revision checks. App launch does not upload local data or approve an installed exporter.
6. Relevant contract rows and owning requirements/scenarios reflect delivered controls; future Workspace identity/cloud scope remains distinct and deferred.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.ts src/ui/workspace/owner-usage-report.integration.test.ts src/ui/workspace/owner-usage-scale.integration.test.ts src/ui/workspace/owner-usage-settings.integration.test.ts src/ui/workspace/owner-usage-settings-remote.integration.test.ts src/ui/workspace/usage-export-journey.integration.test.ts` and `bun run seams:check`.
- Planner defines new real-process protocol tests for exact report parity, alias deduplication, unauthorized Project rejection, duplicate mutations, write-only credentials, explicit export approval, destination changes, revocation, and clear-history confirmation.
- Headed verification uses desktop Usage -> period/filter -> linked work, then Settings -> recording -> approved export -> credential replacement -> revoke/clear selected history. Discover and record the desktop dev command and URL/origin.
- Verify no secret appears in renderer read payloads, diagnostics, persisted UI preferences, or screenshots. Test canceled destructive confirmation and an in-flight delivery warning.
- Preserve existing Core aggregation/export tests while moving server ownership. Network export can use a controlled external endpoint; Core grants and writes run for real.

## Edge Cases & Considerations

- No provider or Workspace account is required to inspect saved local usage.
- Partial measurements must not be represented as exact settled totals.
- Revocation cannot erase data already delivered; UI must retain existing truthful wording.
- Credentials and destination approval remain separate from exporter installation and future account identity.
