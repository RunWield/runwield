---
kind: "work_record"
recordId: "61808ee1-6c9b-4194-8754-1853f49aec17"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-26T13:11:26.090Z"
provenance:
    sourcePlans:
        - "b12dd5b4-1f7d-49d0-86ef-dc389ed60993"
---
# Epic integration gate retry

## Summary

The Epic menu offers “Retry the integration gate” when an implemented Epic is blocked only by unstarted integration repair drafts, and names the drafts and report so users can reassess findings without implementing obsolete repairs. A passing retry marks the Epic reviewed and closes all open repair drafts without verification, preserving them with a reason that names the checked commit. New findings update the highest-order open repair draft’s checked commit and Findings section without creating another child or changing other content, including inline user notes. Delivery readiness uses current branch progress rather than stale primary-checkout drafts. Automatic gate readiness still requires every child to be settled; a paused retry changes neither Epic status nor repair drafts.

## Out of Scope

This work does not change the Epic menu’s branch-based child list or progress count, or how primary-checkout-only repair drafts are seeded onto the Epic branch.

## Future Planning Notes

Explicit retry eligibility applies only to repair children in draft status; started repairs and unsettled non-repair children remain blockers. Repair draft updates and closures must use the document’s resolved location, including primary-checkout-only drafts. A branch move during the retry prevents draft changes and closure.
