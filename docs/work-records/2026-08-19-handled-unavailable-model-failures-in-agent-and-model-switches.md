---
kind: "work_record"
recordId: "7665829e-ee64-4648-81e9-f500fcdc21ef"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-19T18:51:12.773Z"
provenance:
    sourcePlans:
        - "5c06ed28-b643-4084-85a5-ca3de6ffb7a9"
---

# Safe unavailable-model selection

## Summary

Unavailable Agent-model selections preserve the current Agent and model while displaying an error-styled recovery message. Malformed or unknown manual model selections also fail without changing active state. Golden TUI coverage observes message severity and recovery through valid selections.

## Future Planning Notes

Selection failures must preserve active state. Severity assertions should observe normal system-message delivery without adding production dependency seams.
