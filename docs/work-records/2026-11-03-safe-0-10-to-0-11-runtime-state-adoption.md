---
kind: "work_record"
recordId: "96beb706-3f89-4c45-a6a6-f8cc3b88e3f2"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-11-03T00:36:27.925Z"
provenance:
    sourcePlans:
        - "9128ddfd-8601-4602-bec2-bc59e41d1d14"
---

# Safe 0.10-to-0.11 runtime-state adoption

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: this was done as part of the PR for 0.11 and its now out. RunWield 0.11 provides one-way adoption of eligible 0.10 project runtime state into `.wld/internal/` while preserving project configuration and existing work. Publication accepts ordinary repository symlinks while runtime inspection rejects symlinked authorities and paths outside the owning checkout. Migration checks primary-checkout locks even when entry starts in a linked checkout and preserves existing collaboration capabilities when adopting a single legacy secret store. Conflicting secret stores and populated legacy project-local worktree roots stop adoption without moving or deleting their contents. Entry and Doctor identify tracked legacy and current secret paths and provide history-removal and capability-rotation guidance without exposing secret values.

## Out of Scope

This work does not include recovery for version 0.9 or earlier, relocation of populated legacy fallback worktrees, changes to normal home-based worktree locations, or a new package-distribution system.

## Future Planning Notes

Keep repository payload symlinks separate from runtime-authority safety checks; do not special-case individual filenames or traverse payload symlink targets. Preserve source identity and safe-refusal checks during migration-journal restart. Adoption does not support downgrade or concurrent older writers. Stable promotion must use the tested Candidate source, and release publication must retain native Windows and macOS Homebrew qualification gates.
