---
kind: "work_record"
recordId: "e1581360-ea46-40c3-a9c8-8d9ad70b437f"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-28T19:58:18.685Z"
provenance:
    sourcePlans:
        - "d95497fb-0ec8-41ae-98e5-57f3fa7c0d51"
---

# Execution-tree settings for Plan CI

## Summary

Plan Mechanical Validation reloads the verification command from execution-worktree settings before each local CI run. Ordinary linked-worktree settings still resolve through the primary checkout. CI repair instructions identify execution-checkout settings as the command authority and require the configured command to pass.

## Future Planning Notes

Keep execution-tree settings resolution limited to Plan CI. Do not weaken the ordinary primary-checkout settings policy.
