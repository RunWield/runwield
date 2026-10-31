---
kind: "work_record"
recordId: "fffb1146-359a-454f-bc5d-ab8d43dd3af6"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-05T04:20:26.859Z"
provenance:
    sourcePlans:
        - "a4311ccc-d963-4f35-94cd-1c41f9a04733"
---

# Routing-only Triage Reports

## Summary

Triage Reports contain routing intent, complexity, summary, and an optional Session Name, without affected paths. Dispatched Agents discover the relevant files themselves. Affected Paths remain Plan metadata for planned execution.

## Future Planning Notes

Contract-field removal must cover schemas, normalization, metrics, scripts, and reporting consumers together. Schema and normalization changes must land together to preserve valid dispatch.
