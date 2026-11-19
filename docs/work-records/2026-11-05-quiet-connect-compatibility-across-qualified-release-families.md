---
kind: "work_record"
recordId: "91a77766-abd8-4267-81e9-ef898bf565ea"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-05T16:10:48.126Z"
provenance:
    sourcePlans:
        - "5a4b2c5e-bdab-4b7c-85d2-5c34cf79618b"
---

# Quiet Connect compatibility across qualified release families

## Summary

RunWield Connect covers Claude Code 2.x and Codex 0.164.x through release-family policy rather than exact-version matching. Shared MCP responses and both plugins suppress nonblocking compatibility notices, including legacy notices, while Core retains internal assessments and historical evidence. Unqualified families and missing or malformed versions remain usable without routine announcements; unsupported hosts, incompatible adapter contracts, and minimum-version failures retain actionable errors. This keeps ordinary work quiet without weakening compatibility checks or claiming that each covered version was individually tested.

## Out of Scope

This work does not include qualification of additional release families, new live-host acceptance runs, automatic release monitoring, or a background test scheduler.

## Future Planning Notes

Qualify each new stable major and each new pre-1.0 minor before expanding coverage. Stable minor and patch releases, and pre-1.0 patch releases, share their qualified family's coverage. Prerelease and build suffixes do not change the family key or bypass minimum-version checks. Claude Code retains its 2.1.303 minimum; Codex has no minimum. Keep policy coverage separate from exact acceptance-run evidence, and do not rewrite historical results or treat missing qualification alone as a blocker.
