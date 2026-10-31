---
kind: "work_record"
recordId: "a5d17572-da87-4f62-9bcd-a6ede1ce1b7c"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-16T14:10:18.511Z"
provenance:
    sourcePlans:
        - "bc990d08-29bc-41c9-8548-7c51bbc4d5e0"
---

# User verification in lost-worktree recovery

## Summary

Lost-worktree recovery offers the existing User Verified action when the Plan lifecycle permits it. Normal and lost-worktree recovery use the same eligibility rules. The action records user attestation without adding a RunWield validation claim.

## Future Planning Notes

Recovery menus must share lifecycle eligibility checks so they do not offer actions that the lifecycle rejects.
