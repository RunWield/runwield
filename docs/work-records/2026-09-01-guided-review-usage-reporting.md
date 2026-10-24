---
kind: "work_record"
recordId: "99d0a618-adb5-461f-b344-1c2980fd08ae"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-01T23:07:44.426Z"
provenance:
    sourcePlans:
        - "4046a097-b84d-42f8-9d3c-9c1841dd89fc"
---

# Guided Review usage reporting

## Summary

Guided Review forwards provider runtime usage to Workspace jobs without mixing protocol data into review JSON. Workspace aggregates live token and USD cost totals, preserves partial totals on failure, and shows distinct pending, available, and unavailable usage states.

## Future Planning Notes

Keep usage protocol data off stdout when a subprocess also returns machine-readable content. Event presence determines availability so valid zero-token or zero-cost reports are not shown as unavailable.
