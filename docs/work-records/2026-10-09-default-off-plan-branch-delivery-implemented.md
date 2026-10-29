---
kind: "work_record"
recordId: "335cc883-ce2f-4fec-9bf9-ca9fc792868a"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-09T17:17:12.873Z"
provenance:
    sourcePlans:
        - "e1c5b772-69c8-472d-b739-9f110cd81fcd"
---

# Default-off Plan Branch delivery

## Summary

RunWield delivers standalone Plans to a Plan Branch by default, tracking the intended target separately from the actual landing branch. Untargeted Plans resolve the repository default branch rather than the current checkout. Publication to an unchecked-out branch preserves primary-checkout files, and archive, lifecycle reload, and recovery retain landing-branch identity. Completion cards name the landing branch and state “Ready for your merge/PR”.

## Out of Scope

This work does not expand Forge Epic scope.

## Future Planning Notes

Keep intended-target and actual landing-branch data distinct across publication, evidence, recovery, and cleanup. Resumed attempts must retain their recorded landing branch. Unchecked-out branch publication must leave primary-checkout files unchanged.
