---
kind: "work_record"
recordId: "7045085b-cab7-4986-b3e1-53cbee2d839c"
status: "pending_verification"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-20T19:32:48.990Z"
provenance:
    sourcePlans:
        - "7c9a59b8-8747-454e-9d4d-cef8874374bb"
---

# Conservative Snip shell-command wrapping

## Summary

RunWield’s Snip integration wraps only recognized leading simple commands and preserves the remaining shell text unchanged. Unsupported leading constructs, substitutions, comments, continuations, and stderr redirections bypass Snip without changing the command. Supported wrapping preserves quoting, command chaining, output destinations, and exactly-once execution. Deno command wrapping respects user stdout redirections while retaining failure-log reporting.

## Future Planning Notes

Treat Snip as an optional optimization: uncertain shell syntax must pass through unchanged rather than risk altered behavior. Commands that redirect stderr bypass wrapping because Snip’s no-filter notice can contaminate user-controlled output streams.
