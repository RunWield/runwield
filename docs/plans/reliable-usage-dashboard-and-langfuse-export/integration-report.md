# Integration Gate Report: reliable-usage-dashboard-and-langfuse-export

RunWield checked the Epic branch `epic/reliable-usage-dashboard-and-langfuse-export` at `dc60183fbca4687286bda57fa9389de452e1c5f1`, diffed from `da55b44d463c4a6797c87792ce3856aa57b0ab29`.

## Delivered Children

- reliable-usage-dashboard-and-langfuse-export/01-core-measurement-history-and-default-on-recording (validated)
- reliable-usage-dashboard-and-langfuse-export/02-real-model-usage-across-backends-and-auxiliary-calls (validated)
- reliable-usage-dashboard-and-langfuse-export/03-workflow-outcome-observations (validated)
- reliable-usage-dashboard-and-langfuse-export/04-core-usage-reporting-retention-and-clear (validated)
- reliable-usage-dashboard-and-langfuse-export/05-workspace-usage-page (validated)
- reliable-usage-dashboard-and-langfuse-export/06-package-executable-approval-and-metrics-exporter-kind (verified)
- reliable-usage-dashboard-and-langfuse-export/07-core-export-coordination-and-delivery-states (verified)
- reliable-usage-dashboard-and-langfuse-export/08-langfuse-exporter-package (verified)
- reliable-usage-dashboard-and-langfuse-export/09-workspace-export-settings-and-delivery-status (verified)
- reliable-usage-dashboard-and-langfuse-export/10-end-to-end-usage-and-export-acceptance (verified)
- reliable-usage-dashboard-and-langfuse-export/11-repair-integration-findings (draft)

## Findings

### R2-1. Different Project roots can share one measurement journal

Source: Integration review

Requirement: Use a collision-resistant canonical Project identity. Reports, clear actions, and export grants must remain Project-specific.

Evidence: metrics.js:81–85 uses encodeCwdForSessionDir; session-directory-name.ts:5–7 maps path separators to hyphens. usage-reporting.ts:145–146 hashes that directory name. metrics-export-scheduler.ts:154–159 does not check cwdHash.

Fix rejected because: The journal path still uses the lossy Session directory encoding. Project isolation is not restored.

### R2-2. Recording controls do not commit collection boundaries

Source: Integration review

Requirement: Normal recording controls must change collection epochs atomically with journal authorization. Disable/re-enable periods must remain gaps.

Evidence: owner-usage-settings.ts:278–286 calls setCustomSetting. settings.js:604–632 only updates configuration. metrics-journal.ts:420–446 detects enabled-state changes during append.

Fix rejected because: Recording changes still update settings without the journal lock or an epoch marker. Disable and re-enable between appends can leave the collection epoch unchanged.

### R2-3. Model settlements use current consent instead of invocation-start consent

Source: Integration review

Requirement: An invocation is eligible only if recording was enabled at its start and its collection epoch remains current.

Evidence: execution-metrics.ts:633–687 captures historyEpoch but not collection consent. metrics.js:857–869 resolves current enablement and collection epoch for fresh rows.

Fix rejected because: The recorder still captures only the history epoch. New settlement rows use current recording consent and can include work started while recording was disabled.

### R2-4. The initial-history exception allows stale writes after clear

Source: Integration review

Requirement: Clear must reject delayed observations from an older history epoch, including observations from another process.

Evidence: metrics-journal.ts:462–478 checks history identity and timestamp only when invocation.historyEpoch is not 'initial'.

Fix rejected because: Both history guards still exempt the initial epoch. A delayed initial-epoch observation can enter history after clear.

### R2-5. External Guided Review captures its history boundary after the work finishes

Source: Integration review

Requirement: Clear must discard delayed settlements from the old history. Auxiliary invocations must establish measurement identity before use.

Evidence: review-agent-handlers.js:266,308–329 runs the command before recorder creation in finally. execution-metrics.ts:683 captures history at construction.

Fix rejected because: The recorder is still created at settlement. A clear during the command lets old usage acquire the new history epoch.

