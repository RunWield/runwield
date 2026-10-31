---
planId: "bff745e6-ef31-44cf-a93b-5417e5d5eb23"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/metrics.js"
    - "src/shared/workflow/metrics-journal.ts"
    - "src/shared/workflow/execution-metrics.ts"
    - "src/shared/workflow/usage-reporting.ts"
    - "src/shared/workflow/metrics-export-scheduler.ts"
    - "src/shared/workflow/metrics-export-ledger.ts"
    - "src/shared/workflow/metrics-export-grants.ts"
    - "src/ui/workspace/server/owner-usage-settings.ts"
    - "src/ui/workspace/routes/api/review-agent-handlers.js"
    - "src/shared/session/backends/claude-cli/stream-parser.ts"
    - "src/tools/see-image.ts"
    - "src/shared/session/session.js"
    - "src/shared/remote/bounded-model-session.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
    - "docs/user-documentation/settings.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25T00:21:02.248Z"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 11
dependencies: []
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "Metrics Epic Review Fixes"
validatedCommit: "7c4c4f2db949c04440332fdb166166ba12b013c0"
status: "verified"

archivedAt: "2026-10-30T03:46:23.660Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/reliable-usage-dashboard-and-langfuse-export/11-repair-integration-findings.md"
---

# Repair integration findings

## Context

The integration gate checked the Epic branch `epic/reliable-usage-dashboard-and-langfuse-export` at
`dc60183fbca4687286bda57fa9389de452e1c5f1` and rejected it with the 13 findings below. The full report is
`docs/plans/reliable-usage-dashboard-and-langfuse-export/integration-report.md`. After this child is delivered, the
integration gate runs again on the whole Epic.

The findings fall into five problems:

| Area                                  | Findings                 | What goes wrong today                                                  |
| ------------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| Project identity                      | R2-1                     | Two Project roots can share one journal, report, clear, and grant.     |
| Consent and history boundaries        | R2-2, R2-3, R2-4         | Work started while off, or before a clear, can enter the new history.  |
| Measurement start for auxiliary calls | R2-5, R2-7, R2-11        | Guided Review, compaction, and vision calls start with no measurement. |
| Export authorization and recovery     | R2-6, R2-7, R2-12        | Sends after clear or revoke; old work exports; revoked entries stick.  |
| Usage accounting and documentation    | R2-8, R2-9, R2-10, R2-13 | Lost Claude turns, wrong day, false complete coverage, stale docs.     |

### Product ownership

