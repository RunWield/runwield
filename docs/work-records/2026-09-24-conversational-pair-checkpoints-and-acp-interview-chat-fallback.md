---
kind: "work_record"
recordId: "d140df78-c3cc-43d8-a0c8-8f588a67a5e7"
status: "superseded"
scope: "epic"
origin: "internal"
completionMode: "done_enough"
createdAt: "2026-09-24T17:55:02.869Z"
tickets:
    - url: "https://github.com/openabdev/openab/pull/1533"
provenance:
    sourcePlans:
        - "0793ef3b-1dfa-465e-8873-2035c55d4f8b"
supersededBy: "4539f59e-2074-4614-9e77-548b593621df"
---

# Conversational Pair checkpoints and ACP interview chat fallback

## Summary

Completed this Epic as done enough after both child Plans were validated. Pair checkpoints, including final assent, now
continue through ordinary conversation in TUI, Workspace, and ACP; typed completion still gates validation. ACP
interviews keep native forms where supported and use chat otherwise, so no local question page or OpenAB patch is needed
for that path.

## Future Planning Notes

ACP interview waits remain process-local and require retry after process loss. The chat fallback applies only to
interviews; command menus and browser reviews retain their existing behavior.
