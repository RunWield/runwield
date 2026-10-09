---
planId: "f75c427a-9dd9-4a40-95ef-6bca9453194b"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/session/file-session-store-types.ts"
    - "src/shared/session/file-session-store.ts"
    - "src/shared/session/session-resume-list.ts"
    - "src/shared/session/plan-session-lookup.ts"
    - "src/acp/server.js"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/routes/owner-session-api.js"
    - "src/ui/workspace/components/SessionList.jsx"
    - "src/ui/workspace/islands/SessionSurface.jsx"
    - "src/ui/workspace/pages/projects/[projectId]/settings.astro"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/adr/015-file-authoritative-session-bundles.md"
    - "docs/domain-language.md"
    - "docs/acp-implementation-details.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
createdAt: "2026-10-02"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "f3219e8fe10a2659ee48dd162bbc0f3fb048a372"
workRecord:
    status: "generated"
    recordId: "68c201f7-83de-479c-8a2a-bc8e5f259acb"
    path: "docs/work-records/2026-10-02-reversible-session-archive-across-acp-and-workspace.md"
    lastAttemptAt: "2026-10-02T23:07:17.255Z"
archivedAt: "2026-10-08T20:38:58.525Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/archive-sessions-through-acp-and-workspace.md"
---

# Archive Sessions Through ACP and Workspace

## Context

JetBrains calls ACP `session/delete` when a user archives a chat. RunWield currently rejects that method. Workspace
lists saved Sessions but has no archive action or archived view.

The durable Session bundle is authoritative. `docs/adr/015-file-authoritative-session-bundles.md` says Workspace SQLite
is only a projection and registration store. Therefore archive state must live with the file-backed Session manifest,
not only in Workspace.

Affected PRD capabilities:

