---
kind: "work_record"
recordId: "bf95aaac-2076-40f5-9d08-d74b018d380c"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-02T22:05:05.789Z"
provenance:
    sourcePlans:
        - "4977717f-6eee-4732-ac1b-c44bef919fa8"
---

# ACP Terminal Auth

## Summary

RunWield advertises ACP Terminal Auth when the client supports it and blocks new Sessions until login and a usable default model are ready. Both CLI login entry points support setup-only flows without creating a Session.

## Out of Scope

This work does not include Agent Auth, ACP logout, authenticate, or active-Session token refresh.

## Future Planning Notes

Treat ACP readiness as credentials or an authenticated backend plus a usable default model, not credential storage alone. Keep Terminal Auth routed through the existing login and model-selection owners.
