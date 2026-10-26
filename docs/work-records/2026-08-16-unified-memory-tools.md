---
kind: "work_record"
recordId: "2d976ac0-ab27-40c0-8715-c3c27bbe6e62"
status: "approved"
scope: "planned_change"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-16T20:09:06.910Z"
provenance:
    sourcePlans:
        - "39b939be-a544-422f-a765-8d65c632814c"
---

# Unified memory recall and writing

## Summary

RunWield exposes memory_recall and memory_write as the model-facing memory tools. Recall searches project and global memory with provenance labels, while write handles storage and deletion with validation, safe defaults, global initialization, and core tags. Historical tool names remain readable in transcript and metrics consumers.

## Future Planning Notes

Tool renames must remove retired names from current model-facing lists while preserving historical transcript and metrics compatibility.
