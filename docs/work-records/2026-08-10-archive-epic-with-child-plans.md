---
kind: "work_record"
recordId: "d78e2b72-b74a-4f99-bb82-35ab1e1aaf5f"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-10T00:08:11.281Z"
provenance:
    sourcePlans:
        - "9c81e9a0-c2f4-47eb-ae13-285d3ae04c42"
---

# Epic and child Plan archiving

## Summary

Archive Epic moves a terminal Epic and its child Plans into archived storage while preserving their structure. Recoverable worktrees block the operation before any move, and confirmation identifies the affected children and unfinished work. Child-first moves preserve an active parent entry point if an operation needs recovery.

## Future Planning Notes

Check recoverable worktrees before the first archive move. Archive children before their parent so partial operations retain a recovery entry point.
