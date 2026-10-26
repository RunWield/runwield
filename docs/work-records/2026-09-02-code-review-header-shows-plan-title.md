---
kind: "work_record"
recordId: "dee1a319-065d-4a51-b87e-8e6bc99e44dd"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-02T01:29:41.500Z"
provenance:
    sourcePlans:
        - "584d0b85-8b6a-47b3-850f-9dd30d275679"
---

# Plan identity in Code Review headers

## Summary

Standalone and Workspace Code Review show the producing Plan title in the header. The title comes from the first non-empty top-level Plan heading, uses a safe fallback, and travels through existing launch payloads. Long titles remain accessible without hiding review actions.

## Future Planning Notes

Project the smallest stable display value from workflow code through existing launch payloads instead of making browser UI parse Plan Markdown.
