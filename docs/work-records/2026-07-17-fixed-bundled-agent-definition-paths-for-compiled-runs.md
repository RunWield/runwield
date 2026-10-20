---
kind: "work_record"
recordId: "2ddc6dd2-7cf5-4946-9a96-992ba06c4607"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:45:50.231Z"
provenance:
    sourcePlans:
        - "444b5669-d2a7-41bd-a985-bcd1146bd730"
---

# Bundled Agent format access in compiled runs

## Summary

The Deno-era compiled executable makes bundled Agent-definition assets available through a runtime-readable cache and resolves prompt format references to absolute locations. Planner, Architect, and Slicer can read their format resources outside the source tree, while source-mode fallback remains available.
