---
kind: "work_record"
recordId: "839a6cf8-b614-4c9d-bbac-00dd1054ff2f"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:47:27.336Z"
provenance:
    sourcePlans:
        - "a0ef3214-49ec-4d7a-8a0d-6df62774c23d"
---

# Non-Git project execution

## Summary

RunWield requires explicit, project-scoped consent to execute FEATURE Plans and QUICK_FIX work directly in non-Git project roots. Non-Git validation runs available CI, and recovery gives clear Git-required guidance rather than raw command errors. Git-backed projects retain normal worktree isolation, validation, merge, and recovery behavior.

## Out of Scope

Non-Git execution does not provide worktree isolation, baseline restoration, commit-history checks, merge-back, AI diff review, or Code Review.
