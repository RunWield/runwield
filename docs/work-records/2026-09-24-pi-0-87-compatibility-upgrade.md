---
kind: "work_record"
recordId: "eadeaf2f-0c2e-409f-8233-724d929d8e04"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-24T17:08:32.253Z"
provenance:
    sourcePlans:
        - "eca2ba1e-32ca-4e5a-bed5-dc579b81e0a2"
---

# Pi 0.87 compatibility

## Summary

RunWield integrates Pi 0.87 provider context, temperature retries, stream termination, workflow-result reading, and compiled release behavior. Named Invocation expansions, including images, persist as append-only context edits. Legacy repair is idempotent and limited to the active branch, and cache warming stays off without changing stored settings.

## Out of Scope

This work does not include a user-facing cache-warming setting.

## Future Planning Notes

The cache-warming override is specific to Pi 0.87; confirm upstream behavior before replacing it with a user setting. Preserve canonical saved context edits and branch-scoped legacy repair across Pi upgrades.
