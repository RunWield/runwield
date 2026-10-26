---
kind: "work_record"
recordId: "f5bfa8dc-752c-4ade-9590-e4079e2df32c"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:51:20.908Z"
provenance:
    sourcePlans:
        - "8bc1fc1c-5747-426d-92fa-c45b8876efae"
---

# Operation and quick-fix routing boundaries

## Summary

OPERATION routes non-code repository and environment work to Operator. QUICK_FIX routes bounded code changes without a Plan to Engineer and requires Mechanical Validation with bounded repair attempts.

## Future Planning Notes

QUICK_FIX has no Plan lifecycle, AI review, Code Review, or worktree merge-back. Dependency upgrades that require code edits or fail CI return to Router for fresh triage.
