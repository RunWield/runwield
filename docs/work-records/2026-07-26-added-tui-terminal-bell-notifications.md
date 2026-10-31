---
kind: "work_record"
recordId: "b3d1dc0c-e754-470c-86f6-86cb2aeecd45"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-26T03:08:58.548Z"
provenance:
    sourcePlans:
        - "6be1cd31-a2a2-4ca6-9f4c-d3e7982cd121"
---

# TUI terminal bell notifications

## Summary

TUI attention notifications emit terminal BEL by default, with an opt-out setting. Terminal emulators and multiplexers control audible or visual feedback, while existing macOS desktop notifications remain available.

## Future Planning Notes

Terminal feedback belongs to the TUI boundary and terminal configuration. Desktop notification sound controls must not duplicate BEL feedback.
