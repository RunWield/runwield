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

### 1. Project checks fail on the Epic branch

Source: Project checks

Exit code 1.

```text
$ bun scripts/check-bun-runtime.ts && bun scripts/run-ci.ts
ci workspace:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-check-failure-54739f14-136d-4da1-88d9-2c81846251d6.log
ci lint failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-lint-failure-5ffb65dd-90ed-4822-a669-92526b744543.log
ci check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-check-failure-1c9973f9-cb0b-42a6-bf4f-dfda6328a94e.log
ci workspace:build failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-workspace-build-failure-de95a30a-df0c-44cc-8d4f-5e4747782729.log
ci submodules:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-submodules-check-failure-a94a93ec-11b8-4aaa-a3ff-c2429f9465fc.log
ci docs:check failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-docs-check-failure-8e79578d-cb3f-4368-99eb-d4a719d83a11.log
CI failed tasks:
- submodules:check: exit 1
- check: exit 1
- workspace:check: exit 1
- lint: exit 1
- docs:check: exit 1
- workspace:build: exit 1
error: script "ci" exited with code 1
```

### 2. Local measurement is opt-in — finding withdrawn

Source: Integration review; corrected by the owner.

Disposition: Not applicable. Default-off recording is required, not a defect. Do not enable recording by default.

Requirement: Local recording is opt-in. With `workflowMetrics` off or unset, write no metrics. Preserve explicit
settings and scope precedence. Display the effective recording state; export requires separate approval and stays
off until approved.

