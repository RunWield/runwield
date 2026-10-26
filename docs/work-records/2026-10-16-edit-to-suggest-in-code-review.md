---
kind: "work_record"
recordId: "60dc16d7-b2a5-43d0-a3a6-9b0883708c69"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-16T03:41:18.220Z"
provenance:
    sourcePlans:
        - "14000720-5bc1-4921-97ea-eaea9faf18a1"
---

# Edit-to-suggest in Code Review

## Summary

RunWield offers experimental, default-off edit-to-suggest in standalone and Workspace Code Review. All-files edits become suggestion annotations in repair feedback without writing Project files; Guided Review remains unchanged. File reads use the execution worktree and the shared merge-base comparison. A code-only Display setting controls the feature.

## Future Planning Notes

Keep Pierre compatible with the pinned Plannotator version. Workspace review checkout resolution depends on same-origin referrer context; preserve the document policy and referrer fields through service-worker requests.
