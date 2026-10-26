---
kind: "work_record"
recordId: "0d007d7a-5c3c-4832-a379-3d2e35511237"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-11T04:55:36.056Z"
provenance:
    sourcePlans:
        - "f9164a69-018d-4287-9ae0-8178d5cb5974"
---

# Safe lazy-language diff highlighting

## Summary

Workspace code review prepares the current diff's Pierre/Shiki grammars before rendering. Failed grammar loads fall back to plain text rather than hide file content. All-files and Guided Review blocks use the same readiness protection.

## Future Planning Notes

Prepare asynchronous rendering dependencies before invoking vendored renderers. Keep language loading demand-driven and preserve plain text as the safe fallback.
