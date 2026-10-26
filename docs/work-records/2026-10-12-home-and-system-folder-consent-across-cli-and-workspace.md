---
kind: "work_record"
recordId: "0f8a6806-e5c2-4ebf-a95c-b371a7ce5ddb"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-12T14:22:13.205Z"
provenance:
    sourcePlans:
        - "c4ba50dd-3739-4076-8547-31e3bb841304"
---

# Home and system folder consent across CLI and Workspace

## Summary

RunWield detects exact matches for home, filesystem roots, and listed system folders, including symlink aliases. CLI and direct terminal startup require early Continue/Quit consent; Project commands without interaction require --allow-system-directory. Continue suppresses automatic Init, Tutorial, and empty-folder offers while preserving explicit commands. Workspace add and relink enforce root-bound confirmation on the server through a shared accessible dialog.

## Future Planning Notes

Folder consent is not a sandbox and must not extend to ordinary descendants. Check the effective Project root before repair or runtime work, including selected Plans, resumed segments, and primary checkouts. Bind acknowledgement to the inspected root and recheck before writes; retain separate operation-specific consent.
