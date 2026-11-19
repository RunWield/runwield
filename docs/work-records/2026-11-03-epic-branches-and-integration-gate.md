---
kind: "work_record"
recordId: "bc19ad12-b0e7-44ec-817c-e72287b20602"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-11-03T00:35:27.784Z"
provenance:
    sourcePlans:
        - "5a7fd331-f2b4-4b1b-9b79-324a3b55ecb1"
---

# Epic branches and integration gate

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: Owner confirmed this Plan was delivered. Implementation and tests were published in commit 667d10be5 (Run every Epic on its own branch with an integration gate, 2026-10-01), which is contained in main. The draft status was stale. RunWield gives new Git-backed Epics a dedicated branch, created from the latest primary-branch head, and makes child Plans inherit that target unless explicitly overridden. Epic readiness depends on delivered commits being contained in the Epic branch, or explicit user closure, rather than child validation status alone. The integration gate checks the assembled Epic at an exact branch commit with project CI, an Epic-wide integration review, and Code Review according to the user's setting. Integration findings feed ordinary repair-child planning, and repair delivery triggers another gate check. This separates incremental child delivery from acceptance of the combined capability.

## Out of Scope

This work does not include automatic publication of the Epic branch to the primary branch, Plan Packages, Validator-based contract checks, or isolated Planner worktrees.

## Future Planning Notes

Existing Epic branches must be reused without reset. Child draft synchronization must preserve existing branch content and must not move a branch under an active checkout. Gate results apply only to the checked commit; later branch commits require another gate check. The gate checks the Epic branch, not its merge with the current primary branch. Explicit child targets, hold, and done-enough remain supported. Sequence containers, non-Git Epics, and branchless Epics with children already started retain their legacy completion rules.
