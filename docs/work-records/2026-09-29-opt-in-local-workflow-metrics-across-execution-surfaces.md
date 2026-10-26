---
kind: "work_record"
recordId: "e24fc4b5-cf6e-488e-a977-b5f90016d8a2"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-29T21:51:38.721Z"
provenance:
    sourcePlans:
        - "8faf46c2-95d7-4e2d-8458-194172ff0e9a"
---

# Opt-in local workflow metrics across execution surfaces

## Summary

RunWield records privacy-filtered local metrics for tool activity, exposure, model usage and cost, context, retries, latency, delegation, and slash commands across execution surfaces. Recording is off by default and separate by Project. Missing measurements remain explicit.

## Out of Scope

This work does not include a dashboard, export, retention controls, or a new storage service.

## Future Planning Notes

Consumers must preserve the owner’s default-off recording policy and the distinction between missing and measured values.
