# Integration Gate Report: reliable-usage-dashboard-and-langfuse-export

RunWield checked the Epic branch `epic/reliable-usage-dashboard-and-langfuse-export` at `f9dd8819984fd9bcb8826feb66a3a1384e394341`, diffed from `da55b44d463c4a6797c87792ce3856aa57b0ab29`.

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
- reliable-usage-dashboard-and-langfuse-export/11-repair-integration-findings (verified)

## Findings

### 1. Project checks fail on the Epic branch

Source: Project checks

Exit code 1.

```text
$ bun scripts/check-bun-runtime.ts && bun scripts/run-ci.ts
ci test:all:suite failed, read the failure log here: /var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/ci-test-all-suite-failure-1419cb3f-5598-4bed-bd19-00e53f4b1bbf.log
CI failed tasks:
- test:all:suite: exit 1
error: script "ci" exited with code 1
```

### R4-14. A failed recording-setting write rejects the next fresh execution

Source: Integration review

Requirement: Enabled work must record against its start boundary. Storage failures must not silently exclude later work after storage is available.

Evidence: metrics-journal.ts:148–173 commits disabled generation G before setCustomSetting. If that settings write fails, recording remains enabled. Before another append reconciles G, resolveCollectionEpoch at 253–259 gives a fresh recorder gen:G. appendWorkflowMetric at 687–752 then applies disabled gen:G, reconciles to enabled:gen:G, and rejects the fresh capture. ExecutionMetricsRecorder retains the rejected epoch, so all its later rows also fail. The added failed-write test appends from the stale recorder first, which hides this ordering.

### R4-15. Failed vision responses can export invented zero cost

Source: Integration review

Requirement: Missing cost must not become measured zero. Partial or unavailable cost must not produce a native complete Langfuse cost.

Evidence: The new error-response path in see-image.ts:164–181 copies usage.cost.total and labels it calculated, but sets only measurementAvailability to partial. Pi can return an error response with initialized zero usage and cost when a stream fails before final usage. ExecutionMetricsRecorder leaves costAvailability absent. With an eligible recorded start, packages/langfuse-exporter/exporter.ts:361–386 accepts that absent flag and emits native cost_details with total:0 and the pricing model. The thrown-error path avoids this, but the returned-error path does not.
