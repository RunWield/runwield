---
kind: "work_record"
recordId: "62a4e02c-ea11-43ad-a637-110bb2470ef5"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-17T17:51:39.009Z"
provenance:
    sourcePlans:
        - "f8e5ab69-b8ab-4879-8b44-bf8565a1593c"
---

# Planning worktree recovery after Epic history rewrites

## Summary

Planning refresh measures child-owned changes from the recorded worktree base rather than a merge base. After an Epic history rewrite, preparation-only worktrees rebuild on the new target, preserve saved planning edits, retain a recovery ref, and update the registry. Real implementation and conflicting edits remain protected. Recovery also protects ignored files, detects concurrent editor changes, and resumes interrupted journals automatically.

## Future Planning Notes

Use the recorded worktree base to distinguish child changes from rewritten upstream history. Checking implementation changes alone is insufficient: merging old and rewritten histories can still create conflicts or retain duplicate history.
