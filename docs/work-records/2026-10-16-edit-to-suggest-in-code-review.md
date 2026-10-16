---
kind: "work_record"
recordId: "60dc16d7-b2a5-43d0-a3a6-9b0883708c69"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-16T03:41:18.220Z"
provenance:
    sourcePlans:
        - "14000720-5bc1-4921-97ea-eaea9faf18a1"
---

# Edit-to-suggest in Code Review

## Summary

Delivery metadata has been finalized for this validated change.
Candidate containing the implementation and draft record: `48b4a7403c30103b7a26191620d9d313e06aa14d`.
Delivery destination: `plan/edit-code-to-suggest-in-code-review`.
This record accompanies the delivery commit. The publication receipt confirms whether that commit reached its destination; this metadata alone does not prove a remote push or a merge into another branch.

Validation scope is the configured workflow gate. See the delivery card's test results for the actual command output; no additional or full test suite is claimed here.

## Historical pre-publication notes

The recorder draft below is preserved verbatim as historical context. Its publication-pending and outstanding-validation statements describe the earlier snapshot, not the current delivery status. Implementation details, deviations and deferred work remain available here; consult the delivery evidence for final validation outcomes.

> # Edit-to-suggest in Code Review
>
> ## Summary
>
> Implemented experimental, default-off edit-to-suggest in standalone and Workspace Code Review. All-files edits become
> suggestion annotations in repair feedback without writing project files; Guided Review remains unchanged. File reads now
> use the execution worktree and the shared merge-base comparison. Added the code-only Display setting and Core PRD
> requirement. Focused tests passed (77 total), and headed-browser checks confirmed suggestion handoff, comment retention
> after Discard, and unchanged project files.
>
> ## Deferred Work
>
> Resolve the first-line selection action overlapping the edit toolbar. Investigate the React invalid-hook warning emitted
> by the passing PWA asset test.
>
> ## Future Planning Notes
>
> Keep Pierre compatible with pinned Plannotator (1.3.6 for this implementation). Workspace review checkout resolution
> depends on same-origin referrer context; preserve the document policy and referrer fields through service-worker
> requests.
