---
planId: reuse-plan-summaries
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Reuse summary work during a listing

## Request

Summary previews are recomputed as users move between panels. Reuse computed summaries within one browser refresh.
Keep the current summary format and repository contracts. A refresh starts a new view of the data.

## Approved steps

1. Add an operation-scoped summary cache to SummaryBrowser.
2. Expose refresh so the next read uses current repository content.
3. Add public coverage for repeated reads and refresh after an edit.

## Validation

Run the public suite. Listing order and displayed titles must not change.
