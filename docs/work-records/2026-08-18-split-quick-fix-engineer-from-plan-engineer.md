---
kind: "work_record"
recordId: "8141165a-a255-46a8-a5d0-7b986a55efde"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-18T13:26:51.018Z"
provenance:
    sourcePlans:
        - "e29bc564-93dc-4440-a1b5-79fe9f3041a2"
---

# Distinct Quick Fix and Plan execution Agents

## Summary

Selectable Engineer owns Quick Fix work, while workflow-only Plan Engineer owns planned engineering execution. Frontend Engineer remains workflow-only for browser-UI-dominated Plans, and Pair Execution supports both Plan owners. A shared resolver maps stable Plan policy values to runtime Agent identities.

## Future Planning Notes

Keep Plan policy values stable and resolve runtime identities only at activation and comparison boundaries. Identity changes require coverage for runtime selection, Golden TUI behavior, and progress events.
