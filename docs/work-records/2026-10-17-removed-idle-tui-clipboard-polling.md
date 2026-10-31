---
kind: "work_record"
recordId: "ee460c33-12a8-48a0-8d16-49fcc7825e03"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-17T20:07:17.860Z"
provenance:
    sourcePlans:
        - "15362820-c4c2-4de9-89c5-5bd5761ffaf9"
---

# Explicit-read TUI clipboard image detection

## Summary

The TUI checks clipboard images only during explicit paste reads rather than polling while idle. Empty image reads show “No image in clipboard”, and disposed inputs reject paste work. Image previews, text paste, read ordering, and temporary-file cleanup remain intact. This removes clipboard polling without establishing a cause for the reported macOS lockup.

## Future Planning Notes

Keep clipboard detection private to explicit reads so future status hints cannot reintroduce polling.
