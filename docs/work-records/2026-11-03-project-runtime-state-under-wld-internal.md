---
kind: "work_record"
recordId: "86b2aebc-73a5-455f-8316-687bfbed497f"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "done_enough"
createdAt: "2026-11-03T00:35:05.917Z"
provenance:
    sourcePlans:
        - "ba8f9bba-8cae-4d1b-bb33-4932c42368a8"
---

# Project runtime state under `.wld/internal/`

## Summary

The Epic was closed as done enough. RunWield stores machine-owned project state under `.wld/internal/`, separate from trackable settings, Agents, Skills, and prompts. Controller records, the worktree registry, publication staging, and project secrets belong to the primary checkout; document locks and transition journals belong to the selected checkout. Shared layout paths and guarded one-way migration replace independent legacy path construction. The internal root provides a common Git protection boundary, so new runtime stores do not need separate ignore entries.

## Out of Scope

This work does not include relocation of global `~/.wld/` state, normal home-based execution worktrees, or saved publication and repair checkouts.

## Future Planning Notes

Resolve runtime paths through the shared layout module and preserve primary-checkout versus selected-checkout ownership. Do not classify all of `.wld/` as machine-owned: project settings, Agents, Skills, and prompts remain valid repository content. Keep known legacy runtime paths protected from staging and publication; ignore rules do not make tracked runtime files safe. Downgrade and concurrent use with older writers are unsupported after adoption.
