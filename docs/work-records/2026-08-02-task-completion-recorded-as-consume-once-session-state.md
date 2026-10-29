---
kind: "work_record"
recordId: "e93582b8-44d4-432c-a104-f91a0e52b8ad"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-02T23:16:00.668Z"
provenance:
    sourcePlans:
        - "08ebe9a4-346e-445a-81b8-136443d56f53"
---

# Consume-once Session task completion

## Summary

HostedSession records accepted task completions with ownership metadata for consume-once handling by the root workflow. Completion handling does not depend on transcript position, so steered completions do not strand workflows or replay stale results. Isolated Session completions cannot advance the root workflow.

## Future Planning Notes

Represent workflow completion explicitly and scope consumption to its owner. Transcript position is not a reliable completion authority.
