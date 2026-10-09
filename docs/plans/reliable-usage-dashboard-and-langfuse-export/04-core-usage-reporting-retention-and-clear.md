---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/metrics.js"
    - "src/ui/workspace/server/owner-projects.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
createdAt: "2026-09-21T19:28:54.858Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 4
dependencies:
    - "03-workflow-outcome-observations"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "a3714639-e96c-4327-938f-aaef4aa87e1e"
---

# Core Usage Reporting, Retention, and Clear

## Context

Children 01–03 produce a durable, honest measurement history. Nothing can read it yet. The parent Epic requires one set
of reporting rules inside the measurement module, so the Workspace page and any later exporter consume the same numbers
instead of computing competing totals.

The Epic also fixes retention: local records live until the owner deletes them, with no age-based expiry, and a
deliberate clear removes measurement history only — never Sessions, Plans, worktrees, or configuration.

Owning PRD: the Core **Usage measurement and export** capability created in child 01 gains the reporting, retention, and
deletion requirements and scenarios here.

## Objective

A reporting query that accepts an authorized set of Project identities, a period, and a reporting time zone, and returns
settled totals, coverage and exclusion counts, daily buckets, backend and model breakdowns, and stable local identifiers
for links. Plus a clear action that removes selected Project history and makes it unrecoverable through replay or legacy
readers.

## Approach

```text
query(projectIds, period, timeZone)
  -> stream per-Project journals (new suffixes where possible)
  -> replay by stable ID into a disposable in-memory cache (idempotent)
  -> include safe legacy v1 readers, labeled legacy/partial
  -> aggregate: totals, coverage, exclusions, daily buckets, breakdowns
  -> return with explicit host time zone and recorded-through marker
```

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

Clear:

```text
clear(projectIds)
  -> serialize with appends under the same lock
  -> remove measurement history for those Projects
  -> start a fresh history epoch so old payloads cannot reappear
  -> a delayed settlement from an older history epoch is discarded, even cross-process
```

Set aside: a durable analytics index or a Workspace-owned database. Both add an authority the Epic rejects; a disposable
rebuildable cache is sufficient for one developer, and load gets measured before either is reconsidered.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- The Core measurement module from child 01 — reporting queries, aggregation rules, the disposable incremental cache,
  and clear/history-epoch handling.
- `src/shared/workflow/metrics.js` — legacy v1 read path feeding reporting with labeled partial fields.
- A Core-side authorization boundary that accepts Project identities from a caller; Core does not import Workspace
  SQLite.
- `docs/prd/runwield-core-prd.md` — reporting, retention, gap, and deletion requirements and scenarios under **Usage
  measurement and export**.
- `docs/domain-language.md` — only if reporting introduces a term that needs disambiguation; **Usage observation**
  already landed in child 01.

## Reuse Opportunities

- Canonical-root membership and primary-checkout normalization — worktrees count once, Workspace registration IDs stay
  distinct and are resolved by the caller.
- The child 01 journal layout, epoch markers, and lock — clear reuses the same serialization rather than adding a second
  one.
- Stable Session, segment, and Plan identifiers — returned as links without constructing a writable Session manager.
- `defineGitFixture`, `makeValidationProjectRoot`, and `withProcessGlobalTestLock` for real files and clocks.

## Implementation Steps

- A reporting query returns settled totals, coverage and exclusion counts, daily buckets, backend and model breakdowns,
  and stable local identifiers, for an authorized Project set, period, and time zone.
- Aggregation reads collected measurements and safe legacy readers only; it cannot construct a writable Session manager,
  scan transcripts for usage, contact a model, or infer success from Plan status.
- Results carry the reporting time zone and a recorded-through marker explicitly, so a phone and a desktop resolve the
  same day boundaries.
- Periods are half-open local intervals and remain correct across daylight saving changes.
- Active days count only accepted human requests or explicit user-started workflow continuations; open tabs and
  unattended background activity do not count.
- Usage is bucketed to the observation's completion day; incomplete operations appear separately with no invented
  totals.
- Published changes count distinct confirmed delivery attempts for executable Plans — not commits and not Epic
  containers.
- Validation attempts and repair rounds remain separate counts.
- Ongoing and abandoned figures describe observed delivery workflows only, ongoing work is labeled as of its latest
  observation, and an interrupted Agent turn is never called abandoned.
- A disabled, legacy, unavailable, incomplete, or not-yet-collected interval is reported as a gap and is distinguishable
  from a known zero in a covered period.
- Affected totals disclose their exclusions adjacent to the number.
- The report cache is disposable and incrementally refreshed; rebuilding it leaves models, transcripts, and Plans
  untouched, and streaming avoids rescanning full history per request.
- Records do not expire with age or with Session deletion.
- A clear action removes only the selected Projects' measurement history, starts a fresh history epoch, and leaves
  Sessions, Plans, worktrees, and configuration intact.
- Clear serializes its epoch change with appends; a delayed settlement from an older history epoch is discarded even
  when it arrives from another process.
- No transcript replay or legacy re-import restores cleared records.
- `docs/prd/runwield-core-prd.md` names the reporting, retention, gap, and deletion requirements with acceptance
  scenarios, keeping delivery conclusions owned by execution/validation/recovery.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/workflow` plus focused reporting tests; then `deno task ci`.
- Real temporary files and Git repositories provide the journals; only clocks are faked.
- A fixture with a known disabled day, a legacy-only day, and a genuine zero-activity covered day produces three
  distinguishable results, and only the third is a zero point.
- A DST transition inside the period assigns observations to the correct local day with no double-counted or skipped
  hour.
- A failed validation, a repair, and one confirmed publication report one published change plus separate attempt and
  round counts.
- Concurrent Sessions and processes retain valid, uniquely identified records through reporting.
- Kill/restart around a write exposes only persisted evidence and explicit incomplete records.
- A disk failure does not stop work and does not claim measurements were saved.
- Clear removes history for the selected Project only; a paused second process resumed after the clear appends nothing
  stale and reads nothing cleared; restart and the legacy reader cannot restore it.
- Reporting and cache rebuild leave models, transcripts, and Plans untouched.
- Existing protected behavior: child 01–03 recording, redaction, and worktree mapping still pass.
- `deno task seams:check` passes with no new seam for journal reads or Plan state.

## Edge Cases & Considerations

- A lack of records cannot prove recording was disabled versus no activity; report the uncertainty rather than
  manufacturing a settings history.
- Legacy v1 fields expose only understood meanings, labeled legacy/partial; missing tokens, cost, Plan joins, and active
  days are never inferred from event volume.
- The same observation must not appear from both v1 and v2.
- Missing or deleted link targets leave readable measurements without fabricated navigation.
- Growing journals are handled by streaming and incremental cache refresh; a durable index stays deferred until measured
  load warrants it, and must remain rebuildable without transcripts.
- Export-side deletion concerns — pending payloads and delivery fences — belong to child 07, which extends the history
  epoch defined here.
