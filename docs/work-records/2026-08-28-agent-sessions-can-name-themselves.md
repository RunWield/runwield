---
kind: "work_record"
recordId: "f5406f11-f10b-4653-89a3-b68dce63053f"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-28T21:06:17.548Z"
provenance:
    sourcePlans:
        - "5b35b3ec-6b0b-4f06-a7c4-3715706e21bc"
---

# Agent-managed Session names

## Summary

User-facing Agents can name their root Session through set_session_name. Names are sanitized and persisted, and rename events reach both Pi and Claude CLI Sessions. Unnamed Sessions receive a naming reminder; named Sessions do not.

## Future Planning Notes

Apply universal Agent tools during definition loading and runtime tool resolution. Bundled, overlaid, and project-defined Agents require the capability, while isolated Subagents remain excluded.
