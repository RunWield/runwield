---
kind: "work_record"
recordId: "862cc044-f349-400f-afd8-e308036dd965"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-29T03:41:04.244Z"
provenance:
    sourcePlans:
        - "266cb9df-e989-47c4-b2fd-9f55c17875ab"
---

# New Session Project selector

## Summary

A Project selector above the New Session composer follows the Project route and disappears after creation is accepted. Drafts and unresolved requests prevent switching. Loading, failed reads, and navigation failures have recovery paths, while Project-specific defaults and creation stay bound to the selected Project.

## Future Planning Notes

Keep the route as the source of Project identity. Preserve Project-scoped drafts rather than moving in-progress input between Projects.
