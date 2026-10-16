---
kind: "work_record"
recordId: "3b2cb09c-9dd8-4ef9-824a-2ebd2bfa22a3"
status: "approved"
scope: "planned_change"
workKind: "DOCUMENTATION"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-16T17:06:23.354Z"
provenance:
    sourcePlans:
        - "06e22551-74b2-437c-a3a4-e8ec7e7ea511"
---
# Treat unknown check results as inconclusive

## Summary

Delivery metadata has been finalized for this validated change.
Candidate containing the implementation and draft record: `1a222f04d3af2d46b4a0e5bd3a3401660220b397`.
Delivery destination: `plan/empty-answer-is-not-a-negative-answer`.
This record accompanies the delivery commit. The publication receipt confirms whether that commit reached its destination; this metadata alone does not prove a remote push or a merge into another branch.

Validation scope is the configured workflow gate. See the delivery card's test results for the actual command output; no additional or full test suite is claimed here.

## Historical pre-publication notes

The recorder draft below is preserved verbatim as historical context. Its publication-pending and outstanding-validation statements describe the earlier snapshot, not the current delivery status. Implementation details, deviations and deferred work remain available here; consult the delivery evidence for final validation outcomes.

> # Treat unknown check results as inconclusive
> 
> ## Summary
> 
> Added a Core PRD requirement and two acceptance scenarios that distinguish unknown state from a definite negative answer. Updated engineering, review, working-tree safety, and test-writing guidance to require safe handling of inconclusive checks and shared identifiers for matching answers. Added a prompt-composition regression test; focused tests and a section-removal mutation check passed. This change establishes requirements and agent guidance, not runtime compliance; no runtime code changed or was audited.
> 
> ## Deferred Work
> 
> A separate Plan can audit lock release, worktree registry repair, and Session writer locks against the new rule.
> 