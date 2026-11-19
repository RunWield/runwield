---
kind: "work_record"
recordId: "156333db-fe39-4b42-b2d4-57d2b1aa4dc5"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-03T02:04:05.982Z"
provenance:
    sourcePlans:
        - "9b9e2418-db1f-4a72-a942-9ae921ea6e59"
---

# Epic send-back to Architect for re-review

## Summary

Non-Sequence Epics in `ready_for_decomposition` or `ready_for_work` offer **Send back to Architect for re-review**. The action returns the parent to draft and starts Architect directly, without first opening browser review, starting Slicer, or executing work. Existing child contents, states, relationships, worktree records, and branch history remain intact. Approval for later returns the parent to `ready_for_decomposition`, even when children exist; approval to slice starts Slicer.

## Out of Scope

This work does not include Architect send-back actions for Sequences, Workspace menus, or the Connect protocol.

## Future Planning Notes

Ordinary review opening preserves approval; explicit send-back requires new approval. An interrupted or failed Architect turn after send-back leaves a resumable draft and must not restore the prior approval.
