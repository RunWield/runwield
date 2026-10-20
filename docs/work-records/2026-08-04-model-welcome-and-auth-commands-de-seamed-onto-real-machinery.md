---
kind: "work_record"
recordId: "b65384be-ba26-499e-a5e8-991b2af7d2a6"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-04T21:27:35.235Z"
provenance:
    sourcePlans:
        - "577e1104-a38d-49b5-83ff-cd77d80b6906"
---

# Model onboarding and authentication authority

## Summary

Model onboarding uses the real model registry, settings, and command machinery without optional dependency overrides. Login, model selection, and quit use the canonical command registry, while interactive authentication requires an explicit UI capability. Composed-TUI tests exercise real onboarding state and fake only external capabilities.

## Future Planning Notes

Required capabilities must fail clearly at optional-context boundaries rather than become optional themselves. Test durable behavior through real authorities, and remove redundant wrapper state changes.
