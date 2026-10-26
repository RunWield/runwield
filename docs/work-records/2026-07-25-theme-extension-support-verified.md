---
kind: "work_record"
recordId: "32b305ea-2981-41c0-adf0-c3c89e976085"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-25T22:09:51.791Z"
provenance:
    sourcePlans:
        - "3f6e3949-9848-41f2-b39e-03966d01c680"
---

# Dynamic theme extensions

## Summary

RunWield supports Pi-backed theme discovery, theme selection, and external JSON theme installation and removal. The embedded `catppuccin-mocha` theme remains the fallback and wins name collisions.

## Future Planning Notes

External themes remain JSON-only. Lazy discovery preserves inexpensive default-theme startup, and the embedded fallback remains the merge floor.
