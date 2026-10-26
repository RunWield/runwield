---
kind: "work_record"
recordId: "21b92d3b-60a4-4506-815a-48d48d54c168"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-04T00:55:05.481Z"
provenance:
    sourcePlans:
        - "29398c6b-fa02-4bb6-bada-14b2f8429451"
---

# Mascot visibility control and stable TUI blinking

## Summary

RunWield provides a default-on mascot setting with Project overrides, a global TUI toggle, and reload support. TUI and Workspace hide disabled mascots without layout gaps; hiding an active TUI mascot stops its timer. Stable drawing widths prevent horizontal movement during blinking and pose changes.

## Out of Scope

This work does not include a Workspace toggle; Workspace honors settings changed through the TUI or settings files.

## Future Planning Notes

Cache merged settings used during animation and invalidate them on writes and reload. Center animated drawings using the maximum width across frames and poses, not each frame’s width.
