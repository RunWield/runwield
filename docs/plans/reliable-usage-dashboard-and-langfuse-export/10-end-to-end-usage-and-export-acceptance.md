---
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield.md"
    - "docs/domain-language.md"
    - "docs/settings.md"
    - "packages/langfuse-exporter/"
    - "src/shared/workflow/"
    - "src/ui/workspace/"
executionAgent: "engineer"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-09-21T19:28:55.522Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 10
dependencies:
    - "09-workspace-export-settings-and-delivery-status"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "e52757f4-2a63-41dd-bfcf-5fd2fb8d58f9"
---

# End-to-End Usage and Export Acceptance

## Context

Children 01–09 each prove their own boundary. The parent Epic names a journey that none of them owns alone, and states
plainly that a synthetic-only demo is not a completed integration.

This child runs that journey on a real Project with real backends and a disposable Langfuse project, repairs what it
exposes, and reconciles the documentation the earlier children updated in pieces.

Owning PRDs: all three — Core **Usage measurement and export**, Workspace **Personal usage and outcomes**, and the root
capability ownership map — plus
[Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) and
[Models and providers](../../prd/runwield-core-prd.md#models-and-providers), which stay authoritative for delivery
conclusions and backend visibility.

## Objective

Demonstrated agreement: local totals match eligible evidence, remote totals match received observations, and every gap —
disabled days, partial CLI data, a lost export response — is disclosed rather than papered over. Documentation describes
delivered behavior with unmet intent still labeled target or deferred.

## Approach

The journey, in order, on one real Project:

```text
1  non-Plan work                      -> usage recorded, no Plan attribution
2  each backend (Pi, Claude, agy)      -> per-backend observations with real provenance
3  an interruption                     -> ongoing, never "abandoned"
4  a repaired publication              -> failed validation + repair rounds + one delivered attempt
5  a deliberate abandonment            -> abandoned, distinct from interrupted
6  restart                             -> only persisted evidence, gaps stay gaps
7  inspect Usage from TUI-hosted browser and from phone
8  inspect approved records in a disposable Langfuse project
   including: a disabled day, partial CLI data, a lost export response
```

Then two agreement checks:

```text
local totals  == eligible collected evidence    (gaps disclosed adjacent to numbers)
remote totals == received observations          (unconfirmed / missing disclosed, not resent)
```

Set aside: asserting the journey through unit fixtures only. It would have been fast, hermetic, and unable to catch a
mapping that returns HTTP 200 while inflating a vendor chart.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Most of this child is verification; repair work lands wherever the journey
exposes a defect.

- Any module from children 01–09 where the journey exposes a real defect — repaired, with the owning child's protected
  behavior still passing.
- `docs/prd/runwield-core-prd.md`, `docs/prd/runwield-workspace-prd.md`, `docs/prd/runwield.md` — requirements,
  scenarios, ownership map, and cross-links reconciled to delivered behavior.
- `docs/domain-language.md` — **Usage observation**, **Metrics exporter**, and **Delivery unconfirmed** confirmed as
  implemented truth with stable relationships, and no unimplemented proposal promoted.
- `docs/settings.md` and `src/skills/runwield/SETTINGS.md` — default-on recording, retention until deletion, and export
  approval semantics accurate.
- `docs/design-system.md` — any pattern children 05 or 09 added is documented.
- The historical **Complete Tool-Call Metrics** draft is not added as scope; note satisfied coverage goals only and keep
  its token-denominator scope out.

## Reuse Opportunities

- The verification already written in children 01–09 — this child runs the journey they cannot, not their unit coverage
  again.
- `defineGitFixture`, `makeValidationProjectRoot`, `withProcessGlobalTestLock` for the reproducible parts of the
  journey.
- The child 05 and 09 browser flows and dev server (`deno task workspace:dev`, `http://127.0.0.1:5173`).
- The child 08 real-destination checks and pinned Langfuse v4 fixtures.
- `docs/prd/` capability structure and `docs/plan-lifecycle.md` for the reconciliation sweep.

## Implementation Steps

- The full journey runs on a real Project across all three backends, including non-Plan work, an interruption, a
  repaired publication, and a deliberate abandonment, with a restart in the middle.
- Local totals from the Usage page agree with the eligible collected evidence for that journey, with disabled days,
  partial CLI data, and incomplete operations disclosed as gaps rather than zeros.
- The interrupted turn is reported as ongoing and the deliberate abandonment as abandoned, and the two are never
  conflated.
- The repaired publication reports one delivered attempt with separate validation-attempt and repair-round counts.
- Records approved for export appear in a disposable Langfuse project, and remote counts and sums agree with the
  observations actually received.
- A lost export response produces an unconfirmed item that is disclosed in Workspace, never automatically resent, and
  never blocks later records.
- Partial CLI data appears in Langfuse without an invented native complete total or inferred spend.
- A disabled day appears as a gap in both surfaces and produces no records, aggregates, or exports after restart or
  replay.
- Usage inspected from a TUI-hosted browser and from a phone shows the same day boundaries and the same totals.
- Every defect the journey exposes is repaired, and the owning child's protected behavior still passes afterwards.
- The three PRDs, the root capability ownership map, and all cross-references describe delivered behavior, with unmet
  intent still labeled target or deferred and no transient PRD left claiming shipped scope.
- `docs/domain-language.md` defines all three new terms as implemented truth, with avoided aliases and stable
  relationships, and promotes no unimplemented proposal.
- `docs/settings.md` and `src/skills/runwield/SETTINGS.md` state default-on recording, retention until deletion,
  explicit opt-out preservation, and separate export approval.
- No historical metrics reconstruction exists anywhere in the delivered behavior.

## Verification Plan

- Automated: `deno task test` for the full suite, then `deno task ci`, `deno task workspace:check`,
  `deno task workspace:build`, and `deno task doc-links:check`. Never `deno test` directly.
- Creating Langfuse credentials and exporting real records requires explicit owner authorization. Do not upload existing
  history to prove the new-only path; use a disposable project and journey-generated records only.
- Headed browser checks: run `deno task workspace:dev`, open `http://127.0.0.1:5173/usage`, and walk the journey's
  inspection steps on both desktop and phone viewports.
- In the disposable Langfuse project, query the received observations directly and compare counts and sums against the
  local report; an availability label beside a vendor chart still showing invented zero or full totals is a failure.
- Confirm no captured request body, response, log, or browser storage contains prompts, code, conversation text, raw
  tool data, private file paths, or credential values.
- Confirm a restart mid-journey exposes only persisted evidence plus explicit incomplete records, and that no transcript
  replay reconstructs absent usage.
- Confirm Sessions, Plans, and worktrees survive a clear-history action taken during the journey.
- Confirm home, Session navigation, pairing, Project access, explicit recording opt-outs, Session authority, worktree
  protection, redaction, and truthful workflow completion all still behave as before this Epic.
- Confirm `deno task seams:check` passes with no new seam for Plan writes, journal writes, or lifecycle state.
- Existing protected behavior: the full pre-Epic suite passes. Expected to stop existing: zero-filled usage absence,
  opt-in-by-default recording, uncoordinated metrics appends, and pruning publication evidence with no persisted
  observation.

## Edge Cases & Considerations

- Some usage was never retained or is never reported upstream. The journey must disclose that as a qualified gap, not
  treat it as a defect to fix.
- Non-local filesystems may not honor the required lock and durability semantics; if the journey host uses one, record
  the degraded-collection behavior instead of substituting lease expiry.
- A destination outage or quota error during the journey is a normal observable state to capture, not a reason to retry
  blindly.
- The journey's evidence is real-run output. Keep it reproducible enough for later re-verification without turning it
  into a synthetic fixture that proves nothing.
- Assume one host and host-time-zone days; multi-host identity and team aggregation stay out of scope.
