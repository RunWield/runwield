---
kind: "work_record"
recordId: "a264cc8a-3960-42b6-95d6-ef1116da79bc"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-07T03:49:13.639Z"
provenance:
    sourcePlans:
        - "cef05b40-ce1e-49db-b065-1a2054b3d8e8"
---

# Canonical documentation Plan store

## Summary

RunWield discovers and manages Plans through the canonical documentation Plan store. Legacy top-level Plan storage is ignored rather than treated as a second authority. Plans Doctor resolves active Plans through the canonical store.

## Future Planning Notes

Clean-break storage migrations need negative coverage for the retired location as well as positive coverage for the new authority.
