---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths: []
executionAgent: "engineer"
createdAt: "2026-10-25T00:21:02.248Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 11
dependencies: []
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "bff745e6-ef31-44cf-a93b-5417e5d5eb23"
---

# Repair integration findings

## Context

The integration gate checked the Epic branch `epic/reliable-usage-dashboard-and-langfuse-export` at `dc60183fbca4687286bda57fa9389de452e1c5f1` and found the problems below.
The full report is `docs/plans/reliable-usage-dashboard-and-langfuse-export/integration-report.md`. This draft was created by RunWield; plan the repair from these
findings and the Epic. After this child is delivered, the integration gate runs again on the whole Epic.

## Objective

Resolve every finding below on the Epic branch.

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
