---
kind: "work_record"
recordId: "58f46331-e694-49c9-b00d-fbc19bd1d6b8"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-27T22:09:39.780Z"
provenance:
    sourcePlans:
        - "64f0a075-fa48-4ea8-a5f9-88062541a25f"
---

# Stable update discovery and installation

## Summary

RunWield checks Stable release metadata without blocking TUI startup. CLI-only `wld update`, with `wld upgrade` as an alias, installs through the tag-pinned public installer while preserving install-directory behavior.

## Future Planning Notes

Update availability is recomputed from cached release metadata and the current binary version, not stored as durable truth. Installer execution remains CLI-only.
