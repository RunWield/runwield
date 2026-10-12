---
planId: "08304fe2-7ad1-40ca-8ce3-1a14dc5c601a"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/metrics.js"
    - "src/shared/workflow/metrics-journal.js"
    - "src/shared/workflow/metrics.test.js"
    - "src/shared/workflow/metrics-journal.test.js"
    - "src/testing/workflow-metrics-fixture.ts"
    - "docs/settings.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T19:28:54.550Z"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 1
dependencies:
    []
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
userVerifiedAt: null
status: "validated"
validatedCommit: "13620c491749f7b18b12267fd051e2ec1833a323"
---

# Core Measurement History and Durable Recording

The filename keeps `default-on-recording` for stable sibling links; the default-on policy itself was withdrawn by the
owner on 2026-10-06 (see Epic Scope Changes below).

## Context

`recordWorkflowMetric` (`src/shared/workflow/metrics.js`) is the only writer of local workflow metrics. Since this draft
was first written, the independently completed `complete-tool-call-metrics` Plan (2026-09-29) delivered most of the
recording layer this child originally assumed was missing:

- v2 records already carry stable identity — `eventId`, `recorderId`, `seq` — assigned in `sanitizeV2MetricRecord`.
- Appends already serialize through the in-process `metricsWriteQueue`, and `drainWorkflowMetrics` bounds settlement.
- The PRD gained a **Local workflow metrics** capability (`docs/prd/runwield-core-prd.md#usage-measurement-and-export`)
  with detailed recording requirements, and `docs/settings.md` documents the expanded event coverage.

What remains missing is the durability foundation:

- No cross-process coordination. The in-process queue cannot stop two processes (TUI and Workspace, or two Sessions)
  from interleaving lines in one Project journal.
- No recording boundary. A disable→re-enable interval is invisible, and an observation that crossed the boundary can
  land in the wrong interval.
- Untruthful persistence. The queued write swallows its own failure, and `recordWorkflowMetric` returns the record as if
  it had been saved.
- No torn-write repair. A process killed mid-append can leave a partial final line that breaks every later reader.

Recording stays **opt-in**. The owner confirmed on 2026-10-06 that the Epic's default-on policy is withdrawn: recording
stays off unless explicitly enabled, and metrics must stay fast and out of the way — completing the task always outranks
the metrics.

### Epic Scope Changes

- **Parent Epic** — default-on removed from the agreed scope. The Epic's scope bullet, persistence paragraph, and
  "Record by default" outcome row were edited in this session to record the owner's opt-in decision.
- **Sibling 02** — no scope moved by this child. `complete-tool-call-metrics` (outside the Epic) already delivered the
  v2 record contract and recording breadth that 02's draft assumed this child would build; 02's own planning session
  must reconcile its remaining scope (backend usage fidelity, `normalizeRuntimeUsage` zero-coercion) against current
  source.

Owning PRD: this change extends the existing **Local workflow metrics** capability
(`docs/prd/runwield-core-prd.md#usage-measurement-and-export`) with durability, boundary, and gap-honesty requirements.
[Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) stays
authoritative for delivery conclusions; measurement reports outcomes and never creates a third one.

## Objective

One Core-owned durable measurement history under `~/.wld/workflow-metrics/`, written through a single path that
serializes appends across processes with a bounded, never-blocking OS lock, reports persistence truthfully, and refuses
observations that cross a recording boundary. Recording stays opt-in. Existing v1 records stay intact and readable.

## Approach

```text
caller supplies structured fact
  -> collection contract validates shape (v2 identity already assigned)
  -> resolve canonical primary root -> per-Project journal path
  -> in-process queue -> bounded OS file lock (~1s acquire budget)
       re-resolve setting + re-read epoch state from disk
       eligible? repair torn tail -> append -> sync -> release
       lock not acquired in budget? skip, report not-persisted
  -> return persisted:true | persisted:false with reason
```

Eligibility rule, evaluated inside the lock:

```text
eligible(inv) = enabledAtCall(inv) && enabledNowUnderLock(inv)
                && inv.epoch == currentCollectionEpoch
```

Epoch observation is lazy — no settings hook. Inside the lock, the resolved setting is compared with the epoch state on
disk; an observed change appends a collection-epoch transition record before any observation. An unobserved interval is
labeled "no recorded measurements," never a known disabled duration.

