---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/root-session.js"
    - "src/shared/session/session-runtime.js"
    - "src/shared/session/session.js"
    - "src/shared/session/file-session-storage.ts"
    - "src/shared/session/file-session-store.ts"
    - "src/shared/session/session-resume-list.ts"
    - "src/shared/session/image-attachments.ts"
    - "src/shared/session/segment-rollover.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T02:05:49.975Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 4
dependencies:
    - "02-bridge-local-models-and-personal-resources"
    - "03-guard-remote-session-writer-access"
targetBranch: "epic/remote-ssh-development"
planId: "ec285d14-a71f-464c-a934-47c209958966"
---

# Run and Resume Remote Sessions with Local History

## Context

The connection, local model bridge, and guarded writer are useful foundations, but the first complete product slice is a
normal remote TUI turn whose project work happens remotely and whose only authoritative conversation history is on the
laptop. Current Session construction assumes one local cwd for project identity, resources, tools, and persistence, and
Pi transcript writes bypass parts of the file Session store. Child 02 mounts the laptop's full `~/.wld` for direct
personal file access, but that connection-wide mount cannot authorize Session writes.

This slice completes the Remote SSH PRD's core **Local memories and saved Sessions** journey and the Core PRD's Session
continuity and project-context outcomes. It must keep empty starts dormant, preserve local offline history, and
reconnect from committed evidence rather than a frozen runtime stack.

## Objective

Let a user connect to a remote-only project, submit normal Pi-backed TUI turns, save and inspect the Session locally,
disconnect, reconnect, and continue. Keep project identity, execution cwd, temporary mount paths, and personal storage
identity separate.

## Approach

Create a location-aware Session context once at Session creation, then pass it through existing runtime and store
owners. Pi keeps synchronous mounted transcript access during a managed operation; laptop Core keeps stable identity,
manifests, generations, catalog coordination, recovery, and attachments. Resume hydrates from committed local evidence
and validates the remote locator before allowing continuation.

```text
remote user turn
  local lock and fresh mount
  remote Pi and project tools
  remote writer detach
  local generation commit
  dormant local-readable Session
```

Do not create a second remote transcript or synchronize history at exit; either would create competing authority and
lose save-time truth.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/root-session.js`, `session.js`, and `session-runtime.js` — construct and carry location-aware
  Session, project, model, resource, and persistence context.
- `src/shared/session/file-session-storage.ts` and `file-session-store.ts` — store explicit remote locators without
  running laptop path operations against them.
- `src/shared/session/session-resume-list.ts` — list and inspect laptop history offline while requiring a validated
  connection for continuation.
- `src/shared/session/image-attachments.ts` and rollover modules — transfer attachments explicitly and keep stable
  references independent of temporary mounts.
- The owning Core and Remote SSH PRD sections — mark the remote conversation and continuation scenarios delivered while
  workflows and review remain target behavior.

## Reuse Opportunities

- `SessionRuntime.#runManagedOperation` — retain its acquire, hydrate, run, checkpoint, and release ownership while
  adapting the location boundary.
- `installDenoSessionPersistence` and Pi SessionManager behavior — preserve synchronous Pi transcript writes through
  guarded mounted access.
- Existing file manifests, generations, recovery descriptors, resume projections, and segment lineage — preserve formats
  and evidence rules.
- Existing image attachment storage — retain Session-owned local storage and add explicit transfer across the
  connection.

## Implementation Steps

- Session context represents durable remote host identity and canonical project path separately from current execution
  cwd/worktree and temporary storage mountpoints; laptop path APIs never resolve or create the remote locator.
- A new empty remote TUI remains an in-memory shell with no bundle, catalog record, transcript, guarded Session writer
  mount, or lock until the first user message. The separate connection-wide personal mount may already exist.
- The first user message acquires local ownership, creates the local bundle and planning segment, mounts fresh guarded
  access, persists the visible message, and only then allows the remote Pi turn and project tools to continue.
- Pi transcript writes, compaction, metadata, image references, and segment rollover use guarded mounted operation
  access, never the broad personal mount, while local Core commits manifests, generations, recovery descriptors, and
  catalog evidence from laptop bytes.
- Attachments selected locally or produced remotely transfer into local Session-owned storage; durable transcript
  references contain no connection-specific mount path.
- Completed local history can be listed, projected, exported, and inspected while disconnected. Continuing it requires
  validation of its stored remote target and creates fresh channels rather than restoring a frozen stack.
- A lost connection or storage error stops dependent work and records proven or uncertain evidence without replaying
  model requests, tool calls, or external effects on reconnect.
- Local Session IDs, directories, collection names, TUI, ACP, and Workspace behavior remain unchanged; missing remote
  metadata continues to mean a local Session.
- The owning PRD requirements and acceptance scenarios describe delivered save, offline-read, reconnect, attachment, and
  no-remote-transcript behavior without claiming workflow or browser review completion.

## Verification Plan

- Automated: add integration tests for empty start, first-message persistence, remote locator handling, mounted Pi
  append, checkpoint, compaction, attachment transfer, rollover, disconnected projection, resume validation, and
  uncertain interruption. Use real Plan project and Git fixtures rather than storage seams.
- Automated: verify no remote temporary path enters manifests, transcript references, resume records, or project
  identity. Verify local Session formats and local surface tests remain unchanged.
- Automated: run focused tests through `deno run -A scripts/run-tests.js <test paths>`, then `deno task seams:check` and
  `deno task ci`.
- Paired live flow: connect to a synthetic remote-only Git project with a same-named but different laptop sentinel tree;
  submit a prompt that reads a remote sentinel, uses it in a second local model request, and writes a remote project
  file.
- Paired live flow: disconnect after a committed turn, inspect history locally with the host unavailable, reconnect,
  continue the same Session, transfer an image in each direction, and trigger a segment rollover.
- Failure checks: cut transport during append, sync, rollover, and generation publication. Confirm saved entries survive
  where proven, dependent work stops, and no remote personal transcript remains.

## Edge Cases

- A known SSH alias change can retain host identity; ambiguous equivalence requires confirmation instead of history
  merging.
- A remote worktree shares parent project identity but has a distinct execution cwd. Keep both facts explicit.
- An edit can finish remotely before its result or Session commit reaches the laptop. Report uncertainty; do not invent
  rollback or automatic replay.
- Local history remains readable without SSH, but remote continuation cannot proceed against an unvalidated replacement
  host or path.