- [Core Session continuity](../prd/runwield-core-prd.md#session-continuity): add reversible archive state without
  changing Session identity, transcript, workflow, or Plan associations.
- [ACP Session access](../prd/runwield-acp-protocol-prd.md#acp-session-access) and
  [Advertised ACP conformance](../prd/runwield-acp-protocol-prd.md#advertised-acp-conformance): implement
  `session/delete` as archive and advertise the supported capability.
- [Workspace Browser Sessions](../prd/runwield-workspace-prd.md#browser-sessions): provide the Archive action.
- [Workspace Project access and navigation](../prd/runwield-workspace-prd.md#project-access-and-navigation): provide an
  Archived Sessions tab in Project settings with Unarchive. Keep archived Sessions visible under their associated Plans.

Add these as target requirements and acceptance scenarios. Do not change the PRDs to claim they already work.

## Objective

Let users hide conversations from ordinary Session lists without deleting their Session Transcript or changing whether
its associated Plan is complete. A Session has one durable archive state across ACP and Workspace. Workspace users can
find archived Sessions, open them, and restore them to ordinary lists.

If a user archives a busy Session in Workspace, show a confirmation first. On confirmation, stop the current work, wait
for it to settle, then archive. Canceling the confirmation leaves work and archive state unchanged. An explicit ACP
`session/delete` request for a busy Session is the user's confirmation to stop and archive it.

## Approach

Store archive state in the file-authoritative Session manifest. Extend the shared file-session store so ordinary Session
history and TUI resume omit archived Sessions, while Project settings can request the archived list. Plan-associated
Session listings continue to include archived Sessions and their archive status. Keep transcript files and manifest
identity in place; do not use Workspace SQLite as archive authority.

```text
Workspace Archive / Unarchive ─┐
                               ├─> shared Session archive operation ─> Session manifest
ACP session/delete ────────────┘

Normal Session lists show active Sessions
Archived view shows archived Sessions and offers Unarchive
```

Workspace must confirm before it stops a busy Session. Use its existing stop and settlement path. The ACP request itself
confirms the action for that client; do not treat ACP `session/close` as archive because close only releases live
resources.

Do not add ACP `session/list` in this change. The Project settings Archived Sessions tab is the recovery surface. Do not
hard-delete transcripts or Plans.

## Expected Change Surface

The boundaries below have direct evidence in the current code. This list is guidance, not an allowlist: verify the real
footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop
and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or
architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/file-session-store-types.ts` and `src/shared/session/file-session-store.ts` — represent archive
  state in the authoritative manifest and provide archive, unarchive, and listing behavior.
- `src/shared/session/session-resume-list.ts` — keep archived Sessions out of ordinary TUI resume results.
- `src/shared/session/plan-session-lookup.ts` and `src/ui/workspace/server/owner-plan-sessions.ts` — preserve
  Plan-linked Session discovery and expose archive status for archived entries.
- `src/acp/server.js`, `src/acp/server.test.js`, and `src/shared/session/live-session-connection.ts` — advertise and
  implement `session/delete`, resolve ACP Session IDs to durable Session identity, and stop a Session owned by this or
  another RunWield surface before archive.
- `src/ui/workspace/server/session-continuation.js` and `src/ui/workspace/routes/owner-session-api.js` — provide
  project-scoped archive/unarchive actions and active/archived listing without bypassing the shared store.
- `src/ui/workspace/components/SessionList.jsx`, `src/ui/workspace/islands/SessionSurface.jsx`, and
  `src/ui/workspace/static/workspace-styles/session-layout.css` — show the per-Session Archive action, busy
  confirmation, and clear pending/error outcomes.
- `src/ui/workspace/pages/projects/[projectId]/settings.astro`, `src/ui/workspace/owner-workspace.test.js`, and existing
  settings styles/tests — add a Project settings tab that lists archived Sessions with Unarchive. The Archived view does
  not belong on the Session history page. Match existing RunWield controls and tokens; do not add a separate design
  pattern.
- `src/shared/session/file-session-store.test.js`, `src/shared/session/session-resume-list.test.ts`,
  `src/shared/session/plan-session-lookup.test.ts`, `src/ui/workspace/session-continuation.integration.test.ts`, ACP
  server tests, and Project settings/browser tests — prove persisted state, list filtering, Plan-associated visibility,
  ACP behavior, and the actual Workspace interaction.
- `docs/prd/runwield-core-prd.md`, `docs/prd/runwield-acp-protocol-prd.md`, and `docs/prd/runwield-workspace-prd.md` —
  add target requirements and scenarios under the owning capabilities named above.
- `docs/adr/015-file-authoritative-session-bundles.md` — maintain the accepted decision so archive state remains
  file-authoritative and Workspace SQLite stays a projection.
- `docs/domain-language.md` — define the implemented term **Archived Session** and distinguish it from closing a live
  ACP Session, deleting transcript data, and completing a Plan or workflow.
- `docs/acp-implementation-details.md` — update current capability and method coverage after implementation; keep audit
  statements aligned with the implementation.

The ACP initialize response currently advertises `sessionCapabilities.close` and has no delete handler. Do not expand
this change into other optional ACP methods unless required to implement or verify archive behavior.

## Reuse Opportunities

- `FileSessionManifest` and `FileSessionStore` in `src/shared/session/` — existing file authority for stable Session
  identity and segment metadata.
- `WorkspaceSessionContinuationService.listSessions()` — current project-scoped listing and bounded transcript-name
  reads; add archive filtering without changing Plan-associated Session discovery.
- `WorkspaceSessionContinuationService.cancelOperation()` and `readLiveSessionConnection()` in
  `src/shared/session/live-session-connection.ts` — existing local and cross-surface stop paths. Reuse them, then wait
  for the authoritative Session activation to settle rather than creating a second stop mechanism.
- `closeMappedSession()` in `src/acp/server.js` — existing ACP runtime cleanup after cancellation; keep `session/close`
  distinct from durable archive state.
- Existing Session list controls, `RunWieldButton`, and the shared design system — keep controls consistent and
  accessible.

## Implementation Steps

- `FileSessionManifest` has backward-compatible archive metadata, and `FileSessionStore` owns idempotent
  archive/unarchive transitions for a stable RunWield Session ID. Each transition uses the existing Session Writer Lock,
  rereads and validates current manifest state before writing, and cannot overwrite a concurrent turn or generation
  update. It preserves every transcript segment and Plan association and exposes archive state in catalog results.
- `FileSessionStore.listProjectSessions()` returns only active Sessions by default and supports an explicit
  archived-state filter. The filter is applied before pagination and totals so page counts describe the selected view.
  `listRecentResumableSessions()` excludes archived Sessions while preserving current behavior for active and legacy
  manifests. `findPlanAssociatedSessions()` still includes archived Sessions and reports their state so Plan views
  retain their links. Focused tests prove archived Sessions are omitted from ordinary history and resume lists but
  remain discoverable through their associated Plan.
- ACP initialize advertises `sessionCapabilities.delete: {}` and the RunWield implemented-method metadata names
  `session/delete`. `session/delete` resolves both a currently mapped ACP Session and a persisted ACP Session ID to the
  same stable Session; it archives idempotently, closes any ACP-owned live Runtime session, and returns an empty ACP
  result. For a busy Session, cancel through its owning Runtime or the existing live-session connection, then wait for
  authoritative activation settlement before removing the ACP mapping or committing archive state. Unknown or previously
  archived IDs follow ACP's idempotent delete behavior. A wire test sends an unmapped persisted ACP ID derived from a Pi
  segment and proves the owning multi-segment RunWield Session—not a neighbor—is archived.
- Workspace Session APIs accept project-scoped Archive and Unarchive requests and an active/archived list selection.
  They validate Project access and Session ownership before mutation, and return a visible conflict/error without
  claiming success when stopping or persistence fails. Plan-associated Session queries include archived entries and
  their archive state.
- Workspace Session history has a per-row Archive action. Archiving an idle Session needs no confirmation. Archiving a
  busy Session requires confirmation; cancel leaves it running and active, while confirm stops and settles it before
  archiving. Failed requests retain the current view and show an actionable error. The interaction works with keyboard
  and touch input.
- Project settings has an Archived Sessions tab with paginated archived Session names and Unarchive actions. Unarchive
  restores the Session to ordinary history without changing its ID, transcript, or Plan associations. Archived Sessions
  remain listed under associated Plans with a visible archived status.
- Core, ACP, and Workspace tests prove that archive state survives a process/store reopen, updates both list views, and
  does not remove transcript history or Plan associations. ACP method schema and responses validate against the
  published ACP schema.
- The owning Core Session continuity, ACP Session access/conformance, and Workspace Browser Sessions/Project access
  capabilities and acceptance scenarios match the implemented behavior. ADR-015 explains that archive state is in the
  file-authoritative manifest. `docs/domain-language.md` defines Archived Session and its stable relationships.
  `docs/acp-implementation-details.md` reports the implemented `session/delete` capability and preserves the fact that
  `session/list` remains unsupported.

## Approval Confirmation

No Work Records are declared as superseded.

## Verification Plan

- Automated: run focused tests with
  `deno run -A scripts/run-tests.js --isolated src/shared/session/file-session-store.test.js src/shared/session/session-resume-list.test.ts src/shared/session/plan-session-lookup.test.ts src/acp/server.test.js src/ui/workspace/session-continuation.integration.test.ts src/ui/workspace/owner-workspace.test.js`.
  Do not run `deno test` directly.
- Automated: file-session-store tests prove archive state survives reopen, removes a Session from default history,
  includes it in archived results, and restores it without changing the ID, transcript segments, or Plan associations.
  Verify a transition refuses or safely waits when the Session Writer Lock is held and never overwrites a newer
  generation. A resume-list test proves archived Sessions are excluded and active Sessions remain; a Plan-session lookup
  test proves archived associations remain visible with archived status. These tests must fail if archive is only a UI
  filter or a no-op.
- Automated: real ACP wire tests prove initialize advertises delete; `session/delete` returns `{}`; the persisted
  Session is archived; a repeated delete succeeds; an unmapped ACP ID based on a persisted Pi segment archives the
  correct stable multi-segment Session; and a busy Session is stopped and settled before its archive state changes. A
  stub handler that only returns `{}` or mistakes a Pi segment ID for a stable Session ID must fail these tests.
- Automated: Workspace route and Plan-session lookup tests prove an unauthorized Project or foreign Session cannot be
  archived; active and archived filters return the correct records with correct pagination; archive and unarchive
  persist across service restart; associated Plans still show archived Sessions.
- Manual browser: run the Workspace headed-browser check with `deno task workspace:dev` at `http://127.0.0.1:5173`. Open
  `/projects/<projectId>/sessions` for a registered Project. Archive an idle Session from Session history and confirm it
  leaves active history. Open Project settings > Archived Sessions, unarchive it, and confirm it returns to active
  history and opens with the same transcript. Archive a busy Session, cancel the confirmation and verify work continues;
  repeat and confirm, then verify work settles before the Session appears in Archived. Test keyboard and phone-width
  operation, and verify errors do not remove the Session from the current view.
- Manual ACP: connect JetBrains or another ACP Client, archive an idle Session through its archive action, and confirm
  no `session/delete` error appears. For a busy Session, send `session/delete` and verify the turn settles before the
  Session is archived. Confirm this does not mark a Plan complete or delete its transcript.
- Documentation: review the updated PRDs, ADR-015, glossary, and ACP implementation audit together. They must
  distinguish archive from close, transcript deletion, and workflow completion, and must not claim ACP `session/list`
  support.

## Edge Cases & Considerations

- Risk: an ACP ID may identify a Pi transcript segment rather than the stable RunWield Session. Resolve through the
  current ACP mapping or the authoritative Session catalog; do not archive a neighboring Session or only one segment.
- Risk: the ACP or Workspace process may not own the busy Session. Use its existing live-session connection and verify
  authoritative activation settlement; do not commit archive state or report success if cancellation fails or work
  remains active.
- Compatibility: older manifests have no archive field and must remain active by default without migration or data loss.
- Compatibility: ACP `session/delete` allows soft or hard deletion and says missing/already-deleted Sessions should
  succeed silently. RunWield chooses soft archive so Workspace can restore history; transcript deletion is not part of
  this feature.
- Direct links to archived Sessions remain usable. Archive changes ordinary-list visibility, not Session identity,
  transcript access, or the rules for continuing work. Opening an archived Session from its view does not silently
  unarchive it.
- Plan-associated Session rows remain visible when archived, because Plan associations are durable context rather than
  ordinary Session-history navigation.
