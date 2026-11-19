---
kind: "work_record"
recordId: "bf562b2a-9fbf-4eec-9c52-3eb84f08c6a7"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-01T02:27:13.428Z"
provenance:
    sourcePlans:
        - "74dc2c57-4664-452b-b18a-2587fd2ca3a8"
---

# Server-only Workspace import diagnostics

## Summary

Workspace server builds disable only Rolldown's ineffective-dynamic-import warning through the Bun adapter. Browser builds retain this warning, and other warning categories and build errors remain enabled. Runtime imports and startup behavior remain unchanged; this change reduces server-build warning noise without changing the module graph.

## Out of Scope

This work does not include source import cleanup, module-boundary changes, or bundle-size optimization.

## Future Planning Notes

Scope the diagnostic override to Astro's explicit server build target and preserve all other build options. Mixed server imports, including future occurrences, remain accepted; the absence of this warning does not show that mixed imports are absent.
