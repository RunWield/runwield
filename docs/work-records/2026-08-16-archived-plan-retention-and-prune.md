---
kind: "work_record"
recordId: "ad084bfc-ad05-4c6d-9a2b-97b85c48f7b8"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-16T15:06:11.340Z"
provenance:
    sourcePlans:
        - "e7be100d-d6b0-4df0-bb7f-e20cfb9efc97"
---

# Archived Plan retention and pruning

## Summary

Archived Plan pruning uses project-scoped retention settings, a keep-last floor, and Epic child grouping. Deletion eligibility requires Work Record coverage and expired retention. Pruning is an explicit command rather than automatic archive deletion.

## Future Planning Notes

Keep pruning manual, project-scoped, and protected by Work Record provenance. Preserve Epic grouping and retention floors when changing selection rules.
