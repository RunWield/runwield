---
kind: "work_record"
recordId: "aa855a2a-40ed-46e7-ad45-2a5fc83fcd6b"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "done_enough"
createdAt: "2026-11-05T16:12:05.604Z"
provenance:
    sourcePlans:
        - "ba8f9bba-8cae-4d1b-bb33-4932c42368a8"
---

# Project runtime state under `.wld/internal/`

## Summary

The Epic was closed as done enough. RunWield stores project-local machine-owned state under `.wld/internal/` through a shared layout API. Controller records, the worktree registry, publication staging, and project secrets belong to the primary checkout; document locks and transition journals belong to the selected checkout. The generated ignore block contains only `.wld/internal/`, while project settings, Agents, Skills, and prompts remain trackable. Shared entry guards support one-way adoption of inactive legacy state and prevent normal store access when adoption is unsafe. This boundary keeps runtime state out of implementation and publication commits without excluding user-owned project content.

## Out of Scope

This work does not include relocation of global `~/.wld` state or normal home-based worktrees, automatic migration of unfinished publication or repair checkouts, or support for downgrade and mixed-version writers after adoption.

## Future Planning Notes

Route new project-runtime stores through the shared layout API and preserve primary-checkout versus selected-checkout ownership. Keep current runtime ownership separate from the bounded legacy safety catalog. Adoption must preserve recoverable bytes and refuse conflicting authorities, live legacy writers, tracked runtime state, unsafe symlinks, and unfinished publication recovery rather than merge or translate them. Do not ignore or remove `.wld/` as a whole. Help, version, and an empty TUI before its first submitted message must not trigger runtime migration.
