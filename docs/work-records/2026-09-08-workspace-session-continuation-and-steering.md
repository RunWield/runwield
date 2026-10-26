---
kind: "work_record"
recordId: "b9297c76-43e2-40d5-a225-d4575c787ced"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-08T05:08:00.000Z"
provenance:
    sourcePlans:
        - "8c55bf9e-f341-4156-a30b-7ad8cddbbd75"
---

# Workspace Session continuation and steering

## Summary

Workspace and TUI share one conversation through a Core-owned runtime and steering queue. Idle screens, long history, and retained workflow context do not block the next message. The browser discovers active work by Session identity and can answer a question waiting in another TUI process, steer, queue follow-ups, and stop work. A temporary private socket exposes the operation across surfaces on the same machine, while saved history and interrupted-Session recovery remain Core-owned. The phone layout keeps composer controls visible and supports following new messages or reading older history. Session creation publishes identity during the first response, and reload reconnects without duplicating messages or history.

## Out of Scope

This work does not include collaborator ownership or persistence of unfinished interaction waits.

## Future Planning Notes

Workspace and TUI operate as the same OS user on one machine or in one container. Browser disconnection leaves the Agent running; if the process stops, saved history remains available for follow-up without reconstructing unfinished waits.