The original review used a superseded default-on requirement. The Core PRD's
[Local workflow metrics](../../prd/runwield-core-prd.md#local-workflow-metrics) capability defines the current policy.

### 3. Recording controls do not commit collection boundaries

Source: Integration review

Requirement: Normal recording controls must record epoch changes atomically with appends. Disabled intervals must remain gaps after re-enabling.

Evidence: src/ui/workspace/server/owner-usage-settings.ts::mutateUsageSettings('recording') calls the ordinary setCustomSetting writer. src/shared/settings.js::setCustomSetting neither acquires the journal guard nor writes a collection marker. metrics-journal.ts creates boundaries only when an append observes changed settings. Disable and re-enable with no intervening append leaves the old epoch unchanged and loses the disabled interval.

### 4. Model settlements do not retain their start-time recording permission

Source: Integration review

Requirement: An invocation is eligible only if recording was enabled at its start and remains in the same collection epoch.

Evidence: src/shared/workflow/execution-metrics.ts::ExecutionMetricsRecorder captures historyEpoch but no collection epoch or start-time enablement. Each recordModelUsage call reaches metrics.js::recordWorkflowMetric, which samples current permission again. An invocation started while disabled can finish after enablement and persist usage. An invocation spanning a recorded disable/re-enable boundary can also persist under the new epoch.

### 5. Initial-epoch observations can restore cleared history

Source: Integration review

Requirement: Clear must reject delayed observations from the previous history, including writes from another process.

Evidence: src/shared/workflow/metrics-journal.ts:462–476 exempts historyEpoch='initial' from both history-boundary checks. Writer A can capture the initial epoch, pause, then resume after writer B creates and clears the journal. The collection epoch can still match, so A's pre-clear observation is appended to the new history.

### 6. Distinct Projects can share reporting, deletion, and export history

Source: Integration review

Requirement: Use a collision-resistant canonical Project key. Reports, clear operations, and export grants must stay within their authorized Projects.

Evidence: metrics.js::getWorkflowMetricsFilePath still uses encodeCwdForSessionDir. src/shared/session/session-directory-name.ts maps both /a-b and /a/b to --a-b-- for short paths. The added usage-reporting.ts reads and clears this shared journal; metrics-export-scheduler.ts scans it without checking cwdHash. Registering or approving one Project can therefore report, delete, or export the other Project's observations.

### 7. A failed usage append can produce complete zero reporting

Source: Integration review

Requirement: Storage failure must remain fail-honest: disclose missing evidence and never claim complete coverage for data that was not saved.

Evidence: src/shared/workflow/execution-metrics.ts::recordModelUsage updates deduplication and usageCoverage before writing, then ignores the persisted result. settleExecution can subsequently save coverage.usage='complete'. usage-reporting.ts:615–624 adds missing-usage exclusions only for partial/unavailable settlement. If the usage append fails before writing bytes and settlement succeeds, the report can show zero usage with no exclusion.

### 8. Export dispatch can occur after clear or revoke completes

Source: Integration review

Requirement: Under the control lock, persist intent and dispatch the authorized worker request. Clear or revoke must prevent later dispatch; only already-dispatched work may continue.

Evidence: src/shared/workflow/metrics-export-scheduler.ts:347–400 releases configuration and journal locks after saving intent, then awaits buildMetricsExportObservation before calling callExporter. Another process can clear history or revoke consent during those crypto awaits. The scheduler then dispatches the retained observation and credentials without another check. This is not an already-dispatched request.

### 9. Guided Review exports operations that started before consent

Source: Integration review

Requirement: Export starts with operations begun after the durable approval boundary, not old operations that finish later.

Evidence: src/ui/workspace/routes/api/review-agent-handlers.js::recordGuideJobMetric constructs the external Guided Review recorder only in the completion path and writes no execution_started record. metrics-export-scheduler.ts::scanProject uses the settlement row offset when no start exists. A custom Guided Review command started before destination approval is therefore exported if it finishes afterward. Capturing history only at completion also lets that operation write after an intervening clear.

### 10. Missing agy usage becomes complete zero cost

Source: Integration review

Requirement: Missing cost must not become measured zero. Zero requires source evidence.

Evidence: src/shared/session/backends/agy-cli/execution-session.ts:566–595 replaces absent token buckets with zero for pricing and sets costAvailability='complete' whenever a catalog model exists. The parser supplies a non-null usage object even when a result omits all usage. That result becomes calculated cost 0; usage-reporting.ts counts it, and packages/langfuse-exporter/exporter.ts exports native cost_details.total=0.

### 11. Partial token measurements are exported as native totals

Source: Integration review

Requirement: Partial token categories must remain metadata with availability flags, without native complete totals or pricing inference.

Evidence: packages/langfuse-exporter/exporter.ts::map constructs usage_details from any available buckets, even when measurementAvailability='partial'. Its read-back matcher explicitly accepts a derived total equal to the known-bucket sum. Thus an incomplete agy observation can contribute a native total; usage_complete=false metadata does not prevent it.

### 12. Unavailable model timing becomes native zero latency

Source: Integration review

Requirement: Missing timing must remain unavailable; native destination metrics must not imply measured latency.

Evidence: packages/langfuse-exporter/exporter.ts:305–310 substitutes occurredAt for both start and end when observed timing is missing. It still emits a GENERATION with these timestamps, and matches requires the same timestamps on read-back. A model observation without measured timing becomes a zero-duration native generation despite timing_measured=false.

### 13. A missing approved directory blocks allowlist edits

Source: Integration review

Requirement: Workspace must provide working explicit Project export controls while preserving separate grants for unavailable Projects.

Evidence: src/ui/workspace/server/owner-usage-settings.ts::preserveUnavailableRoots retains unavailable approved roots during Project edits. src/shared/workflow/metrics-export-grants.ts::saveDestinationGrant then calls realpathSync on every retained root before checking the existing grant. If one directory was deleted or moved, saving changes for the remaining Projects fails.

### 14. Worktree aliases can falsely show that export stopped

Source: Integration review

Requirement: Worktrees share one Project identity, and Workspace must accurately show the approved export Projects.

Evidence: owner-usage-settings.ts maps one canonical grant root to every matching registration. UsageSettings.tsx::DestinationPanel initializes projectIds only once, and mutation success updates view without resetting that selection. With primary and worktree registrations selected, unchecking one and saving retains the canonical grant through the other. The unchecked row continues to say 'Not exported' after success, although its measurements remain exportable.

### 15. Ongoing workflow reporting ignores repair completion

Source: Integration review

Requirement: The report must label ongoing work as of its latest observed workflow event, while counting one repair per round.

Evidence: src/shared/workflow/validation-supervisor.ts:262–273 emits repair_round_finished after committing repair completion. The latestWorkflows event list in usage-reporting.ts:491–502 omits that event. If work stops before the next validation observation, the ongoing report retains the earlier repair-start timestamp and link instead of the latest completion observation.
