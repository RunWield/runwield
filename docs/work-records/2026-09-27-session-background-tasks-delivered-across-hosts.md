---
kind: "work_record"
recordId: "de52a432-a53a-4024-8823-ee7e123f8d95"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-27T00:31:53.150Z"
provenance:
    sourcePlans:
        - "3d5753f1-239c-425d-9e19-d65d77a79076"
---

# Session-owned background tasks across hosts

## Summary

Session-owned background shell tasks and read-only delegates return immediately and share limits, logs, and cancellation. Results reach TUI, Workspace, and ACP automatically. Stop suppresses late results.
