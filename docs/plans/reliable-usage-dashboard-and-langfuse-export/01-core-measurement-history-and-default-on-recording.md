---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/metrics.js"
    - "src/shared/workflow/metrics.test.js"
    - "src/shared/settings.js"
    - "src/testing/workflow-metrics-fixture.ts"
    - "docs/settings.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T19:28:54.550Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 1
dependencies:
    []
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "08304fe2-7ad1-40ca-8ce3-1a14dc5c601a"
---

# Core Measurement History and Default-On Recording

## Context

`recordWorkflowMetric` (`src/shared/workflow/metrics.js:277`) is the only writer of local workflow metrics today. It
assigns no stable event identity, coordinates appends with nothing, and wraps the write in `catch { return record }` —
so a caller can receive a record that was never saved. Recording is opt-in: `isWorkflowMetricsEnabled` (L80) returns
`false` when the setting is absent, and `docs/settings.md:365` documents `workflowMetrics` as default-disabled.

The parent Epic
[Reliable Usage, Workspace Dashboard, and Langfuse Export](../reliable-usage-dashboard-and-langfuse-export.md) requires
the opposite default and a history trustworthy enough to report and later export. This child builds that foundation and
nothing above it: no reporting queries, no dashboard, no exporter.

Owning PRD: this change creates the Core **Usage measurement and export** capability heading in
`docs/prd/runwield-core-prd.md` and owns its recording, retention, consent, and gap requirements.
[Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) stays
authoritative for delivery conclusions; measurement reports outcomes and never creates a third one.

## Objective

One Core-owned durable measurement history under `~/.wld/workflow-metrics/`, written through a single path that assigns
stable identities, serializes appends, reports persistence truthfully, and refuses observations that cross a recording
boundary. Recording is on unless the user explicitly turned it off. Existing v1 records stay readable and visibly
legacy.

## Approach

```text
caller supplies structured fact
  -> collection contract validates shape and assigns observation + operation IDs
  -> resolve canonical primary root -> per-Project journal path
  -> in-process queue -> short-lived OS file lock
       re-read collection epoch + history epoch from disk
       eligible? append -> sync -> release
  -> return persisted:true | persisted:false with reason
```

Eligibility rule, evaluated inside the lock:

```text
eligible(inv) = enabledAt(inv.start) && inv.epoch == currentCollectionEpoch
                && currentHistoryEpoch == epochAtStart
```

A start record without settlement is an incomplete measurement, not a workflow failure. A torn final append is removed
under the lock; interior corruption is isolated and surfaced, never silently dropped. Storage failure is fail-open for
the caller and fail-honest for reporting.

The setting keeps its boolean/object shape. Only the absent case changes, following the existing `!== false` idiom used
by `shouldCleanupMergedWorktrees` (`src/shared/settings.js:643`).

Set aside: reusing the Session writer lock and control state machine. It would have coupled measurement durability to
Session authority that ADR-015 deliberately keeps separate.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation and change whatever the
steps need.

- `src/shared/workflow/metrics.js` — collection contract, identity assignment, epoch resolution, locked append, truthful
  persistence result; `recordWorkflowMetric` keeps its existing call signature for current callers.
- A cohesive Core measurement module beside it for journal layout, epoch markers, and replay identity.
- `src/shared/settings.js` — absent-setting default becomes enabled; both boolean and object forms normalize; existing
  scope precedence and explicit `false` survive.
- `src/shared/workflow/metrics.test.js` — existing redaction and worktree-mapping protection stays; new epoch, lock, and
  torn-append coverage.
- `src/testing/workflow-metrics-fixture.ts` — fixture stops needing an explicit enable to exercise recording.
- `docs/settings.md` (L365, L369–382) and `src/skills/runwield/SETTINGS.md:126` — default-on, opt-out preserved,
  retention until deleted.
- `docs/domain-language.md` — add **Usage observation**.
- `docs/prd/runwield-core-prd.md` — create the **Usage measurement and export** capability with recording, retention,
  consent, and gap requirements plus acceptance scenarios.

## Reuse Opportunities

- `resolvePrimaryCheckoutRoot` and `encodeCwdForSessionDir` via `getWorkflowMetricsFilePath` (L93) — worktrees already
  map to the primary checkout file.
