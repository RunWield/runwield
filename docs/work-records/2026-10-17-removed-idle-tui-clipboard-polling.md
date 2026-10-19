---
kind: "work_record"
recordId: "ee460c33-12a8-48a0-8d16-49fcc7825e03"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-17T20:07:17.860Z"
provenance:
    sourcePlans:
        - "15362820-c4c2-4de9-89c5-5bd5761ffaf9"
---
# Removed idle TUI clipboard polling

## Summary

Delivery metadata has been finalized for this validated change.
Candidate containing the implementation and draft record: `2084854a5dcdf07be9a5fdce8b721a3924216755`.
Delivery destination: `main`.
This record accompanies the delivery commit. The publication receipt confirms whether that commit reached its destination; this metadata alone does not prove a remote push or a merge into another branch.

Validation scope is the configured workflow gate. See the delivery card's test results for the actual command output; no additional or full test suite is claimed here.

## Historical pre-publication notes

The recorder draft below is preserved verbatim as historical context. Its publication-pending and outstanding-validation statements describe the earlier snapshot, not the current delivery status. Implementation details, deviations and deferred work remain available here; consult the delivery evidence for final validation outcomes.

> # Removed idle TUI clipboard polling
> 
> ## Summary
> 
> Removed idle clipboard polling and made image detection private to explicit Ctrl-V reads. Added “No image in clipboard” feedback and a post-disposal paste guard while preserving previews, text paste, read ordering, and temporary-file cleanup. Updated Core requirements and feature documentation. The 65-test focused suite passed. The rebuilt, locally installed binary produced zero idle clipboard calls across three sessions for 30 seconds; the old binary produced four probes in five seconds. This removes the observed polling problem, not a proven macOS lockup cause.
> 
> ## Deferred Work
> 
> Carlos’s real screenshot-to-model check remains. Lockup prevention still requires normal-use observation after reboot; the LaunchServices identifier-wrap explanation remains a hypothesis.
> 
> ## Future Planning Notes
> 
> Existing RunWield processes must restart to load the fix. Keep clipboard detection private to explicit reads so future status hints cannot reintroduce polling.
> 