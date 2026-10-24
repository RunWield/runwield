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

RunWield advances workflow state from accepted Workflow Tool Events instead of Agent transcript inspection. Typed consume-once events support outbox recovery, owner and attempt scoping, and event-first routing across planning, execution, repair, review, and validation. Transcripts serve display and audit needs, not workflow authority.

## Future Planning Notes

For future workflow-tool changes, publish only after semantic acceptance and prerequisite writes succeed, then consume events through scoped owners. Keep transcript readers limited to compatibility, display, audit, or non-authoritative handoff text.
