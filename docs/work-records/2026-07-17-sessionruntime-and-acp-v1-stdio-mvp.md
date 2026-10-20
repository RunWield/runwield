---
kind: "work_record"
recordId: "7709289b-9d53-4ae7-9c5e-0659eed411bf"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:50:26.531Z"
provenance:
    sourcePlans:
        - "42255481-0492-4fa1-a83b-db7e419c607b"
---

# SessionRuntime and ACP v1 stdio foundation

## Summary

TUI and ACP v1 stdio share an adapter-neutral SessionRuntime. ACP supports prompt streaming, cancellation, interactions, persisted Session replay, concurrency guards, and protocol error handling.

## Future Planning Notes

Adapters consume SessionRuntime events and interactions without importing TUI internals. Runtime state remains HostedSession-scoped.
