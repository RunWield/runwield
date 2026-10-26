---
kind: "work_record"
recordId: "f9212311-026d-4e30-85a7-a5036e34fa7d"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:47:02.870Z"
provenance:
    sourcePlans:
        - "a27652c4-f583-4618-8b9c-fc83c6f586a7"
---

# Explicit worktree merge targets

## Summary

RunWield records each execution worktree's source branch and uses it as the explicit merge-back target. Merge handling is independent of the current checkout and safe for concurrent use. Recovery respects the target and supports bounded Engineer-assisted conflict repair.
