---
kind: "work_record"
recordId: "942e23d4-63cc-4125-9c28-0e075c3cf5bf"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-24T20:25:20.579Z"
provenance:
    sourcePlans:
        - "01d970e6-db23-4636-887d-b29193831935"
---

# Transient provider failure recovery and notices

## Summary

Unexpected provider EOF uses Pi’s existing retry policy. Shared live and saved Session notices describe failures safely without hiding raw diagnostics. Cancellation, partial output, tool execution, and replay retain their existing behavior.
