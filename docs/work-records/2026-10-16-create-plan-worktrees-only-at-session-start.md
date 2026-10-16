---
kind: "work_record"
recordId: "a91edc69-e3ee-4ef8-8bfb-84fdb182ad25"
status: "pending_verification"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-16T15:21:47.702Z"
provenance:
    sourcePlans:
        - "4b5a0ce0-d604-4c4f-808a-f7c720e5410a"
---

# Create Plan worktrees only at session start

## Summary

Made Plan location lookup non-creating and non-fetching. Shared session-start preparation now creates or refreshes worktrees for planning, review, re-review, execution, and Epic continuation, using the latest fetched target branch. Session-less writes to unstarted Plans refuse before side effects. Existing refresh, sibling scope synchronization, Sequence support, and execution recovery remain intact. Updated the Core PRD and ADR-005. Reported verification covered 136 focused tests, 10 deliberate-fault checks, type checking, zero-seam enforcement, documentation links, and diff checks.

## Deviations from Plan

No bulk push/share loop existed in this checkout; collaboration protection uses preflight refusal before push, share, or unshare side effects. Acceptance journeys used real Git/runtime fixtures instead of a manual keyboard walkthrough.
