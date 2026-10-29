---
kind: "work_record"
recordId: "79c918ba-6012-4c58-a0ba-a1c568279c53"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-29T03:38:32.549Z"
provenance:
    sourcePlans:
        - "54c6f794-252f-4210-be53-ca5bf50c5ff1"
---

# Configurable bash allowlists for Guide and delegates

## Summary

Agent and subagent definitions support configurable bash command allowlists with inherited parent limits and inspection defaults for Guide and read delegates. Checks run before Pi bash and RunWield background shell execution. Root Session rebuilds refresh the policy, and restricted Pi Sessions skip Snip.

## Future Planning Notes

The command filter is best-effort, not a sandbox. It does not govern native external-host shells.
