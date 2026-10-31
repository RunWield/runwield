---
planId: prune-history
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
planDeviations:
    - id: retention-age-window
      supersededRequirement: Keep the newest 10 records and remove the rest.
      replacementRequirement: Delete only records older than 30 days; retain all records at or after the 30-day cutoff, regardless of count.
      reason: Support monthly audits even when execution volume varies.
      approvedAt: "2026-10-20T15:00:00.000Z"
---

# History retention

## Request

Add pruning for local execution history. The original request retains a compact recent list.

## Approved steps

1. Add `pruneHistory(root, now)` to the retention module.
2. Keep the newest 10 records and remove the rest.
3. Preserve all fields of retained records. Return the retained records in newest-first order.

## Validation

Use public APIs and real temporary files. Run the public suite.
