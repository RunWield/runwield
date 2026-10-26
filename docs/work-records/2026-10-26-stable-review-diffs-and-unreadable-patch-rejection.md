---
kind: "work_record"
recordId: "8ba6e378-6e59-41f9-a43f-e245b5450e8b"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-26T03:41:11.572Z"
provenance:
    sourcePlans:
        - "e3db158c-4efc-4368-9545-3b3409ef367e"
---
# Stable review diffs and unreadable-patch rejection

## Summary

RunWield Core review diffs use fixed a/ and b/ prefixes and repository-root paths, without color codes or external diff output, regardless of user Git settings. Review, repair, Workspace Code Review, Epic integration, and worktree fallback paths share this format. Core semantic review rejects a non-empty required patch with no readable file headers instead of treating it as an empty change that can receive approval. This keeps Git display settings from bypassing the requirement to read changed files.

## Out of Scope

This work does not include forge-supplied standalone review patches or Connect-specific host-resume review gates. Epic integration receives the fixed diff format, not the strict unreadable-patch gate.

## Future Planning Notes

Local review-diff producers must reuse REVIEW_DIFF_FORMAT_ARGS. Approval gates use requiredReviewDiffFiles for the required full or repair patch; display consumers retain the non-throwing parseDiffFiles parser. Empty or whitespace-only patches remain valid empty inputs.
