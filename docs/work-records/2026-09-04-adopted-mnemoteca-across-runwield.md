---
kind: "work_record"
recordId: "d966173b-5096-4d45-8eea-767963216246"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-04T03:28:32.206Z"
provenance:
    sourcePlans:
        - "5a315cc8-5abc-4fb2-a7ad-31b32795d36a"
---

# Unified Mnemoteca integration

## Summary

RunWield uses Mnemoteca as its memory integration across installation, runtime preflight, extensions, Claude bridge, Core Memory, Sleep backup, Work Record indexing, and workflow composition. Installation and migration use the official Mnemoteca installer.

## Future Planning Notes

Delegate migration and archive integrity to the official Mnemoteca installer. Preserve isolated database configuration so tests never touch the developer’s real database.
