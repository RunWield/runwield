---
kind: "work_record"
recordId: "fcaed561-4d2c-487c-afb2-6f6871f53aee"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-21T20:51:23.715Z"
provenance:
    sourcePlans:
        - "e8781b46-e323-405e-b6b0-f3d75ed79355"
---

# Unified local Skill discovery and precedence

## Summary

One Core Skill catalog owns listing, model advertising, and invocation. Project-local Agent Skills join consistent layered precedence and bundled-name protection, and both external Skill locations can be disabled. Pi does not load a second catalog.

## Future Planning Notes

Keep Skill selection centralized, with fresh per-Project discovery. Disable Pi Skill loading during startup and reload so it cannot bypass Core precedence and exclusions.
