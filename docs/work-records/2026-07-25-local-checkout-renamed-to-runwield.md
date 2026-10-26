---
kind: "work_record"
recordId: "b73d647d-0706-4054-b7a3-7f132c8c20b9"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-25T22:09:34.206Z"
provenance:
    sourcePlans:
        - "16e5c776-d721-4a70-ae0f-a940b3fb140f"
---

# Checkout path identity continuity

## Summary

The renamed local checkout retains access to existing Sessions, Mnemoteca project memory, Agent host state, shell commands, worktrees, and IDE tooling. This record documents a local identity migration rather than automatic path-migration support.

## Out of Scope

This work does not include source rebranding or GitHub repository changes.

## Future Planning Notes

Absolute project paths can be durable tool identities. Path migrations require quiescent writers, protected external stores, structural metadata changes, and resume checks before rollback state removal.
