---
kind: "work_record"
recordId: "a36d95ab-5c2d-4623-9c55-6b436f266b45"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-22T17:26:48.815Z"
provenance:
    sourcePlans:
        - "4c50a988-e730-4699-a0c6-df199f54addf"
---

# Shared common-ancestor review patches

## Summary

Reviewer tools, repair and resume flows, standalone Code Review, and Workspace reload share one common-ancestor-to-current-files patch. It includes committed and uncommitted execution work while excluding target-only changes. Invalid ancestry fails closed, and transient Git read failures retain saved-patch fallback.

## Future Planning Notes

Anchor full review patches to the target/execution common ancestor. Missing ancestry is an invalid comparison, while transient checkout read failures may use the saved patch.
