---
kind: "work_record"
recordId: "943b37ec-5a4d-4a50-a51a-8998620cc916"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-22T12:34:44.772Z"
provenance:
    sourcePlans:
        - "0ae18c01-9dd4-44c8-96d5-dcf816f23c47"
---

# ACP reasoning and exact context reporting

## Summary

The ACP adapter exposes and persists the standard reasoning selector, applies it to the next provider turn, and refreshes configuration after model or Agent changes. Usage updates report exact Runtime context usage and capacity, suppress unknown values, and preserve cumulative cost.

## Future Planning Notes

Runtime context usage is the authority for ACP indicators. Never substitute per-message token counts or fabricate capacity. Registry metadata must describe published release assets rather than the local build version.
