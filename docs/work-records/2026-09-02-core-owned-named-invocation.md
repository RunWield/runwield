---
kind: "work_record"
recordId: "2444044e-afd6-4b15-8879-dc8681200e07"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-02T01:46:43.210Z"
provenance:
    sourcePlans:
        - "a5983252-78d4-466f-879e-17d27b749ade"
---

# Core-owned Named Invocation

## Summary

Prompt Template and Skill slash invocations resolve in shared Session runtime for TUI, Workspace, and ACP. Prompt Templates can declare one-shot Agent, model, and thinking policy and run through an auxiliary turn without changing root Session state. Saved history preserves exact hidden expansions while displays remain compact, and reload refreshes active Agent catalogs.

## Future Planning Notes

Keep raw slash classification in Core and Prompt Template workflow authority separate from Skills. Preserve immutable transcript expansions for resume instead of re-reading changed template files.
