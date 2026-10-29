---
kind: "work_record"
recordId: "bf81ff83-73b6-47a8-a3ae-4cf05bc3ca5d"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-23T02:47:51.669Z"
provenance:
    sourcePlans:
        - "d26b8dd4-b04c-4130-849a-cacd1b93db84"
---

# Automatic Epic child Session continuation

## Summary

Successful child Plan validation can advance an Epic to its next ordered child in a fresh Runtime Session. Typed validation results and core-owned Session replacement support TUI rebinding and stable ACP Session identity.

## Future Planning Notes

Epic continuation uses typed validation results and the core-owned `session_replaced` event, not low-level Plan events or adapter-specific inference.
