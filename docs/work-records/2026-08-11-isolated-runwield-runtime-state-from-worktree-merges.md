---
kind: "work_record"
recordId: "dc1e7c94-a38a-418d-9c63-4550fb3583ca"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-11T16:31:08.168Z"
provenance:
    sourcePlans:
        - "ea4f8a95-7e76-435f-90d2-d811f8450885"
---

# Runtime-state isolation from worktree publication

## Summary

Linked execution worktrees resolve ordinary project settings through the primary checkout. RunWield classifies its runtime state separately and excludes that state from staging and merge-risk checks. Missing worktree registry entries can be reconstructed from Plan evidence without discarding finished work.

## Future Planning Notes

Enumerate RunWield-owned runtime state narrowly; project-owned settings, Agents, Skills, and prompts can be valid deliverables. Use real Git fixtures for worktree and registry behavior.
