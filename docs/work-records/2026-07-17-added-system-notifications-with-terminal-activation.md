---
kind: "work_record"
recordId: "1e67b377-0802-4889-9ee0-db54bbbf4127"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:51:30.256Z"
provenance:
    sourcePlans:
        - "44a682b4-1ecf-43c0-a3f2-f8e65a3ecd26"
---

# System notifications with terminal activation

## Summary

RunWield sends configurable macOS notifications when an Agent returns control, requests user input, or finishes writing a Plan. Notifications include Session context and use terminal-notifier for click activation when available, with an osascript fallback. Delivery failures do not change workflow behavior.

## Out of Scope

This work does not include exact activation for terminals without a reliable tab or pane API.

## Future Planning Notes

Keep notification dispatch centralized and best-effort, with per-event settings, Session context, and graceful fallback behavior.
