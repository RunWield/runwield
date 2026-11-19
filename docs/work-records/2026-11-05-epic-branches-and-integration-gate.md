---
kind: "work_record"
recordId: "eaf4dcb8-d6e0-4f90-9bf4-0e692d6421d6"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-11-05T16:12:43.819Z"
provenance:
    sourcePlans:
        - "5a7fd331-f2b4-4b1b-9b79-324a3b55ecb1"
---

# Epic branches and integration gate

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: Owner confirmed this Plan was delivered. Implementation and tests were published in commit 667d10be5 (Run every Epic on its own branch with an integration gate, 2026-10-01), which is contained in main. The draft status was stale. RunWield gives new Git-backed Epics a dedicated branch, defaulting to `epic/<epic-name>`, and child Plans inherit that delivery target unless explicitly overridden. Epic readiness depends on delivered commits contained in that branch, not child statuses alone, while direct user closure or acceptance remains authoritative. The integration gate checks the assembled Epic at an exact branch head with project CI, whole-Epic integration review, and Code Review according to the user's `codereview` setting. Durable findings support user-approved repair children whose delivery returns the assembled work to the gate, separating incremental child delivery from whole-capability acceptance.

## Out of Scope

This work does not include automatic merging of the Epic branch into the primary branch, Plan Packages, or Validator-based Epic contracts.

## Future Planning Notes

Create a missing Epic branch from the latest primary branch and record its base commit; preserve existing branch history and explicit child targets. Gate results apply only to the checked commit: later Epic branch commits require another gate check, and the gate does not establish merge compatibility with a newer primary branch. Branch preparation must preserve the user's checkout and existing child documents. Sequence containers, non-Git Epics, and branchless Epics with already-started children retain their legacy completion behavior.
