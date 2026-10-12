# Manual QA for reliable-usage-dashboard-and-langfuse-export

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="reliable-usage-dashboard-and-langfuse-export/01-core-measurement-history-and-default-on-recording" -->

## Core Measurement History and Durable Recording

Manual verification steps for
reliable-usage-dashboard-and-langfuse-export/01-core-measurement-history-and-default-on-recording

- [ ] With recording disabled, perform workflow activity and confirm that no new metrics are recorded; enable recording
      and confirm that new activity is recorded.
- [ ] Disable recording, perform workflow activity, then re-enable it. Confirm that activity from the disabled interval
      is not recorded or replayed, and that the journal shows the observed collection boundary.
- [ ] Open existing v1 metrics before and after recording is enabled. Confirm that the v1 records remain intact and
      readable.
- [ ] Cause a journal write failure or lock timeout. Confirm that workflow work completes and the result reports that
      the measurement was not saved.

<!-- runwield:manual-qa:end child="reliable-usage-dashboard-and-langfuse-export/01-core-measurement-history-and-default-on-recording" -->

<!-- runwield:manual-qa:start child="reliable-usage-dashboard-and-langfuse-export/02-real-model-usage-across-backends-and-auxiliary-calls" -->

## Real Model Usage Across Backends and Auxiliary Calls

Manual verification steps for
reliable-usage-dashboard-and-langfuse-export/02-real-model-usage-across-backends-and-auxiliary-calls

- [ ] Run a session with missing usage fields; confirm the runtime event, replay totals, and footer show unavailable
      values, not zero.
- [ ] Open a session with compaction usage; confirm replay shows it as a separate component and excludes it from
      assistant totals.
- [ ] Run a vision fallback call with usage; confirm exactly one usage observation contains the reported values. Repeat
      with missing usage and confirm it is marked unavailable.
- [ ] Run Guided Review with measured and missing usage; confirm one aggregated usage observation per settled external
      job and that the outcome event still appears.
- [ ] Review Claude and agy session usage; confirm supplied zero remains zero, absent values remain unavailable, and agy
      cost is never shown as zero.

<!-- runwield:manual-qa:end child="reliable-usage-dashboard-and-langfuse-export/02-real-model-usage-across-backends-and-auxiliary-calls" -->

<!-- runwield:manual-qa:start child="reliable-usage-dashboard-and-langfuse-export/03-workflow-outcome-observations" -->

## Workflow Outcome Observations

Manual verification steps for reliable-usage-dashboard-and-langfuse-export/03-workflow-outcome-observations

- [ ] Complete a workflow with a failed validation, a repair round, and confirmed publication. Confirm the dashboard
      shows separate validation-attempt, repair-round, and publication counts.
- [ ] Repeat publication cleanup for the same attempt. Confirm the publication count does not increase.
- [ ] Disable metric recording or make the metrics journal unavailable, then confirm publication still completes.
- [ ] View observations for a workflow with no committed Plan association. Confirm they have no Plan attribution.

<!-- runwield:manual-qa:end child="reliable-usage-dashboard-and-langfuse-export/03-workflow-outcome-observations" -->

<!-- runwield:manual-qa:start child="reliable-usage-dashboard-and-langfuse-export/04-core-usage-reporting-retention-and-clear" -->

## Core Usage Reporting, Retention, and Clear

Manual verification steps for reliable-usage-dashboard-and-langfuse-export/04-core-usage-reporting-retention-and-clear

- [ ] Review a report for a known period and confirm token, cost, and latency totals match its recorded observations.
- [ ] Confirm the report distinguishes a covered zero-activity day from disabled or legacy-only gaps, and assigns
      activity to the correct local day across a daylight-saving change.
- [ ] Clear one Project's measurement history; confirm another Project's history and the selected Project's Sessions,
      Plans, worktrees, and configuration remain intact.
- [ ] Record a new observation after clearing and confirm it appears in the report, while cleared history does not
      return after restart.

<!-- runwield:manual-qa:end child="reliable-usage-dashboard-and-langfuse-export/04-core-usage-reporting-retention-and-clear" -->

<!-- runwield:manual-qa:start child="reliable-usage-dashboard-and-langfuse-export/05-workspace-usage-page" -->

## Workspace Usage Page

Manual verification steps for reliable-usage-dashboard-and-langfuse-export/05-workspace-usage-page

- [ ] Open `/usage` as a paired owner. Confirm the report shows totals, coverage notes, time zone, and recorded-through
      date.
- [ ] Change the period and Project filter. Confirm totals and day boundaries update, and excluded Projects are
      identified.
- [ ] Confirm a gap breaks the trend and a covered zero-activity day shows a zero point; check the trend’s table
      equivalent.
- [ ] Open Session and Plan links. Confirm they reach authorized pages, and a missing target does not remove the
      measurement.
- [ ] Check the page at phone and compact desktop widths, then use Tab to reach filters, links, and tables.
- [ ] Confirm home and Session navigation remain available, and the page does not show recording-state, Settings, or
      export controls.

<!-- runwield:manual-qa:end child="reliable-usage-dashboard-and-langfuse-export/05-workspace-usage-page" -->

<!-- runwield:manual-qa:start child="reliable-usage-dashboard-and-langfuse-export/06-package-executable-approval-and-metrics-exporter-kind" -->

## Package Executable Approval and Metrics-Exporter Kind

Manual verification steps for
reliable-usage-dashboard-and-langfuse-export/06-package-executable-approval-and-metrics-exporter-kind

- [ ] Use a disposable HOME and a trusted local fixture. Install it and decline both prompts; check that the settings
      file keeps extensions disabled and has no exporter approval.
- [ ] Start a fresh Session after refusal. Check that the extension marker does not appear and that the fixture theme
      and prompt remain available.
- [ ] Install the fixture again and accept both prompts. Check the command output and settings file for the saved
      extension choice and exporter approval.
- [ ] Start a fresh Session after approval. Check that the approved extension loads.

<!-- runwield:manual-qa:end child="reliable-usage-dashboard-and-langfuse-export/06-package-executable-approval-and-metrics-exporter-kind" -->

<!-- runwield:manual-qa:start child="reliable-usage-dashboard-and-langfuse-export/07-core-export-coordination-and-delivery-states" -->

## Core Export Coordination and Delivery States

Manual verification steps for
reliable-usage-dashboard-and-langfuse-export/07-core-export-coordination-and-delivery-states

- [ ] Approve an exporter, grant one Project, and confirm only new eligible events from that Project reach the
      destination.
- [ ] Confirm destination status shows accepted and confirmed items, and does not show credentials or observation
      content.
- [ ] Make the destination accept a request but drop the response; confirm the item becomes unconfirmed, is not sent
      again, and later items still send.
- [ ] Clear a Project while a request is in flight; confirm the clear result reports the in-flight delivery and the
      cleared measurements do not return.
- [ ] Cause the exporter to hang or exit; confirm local recording and the host process continue.

<!-- runwield:manual-qa:end child="reliable-usage-dashboard-and-langfuse-export/07-core-export-coordination-and-delivery-states" -->