Exact journal schema (fixed by this Plan; the earlier draft deferred it):

```text
~/.wld/workflow-metrics/<encoded-primary-root>/
├── metrics.jsonl     # existing v1 + v2 lines; location unchanged
├── state.json        # { v: 1, collectionEpoch, historyEpoch }; atomic replacement
└── .journal.lock     # proper-lockfile lock target
```

- Epoch transitions are appended to `metrics.jsonl` as records (event `collection_epoch`, epoch ID, enabled/disabled,
  timestamp) so the durable timeline lives in the journal. `state.json` is the fast in-lock read of the current epochs,
  rebuilt from the journal when missing or behind.
- The lock is `proper-lockfile` (already a dependency), acquired with a bounded budget using the `ELOCKED`-retry pattern
  from `acquireSettingsLockSyncWithRetry` (`src/shared/settings.js:133`). On timeout the observation is skipped and
  reported not-persisted. The lock is held only for state read, tail check, append, and sync; no network I/O occurs
  under it.
- A torn final append is truncated under the lock with earlier valid records intact; interior corruption is isolated and
  surfaced as a coverage gap, never silently dropped.
- Storage failure is fail-open for the caller and fail-honest for reporting.

Set aside: reusing the Session writer lock and control state machine — it would couple measurement durability to Session
authority that ADR-015 deliberately keeps separate. Also set aside: queueing skipped observations for a later retry — a
hidden buffer adds machinery for a rare contention case; a skipped observation is reported not-persisted and stays lost,
consistent with the owner's priority of work over metrics.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation and change whatever the
steps need.

- `src/shared/workflow/metrics.js` — `recordWorkflowMetric` keeps its existing call signature; its queued write
  delegates to the journal module and returns a truthful persistence result.
- `src/shared/workflow/metrics-journal.js` (new) — the journal module: lock, epoch state, tail repair, append; owns the
  schema above.
- `src/shared/workflow/metrics.test.js` — existing redaction and worktree-mapping protection stays.
- `src/shared/workflow/metrics-journal.test.js` (new) — concurrency, epochs, torn tail, kill/restart, disk failure.
- `src/testing/workflow-metrics-fixture.ts` — keeps its explicit enable (opt-in is unchanged); gains whatever the new
  tests need, such as a second-process or contended-lock scenario.
- `docs/settings.md` (`workflowMetrics` section, ~L489) — documents durability and recording-boundary semantics; the
  default stays disabled.
- `docs/domain-language.md` — adds **Usage observation**.
- `docs/prd/runwield-core-prd.md` — extends **Local workflow metrics** with durability, boundary, and gap-honesty
  requirements and acceptance scenarios.

No `src/shared/settings.js` change: the absent-setting default stays disabled, boolean/object normalization and scope
precedence already exist, and epoch observation is lazy at append time.

## Reuse Opportunities

- `resolvePrimaryCheckoutRoot` and `encodeCwdForSessionDir` via `getWorkflowMetricsFilePath` — worktrees already map to
  the primary checkout file.
- `sanitizeMetricValue` / `sanitizeMetricDetails` and `sanitizeV2MetricRecord` — existing redaction and identity
  assignment stay as the validation layer.
- `proper-lockfile` and the `acquireSettingsLockSyncWithRetry` pattern — the repo's existing OS-lock convention.
- `drainWorkflowMetrics` / `waitForMetrics` — the bounded-settlement convention for callers that must wait.
- `defineGitFixture` (`src/shared/git-test-fixture.ts`), `makeValidationProjectRoot`, and `withProcessGlobalTestLock`
  (`src/testing/process-global-lock.ts`) — real repositories and sandboxed HOME.

## Implementation Steps

- The journal module owns and exports journal append, epoch resolution, and tail repair; `metrics.js` no longer performs
  an uncoordinated `Deno.writeTextFile` append.
- Appends for one Project journal serialize across processes through the bounded OS lock; the lock is held only for the
  state read, tail check, append, and sync, and no network I/O occurs while it is held.
- Lock acquisition is bounded (~1s); on timeout the observation is skipped and reported `persisted:false` with a reason.
  The caller never blocks beyond the budget, and a failed or skipped write never throws into model or delivery work.
