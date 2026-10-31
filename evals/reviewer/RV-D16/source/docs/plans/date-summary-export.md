---
planId: date-summary-export
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Dated summary export

## Request

Add an optional UTC date column to exported event summaries for portable reports.

## Approved steps

1. Update `src/summary.ts` so `exportSummary` accepts an optional `includeDates` flag, defaulting to false.
2. When enabled, prefix each title with its UTC `YYYY-MM-DD` date and a space.
3. Preserve the title-only output when the flag is omitted.

## Validation

Use public APIs and real temporary files. Run the public suite.
