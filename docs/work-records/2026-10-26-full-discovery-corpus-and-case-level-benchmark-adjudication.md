---
kind: "work_record"
recordId: "645f73cc-7766-434f-9efc-86c4622d3fbe"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "done_enough"
createdAt: "2026-10-26T02:46:09.027Z"
provenance:
    sourcePlans:
        - "21e30b85-ac1f-4afa-a201-fa23273a7bc7"
---
# Full discovery corpus and case-level benchmark adjudication

## Summary

The Epic was closed as done enough. The Reviewer benchmark covers 33 cases across 16 defective-and-clean discovery pairs and one multi-defect case, without changing production Semantic Review. Corpus selection discovers fixture packages from their manifests, while smoke selection preserves the original nine cases. Owner oracle verdicts and finding labels exclude cases with faulty fixtures or valid unlisted defects from every score without blocking scores for other cases. The discovery report presents each case’s planted defects, proofs, and Reviewer findings together, providing a broader basis for evaluating review quality.

## Out of Scope

This work does not include additional multi-defect scenarios, repair-state execution, repeated trials, candidate prompt changes, or configuration comparisons.

## Future Planning Notes

Keep hidden oracles and proofs outside Reviewer projects and their Git history. Exclude an entire case from all measures when its verdict is `fixture_needs_repair` or any finding is `novel_valid`; retain failed, timed-out, and missing cases in denominators unless excluded. Semantic scores require oracle verdicts and finding labels for all counted cases; path matches earn no semantic credit. Fixture corrections require revised fixtures and new observations, not relabeling old output as evidence against revised truth. Preserve historical reports, reject resume when fixtures or selection change, and do not infer stability or improvement from one trial or comparisons across different fixture revisions.
