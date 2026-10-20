---
kind: "work_record"
recordId: "fd8b0c45-5d82-43dd-9714-857a6de311b5"
status: "approved"
scope: "planned_change"
workKind: "DOCUMENTATION"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-20T03:13:31.894Z"
provenance:
    sourcePlans:
        - "2735bd6a-955b-40e1-a71a-e0f015b94488"
---

# Release-aligned documentation system

## Summary

RunWield provides an isolated Starlight manual from an explicit source allowlist, with branding, search, safe link and asset rewriting, and output-boundary checks. Release-aligned Pages automation reconciles the Stable docs branch, preserves corrections, deploys exact commits, and rejects conflicts and stale updates. Stable releases and independent documentation fixes share this publication path, and Workspace links to the manual.

## Future Planning Notes

Keep live publication evidence distinct from local build and browser evidence. Preserve the Stable docs branch through normal reconciliation and non-force pushes so release updates cannot overwrite independent corrections.
