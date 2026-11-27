---
kind: "work_record"
recordId: "8106889d-c62b-4b01-b6ce-39a7c373bb98"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-31T15:05:17.982Z"
tickets:
    - url: "https://app.todoist.com/app/task/make-terminal-workflow-tools-authoritative-in-every-path-6hFm55r9wQpjmFCC"
provenance:
    sourcePlans:
        - "c4f4bd36-cb3c-4972-a9b7-dbc6b5b84bab"
---

# Authoritative Workflow Tool Events

## Summary

RunWield moved root workflow handoffs to accepted Workflow Tool Events. Typed events support one-time consumption, recovery from a durable outbox, and scoping by owner and attempt. At delivery, isolated repair still used transcript evidence as a fallback for completion, and Claude review still used transcript evidence to decide whether a separate diff read was required.

## Future Planning Notes

For future workflow-tool changes, publish only after semantic acceptance and prerequisite writes succeed, then consume events through scoped owners. Check each completion and review path for transcript-based decisions before treating events as its sole authority.
