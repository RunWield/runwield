---
kind: "work_record"
recordId: "fcb85ab0-8d6a-4261-b664-75bb0c48aa04"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-26T13:13:02.118Z"
provenance:
    sourcePlans:
        - "5d5dbde5-c78a-4cb6-8f1d-47c9fb043752"
---
# Bounded Epic Integration Gate reviews

## Summary

The Epic Integration Gate keeps a persistent Review Issue Ledger with stable finding IDs across repair attempts. It runs one full discovery review; later reviews verify open findings and check repair changes for regressions. From the third review with findings, the gate asks the user to plan another repair, take over in Code Review, or stop instead of automatically creating another repair child. Existing integration repair children count toward this limit. Human takeover requires passing project checks and preserves AI findings while recording human approval separately.

## Out of Scope

This work does not include changes to gate checkout setup, Epic continuation, or per-Plan Semantic Review.

## Future Planning Notes

The round limit must remain enforced in code, not only in reviewer instructions. Every verification review must account for each open finding ID. Saved review state must respect exact-head checks and controller-revision guards against concurrent writes. Code Review change requests create repair children regardless of the round limit; an unanswered limit prompt pauses the gate without creating a child.
