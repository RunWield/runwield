---
kind: "work_record"
recordId: "d1d9245b-971a-41ac-83d2-c0813b074583"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:41:42.118Z"
provenance:
    sourcePlans:
        - "daa36ef2-5d66-4794-a61a-562d9253817c"
---

# Batched Cymbal show and outline tooling

## Summary

The code_batch tool executes up to five known Cymbal show and outline operations sequentially. Each operation has isolated errors, labeled output, and bounded truncation, so Agents can retrieve related code context in one request.

## Out of Scope

This work does not include batch search or project-context snapshots.

## Future Planning Notes

Code retrieval batches need deterministic operation limits and strict output budgets to keep context use predictable.