- `sanitizeMetricValue` / `sanitizeMetricDetails` (L149, L182) — existing path and text redaction, kept for v1 readers.
- Existing private-file, atomic-replacement, and OS-lock conventions — reuse the low-level durability approach, not the
  Session lock.
- `defineGitFixture` (`src/shared/git-test-fixture.ts`), `makeValidationProjectRoot`, and `withProcessGlobalTestLock`
  (`src/testing/process-global-lock.ts`) — real repositories and sandboxed HOME.

## Implementation Steps

- The measurement module owns and exports the observation contract, journal append, and epoch resolution; `metrics.js`
  no longer performs an uncoordinated `Deno.writeTextFile` append.
- Every persisted observation carries a stable observation ID and operation ID; a persistence retry reuses its record
  identity rather than minting a new one.
- Appends for one Project serialize through an in-process queue and a short-lived OS file lock; no network I/O occurs
  while that lock is held.
- Each append re-reads the on-disk collection and history epochs inside the lock; a process-local cached setting cannot
  authorize a stale write.
- `recordWorkflowMetric` and the new collection entry point report persistence truthfully, and a failed write never
  throws into model or delivery work.
- Recording is enabled when `workflowMetrics` is absent, `true`, or `{ enabled: true }`, and disabled only for explicit
  `false` or `{ enabled: false }` at the winning scope; an upgrade fixture with explicit `false` stays silent.
- Disabling stops recording immediately and rejects late observations that cross the boundary; re-enabling starts a new
  collection epoch with no catch-up pass and no hidden buffer.
- A torn final append is removed under the lock with earlier valid records intact; interior corruption is isolated and
  reported.
- v1 records remain readable through a legacy path that exposes only understood fields, never copies generic `details`
  into the new contract, and cannot present the same observation through both v1 and v2.
- `docs/domain-language.md` defines **Usage observation** as a content-free record of activity Core actually observed
  while measurement was enabled, with its avoided aliases (transcript, billing charge) and its relationships to Session,
  Plan, and collection epoch.
- `docs/prd/runwield-core-prd.md` contains the new **Usage measurement and export** capability with named observable
  requirements and acceptance scenarios for default-on recording, explicit opt-out, gap honesty, and retention until
  deletion; unmet export and reporting intent is labeled target.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/workflow/metrics.test.js` plus the new measurement module
  tests; then `deno task seams:check` and `deno task ci`. Never `deno test` directly.
- Fresh configuration records; explicit `false` at global and at project scope does not; project precedence over global
  survives.
- An upgrade fixture combining explicit `false`, real v1 metrics, transcript-only activity, and later enablement shows
  old metrics visible and old unknown periods still unknown.
- Work performed between disable and re-enable produces no records, aggregates, or replayed observations after restart.
- An invocation started while enabled and settling after a disable is excluded; the converse is excluded too.
- Two concurrent processes appending to one Project journal yield valid, uniquely identified records with no interleaved
  lines.
- Kill/restart around a write exposes only persisted evidence plus an explicit incomplete record.
- A simulated disk failure does not stop the caller and does not report the measurement as saved.
- Existing protected behavior: `metrics.test.js` redaction and worktree-to-primary mapping still pass. Expected to stop
  existing: the silent `catch { return record }` path and the absent-setting-means-disabled default.
- No new injection seam is introduced for journal writes, epoch state, or settings; `deno task seams:check` passes
  without re-baselining.
- `deno task doc-links:check` passes; the glossary describes implemented behavior only.

## Edge Cases & Considerations

- Non-local filesystems may not honor OS-lock semantics. Detect and report degraded collection rather than substituting
  lease expiry or allowing silent concurrent writes.
- Absence of records cannot prove recording was disabled versus no activity. Label that interval “no recorded
  measurements,” never a known disabled duration.
- Turning recording off controls new writes only; it must not hide already-collected history.
- Upgrade must not label pre-upgrade empty periods as covered just because the new default is on.
- Keeping history indefinitely grows files; this child only appends and replays, and later reporting owns incremental
  reads.
- Assume the journal directory layout and epoch marker spelling are this Epic's to choose; Planner fixes the exact
  schema.
