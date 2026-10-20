---
kind: "work_record"
recordId: "42299407-d261-4d55-ae9f-d7cd2c56fbe2"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-13T13:21:13.659Z"
provenance:
    sourcePlans:
        - "7c585b2d-47b2-4417-9f2d-c73a07fee0e9"
---

# Standalone Code Review with wld review

## Summary

RunWield supports Standalone Code Review of PR/MR URLs, branches, and uncommitted changes through `wld review`, without
a Plan lifecycle. All modes share diffs, Guided Review, and Engineer chat. On-demand Review Worktrees support Forge
comments and approval, commit-and-push, checkout recovery, and cancellation while preserving local work and annotations.
Stale-head handling and publication retries preserve the review baseline.

## Deviations from Plan

1. Superseded requirement: Manual verification step 3: Ask the user before posting, then post a comment and approve on a
   PR the user picks. Replacement requirement: Manual verification step 3: Use the user-authorized test PR #244. Post a
   comment through wld review and confirm it through the GitHub API. Attempt approval, confirm GitHub rejects
   self-approval with HTTP 422 and that the page remains usable with annotations retained. Verify successful approval
   submission through the automated Forge subprocess tests; live approval success is not required for this same-account
   test PR. Reason: The user authorized testing as needed on the test PR opened with their account. GitHub forbids
   approving one's own PR. Live neutral review posting succeeded; the approval refusal and page recovery were verified.

## Future Planning Notes

Keep Forge annotation anchors tied to the reviewed head SHA and refresh before posting when that head changes. Preserve
the original approval baseline across commit-and-push retries. Remove only Review Worktrees created by RunWield that
have no uncommitted or unpushed work.
