---
kind: "work_record"
recordId: "ffc792b8-5c03-4c7f-80d7-4b8bc215c410"
status: "superseded"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-20T03:13:52.745Z"
provenance:
    sourcePlans:
        - "2d8c7972-ac2c-4cb6-b073-b326c9cbae7e"
supersededBy: "4539f59e-2074-4614-9e77-548b593621df"
---
# Unified ACP Slash Commands and Interactions

## Summary

Implemented shared Core command behavior across ACP, TUI, and Workspace. ACP now uses the shared Agent/model policy,
serves token-protected Workspace question controls when native forms are unavailable, routes local Plan, Code, and
Artifact reviews through the existing review bridges, and preserves the durable Session ID when execution continues in a
worktree. Updated tests retain prior coverage and verify the new same-Session and shared-model behavior. Targeted
suites, Workspace builds, runtime asset checks, and `deno task ci` passed.

## Future Planning Notes

Keep command policy in shared Core helpers and surface code limited to presentation. Execution handoffs must rebind the
existing durable Session rather than replace its identity.
