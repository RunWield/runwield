---
kind: "work_record"
recordId: "4082e02d-d083-4e39-a051-4a7176c7a25a"
status: "pending_verification"
scope: "planned_change"
workKind: "DOCUMENTATION"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-27T00:18:01.094Z"
provenance:
    sourcePlans:
        - "e0d548d5-c6f0-412c-90c4-0f76be5f47ff"
---

# Plan backlog cleanup

## Summary

The Plan backlog excludes obsolete and duplicate proposals, while completed work is preserved in the archive. Forge is retained as a draft Epic without its stale child Plans. Retained Plans, PRDs, TODO entries, and archive links no longer depend on the deleted proposals. Plan storage guidance points to the Plan Store PRD rather than the removed Plan Packages Epic, so later planning does not inherit its obsolete storage assumptions.

## Deviations from Plan

1. Superseded requirement: Move forge-change-request-delivery to Draft on the Workspace Plan board. This is the manual_status_change board action, not a front matter edit. Lifecycle operations belong to the owner on the primary checkout before execution starts.
   Replacement requirement: The Engineer is authorized to complete the remaining lifecycle preconditions, including returning forge-change-request-delivery to Draft through RunWield's supported lifecycle operation, and to make the completed preconditions available to the existing execution checkout. Do not hand-edit protected lifecycle metadata or discard user work.
   Reason: The owner completed the abandonment and archive steps but cannot perform the board action, and explicitly authorized the Engineer to complete the remaining operations.

## Out of Scope

This work does not include application behavior changes, edits to in-flight Connect, Usage, or Remote SSH Epic Plans, or deletion of leftover branches.

## Future Planning Notes

Forge requires a new architecture review against current code and PRDs, followed by a new decomposition, before work resumes. In-flight Epic branches own their Plan documents; backlog cleanup must preserve their main-branch snapshots.