### R2-6. Export dispatch occurs after its authorization locks are released

Source: Integration review

Requirement: Persist intent and dispatch the authorized worker request under the control lock. Clear or revoke must prevent requests that have not yet been dispatched.

Evidence: metrics-export-scheduler.ts:348–402 releases locks before observation construction and deliver dispatch. Lines 451–498 do the same for confirmation.

Fix rejected because: Delivery and confirmation still dispatch after the authorization locks are released, without another consent check. Clear or revoke can finish before dispatch.

### R2-7. Export eligibility admits auxiliary work started before approval

Source: Integration review

Requirement: Export must include only operations started after the grant boundary, not old operations that complete later.

Evidence: metrics-export-scheduler.ts:145–159 excludes only recorded pre-boundary execution starts. SessionContextMetricsRecorder in execution-metrics.ts:44–101 creates its usage recorder without recording an execution start.

Fix rejected because: Missing start evidence still permits export. Auxiliary operations started before approval can therefore export their later settlements.

### R2-8. Claude steering drops usage from later results in the same process

Source: Integration review

Requirement: Supported Claude work must contribute once, without losing later cumulative or distinct turn totals.

Evidence: claude-cli/stream-parser.ts assigns claude_turn_total to each result. execution-session.ts:203–207,426–453 permits and forwards later results. execution-metrics.ts:1170–1171 deduplicates that ID.

Fix rejected because: All Claude results still share one source ID. The recorder discards later results even when steering adds work.

### R2-9. The report ignores observed model completion time

Source: Integration review

Requirement: Usage must belong to its completion day and the correct half-open reporting period.

Evidence: usage-reporting.ts:261–262 uses completedAt or ts. agy-cli/execution-session.ts:468,584–586 supplies the observed completion as endedAt. execution-metrics.ts:1212–1224 sets ts only from observedAt.

Fix rejected because: Reporting still ignores endedAt. Delayed cleanup can move usage to the wrong day or reporting period.

### R2-10. A failed usage append can still produce complete coverage

Source: Integration review

Requirement: Storage failure must remain fail-honest: missing persisted usage must produce degraded coverage, not a complete zero.

Evidence: execution-metrics.ts:1170–1174 updates coverage before the unchecked recordWorkflowMetric call; line 1572 saves that coverage. usage-reporting.ts:615–623 adds missing-usage exclusions only for partial or unavailable coverage.

Fix rejected because: Coverage and deduplication still change before persistence, and the append result is ignored. A later successful settlement can report complete coverage despite lost usage.

### R2-11. Vision failures have no measurement start or incomplete observation

Source: Integration review

Requirement: RunWield-started auxiliary calls must have identities before invocation and expose incomplete measurement when settlement evidence is missing.

Evidence: see-image.ts:133–163 invokes the model before building the usage observation and throws before the callback. session.js:2264–2276 creates the fallback recorder only in that callback.

Fix rejected because: The vision request still starts without a measurement start. Error and abort responses throw before the usage callback, so failed work can leave no measurement evidence.

### R2-12. Crash recovery leaves revoked destinations permanently in flight

Source: Integration review

Requirement: Process loss must change unfinished export attempts to uncertain delivery, and clear must distinguish actual in-flight requests.

Evidence: metrics-export-scheduler.ts:297–320 returns when no grants exist and recovers only granted destinations. metrics-export-ledger.ts:58–85 still counts sending or confirming entries across destination directories.

Fix rejected because: Recovery still processes only current grants. Revoked destinations retain abandoned in-flight entries after process loss.

### R2-13. Settings documentation still claims that reporting and upload do not exist

Source: Integration review

Requirement: Update settings documentation to describe the delivered Usage report and optional export without contradictory capability claims.

Evidence: docs/user-documentation/settings.md:541–542 still says metrics are record-only, there is no reporting UI or analytics sync, and nothing is uploaded.

Fix rejected because: The obsolete capability statement remains and contradicts the delivered Usage report and optional export.
