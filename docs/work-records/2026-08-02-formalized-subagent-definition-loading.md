---
kind: "work_record"
recordId: "52b2953d-e0c4-4734-8d39-68feee925a28"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-02T15:05:46.726Z"
provenance:
    sourcePlans:
        - "069d2ec8-ab4a-47cd-969b-fb3ee4d811ea"
---

# Shared subagent definition loading

## Summary

Workflow-dispatched Subagents use a typed definition registry and shared loader. Validation, Delegated Agent, Slicer, and Init share prompt-loading and Front Matter handling. Runtime identifiers remain stable, and workflow-only Subagents stay outside manual Agent selection.