- Each append re-resolves the `workflowMetrics` setting and re-reads epoch state inside the lock; a process-local cached
  setting cannot authorize a stale write.
- A setting change observed under the lock appends a `collection_epoch` transition record and atomically updates
  `state.json` before any observation. Disabling rejects observations that crossed the boundary; re-enabling starts a
  new collection epoch with no catch-up pass and no hidden buffer.
- `recordWorkflowMetric` and the journal entry point report persistence truthfully: `persisted:true` only after a
  completed append and sync, otherwise `persisted:false` with a reason.
- Observation identity is assigned once when the record is constructed; a caller retry of a failed append reuses that
  identity rather than minting a new `eventId`.
- A torn final append is truncated under the lock with earlier valid records intact; interior corruption is isolated and
  reported, never silently dropped.
- v1 records remain untouched and parseable; the writer never copies generic v1 `details` into v2 records, and dedicated
  frontend events keep their v1 path so one observation cannot appear through both versions.
- Recording stays opt-in: absent setting records nothing, explicit `false` at any scope stays silent, boolean and object
  forms and project-over-global precedence behave exactly as today. An upgrade fixture with explicit `false` stays
  silent.
- `docs/domain-language.md` defines **Usage observation** as a content-free record of activity Core actually observed
  while measurement was enabled, with its avoided aliases (transcript, billing charge) and its relationships to Session,
  Plan, and collection epoch.
- `docs/prd/runwield-core-prd.md` extends **Local workflow metrics** with named observable requirements and acceptance
  scenarios for cross-process durability, truthful persistence, recording boundaries, and gap honesty; unmet reporting
  and export intent stays labeled target/deferred.

## Verification Plan

- Automated:
  `deno run -A scripts/run-tests.js src/shared/workflow/metrics.test.js src/shared/workflow/metrics-journal.test.js`;
  then `deno task seams:check` and `deno task ci`. Never `deno test` directly.
- Fresh configuration records nothing; explicit `true` records; explicit `false` at global and at project scope does
  not; project precedence over global survives.
- An upgrade fixture combining explicit `false`, real v1 metrics, transcript-only activity, and later enablement shows
  old v1 metrics intact and parseable, an epoch transition recorded at the observed enablement, and old unknown periods
  still unknown.
- Work performed between disable and re-enable produces no records, aggregates, or replayed observations after restart.
- An invocation started while enabled and settling after a disable is excluded; the converse is excluded too.
- Two concurrent processes appending to one Project journal yield valid, uniquely identified records with no interleaved
  lines.
- A lock held past the acquire budget by another holder: the caller completes without blocking beyond the budget and the
  observation is reported not-persisted.
- Kill/restart around a write exposes only persisted evidence plus an explicit incomplete record; a torn final line is
  removed with earlier records intact.
- A simulated disk failure does not stop the caller and does not report the measurement as saved.
- Existing protected behavior: `metrics.test.js` redaction and worktree-to-primary mapping still pass. Expected to stop
  existing: the swallowed-catch path that returns a saved-looking record — replaced by the truthful result. The opt-in
  default is unchanged; no behavior stops there.
- No new injection seam is introduced for journal writes, epoch state, or settings; `deno task seams:check` passes
  without re-baselining.
- `deno task doc-links:check` passes; the glossary describes implemented behavior only.

## Edge Cases & Considerations

- Non-local filesystems may not honor OS-lock semantics. Detect and report degraded collection rather than substituting
  lease expiry or allowing silent concurrent writes.
- Absence of records cannot prove recording was disabled versus no activity. Label that interval "no recorded
  measurements," never a known disabled duration.
- Turning recording off controls new writes only; it must not hide already-collected history.
- Skipped observations under lock contention are lost by design — the owner's priority is completing work over
  collecting metrics. They are reported not-persisted so later reporting shows a coverage gap, never a false zero.
- Keeping history indefinitely grows files; this child only appends and repairs, and later reporting owns incremental
  reads.
- Assumption: keep the **Local workflow metrics** PRD heading and `local-workflow-metrics` anchor; retitle to the Epic's
  proposed **Usage measurement and export** name when child 04 adds reporting and retention requirements to the same
  capability, so links stay stable until then.
