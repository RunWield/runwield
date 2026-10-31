---
kind: "work_record"
recordId: "9a678b00-6f99-48dc-9242-73ca8ae416e5"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:42:05.810Z"
provenance:
    sourcePlans:
        - "4c9c9710-739b-402d-8495-e53be5d1dd5f"
---

# Empty-project startup guidance

## Summary

RunWield detects empty project directories and gives nonblocking greenfield guidance instead of the normal boot banner and initialization offer. Initial requests route normally with Session-scoped greenfield context that survives rebuilds. Initialization in an empty directory is a no-op and does not update initialization state.
