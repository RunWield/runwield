---
kind: "work_record"
recordId: "c88ede5b-2243-4ab7-bafd-13bb24557c0d"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-11-05T16:14:05.303Z"
provenance:
    sourcePlans:
        - "9128ddfd-8601-4602-bec2-bc59e41d1d14"
---

# Runtime-state adoption safety for 0.11

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: this was done as part of the PR for 0.11 and its now out. RunWield supports one-way adoption of inactive 0.10 project runtime state into `.wld/internal/` at the 0.11 boundary. Adoption checks primary-checkout locks even when entry starts from a linked checkout and refuses populated legacy project-local worktree roots without moving their contents. Publication accepts ordinary repository symlinks while retaining containment checks for runtime authorities and checkout roots. Project-secret adoption preserves existing collaboration capabilities, refuses conflicting stores, and reports tracked legacy or current secret paths without exposing values. These boundaries protect existing work and collaboration access during upgrades and publication retries.

## Out of Scope

This work does not include 0.9-or-earlier recovery, automatic relocation of populated legacy worktrees, secret-store merging, downgrade or mixed-version support, relocation of home-directory state or normal home-based worktrees, or a new package-distribution system.

## Future Planning Notes

Keep repository payload inspection separate from runtime-authority validation; do not special-case individual symlink filenames or follow repository symlink targets. Migration checks must prove that normal pull and push commands use the original migrated capability, not a newly created share or replacement credentials. Preserve one-way adoption through the existing layout owner and journal. Stable promotion must use the tested Candidate source, with native Windows and macOS Homebrew qualification required before publication.