The Core PRD capability [Usage measurement and export](../../prd/runwield-core-prd.md#usage-measurement-and-export)
owns every requirement here. This repair changes these named requirements:

- **Changed — "Collection epochs reflect observed boundaries, not inferred disabled durations."** Today Core observes
  settings lazily. After this change, the normal recording control commits a boundary. A direct settings-file edit is
  still observed lazily.
- **Changed — "Core owns delivery authorization and lifecycle."** Today Core releases the guard before dispatch. After
  this change, Core hands the request to the worker under the guard and awaits the network result after release.
- **Changed — "Auxiliary calls use the same opt-in measurement history without duplicate accounting."** Each
  RunWield-started auxiliary call records its measurement start before the model call, and failed calls record
  incomplete measurement.
- **Changed — "Record structured workflow observations locally…"** One journal per primary Project still holds. Its
  directory name becomes collision-resistant.
- **Preserved and now delivered — "Export only under explicit destination consent."** An execution that started before
  the grant position is never exported. Rows without an execution, such as workflow outcomes, start at their own
  position. This repair makes missing start evidence fail closed.
- **Preserved and now delivered — "Active days require human input evidence."** Usage belongs to the observation's
  completion day.
- **Preserved and now delivered — "Supported backends preserve their measurement detail and upstream limits."** Claude
  turn totals count once per turn.
- **Preserved — "Keep and clear measurement history…"**, opt-in recording, no journal for opt-out installs, and the
  1-second recording lock budget.

The glossary entry **Collection epoch** in `docs/domain-language.md` says epochs are "lazily observed by Core". That
changes with R2-2.

> [!NOTE]
> **The old initial-epoch exemption ends**
>
> A project memory records that a captured `initial` history epoch is exempt from the clear timestamp fence for an
> empty history. R2-4 removes that exemption on purpose. Any clear now rejects an older `initial` capture.

## Findings

### R2-1. Different Project roots can share one measurement journal

Source: Integration review

Requirement: Use a collision-resistant canonical Project identity. Reports, clear actions, and export grants must remain Project-specific.

Evidence: metrics.js:getWorkflowMetricsFilePath uses encodeCwdForSessionDir. session-directory-name.ts:5–7 maps both /tmp/a-b and /tmp/a/b to --tmp-a-b--. The new usage-reporting.ts:projectIdentity hashes that same directory name and reads all its rows. metrics-export-scheduler.ts:scanProject does not check the row's cwdHash. Thus, reporting or clearing Project A includes Project B, and an export grant for A can export B's measurements.

### R2-2. Recording controls do not commit collection boundaries

Source: Integration review

Requirement: Normal recording controls must change collection epochs atomically with journal authorization. Disable/re-enable periods must remain gaps.

Evidence: owner-usage-settings.ts:mutateUsageSettings('recording') calls setCustomSetting only. settings.js:setCustomSetting writes configuration without the journal lock or an epoch marker. metrics-journal.ts:appendWorkflowMetric detects changes lazily. Disable and re-enable between appends leaves the old epoch unchanged and no disabled-period evidence. A setting write can also occur after an append's enabled check because the two operations use different locks.

### R2-3. Model settlements use current consent instead of invocation-start consent

Source: Integration review

Requirement: An invocation is eligible only if recording was enabled at its start and its collection epoch remains current.

Evidence: execution-metrics.ts:ExecutionMetricsRecorder captures historyEpoch but not collection enablement or collectionEpoch. metrics.js:recordWorkflowMetric resolves both from current settings for each fresh row. Pi reconciles entries at execution settlement in session.js:4735 and 5060. Starting with recording off, then enabling before settlement, records the earlier disabled work. The same omission lets late backend settlements cross collection epochs.

### R2-4. The initial-history exception allows stale writes after clear

Source: Integration review

Requirement: Clear must reject delayed observations from an older history epoch, including observations from another process.

Evidence: metrics-journal.ts:462–478 exempts invocation.historyEpoch === 'initial' from both history checks. Writer A can capture initial, writer B can create nonempty history, and clear can then replace that history while preserving the collection epoch. When A resumes, both history guards are bypassed and its pre-clear observation is appended to the new history.

### R2-5. External Guided Review captures its history boundary after the work finishes

Source: Integration review

Requirement: Clear must discard delayed settlements from the old history. Auxiliary invocations must establish measurement identity before use.

Evidence: review-agent-handlers.js:addGuideJobUsage retains usage while the command runs, but recordGuideJobMetric creates ExecutionMetricsRecorder only at settlement (lines 314–336). A clear between a usage frame and settlement causes the recorder to capture the new history epoch. The old usage subtotal then enters the cleared history.

### R2-6. Export dispatch occurs after its authorization locks are released

Source: Integration review

Requirement: Persist intent and dispatch the authorized worker request under the control lock. Clear or revoke must prevent requests that have not yet been dispatched.

Evidence: metrics-export-scheduler.ts:346–401 returns the saved intent from withExportConfigurationLock/withWorkflowMetricJournalLock, releases both locks, awaits buildMetricsExportObservation, and only then calls callExporter. Another process can complete clear or revoke during this gap. The saved row and credentials are still sent without another authorization check. The confirm path has the same gap.

### R2-7. Export eligibility admits auxiliary work started before approval

Source: Integration review

Requirement: Export must include only operations started after the grant boundary, not old operations that complete later.

Evidence: metrics-export-scheduler.ts:144–159 excludes only executions with an execution_started row before the grant offset. SessionContextMetricsRecorder in execution-metrics.ts:32–115 never writes that start for its internal usage recorder. A manual compaction started before approval therefore records model_usage after approval and is exported. External Guided Review also has no pre-invocation start row. Missing start evidence currently authorizes export instead of excluding uncertain eligibility.

### R2-8. Claude steering drops usage from later results in the same process

Source: Integration review

Requirement: Supported Claude work must contribute once, without losing later cumulative or distinct turn totals.

Evidence: claude-cli/execution-session.ts now sends steering into the active process and permits further results while steering remains pending. stream-parser.ts:259 gives every result the sourceId claude_turn_total. execution-metrics.ts:1170–1171 rejects every later observation with that sourceId. The first result is retained even when later results contain additional usage.

### R2-9. The report ignores observed model completion time

Source: Integration review

Requirement: Usage must belong to its completion day and the correct half-open reporting period.

Evidence: usage-reporting.ts:261–262 uses completedAt or ts, but not endedAt. agy-cli/execution-session.ts records usageEndedAt when usage arrives, then passes it as endedAt only after process and bridge cleanup. execution-metrics.ts supplies no observedAt for this path, so ts becomes recording time. If cleanup crosses midnight or a period boundary, the report assigns the usage to the wrong day.

### R2-10. A failed usage append can still produce complete coverage

Source: Integration review

Requirement: Storage failure must remain fail-honest: missing persisted usage must produce degraded coverage, not a complete zero.

Evidence: execution-metrics.ts:recordModelUsage sets usageCoverage and marks sourceId reconciled before awaiting recordWorkflowMetric, then ignores its persisted result. settleExecution can subsequently save coverage.usage='complete' after a failed model_usage append. usage-reporting.ts adds missing-usage exclusions only when execution_finished declares partial or unavailable coverage. A failed usage write followed by a successful settlement can therefore report zero usage with no observation exclusions.

### R2-11. Vision failures have no measurement start or incomplete observation

Source: Integration review

Requirement: RunWield-started auxiliary calls must have identities before invocation and expose incomplete measurement when settlement evidence is missing.

Evidence: see-image.ts calls completeSimpleFn before creating a usage observation. Error or aborted responses throw before onModelUsage runs, and there is no start observation. session.js:onModelUsage creates a fallback recorder only after successful completion. A failed or interrupted vision request therefore leaves no pending measurement or unavailable-usage evidence, even when the response contains usage.

### R2-12. Crash recovery leaves revoked destinations permanently in flight

Source: Integration review

Requirement: Process loss must change unfinished export attempts to uncertain delivery, and clear must distinguish actual in-flight requests.

Evidence: metrics-export-scheduler.ts:runMetricsExportCycle recovers sending/confirming ledger entries only while iterating current grants. Revoke removes the grant. If the sender then dies before settlement, that ledger is never recovered. metrics-export-ledger.ts:metricsDeliveryInFlightForJournal still counts its sending/confirming entry, so later clears continue to report delivery in flight after restart.

### R2-13. Settings documentation still claims that reporting and upload do not exist

Source: Integration review

Requirement: Update settings documentation to describe the delivered Usage report and optional export without contradictory capability claims.

Evidence: docs/user-documentation/settings.md:541–542 says metrics are record-only, there is no reporting UI or analytics sync, and nothing is uploaded. The same file later documents Usage and destination export controls. The obsolete statement gives incorrect guidance about the assembled feature.

## Objective

Every finding above is fixed on the Epic branch, with a behavioral test that fails on `dc60183` and passes after the
fix. The Core PRD, glossary, and user documentation describe the delivered behavior.

## Approach

The fixes share one rule: **a measurement is decided when its work starts, not when its row is written.** Every
invocation captures its Project, recording consent, collection epoch, and history epoch before the model call. The
journal append then rejects the row if any of those changed.

```text
invocation start
  resolveMeasurementProject(root)          # R2-1: one canonical identity
  capture { enabled, collectionEpoch, historyEpoch }   # R2-3, R2-4
  write execution_started                  # R2-5, R2-7, R2-11: start evidence
model call …
settlement
  append rows with the captured epochs     # journal rejects stale captures
  coverage changes only after persisted:true   # R2-10
```

### 1. One canonical Project identity (R2-1)

A new owner function in `metrics.js`, `resolveMeasurementProject(root)`, returns `{ root, key, journalPath }`:

- `root` is the realpath of the primary checkout root. It falls back to `path.resolve()` when the root does not exist.
- `key` is the full SHA-256 hex of `root`.
- `journalPath` is `~/.wld/workflow-metrics/<sanitized basename, at most 40 chars>-<key>/metrics.jsonl`.

Every consumer uses it: `getWorkflowMetricsFilePath`, the `cwdHash` of new rows, `usage-reporting.ts`
`projectIdentity` and `usageProjectIdentityForRoot`, grant canonicalization in `metrics-export-grants.ts`, and
`canonicalRoot` in `owner-usage-settings.ts`. The alias-preference logic in `journalPaths` goes away.
`encodeCwdForSessionDir` does not change, because Sessions and worktrees also use it.

`metricsDeliveryInFlightForJournal` matches ledger items by `projectRef` instead of `journalRef`. `projectRef` does not
depend on the journal path, so entries written before the move still count.

**Legacy adoption.** On first resolve, if `journalPath` is absent and a legacy directory exists at the old lossy name,
Core adopts it once under the legacy journal guard:

```text
adoptLegacyJournal(project)
  lock legacy guard (bounded try); finish pending clear/repair
  if every data row's cwdHash is one of this Project's spellings
    rename legacy dir → new dir        # bytes, state.json, epochs, grant offsets unchanged
  else                                 # a real collision
    create the new journal with a fresh history epoch
    write a measurement_gap marker with reason legacy_shared_journal
    copy only data rows whose cwdHash is one of this Project's spellings
    move any grant start for this Project to the new journal's end
    leave the legacy file unchanged
```

A process that loses the rename race sees `ENOENT` or `ENOTEMPTY` and uses the new directory.

**Decision (owner, Plan review):** in a real collision, copy only the attributable rows. Copied rows show in the report
but never export, because the grant start moves to the new end. The legacy file stays unchanged. `cwdHash` already
distinguishes the two Projects. A real collision needs two roots that differ only by `/` versus `-`, so the case is
rare.

Option set aside: keeping the old path and filtering rows by `cwdHash` everywhere. That needs per-Project tombstones for
clear, two epochs per reader, and two offsets per grant, permanently.

### 2. Consent and history boundaries (R2-2, R2-3, R2-4)

**Recording control commits a host-level generation (R2-2).** The Workspace `recording` action is the only normal
control that writes `workflowMetrics`. TUI `/settings` and the CLI do not write it. The control writes the global
setting, so one change affects every Project. Core therefore keeps one host-level recording generation instead of
looping over Project journals.

```text
setWorkflowMetricsRecording(enabled)          # new, metrics-journal.ts
  lock ~/.wld/workflow-metrics/recording.guard exclusive (bounded, retryable error)
  write recording.json { generation: uuid }   # first: a crash leaves only an extra boundary
  setCustomSetting("workflowMetrics", …, "global")

appendWorkflowMetric
  lock journal guard
  lock recording.guard shared (same deadline)   # order: journal → recording, never reversed
  if state.recordingGeneration ≠ current generation and the Project has no project-scope override
    new epoch id "gen:<generation>"; write collection_epoch marker
  … existing checks and write, both locks held
```

- `resolveCollectionEpoch` reads `recording.json` without a lock and predicts the same `gen:<generation>` id. All
  invocations captured after one control change share that epoch. Captures from before it get `collection_boundary`.
- Disable followed by enable creates two generations, so the disabled period stays a gap.
- An opt-out install gets no journal: `recording.json` lives outside Project journals, and the early `disabled` return
  stays.
- A direct settings-file edit has no generation change. The existing lazy detection still handles it.
- Cost: one extra shared, non-contending lock and one small read per append, inside the existing 1-second budget.

> [!NOTE]
> **Assumption: project overrides keep their epoch**
>
> A Project with its own project-scope `workflowMetrics` value does not get a boundary from a global change. Its
> effective state did not change. This is a reviewable assumption.

**Capture consent at start (R2-3).** The `ExecutionMetricsRecorder` constructor resolves
`resolveCollectionEpoch(path, isWorkflowMetricsEnabled(merged setting))` once. It stores
`{ collectionEnabledAtCall, collectionEpoch, historyEpoch }` and adds all three to `baseLinks()`.
`recordWorkflowMetric` uses a supplied `collectionEpoch` and `collectionEnabledAtCall` for every row, not only retries.
After a persisted `recordExecutionStart`, the recorder adopts the saved `collectionEpoch` as well as the
`historyEpoch`. `SessionContextMetricsRecorder` sends its inner recorder's captured epochs on its own rows.

**Replace the `initial` exemption with an alias (R2-4).**

```diff
 appendWorkflowMetric history guards
-  skip both guards when invocation.historyEpoch === "initial"
+  if invocation.historyEpoch === "initial"
+    accept only if state.historyEpoch is "initial" or equals state.initialHistoryEpoch
+  timestamp fence applies unless that alias check passed
```

- Each place that turns `initial` into a UUID sets `state.initialHistoryEpoch`: `repairJournalTail`,
  `withWorkflowMetricJournalLock`, and `appendWorkflowMetric`. `scanJournalLines` rebuilds it when `state.json` is lost.
- `clearWorkflowMetricJournal` never carries the alias into the new history.
- Two writers that both captured `initial` before any history existed are still accepted. A capture from before any
  clear is rejected.

> [!WARNING]
> **One existing test changes meaning**
>
> `metrics-journal.test.js` "first-ever pending append with an earlier timestamp survives empty-history clear" accepts
> an `initial` capture after a clear. After this change, that capture is rejected. Invert the test; do not delete it.

### 3. Measurement start for auxiliary calls (R2-5, R2-7, R2-11)

External Guided Review, manual compaction, and the `see_image` fallback all start model work with no measurement start.
They get one shared shape: create the recorder before the call, write a start, and settle in `finally`.

**Decision (owner, Plan review):** auxiliary calls reuse `execution_started` and `execution_finished` with
`dispatchKind: "auxiliary"` and `userInitiated: false`. This needs no schema change. It delivers R2-11's "incomplete
measurement" through the report's existing start-without-finish rule, and export eligibility already reads starts.
Active days stay correct because auxiliary starts are not user-initiated. A failed auxiliary call appears in the
report's incomplete list, which is the intended result for a failed measurement.

- **External Guided Review (R2-5).** `runGuideJob` creates `entry.metricsRecorder` before `runGuideCommand` for
  external, non-fixture engines and awaits `recordExecutionStart`. `recordGuideJobMetric` reuses it, records usage,
  and calls `settleExecution` with the job outcome. The `guided_review_generation_result` row carries the epochs
  captured at job start for every engine. `sourceSurface` uses an allowed value; `"guided_review"` is dropped by the
  sanitizer today.
- **Manual compaction.** `SessionContextMetricsRecorder.start()` awaits the inner recorder's start before
  `compaction_started`. `finish()` settles it with the compaction outcome. The caller at `session.js` (~3236) awaits
  `start()` instead of `void`.
- **Vision fallback (R2-11).** `createSeeImageTool` gains a start hook that runs before `completeSimpleFn` and returns a
  measurement handle:
    - On success, the handle records the request observation, as today.
    - On an `error` or `aborted` response, it records the response usage with `measurementAvailability` `partial` or
      `unavailable` and a content-free `unavailableReason`.
    - On a thrown error with no response, it records an `unavailable` observation.
    - In `session.js`, the hook uses the active execution recorder captured at call start. When none exists, it
      creates an auxiliary recorder, writes its start, and settles it after the call.
    - `remote/bounded-model-session.ts` uses the same hook.

### 4. Export authorization, eligibility, and recovery (R2-6, R2-7, R2-12)

**Dispatch under the lock (R2-6).** The export worker is a `Worker` thread in the same process. The only step RunWield
controls is `worker.postMessage(request)`. That step is synchronous, so "dispatch" means "`postMessage` returned".

```diff
 deliver
+  build observation; spawn worker          # before any lock
   lock .send.lock (try) → .config.lock → journal guard
     check consent, approval, history, row identity at offset
     append send intent (synced)
-  release locks
-  build observation; spawn worker; postMessage
+    postMessage(request)                   # still under both locks
+  release locks
   await result                             # network I/O outside locks
```

- If authorization fails or the signal aborts, Core terminates the pre-spawned worker.
- The locked callback returns `{ intent, pending }` in an object. A bare promise would make
  `withWorkflowMetricJournalLock`'s `return await run()` hold the journal lock across network I/O.
- The confirm path changes the same way.
- The comment on `withWorkflowMetricJournalLock` changes to: "must not await network I/O; may hand an authorized
  request to a pre-spawned worker."
- Clear already takes the journal guard and revoke takes the configuration lock, so no new lock is needed.

**Fail closed on missing start evidence (R2-7).** `scanProject` changes from an exclude list to an allow list:

- `startedExecutions` holds each v2 `execution_started` row seen in the current history, scanning from the boundary.
  The boundary is the grant offset in the same history epoch, or 0 in a new history.
- An exportable row with an `executionId` is queued only if its ID is in `startedExecutions`.
- A row without an `executionId`, such as a workflow outcome, stays eligible at its own position. The PRD says this
  already.
- A saved cursor without `startedExecutions` is rebuilt from the boundary. Ledger keys prevent a duplicate send.

**Recover every destination (R2-12).**

- `recoverAbandonedDeliveries(destinationId)` moves out of the per-grant loop.
- Before the no-grants return, `runMetricsExportCycle` visits every directory under `destinations/`. When it can take
  that destination's `.send.lock`, it recovers: `sending` becomes `unconfirmed` with `process_lost`, and `confirming`
  ends. It releases the lock for revoked destinations.
- An entry is in flight only if its state is `sending` or `confirming` **and** a try of its `.send.lock` fails. The OS
  releases that lock when the process dies, so a dead holder is never counted. `metricsDeliveryInFlightForJournal` and
  `metricsDeliveryInFlight` both use this check. A try is non-blocking, so it is safe under the journal guard or the
  configuration lock.

### 5. Usage accounting (R2-8, R2-9, R2-10)

**Claude turns (R2-8).** In streaming input mode, each turn emits its own `result`. The
[Claude Agent SDK cost guide](https://docs.claude.com/en/docs/agent-sdk/cost-tracking) says `usage` covers only that
turn, while `total_cost_usd` and `modelUsage` are running totals for the whole process. So the parser in
`stream-parser.ts` keeps a per-stream result ordinal:

- Turn rows get `sourceId` `claude_turn_total:<ordinal>`. Each turn's `usage` counts once.
- Turn cost is `total_cost_usd` minus the previous result's value in the same stream. The first result uses its full
  value.
- Per-model rows get `claude_model_<index>:<ordinal>` and stay `alternative`, so reports and export still exclude them.

**Completion time (R2-9).** `recordModelUsage` sets `ts` from `observedAt`, else from `endedAt`. That puts the row on
its completion day and lets the clear timestamp fence see the observed time. `usage-reporting.ts` `observationTime`
uses `completedAt`, then `endedAt`, then `ts`. The reader change handles rows already written with recording time in
`ts`.

**Coverage after persistence (R2-10).**

```diff
 recordModelUsage
-  mark sourceId reconciled; update usageCoverage
-  await recordWorkflowMetric(...)          # result ignored
+  skip if sourceId is reconciled or pending; mark it pending
+  result = await recordWorkflowMetric(...)
+  if result.persisted: mark reconciled; update usageCoverage as today
+  else: clear pending; usageIncomplete = true; coverage becomes partial (some usage saved) or unavailable (none)
```

Once an execution has lost a usage row, its settlement never reports `complete`. The report already adds exclusions for
`partial` and `unavailable` coverage.

### 6. Documentation (R2-13 and PRD synchronization)

- `docs/user-documentation/settings.md`: remove the "record-only" paragraph. Describe the Workspace Usage report, clear,
  and optional export, and that export needs a separate approval. Replace `<encoded-project-root>` with the new
  directory name in the settings table and "Where records go".
- `docs/architecture.md` lines that name `<encoded-project-root>` get the same path update.
- The Core PRD requirements listed under Product ownership match delivered behavior.
- `docs/domain-language.md` **Collection epoch**: normal recording controls commit boundaries; direct settings edits are
  still observed lazily.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/metrics.js` — `resolveMeasurementProject`, legacy adoption call, `cwdHash`, and use of captured
  epochs in `recordWorkflowMetric`.
- `src/shared/workflow/metrics-journal.ts` — `setWorkflowMetricsRecording`, recording generation, the `initial` alias,
  and the updated lock comment.
- `src/shared/workflow/execution-metrics.ts` — start-time consent capture, `SessionContextMetricsRecorder` start and
  settlement, `recordModelUsage` ordering and `ts`.
- `src/shared/workflow/usage-reporting.ts` — canonical Project identity and `observationTime`.
- `src/shared/workflow/metrics-export-scheduler.ts` — dispatch under lock, allow-list eligibility, all-destination
  recovery.
- `src/shared/workflow/metrics-export-ledger.ts` — lock-aware in-flight checks and `projectRef` matching.
- `src/shared/workflow/metrics-export-grants.ts` — canonical root from `resolveMeasurementProject`.
- `src/ui/workspace/server/owner-usage-settings.ts` — recording action calls `setWorkflowMetricsRecording`;
  `canonicalRoot` uses the shared identity.
- `src/ui/workspace/routes/api/review-agent-handlers.js` — recorder created and started before the guide command.
- `src/shared/session/backends/claude-cli/stream-parser.ts` — per-result source identity and cost delta.
- `src/tools/see-image.ts`, `src/shared/session/session.js`, `src/shared/remote/bounded-model-session.ts` — vision start
  hook and failure observations; awaited compaction start.
- `src/testing/metrics-export-fixture.ts`, `src/testing/workflow-metrics-fixture.ts` — fixtures follow the new path.
- `docs/prd/runwield-core-prd.md`, `docs/domain-language.md`, `docs/user-documentation/settings.md`,
  `docs/architecture.md` — synchronized descriptions.

Out of scope: `encodeCwdForSessionDir` for Sessions and worktrees, and cost inflation from a resumed Claude session (see
Edge Cases).

## Reuse Opportunities

- `src/shared/native-file-lock.ts` `openNativeFileLock` — shared and exclusive `flock` for `recording.guard`, and the
  non-blocking `.send.lock` try.
- `src/shared/private-json-file.ts` `writeTextAtomically` — `recording.json`.
- `ExecutionMetricsRecorder.recordExecutionStart` and `settleExecution` — the auxiliary start and settlement.
- The existing `tryExportLock` and recovery block in `metrics-export-scheduler.ts` — extracted, not rewritten.
- `defineGitFixture`, `metrics-export-fixture.ts` `hold()` and `release()`, and child-process cycle tests in
  `metrics-export-process.test.ts` — real cross-process evidence without new seams.

## Implementation Steps

1. `resolveMeasurementProject(root)` in `src/shared/workflow/metrics.js` returns the realpath primary root, its full
   SHA-256 `key`, and a journal path whose directory is `<sanitized basename>-<key>`. `/tmp/x/a-b` and `/tmp/x/a/b`
   resolve to different journal paths.
2. `getWorkflowMetricsFilePath`, new-row `cwdHash`, `usage-reporting.ts` `projectIdentity` and
   `usageProjectIdentityForRoot`, `metrics-export-grants.ts` root canonicalization, and `owner-usage-settings.ts`
   `canonicalRoot` all derive identity from `resolveMeasurementProject`. No reader derives identity from a directory
   name.
3. On first resolve, a legacy lossy-name journal whose data rows all belong to the Project is renamed, under the legacy
   guard, to the new directory with identical bytes and `state.json`. In a real collision, each Project's new journal
   starts a fresh history epoch with a `legacy_shared_journal` gap marker. It contains only data rows whose `cwdHash`
   matches that Project, and any grant start for that Project moves to the new end. The legacy file stays unchanged. A
   second adopter that loses the race uses the new directory.
4. `metricsDeliveryInFlightForJournal` matches ledger items by `projectRef`.
5. `setWorkflowMetricsRecording(enabled)` in `metrics-journal.ts` writes `recording.json` with a fresh generation and
   then the global setting, both under an exclusive `recording.guard`. `mutateUsageSettings('recording')` calls it
   instead of `setCustomSetting`.
6. `appendWorkflowMetric` holds the journal guard and a shared `recording.guard` from its settings read through its
   write. A changed generation starts epoch `gen:<generation>` and writes a `collection_epoch` marker, except for a
   Project with a project-scope `workflowMetrics` value. `resolveCollectionEpoch` predicts the same id. An opt-out
   install still creates no journal.
7. `ExecutionMetricsRecorder` captures `collectionEnabledAtCall`, `collectionEpoch`, and `historyEpoch` in its
   constructor and sends them on every row. `recordWorkflowMetric` uses supplied values for fresh rows, not only
   retries. A persisted start updates both epochs. `SessionContextMetricsRecorder` rows carry the inner recorder's
   epochs.
8. `appendWorkflowMetric` accepts an `initial` history capture only when the current history is `initial` or equals
   `state.initialHistoryEpoch`. All three materialization sites set the alias, `scanJournalLines` rebuilds it, and
   `clearWorkflowMetricJournal` never carries it forward.
9. External Guided Review creates and starts its recorder before `runGuideCommand` and settles it in `finally` with the
   job outcome. `guided_review_generation_result` carries start-time epochs. Its `sourceSurface` survives
   sanitization.
10. Manual compaction awaits a start of the inner usage recorder before `compaction_started` and settles it in
    `finish()`. The `session.js` caller awaits `start()`.
11. The `see_image` tool calls a start hook before `completeSimpleFn`. Success, `error`/`aborted` responses, and thrown
    errors each record one observation; failures record `partial` or `unavailable` with a content-free reason. With no
    active execution recorder, `session.js` and `bounded-model-session.ts` create, start, and settle an auxiliary
    recorder around the call.
12. Every auxiliary start from steps 9–11 is an `execution_started` row with `dispatchKind: "auxiliary"` and
    `userInitiated: false`, settled by `execution_finished`. No new event name exists, auxiliary starts add no Active
    day, and an auxiliary start without a finish appears as incomplete in the report.
13. The deliver and confirm paths in `metrics-export-scheduler.ts` build the observation and spawn the worker before
    locking, and call `postMessage` inside the configuration and journal locks after authorization. Network results
    are awaited after release. A failed authorization terminates the worker. The `withWorkflowMetricJournalLock` comment
    states the new rule.
14. `scanProject` queues an execution-scoped row only when its `executionId` has a start at or after the boundary in the
    same history. Rows without `executionId` keep position-based eligibility. Cursors without `startedExecutions` are
    rebuilt.
15. `runMetricsExportCycle` recovers abandoned `sending` and `confirming` entries for every destination directory,
    including revoked ones, before its no-grants return. In-flight checks count an entry only while another process
    holds its `.send.lock`.
16. The Claude stream parser gives each `result` its own ordinal `sourceId` for turn and per-model rows, and turn cost is
    the running-total delta within the stream.
17. `recordModelUsage` sets `ts` from `observedAt`, else `endedAt`. `usage-reporting.ts` `observationTime` prefers
    `completedAt`, then `endedAt`, then `ts`.
18. `recordModelUsage` marks a source reconciled and updates coverage only after `persisted: true`. A failed append
    leaves the source retryable and makes the execution's settlement coverage `partial` or `unavailable`.
19. `docs/user-documentation/settings.md` and `docs/architecture.md` describe the Usage report, clear, optional export,
    and the new journal directory name, with no record-only claim.
20. The Core PRD requirements named under Product ownership describe the delivered behavior: committed recording
    boundaries, dispatch under the guard, auxiliary start evidence and failure observations, the collision-resistant
    journal directory, and fail-closed export eligibility. Unmet intent stays labeled target or deferred.
21. `docs/domain-language.md` **Collection epoch** says normal recording controls commit boundaries and direct settings
    edits are observed lazily.

## Verification Plan

Run focused tests with `bun scripts/run-tests.js <paths>`. RunWield runs the full `bun run ci` afterward.

Each test below must fail on `dc60183` and pass after the fix. A stub or pass-through cannot satisfy it.

| Finding | Test file                                                                                                                      | Scenario that must hold                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1    | `usage-reporting.test.ts`                                                                                                      | Record in `a-b` and `a/b`. Paths differ. Clearing `a-b` leaves `a/b`'s journal bytes and report rows unchanged. A grant for `a-b` exports no `a/b` row.                                                                                                                       |
| R2-1    | `usage-reporting.test.ts`, `metrics-export-process.test.ts`                                                                    | A seeded legacy journal with a grant offset is adopted with identical bytes. Reports show its rows; the next cycle sends no duplicate. A seeded collided journal gives each Project only its own rows in reports, exports none of them, and leaves the legacy file unchanged. |
| R2-2    | `owner-usage-settings.integration.test.ts`, `metrics-journal.test.js`                                                          | Recording on, capture an invocation, `mutateUsageSettings` off then on, append: `collection_boundary`. A new capture after the control persists.                                                                                                                              |
| R2-3    | `execution-metrics.test.ts`                                                                                                    | Recording off, create a recorder, turn recording on, `recordModelUsage`: `persisted: false`, reason `disabled`.                                                                                                                                                               |
| R2-4    | `metrics-journal.test.js`                                                                                                      | Writer A captures `initial`; writer B persists a row; clear; A appends: `history_boundary`. Two `initial` captures before any history both persist.                                                                                                                           |
| R2-5    | `guided-review-usage.test.ts`                                                                                                  | Record a row; a guide command stub clears history before resolving; no `model_usage` row from that job is in the new history; a start row precedes job usage.                                                                                                                 |
| R2-6    | `metrics-export-delivery.test.ts`                                                                                              | A clear or revoke committed before the locked dispatch step produces no `postMessage`. A test exporter records receipt before the cycle releases its locks.                                                                                                                   |
| R2-7    | `metrics-export-consent.test.ts`                                                                                               | After a grant, a `model_usage` row whose execution has no start row is not sent. A compaction started before the grant exports nothing. An outcome row after the grant is sent.                                                                                               |
| R2-8    | `claude-cli-backend.test.ts`, `execution-metrics.test.ts`                                                                      | Two results in one stream record two turn rows; the report sums both `usage` values; cost equals the final running total.                                                                                                                                                     |
| R2-9    | `usage-reporting.test.ts`, `agy-cli-backend.test.ts`                                                                           | An agy row with `endedAt` 23:59 and recording after midnight belongs to the earlier day and period.                                                                                                                                                                           |
| R2-10   | `execution-metrics.test.ts`                                                                                                    | A failing `model_usage` append followed by a successful settlement writes `coverage.usage` `partial` or `unavailable`; the report shows exclusions, not a complete zero.                                                                                                      |
| R2-11   | `src/tools/see-image-usage.test.ts`, `src/shared/session/see-image-usage.test.ts`, `src/shared/remote/see-image-usage.test.ts` | An `error` response with usage, an `aborted` response, and a thrown error each leave a start row and an incomplete or unavailable observation. With no active execution, the start row has `dispatchKind: "auxiliary"`, and the report adds no Active day.                    |
| R2-12   | `metrics-export-process.test.ts`                                                                                               | Grant, hold, child cycle, kill child, revoke, release: clear reports `deliveryInFlight: false`; the next cycle marks the entry `unconfirmed` with `process_lost`.                                                                                                             |

> [!NOTE]
> **Assumption: R2-6 is proven through the locked step**
>
> A black-box test cannot reliably land a clear in a gap that no longer exists. The R2-6 test may call the exported
> lock-scoped authorize-and-dispatch function directly with a real journal and grant. Exporting a function is not an
> injection seam. `bun run seams:check` must still pass.

**Behavior that must stay protected:**

- Opt-out or unset recording creates no journal (`metrics-journal.test.js`, `metrics.test.js`).
- Two writers that both captured `initial` before any history persist.
- A paused writer from before a clear is rejected (`usage-reporting-clear-race.test.ts`).
- Recording lock acquisition stays near 1 second and returns `lock_timeout`, not a block.
- Live in-flight deliveries still report in flight (`metrics-export-delivery.test.ts` around lines 93, 113, 170).
- An execution started after the grant still exports (`metrics-export-process.test.ts` around line 135).
- Claude alternative rows stay out of totals and exports.
- Pi and agy usage, latency, and Plan attribution tests in `execution-metrics-*.test.ts` and
  `usage-reporting-runtime.test.ts`.

**Behavior expected to stop existing — invert these tests, do not delete them:**

- `metrics-journal.test.js` "first-ever pending append with an earlier timestamp survives empty-history clear": the
  capture is now rejected.
- `metrics-export-consent.test.ts` cases around lines 162 and 207 that export rows without start evidence: those rows
  are now not sent.
- Assertions that Claude results use the single `sourceId` `claude_turn_total` (`claude-cli-backend.test.ts` line 228,
  `execution-metrics.test.ts` line 482): the id now carries an ordinal.

**Documentation checks:**

- `grep -n "record-only\|no reporting UI\|encoded-project-root" docs/user-documentation/settings.md docs/architecture.md`
  returns nothing.
- The Core PRD requirements named under Product ownership and the **Collection epoch** glossary entry describe the
  delivered behavior and claim nothing this Plan does not deliver.

**Manual check (optional):** with a disposable HOME, enable recording in Workspace Usage settings, run one Pi turn,
turn recording off and on, and open the Usage page. The page shows the turn, and the off period shows as a gap.

## Edge Cases & Considerations

- **Rename race between two adopters.** Rename is atomic; the loser sees `ENOENT` or `ENOTEMPTY` and uses the new
  directory.
- **Report reads are synchronous.** Adoption uses a bounded synchronous guard try. If the guard is busy, the report
  shows the legacy journal as unavailable for that query and retries next time.
- **Lock order.** `.send.lock` (try only) → `.config.lock` → journal guard → `recording.guard` (shared). The recording
  control takes only `recording.guard`; clear takes only the journal guard; revoke takes only the configuration lock.
  A `.send.lock` taken while another lock is held is try-only.
- **Crash during the recording control.** `recording.json` is written before the setting. A crash in between leaves one
  extra boundary, which only rejects in-flight captures.
- **Worker spawn before lock.** A spawned worker that loses authorization is terminated. It never receives a request.
- **Fire-and-forget compaction start.** Awaiting `start()` adds at most the 1-second recording budget before compaction.
  Completing the task still outranks metrics: a timeout returns non-persistence and compaction continues.
- **Resumed Claude sessions.** `total_cost_usd` on the first result of a resumed process includes earlier session spend.
  This is existing behavior and is out of scope; record it as a follow-up if it matters.
- **Sessions and worktrees.** `encodeCwdForSessionDir` keeps its lossy encoding for Sessions and worktrees. That is a
  separate issue.
- **Rows without `executionId`.** Workflow outcome rows stay eligible at their own position, as the Export consent
  requirement already says.
