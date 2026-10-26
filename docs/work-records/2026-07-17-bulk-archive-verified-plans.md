---
kind: "work_record"
recordId: "1b9dd2d0-7eb9-4335-a35a-7b36f6ece4d4"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:41:20.973Z"
provenance:
    sourcePlans:
        - "42910b23-b1a5-46f6-9312-0562840f5890"
---

# Bulk archival of verified Plans

## Summary

RunWield can archive all active Plans that match verified status, with an optional reason. Bulk archival preserves single-Plan safeguards, continues after individual failures, reports each outcome, and returns a nonzero exit status on partial failure.
