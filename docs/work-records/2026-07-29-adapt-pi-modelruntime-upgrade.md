---
kind: "work_record"
recordId: "bce0330f-dbc0-4a9a-8a82-27b051646984"
status: "approved"
scope: "planned_change"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-29T03:36:45.584Z"
provenance:
    sourcePlans:
        - "adcd3dea-10bd-4f5e-98b9-9477809b315d"
---

# Pi ModelRuntime integration

## Summary

RunWield uses cached Pi ModelRuntime integration for model and authentication APIs, Agent Session creation, and TUI model selection. The integration preserves the model facade, temperature wrapping, and maximum thinking-level support.

## Future Planning Notes

Pi integrations use public ModelRuntime contracts rather than private or removed APIs. The Deno-era dependency policy separates allowed import ranges from locked resolutions.
