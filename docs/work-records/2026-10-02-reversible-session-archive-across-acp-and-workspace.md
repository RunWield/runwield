---
kind: "work_record"
recordId: "68c201f7-83de-479c-8a2a-bc8e5f259acb"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-02T23:07:17.255Z"
provenance:
    sourcePlans:
        - "f75c427a-9dd9-4a40-95ef-6bca9453194b"
---

# Reversible Session archive across ACP and Workspace

## Summary

RunWield supports durable, file-authoritative Session archive through ACP and Workspace, with an Archived Sessions settings tab and Unarchive. Archive hides Sessions from ordinary history and resume lists while preserving identity, transcripts, Plan links, and workflow state. Busy Sessions stop and settle before archive.

## Future Planning Notes

Keep archive distinct from ACP close, transcript deletion, and Plan completion. Resolve ACP segment IDs to stable Session identity and require authoritative settlement before archive. Direct and Plan links remain accessible without restoring an archived Session.
