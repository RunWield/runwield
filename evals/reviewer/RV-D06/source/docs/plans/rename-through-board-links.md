---
planId: rename-through-board-links
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Rename boards through shared links

## Request

Board owners need maintainers to rename a shared board through the existing capability link service. Reviewer links
remain read-only. Mutation authority comes only from the verified, board-scoped capability. The role query parameter
is a caller-controlled display hint and must not grant authority. Keep it in the link format and response so the UI
can label the link. Keep signature verification and board isolation before any mutation. Signing keys come from the
trusted server configuration, never from link input. The local board store has one writer at a time.

## Approved steps

1. Add an optional title update to the shared-link service, with a forbidden result for readers.
2. Preserve read access, signed capability validation, and board scope checks.
3. Cover a maintainer rename, a reviewer refusal, and invalid or mismatched capabilities using a real local store.

## Validation

Use Bun 1.4.3. Run `bun run test` against real temporary data and local HTTP servers where needed.
