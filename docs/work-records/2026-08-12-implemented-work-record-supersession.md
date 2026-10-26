---
kind: "work_record"
recordId: "b6f4b4a5-629d-4bdc-88a9-52205b29b192"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-12T17:34:34.656Z"
provenance:
    sourcePlans:
        - "29ebfa42-f20b-4287-812e-220b3681f381"
---

# User-authorized Work Record supersession

## Summary

Work Record supersession supports approved Plan declarations and Recorder proposals across completion modes. Recorder proposals remain pending until explicit user confirmation in interactive, headless, and backfill flows. Canonical updates use locking and rollback protection, while index synchronization follows the Markdown authority. Users can also authorize supersession through wld wr supersede.

## Future Planning Notes

Canonical Markdown owns supersession state; search indexes are projections. Recorder proposals require explicit user confirmation before they change existing records.
