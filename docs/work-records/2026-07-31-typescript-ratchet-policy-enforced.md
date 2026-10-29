---
kind: "work_record"
recordId: "ad7a0b9b-b855-499c-87d9-d373ee31c00b"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-31T04:10:08.017Z"
provenance:
    sourcePlans:
        - "6aa3e38e-de12-47d4-a584-926d24061f79"
---

# TypeScript source ratchet

## Summary

The mixed-source policy requires new production source to use TypeScript while allowing existing JavaScript and JSX. CI rejects new production JavaScript and stale baseline entries, and checks non-Workspace TypeScript directly.

## Future Planning Notes

Migrations reduce the legacy-source baseline and retain real source extensions in imports. Low-risk language conversions must not expand into high-authority lifecycle, Session, validation, or worktree changes without explicit scope.
