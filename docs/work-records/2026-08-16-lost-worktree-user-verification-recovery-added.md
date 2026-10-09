---
kind: "work_record"
recordId: "a5d17572-da87-4f62-9bcd-a6ede1ce1b7c"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-16T14:10:18.511Z"
provenance:
    sourcePlans:
        - "bc990d08-29bc-41c9-8548-7c51bbc4d5e0"
---

# Lost-worktree User Verification recovery added

## Summary

RunWield now offers the existing User Verified action from the lost-worktree recovery menu when the Plan status is
eligible, such as implemented. The normal recovery menu now also hides that action for ineligible statuses, such as
failed. The change reuses the existing attestation flow and does not add a new validation claim.

## Deviations from Plan

Full `deno task ci` did not pass because `src/ui/tui/golden-scenarios/project-workflow.test.ts` failed under the full
suite twice, although that file passed when rerun standalone.

## Future Planning Notes

Recovery menu actions should use the same lifecycle eligibility checks across normal and lost-worktree paths so users do
not see choices that the lifecycle will reject.
