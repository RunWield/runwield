---
status: accepted
---

# Plan archival and retrieval

## Context

Completed, closed, abandoned, or stale Plan files should stop crowding active
Plan workflows while remaining available as project history. RunWield already
treats top-level `docs/plans/archived/` as hidden from normal `wld plans`
listing while still allowing explicit file access.

Archival is a storage concern, not a lifecycle state. The durable Plan status
(`verified`, `closed_without_verification`, `implemented`, `on_hold`, etc.)
remains meaningful after the file moves.

## Decision

RunWield archives Plans by physically moving markdown files from `docs/plans/`
to `docs/plans/archived/`, preserving nested relative paths. For example,
`docs/plans/my-epic/01-child.md` archives to
`docs/plans/archived/my-epic/01-child.md`.

The first command surface is explicit and reversible:

- `wld plans archive` lists archived Plans.
- `wld plans archive <plan-name-or-id> [--reason <text>] [--force]` archives one
  active Plan.
- `wld plans archive restore <archived-plan-name-or-id> [--to <plan-name>]`
  restores one archived Plan to active `docs/plans/`.
- `wld plans read <plan-name-or-id>` inspects active or archived Plans.

A later follow-up adds exact-status bulk archival:

- `wld plans archive --all --status <status> [--reason <text>] [--force]`
  archives active Plans whose lifecycle status exactly matches `<status>`.

Archive and restore metadata is recorded in front matter (`archivedAt`,
`archiveReason`, `archivedFromStatus`, `archivedFromPath`, `restoredAt`,
`restoredFromPath`) without adding an `archived` status.

`verified` and `closed_without_verification` Plans can be archived without
`--force`. Other statuses require `--force`. Plans with recoverable worktree
states (`active`, `execution_failed`, `validation_failed`, or `merge_conflict`)
are blocked until a separate abandon/cleanup flow handles that recovery state.

Bulk archival is best effort. Each exact-status match is attempted
independently; safe Plans move even when another match is blocked. If any match
fails, the CLI prints both successes and failures, then exits non-zero after the
summary.

## Non-decisions

- No automatic boot sweep moves Plans by age. Automatic movement is risky around
  worktree recovery, Epic/child relationships, `on_hold`, and manual closure
  semantics.
- No CLI archive search is added in this slice. Discovery starts with a plain
  archive list; richer search belongs in a unified UI/search surface later.
- No one-off LanceDB or full-text archive index is added. Archived markdown
  remains plain text and can be indexed later by a broader search system.
- No cascading Epic/child archival is added. Archiving an Epic does not
  automatically archive child FEATURE Plans, and archiving a child does not
  modify its Epic. Bulk status archival still evaluates each matching Plan
  independently.

## Consequences

Normal active workflows stay focused because `wld plans` and active Plan
resource APIs hide `docs/plans/archived/`. Historical context remains available
in plaintext and can be listed, read, restored, or targeted by explicit paths.
Future Plan UI controls should call the centralized `src/plan-store.js` archive
helpers instead of moving files directly.
