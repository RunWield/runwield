---
planId: "a3714639-e96c-4327-938f-aaef4aa87e1e"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/usage-reporting.ts"
    - "src/shared/workflow/metrics-journal.ts"
    - "src/shared/workflow/metrics.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T19:28:54.858Z"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 4
dependencies:
    - "03-workflow-outcome-observations"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
userVerifiedAt: null
status: "validated"
validatedCommit: "86219401563ceffe74954bad1a4009fd738b7158"
---

# Core Usage Reporting, Retention, and Clear

## Context

Children 01–03 produce a durable, honest measurement history. Nothing can read it yet. The parent Epic requires one set
of reporting rules inside the measurement module, so the Workspace page (child 05) and any later exporter consume the
same numbers instead of computing competing totals.

The Epic also fixes retention: local records live until the owner deletes them, with no age-based expiry, and a
deliberate clear removes measurement history only — never Sessions, Plans, worktrees, or configuration.

What children 01–03 delivered, verified in source:

```text
src/shared/workflow/
├── metrics-journal.ts        # child 01: lock, epochs, tail repair, append (write side)
├── metrics.js               # v1/v2 record sanitizing; V2_EVENTS vocabulary; queue + append entry
├── execution-metrics.ts     # child 02: model usage, context, latency, tool observations
└── outcome-observations.ts  # child 03: validation, repair, publication observations
```

- Journals live at `~/.wld/workflow-metrics/<encoded-primary-root>/metrics.jsonl` with `state.json` beside them. Rows
  are v2 observations (stable `eventId`, `historyEpoch`, `collectionEpoch`), `collection_epoch` control records, and
  `measurement_gap` records; older v1 rows (`v: 1`, `category`/`event`/`details`) share the same file.
- `execution_started` rows carry `dispatchKind` (`interactive` | `plan_execution` | `quick_fix` | `validation_repair` |
  `background_task_result`) and `sourceSurface` — the journal evidence for what started a turn.
- Child 01 deliberately kept the PRD heading **Local workflow metrics**
  (`docs/prd/runwield-core-prd.md#usage-measurement-and-export`) and deferred the retitle to this child, which adds the
  reporting and retention requirements to the same capability.

Sibling boundaries: child 05 wires the Workspace page and owner routes to this query; child 07 extends the clear path
with export-side deletion and delivery fences; child 09 wires the browser clear control. This child delivers Core only
and touches no Workspace file.

Owning PRD: the Core **Usage measurement and export** capability (retitled from **Local workflow metrics** here) gains
the reporting, retention, and deletion requirements and scenarios.

## Objective

A reporting query that accepts an authorized set of Project identities, a period, and a reporting time zone, and returns
settled totals, coverage and exclusion counts, daily buckets, backend and model breakdowns, and stable local identifiers
for links. Plus a clear action that removes selected Project history and makes it unrecoverable through replay or legacy
readers.

## Approach

```text
query(projectRoots, period, timeZone)
  -> stream per-Project journals (new byte suffixes where possible)
  -> replay by stable eventId into a disposable in-memory cache (idempotent)
  -> include safe legacy v1 rows, labeled legacy/partial
  -> aggregate: totals, coverage, exclusions, daily buckets, breakdowns
  -> return with explicit host time zone and recorded-through marker
```

