---
kind: "work_record"
recordId: "09979af2-211b-4e57-8517-f81c39d18ce3"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-23T19:01:24.995Z"
provenance:
    sourcePlans:
        - "b1f73d48-320a-4451-bd59-b4f9a0b266fe"
---

# Provider-neutral Ticket References

## Summary

Plans preserve provider-neutral Ticket References through storage, Workspace display, and Work Record snapshots. Ticket URLs support search, reading, and safe navigation; Epic Work Records aggregate and deduplicate references from the Epic and its children.

## Future Planning Notes

Ticket References provide demand provenance only, without provider fetching or status synchronization. Child Plans retain direct references rather than inherited Epic references.
