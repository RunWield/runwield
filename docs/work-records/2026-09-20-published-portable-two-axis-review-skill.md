---
kind: "work_record"
recordId: "c11cd225-63ac-4096-98b7-3fcec83b2b1b"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-20T03:14:24.879Z"
provenance:
    sourcePlans:
        - "f62d88b6-b3b3-4c05-a169-8b0d2058f58a"
---

# Portable Standards and Spec review skill

## Summary

The standalone review Skill covers Standards and Spec review of pull requests, fixed points, and working trees, with GitHub and GitLab comment guidance. Publishing checks support source-less Skills and recursively check every Markdown support file for content drift and leaks. GitLab draft-note bulk publication uses an API call where the CLI has no publish command.

## Future Planning Notes

Keep published-Skill discovery recursive and disk-led so unregistered support files cannot bypass drift or wording checks. Preserve batched GitLab comment publication to avoid unbatched notifications.