The query lives in a new read-side module, `src/shared/workflow/usage-reporting.ts`. The write side stays in
`metrics-journal.ts`; reporting never appends, and aggregation cannot construct a writable Session manager, scan
transcripts, contact a model, or infer success from Plan status. The caller (child 05's owner routes) resolves which
Project roots are authorized; Core maps roots to journal paths through the existing
`getWorkflowMetricsFilePath`/`resolvePrimaryCheckoutRoot` path and never imports Workspace SQLite.

Day and gap rules:

```text
day boundary      = half-open local interval in the reporting zone, DST-correct
active day        = accepted human request OR explicit user-started continuation
usage day         = the observation's completion day
incomplete op     = shown separately, never given an invented total
disabled/legacy/unavailable/not-yet-collected = gap (breaks a trend)
known zero in a covered period               = zero (draws a point)
published changes = distinct confirmed delivery attempts for executable Plans
```

Active-day evidence comes from the journal, not from open tabs or event volume: a day is active when it contains an
`execution_started` row with `dispatchKind` `interactive` (an accepted human request) or a user-started workflow
continuation kind (`plan_execution`, `quick_fix`, `validation_repair`), or a `command_started` row (an explicit user
slash command). `background_task_result` and unattended background activity never make a day active. The engineer
verifies each dispatch kind's user-started-ness against its call sites in `src/shared/session/session.js` before
finalizing the set.

Clear:

```text
clear(projectRoots)
  -> take the same journal guard + lock as appends
  -> truncate metrics.jsonl, reset state.json counters, keep the collection epoch
  -> append a fresh history-epoch marker row (new historyEpoch UUID)
  -> drop that Project's cached observations (history-epoch mismatch)

appendWorkflowMetric (extended)
  -> invocation captures historyEpoch at call time (resolveCollectionEpoch already returns it)
  -> under the lock, a captured non-initial historyEpoch that differs from the
     on-disk epoch is rejected with reason "history_boundary"
```

That invocation check is what discards a delayed settlement from an older history epoch, even when it arrives from
another process: the record was captured before the clear, and the append re-reads the durable epoch inside the lock.
Because v1 rows live in the same file, truncation removes them too — no legacy re-import can restore cleared records.

Set aside: a durable analytics index or a Workspace-owned database. Both add an authority the Epic rejects; a disposable
rebuildable cache is sufficient for one developer, and load gets measured before either is reconsidered.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/shared/workflow/usage-reporting.ts` (new) — the reporting query, aggregation rules, day/gap classification, the
  disposable incremental cache, and the clear action's read-side invalidation.
- `src/shared/workflow/metrics-journal.ts` — clear's locked truncate/epoch-reset, and the invocation `historyEpoch`
  capture plus the `history_boundary` rejection in `appendWorkflowMetric`.
- `src/shared/workflow/metrics.js` — the legacy v1 read path feeding reporting with labeled partial fields; the v2 write
  path is unchanged except for carrying the captured history epoch into the invocation.
- `src/shared/workflow/usage-reporting.test.ts` (new) and `metrics-journal.test.js` — reporting fixtures and clear
  boundary tests.
- `docs/prd/runwield-core-prd.md` — the capability retitled to **Usage measurement and export** with the
  `usage-measurement-and-export` anchor, plus reporting, retention, gap, and deletion requirements and scenarios;
  references to the old `local-workflow-metrics` anchor updated in `docs/domain-language.md`,
  `docs/prd/runwield-workspace-prd.md`, and `docs/prd/runwield-acp-protocol-prd.md`.
- `docs/domain-language.md` — **Active day** and **Usage gap** entries for the report-visible concepts this change makes
  real; the existing **Usage observation**, **Collection epoch**, and **History epoch** entries stay authoritative.

## Reuse Opportunities

- `getWorkflowMetricsFilePath` and `resolvePrimaryCheckoutRoot` — canonical root to journal path; worktrees count once.
- The child 01 journal layout, guard/lock sequence, epoch markers, and `state.json` checkpoints — clear reuses the same
  serialization rather than adding a second one.
- `resolveCollectionEpoch` — already returns both `collectionEpoch` and `historyEpoch`; the invocation extension reads
  it, it is not rebuilt.
- The `V2_EVENTS`/`V2_LINKS` vocabulary in `metrics.js` — the field whitelist for aggregation; reporting reads the same
  shapes the writer sanitizes.
- Stable Session, segment, and Plan identifiers (`V2_LINKS`) — returned as links without constructing a writable Session
  manager.
- `defineGitFixture`, `makeValidationProjectRoot`, and `withProcessGlobalTestLock` for real files and clocks; only
  clocks are faked.

## Implementation Steps

- `src/shared/workflow/usage-reporting.ts` exists and exports a reporting query that returns settled totals, coverage
  and exclusion counts, daily buckets, backend and model breakdowns, and stable local identifiers, for an authorized
  Project root set, period, and time zone; results carry the reporting time zone and a recorded-through marker
  explicitly, so a phone and a desktop resolve the same day boundaries, and the recorded-through marker is the latest
  durable included row's timestamp, never `Date.now()`.
- Periods are half-open local intervals and remain correct across daylight saving changes; day boundaries are computed
  in the reporting zone, not by UTC arithmetic.
- Active days count only `execution_started` rows with `interactive` or user-started workflow continuation dispatch
  kinds, or `command_started` rows; `background_task_result` rows and open tabs do not count.
- Usage is bucketed to the observation's completion day; incomplete operations appear separately with no invented
  totals.
- Published changes count distinct `publication_confirmed` eventIds for executable Plans — not commits and not Epic
  containers; `validation_attempt` and `repair_round` figures remain separate counts.
- Ongoing and abandoned figures describe observed delivery workflows only, ongoing work is labeled as of its latest
  observation, and an interrupted Agent turn is never called abandoned.
- A disabled, legacy, unavailable, incomplete, or not-yet-collected interval is reported as a gap and is distinguishable
  from a known zero in a covered period; affected totals disclose their exclusions adjacent to the number.
- Legacy v1 rows surface only directly understood fields, labeled legacy/partial; tokens, cost, Plan joins, active days,
  and published changes are never inferred from v1 event volume, and no observation appears from both v1 and v2.
- The report cache is disposable and incrementally refreshed by new journal byte suffixes; rebuilding it leaves models,
  transcripts, and Plans untouched, and streaming avoids rescanning full history per request.
- Records do not expire with age or with Session deletion; no expiry logic exists in the reporting or journal modules.
- A clear action in the measurement module removes only the selected Projects' measurement history (v2 rows, v1 rows,
  and gap records alike), starts a fresh history epoch with a fresh-epoch marker row durably on disk, resets
  `state.json` counters and `outcomeEventOffsets`, and leaves Sessions, Plans, worktrees, and configuration intact; the
  collection epoch (enabled/disabled state) survives so recording continues seamlessly, and a new observation recorded
  after the clear persists and reports normally.
- `appendWorkflowMetric` captures the history epoch in its invocation and rejects a delayed settlement whose captured
  non-initial history epoch no longer matches the on-disk epoch, with reason `history_boundary`, even when the append
  arrives from another process.
- No transcript replay or legacy re-import restores cleared records.
- `docs/prd/runwield-core-prd.md` retitles the capability to **Usage measurement and export** with the
  `usage-measurement-and-export` anchor, adds the reporting, retention, gap, and deletion requirements with acceptance
  scenarios, keeps delivery conclusions owned by execution/validation/recovery, and leaves export requirements labeled
  target until children 06–08 deliver them; all in-repo references to the old anchor are updated in the same change.
- `docs/domain-language.md` defines **Active day** and **Usage gap** consistent with the delivered behavior, and its
  **Usage observation** entry links the retitled capability.

## Verification Plan

- Automated:
  `deno run -A scripts/run-tests.js src/shared/workflow/usage-reporting.test.ts src/shared/workflow/metrics-journal.test.js src/shared/workflow/metrics.test.js`,
  then `deno task ci` and `deno task doc-links:check` (the anchor retitle changes links).
- Real temporary files and Git repositories provide the journals; only clocks are faked. No seam is added for journal
  reads or Plan state; `deno task seams:check` passes.
- **Totals fidelity:** a hand-written journal with one `model_usage` row of known token counts and cost, one
  `response_latency` row of known milliseconds, and one `execution_finished` with an incomplete outcome reports exactly
  those token and cost totals in the backend/model breakdowns, and the incomplete operation appears in a separate list
  contributing zero to every total. A query that returns row counts instead of settled values fails this check.
- **Active-day rule:** a day containing only an `execution_started` row with `dispatchKind: "background_task_result"` is
  not active; a day with `dispatchKind: "interactive"` and a day with a `command_started` row are active. Counting any
  row as activity fails this check.
- A fixture with a known disabled day (a `collection_epoch` disabled transition), a legacy-only day (v1 rows only), and
  a genuine zero-activity covered day produces three distinguishable results, and only the third is a zero point; a
  mixed period reports its exclusion counts adjacent to the affected totals.
- A DST transition inside the period assigns observations to the correct local day with no double-counted or skipped
  hour (America/New_York November transition is a ready fixture), and an observation completing exactly at local
  midnight lands in the next day only.
- A journal with a failed `validation_attempt`, a `repair_round`, and one `publication_confirmed` reports one published
  change plus separate attempt and round counts; a repeated `publication_confirmed` eventId counts once. Ongoing and
  abandoned figures appear, and an interrupted turn is labeled ongoing, not abandoned.
- **Incremental refresh:** after a first query over a padded multi-megabyte journal, appended rows are absorbed by
  parsing only the new byte suffix — asserted with a parsed-line/byte counter on the reader, not by timing alone. A full
  rescan per query fails this check.
- Concurrent Sessions and processes retain valid, uniquely identified records through reporting; the cache replays by
  stable eventId so a refresh adds nothing.
- Kill/restart around a write exposes only persisted evidence and explicit incomplete records; a disk failure does not
  stop work and does not claim measurements were saved.
- **Clear round trip:** clear removes history for the selected Project only — a second Project's journal is
  byte-identical before and after; Sessions, Plans, worktrees, and configuration survive; a fresh history-epoch marker
  row is on disk after the clear. A new observation recorded after the clear persists and reports, and a pre-clear
  eventId does not resurrect. A paused second process — a real spawned `Deno.Command` child following the existing
  two-process pattern in `metrics-journal.test.js` — resumed after the clear appends nothing stale (its captured history
  epoch is rejected with `history_boundary`) and reads nothing cleared; restart and the legacy v1 reader cannot restore
  it.
- Reporting and cache rebuild leave models, transcripts, and Plans untouched.
- **Document truth:** `docs/prd/runwield-core-prd.md` contains the `usage-measurement-and-export` anchor with the
  reporting, retention, gap, and deletion requirement scenarios, and `docs/domain-language.md` defines **Active day**
  and **Usage gap**; a content check over both files is part of the focused test run, so skipped documentation fails the
  check.
- Existing protected behavior: child 01–03 recording, redaction, epoch boundaries, and worktree mapping still pass
  (`metrics.test.js`, `execution-metrics*.test.ts`, `workflow-outcome-observations.test.ts`). Expected to stop existing:
  nothing — this child is additive on the write side; the only `metrics-journal.ts` behavior change is the new
  `history_boundary` rejection, which no existing test exercises because no existing test clears history.

## Edge Cases & Considerations

- A lack of records cannot prove recording was disabled versus no activity; report the uncertainty rather than
  manufacturing a settings history.
- The same observation must not appear from both v1 and v2; v1 rows predate the v2 writer, and the report labels them
  legacy/partial rather than merging them into settled totals.
- Missing or deleted link targets leave readable measurements without fabricated navigation; the query returns stable
  identifiers and never resolves labels itself.
- Growing journals are handled by streaming and incremental cache refresh; a durable index stays deferred until measured
  load warrants it, and must remain rebuildable without transcripts.
- Clear on a journal with no history still starts a fresh history epoch; a first-ever append captured as `initial`
  before that clear is allowed to persist into the new epoch (it cleared nothing).
- Export-side deletion concerns — pending payloads and delivery fences — belong to child 07, which extends the history
  epoch defined here; child 09 wires the browser clear control to this action.
- Assumption: the active-day dispatch-kind set (`interactive`, `plan_execution`, `quick_fix`, `validation_repair`) is
  verified against call sites during implementation; if a kind turns out to be auto-started rather than user-started, it
  is excluded and the PRD scenario is corrected in the same change.
