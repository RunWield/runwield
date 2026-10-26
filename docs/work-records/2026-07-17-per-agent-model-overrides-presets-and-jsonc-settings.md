---
kind: "work_record"
recordId: "1fed84ad-6da4-4a21-b706-7ce769998120"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:40:58.897Z"
provenance:
    sourcePlans:
        - "110786ce-e028-4b3f-98f3-722c25782f5e"
---

# Per-Agent model overrides, presets, and JSONC settings

## Summary

RunWield merges global and project per-Agent model overrides with preset overlays, while explicit runtime selections retain priority. Settings accept JSONC comments and trailing commas. Invalid configured models fall back safely, model resolution stays aligned with footer display, and /reload applies preset changes.
