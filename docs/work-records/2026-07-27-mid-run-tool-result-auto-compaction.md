---
kind: "work_record"
recordId: "dc467de9-9e61-4746-a4c0-c7b3cecae1c9"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-27T13:15:09.586Z"
provenance:
    sourcePlans:
        - "5cf1e3a4-c0fe-4407-b65f-2a7b2ba927b4"
---

# Mid-run context resilience

## Summary

RunWield detects context pressure at safe completed-turn boundaries, compacts, measures recovery, and continues or pauses without treating stale partial outcomes as success. Shared coordination applies across hosted and delegated Sessions, TUI, and ACP.

## Future Planning Notes

Context resilience uses public Pi contracts and shared coordination rather than adapter-local policy, private hooks, or duplicate summarization.
