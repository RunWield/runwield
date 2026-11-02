---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/ui/workspace/"
    - "src/ui/review/"
    - "src/shared/attached/"
    - "src/acp/"
    - "src/shared/collaboration/"
    - "docs/design-system.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev"
devServerHmr: true
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 9
dependencies:
    - "external-plan-store/run-lifecycle-from-canonical-plans"
    - "external-plan-store/move-work-records-with-delivery-copies"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "9a914c1e-a72e-4811-be36-c90c1502f7c6"
---

# Expose Home Plans across User Surfaces

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The browser and external hosts currently consume file/path assumptions from repository Plans. Surface parity is required so a store migration does not leave a working CLI with inaccessible review or stale search.

Owning requirements: [Plan access](../../prd/plan-store-prd.md#plan-store); [Workspace Plans](../../prd/runwield-workspace-prd.md#local-plan-management); [Shared collaboration](../../prd/runwield-workspace-prd.md#shared-plan-collaboration); [Connect outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes); [ACP workflow](../../prd/runwield-acp-protocol-prd.md#chat-workflow-access). These are target changes; preserve the existing behavior named below.

## Objective

The admitted-package path can browse, edit, review and continue the same home Plan through supported surfaces with current revisions. This preparatory adaptation includes the browser review used by ordinary CLI workflows; public home-store admission remains with the following activation child. Strict host permissions and remote-canonical Shared Plan rules remain intact.

## Approach

Adapt surfaces to Core resource IDs and document operations; preserve current RunWield design-system patterns and
semantics. UI routes/search remain projections. For restricted external hosts, use an already supported root grant or
authorized Core document tools instead of a repository symlink/copy. Share/pull/push transport adapts at its existing
boundary and must not turn remote-canonical shared content into locally writable authority.

Package fixtures and explicit internal format admission exercise these adapters before public default cutover. Existing admitted legacy Projects remain functional until the activation child switches the complete workflow. No desktop-shell or unrelated Workspace redesign is part of this child.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/` — Plan Board/detail/editor/search and import empty states
- `src/ui/review/` — package documents and revision-bound review
- `src/shared/attached/` — Connect paths, resource reads and continuation
- `src/acp/` — shared Plan access through supported client contracts
- `src/shared/collaboration/` — preserve shared Plan authority while adapting transport
- `docs/design-system.md` — reuse existing patterns; document any necessary shared addition
- `docs/domain-language.md` — Plan Board, Plan Editor and reader definitions
- `docs/prd/runwield-workspace-prd.md` — local management, search and shared review
- `docs/prd/runwield-connect-prd.md` — host authorization and shared outcomes
- `docs/prd/runwield-acp-protocol-prd.md` — client workflow access

## Reuse Opportunities

- Reuse shared design-system tokens/primitives, theme bridge and existing Plan review surfaces.
- Reuse canonical Core resource/revision APIs and existing collaboration capabilities; do not make caches authoritative.

## Implementation Steps

1. Workspace lists, search, document reading and editing resolve canonical Project/Plan IDs; a branch change or stale repository copy cannot change displayed truth.
2. Review actions bind to current package revisions and invalidate stale content consistently with CLI/Core; separate documents remain readable through the normal review flow.
3. Empty unimported Project views explain explicit import without starting migration, creating links or mutating runtime during passive reads.
4. Connect and ACP access the live Plan through authorized paths or document tools; restricted host permissions are honored without another live copy.
5. Existing sharing transport preserves remote-canonical locking, encryption/secrets ownership and read-only restrictions while local package metadata remains protected.
6. Core-backed surface tests and headed browser evidence demonstrate the same Plan revision across TUI, Workspace, Connect and ACP.
7. Workspace/Connect/ACP capability references describe the tested package path and shared Core ownership, with public activation still target. Proposed Plan Board/Editor/reader wording is prepared without claiming that the default backend has switched; the activation child publishes those definitions with actual public behavior.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/ui/workspace/workspace-board.test.ts src/ui/workspace/workspace-plan-review.integration.test.ts src/shared/attached/plan-written.test.ts src/acp/managed-session.integration.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Open the same package through two surfaces, edit from one, then reject a stale action from the other while both converge to current content.
- Index/search and passive board/detail reads make no Project or Git changes; a malformed package does not hide healthy resources.
- A restricted host exercises its supported access route and cannot bypass denied roots; shared remote-canonical Plans remain non-writable locally.
- Manual: Run `bun run workspace:dev` at `http://127.0.0.1:5173/dev` for headed fixture checks, including `/dev/plan-review`; discover the normal live Workspace server command/route for a real registered Project and prove board -> Plan detail -> document edit -> review -> continuation, plus empty import guidance.
- Preserve: Current visual system, revision-safe review, private search boundaries, host permission enforcement and Shared Plan authority.
- Retire: UI assumptions that live Plan bodies or Work Records must be repository files and path-based authority reconstructed by adapters.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Development fixture routes alone do not prove real registered-Project navigation; include a live composed browser journey.
