---
kind: "work_record"
recordId: "3b2cb09c-9dd8-4ef9-824a-2ebd2bfa22a3"
status: "pending_verification"
scope: "planned_change"
workKind: "DOCUMENTATION"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-16T17:06:23.354Z"
provenance:
    sourcePlans:
        - "06e22551-74b2-437c-a3a4-e8ec7e7ea511"
---

# Treat unknown check results as inconclusive

## Summary

Added a Core PRD requirement and two acceptance scenarios that distinguish unknown state from a definite negative answer. Updated engineering, review, working-tree safety, and test-writing guidance to require safe handling of inconclusive checks and shared identifiers for matching answers. Added a prompt-composition regression test; focused tests and a section-removal mutation check passed. This change establishes requirements and agent guidance, not runtime compliance; no runtime code changed or was audited.

## Deferred Work

A separate Plan can audit lock release, worktree registry repair, and Session writer locks against the new rule.
