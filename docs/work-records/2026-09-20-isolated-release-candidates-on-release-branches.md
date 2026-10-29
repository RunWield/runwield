---
kind: "work_record"
recordId: "cb218bdd-6b7c-4638-bf0c-34f30c0f3988"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-20T03:14:45.661Z"
provenance:
    sourcePlans:
        - "4ccd11cc-7bc9-4e05-8cce-3448d5862cd6"
---

# Release Candidate isolation on Release Branches

## Summary

RunWield atomically publishes the dedicated Release Branch and first tag for each new Candidate series. Later Candidates use the checked remote branch tip rather than caller HEAD. Stable promotion, Direct Stable, dirty-checkout support, legacy series behavior, and repository-neutral release guidance retain their existing behavior.

## Future Planning Notes

Make fixes on the Release Branch first and forward-port them to main. Later Candidates must use the live pushed branch tip with ancestry and race checks, never a fallback to caller HEAD.
