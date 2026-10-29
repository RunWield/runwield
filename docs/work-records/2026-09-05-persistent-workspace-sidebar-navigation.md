---
kind: "work_record"
recordId: "a69e9613-2101-45c6-a899-cd89af4912d4"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-05T03:38:41.003Z"
provenance:
    sourcePlans:
        - "2a7837a7-c3da-4ba5-b374-8f5afcfbfb50"
---

# Persistent Workspace sidebar navigation

## Summary

Workspace keeps the owner sidebar mounted during authenticated navigation while the main surface changes. Sidebar refresh is event-driven, runs once per completed in-app navigation, preserves unchanged Project and Session rows, and avoids idle polling.

## Future Planning Notes

Use authenticated client navigation and initialize page scripts on Astro navigation events. ClientRouter and transition persistence support the app shell without a separate React shell.
