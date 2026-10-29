---
kind: "work_record"
recordId: "30a11604-d90b-4568-be23-1ab9caf53859"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "done_enough"
createdAt: "2026-07-17T04:50:20.148Z"
provenance:
    sourcePlans:
        - "08b0feb2-348b-4a47-a754-53c9d29bace9"
---

# Session Host multi-session isolation

## Summary

The Epic was closed as done enough. RunWield uses SessionHost and HostedSession boundaries to isolate Agent runtime, TUI, routing, handoffs, workflow execution, validation, model state, and Session state while preserving existing TUI behavior.

## Out of Scope

This work does not include external clients such as Takopi, Telegram, Slack, or Discord.

## Future Planning Notes

Session adapters must preserve the HostedSession boundary and isolation between Sessions.
