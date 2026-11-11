---
planId: "9a914c1e-a72e-4811-be36-c90c1502f7c6"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/shared/workflow/package-workflow.ts"
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
userVerifiedAt: null
status: "reviewed"
---

# Expose Home Plans across User Surfaces

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The browser and external hosts currently consume file/path assumptions from repository Plans. Surface parity is required so a store migration does not leave a working CLI with inaccessible review or stale search.

Owning requirements: [Plan access](../../prd/plan-store-prd.md#plan-store); [Workspace Plans](../../prd/runwield-workspace-prd.md#local-plan-management); [Shared collaboration](../../prd/runwield-workspace-prd.md#shared-plan-collaboration); [Connect outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes); [ACP workflow](../../prd/runwield-acp-protocol-prd.md#chat-workflow-access). These are target changes; preserve the existing behavior named below.

### Prepared-branch findings

- `src/shared/plan-package-store.ts` already owns package documents, numeric revisions, catalog diagnostics and guarded writes. `src/shared/workflow/package-workflow.ts` admits a `PackageWorkflowSelection` through `withPackageWorkflow`; it explicitly refuses to infer selection from a name, path or package existence.
- `src/ui/workspace/server/plan-adapter.js` already delegates catalog, body and lifecycle operations to Core. Extend that route instead of adding a second browser store. `server/project-artifacts.ts` still authorizes repository or registered-worktree Markdown; home resources need equally bounded authorization by Project, Plan and resource identity.
- `src/ui/review/plan-review.ts` prepares a path-backed review payload. `PlanReviewSurface.tsx` and the owner Plan route must carry the admitted resource and revision through reads, saves and decisions, including the review opened by ordinary Core workflows.
- Astro `server/astro-canonical-data.js` keeps development data in memory. `/dev` is a Surface Lab, not evidence of real persistence. `workspace-plan-review.integration.test.ts` currently checks source text; retain useful regressions but add behavioral coverage through the real server.
- Child 8's canonical Work Records must remain readable/searchable through `server/project-artifacts.ts` and `server/workspace-search.ts`; repository delivery copies are never the personal authority.

No sibling scope moves are proposed. Public activation, default import and removal of legacy admission stay with child 10.

## Objective

The admitted-package path can browse, edit, review and continue the same home Plan through supported surfaces with current revisions. This preparatory adaptation includes the browser review used by ordinary CLI workflows; public home-store admission remains with the following activation child. Strict host permissions and remote-canonical Shared Plan rules remain intact.

## Approach

Adapt surfaces to Core resource IDs and document operations; preserve current RunWield design-system patterns and
semantics. UI routes/search remain projections. For restricted external hosts, use an already supported root grant or
authorized Core document tools instead of a repository symlink/copy. Share/pull/push transport adapts at its existing
boundary and must not turn remote-canonical shared content into locally writable authority.

Resolve the registered Project and its existing internal admission on each server/host operation. Carry the resource identity and expected revision through asynchronous request boundaries; a request must not depend on another request's `AsyncLocalStorage` scope. Do not introduce a public switch, browser-supplied filesystem root or global package selector.

```text
registered Project + authorized Plan/resource identity
  -> existing internal package admission
  -> Core package document / workflow operation
  -> current content + revision + permitted actions
  -> Workspace reader, review, Connect or ACP projection
```

Keep the Plan home's shared reader and Workflow sidebar, Plan Board and body editor. Reuse `docs/design-system.md`, the `--rw-*` theme tokens and existing controls. Add document selection and empty/stale/denied states within those patterns; preserve keyboard focus, unsaved input and small-screen action access. A repository mirror would simplify old path consumers but create a competing writer, so adapt resource access instead.

Package fixtures and explicit internal format admission exercise these adapters before public default cutover. Existing admitted legacy Projects remain functional until the activation child switches the complete workflow. No desktop-shell or unrelated Workspace redesign is part of this child.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store.js`, `src/shared/plan-package-store.ts`, `src/shared/workflow/package-workflow.ts` — reuse and minimally extend resource/revision operations at their authoritative owner
- `src/ui/workspace/server/plan-adapter.js`, `server/project-artifacts.ts`, `server/workspace-search.ts`, owner routes and `server.js` — resolve authorized admitted resources, including canonical Work Records, across real HTTP requests
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

1. Workspace catalog, search, owner Plan routes and document operations resolve canonical Project/Plan/resource IDs under explicit internal admission. Changing branches or a stale repository delivery copy cannot change displayed truth. Healthy Plans remain visible beside malformed-package diagnostics. Work Record browsing/search reads the canonical record even when delivery copies are disabled or stale.
2. Review payloads, document saves and review decisions use Core revisions and preserve protected metadata. Context, validation and available manual-QA/integration-report documents are readable through the normal review surface; writable resources use their existing Core policy. A concurrent relevant edit rejects stale save/approval/continuation without overwriting newer content or advancing workflow. Refresh exposes the current revision while preserving a rejected local draft. Nested Plan/document links use the authoritative document context and keep repository-link containment.
3. Empty unimported Project views explain explicit import without starting migration, creating links or mutating runtime during passive reads.
4. Connect instructions/action context and ACP's supported client/resource access reach the same admitted Plan and revision after continuation/restart. Reuse an existing authorized root grant or Core document operation where available. If a restricted host has no supported authorized route, return an actionable permission requirement and stop that action; do not claim access, silently grant roots, create a symlink/copy, or weaken host enforcement. Keep ACP capability negotiation and host-owned reasoning unchanged.
5. Existing share/pull/push adapters translate package documents at the existing collaboration boundary, preserving remote revisions, locks, encryption/secrets ownership and read-only restrictions. A Shared Plan remains remote-canonical; local display/package state cannot authorize a write or overwrite local controller metadata. The separate remote Workspace server remains a remote Shared Space service.
6. Core-backed surface tests and headed browser evidence demonstrate the same Plan revision across TUI, Workspace, Connect and ACP.
7. Workspace/Connect/ACP capability references describe the tested package path and shared Core ownership, with public activation still target. Proposed Plan Board/Editor/reader wording is prepared without claiming that the default backend has switched; the activation child publishes those definitions with actual public behavior.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. This prepared branch contains `scripts/run-tests.js`, not the user's newly named `scripts/run-tests.ts`; `package.json` still delegates `test:suite` to the JavaScript runner. Use the user-authorized `bun run test` entrypoint, which ends in `bun run test:suite` and forwards the paths below. Do not invoke `bun test`, invent a missing TypeScript runner, or migrate the runner in this child.

Extend these existing files with the behavior assigned below, then run:

```sh
bun run test src/ui/workspace/workspace-board.test.ts src/ui/workspace/workspace-plan-review.integration.test.ts src/ui/workspace/plan-review-cross-surface.integration.test.ts src/ui/workspace/server/workspace-search.test.ts src/shared/attached/plan-written.test.ts src/acp/managed-session.integration.test.ts src/cmd/plans/collaboration-commands.integration.test.ts
```

These are planned test additions, not claims that the current suite proves package support. Use real package stores, registered Projects, Git repositories and disposable homes via existing package/Git/validation fixtures. Use `getHomeDir()`/`getCwd()` and `withProcessGlobalTestLock` around HOME/cwd mutation. Do not inject or re-baseline seams for owned persistence, lifecycle, registry or locks; keep `seams:check` intact.

- **Board/search:** extend `workspace-board.test.ts` and `server/workspace-search.test.ts` with an admitted home Plan and canonical Work Record, stale repository copies, a sibling checkout and a malformed package. Assert canonical results, private-project isolation and no passive filesystem/Git/runtime-admission changes, including an unimported Project. This fails if the adapter falls back to repository Markdown or writes during reads.
- **Real requests and revision races:** extend `workspace-plan-review.integration.test.ts` and `plan-review-cross-surface.integration.test.ts` using real owner/review handlers, an owner-coordination store and registered disposable Project. Read a Plan and separate documents, save from a second request/surface, reject the first revision's save and review decision, then reload and continue using the new revision. Assert body, metadata and workflow state; source-text assertions and mocked adapters cannot satisfy this outcome. Include nested document links and denied traversal/unrelated-home-resource reads.
- **External hosts:** extend `attached/plan-written.test.ts` and `acp/managed-session.integration.test.ts` through their real service/protocol entry points. An authorized route reads/edits the admitted Plan and resumes the same identity; denied home access with no authorized alternative stays denied and changes no bytes/state. Prove the Core/TUI-facing workflow reader, Workspace, Connect and ACP agree on the edited revision. Network/agent turns may be faked at the genuine boundary, never the store or permission decision.
- **Sharing:** extend `collaboration-commands.integration.test.ts` for package share/pull/push, stale remote revision and local locked/read-only mutation. Assert remote authority and protected local metadata survive; the test must fail if the local copy is treated as independently writable.
- **Failure sensitivity:** temporarily substitute a repository body, drop the revision comparison or bypass the denied-resource check for each distinct new behavior and confirm its focused test fails; revert each mutation. Existing source-text checks or a passing old suite alone are insufficient.

### Browser evidence

Use `bun run workspace:dev` at `http://127.0.0.1:5173/dev` and `/dev/plan-review` for fixture visual checks only. The Astro CLI's [development server](https://docs.astro.build/en/reference/cli-reference/) is distinct from the real composed server.

For persistence evidence, add a bounded runnable test/QA launcher beside the Workspace integration tests that uses `startWorkspaceServer` from `src/ui/workspace/server.js` with `mode: "owner"`, the real owner store and a registered disposable Git Project. Provision package data with existing internal admission; bind that admission at the real request boundary without exposing a production activation flag. Serve the built Workspace assets. This launcher is test-environment setup, not a replacement store or service. Record its exact command, port and `/projects/<projectId>/plans/<planId>` URL in implementation evidence; `workspace:remote` is not a local-owner substitute.

In a worktree-specific headed browser session, demonstrate registered Project -> Board/search -> Plan home -> document edit -> review -> continuation against that server. Use two tabs to show a stale decision rejected after the other tab saves; refresh and verify current text/revision, then restart/reconnect and verify persistence. Include the ordinary Core-opened browser review path, available separate documents, nested links, canonical Work Record access, and the unimported empty state without import side effects. Keep auth/registered-root checks active.

Capture desktop (1440x1000) and phone (390x844) screenshots of changed states, keyboard/focus checks and console/network diagnostics. Record commands, URL, admission setup, exact revision/content observations and screenshot paths. Check empty, loading, malformed, permission-denied and stale states without losing user input. Fixture-only screenshots, direct adapter calls or an in-memory app do not fulfill the composed-browser journey. Public entrypoints must still use legacy admission until child 10.

- Preserve: Current visual system, revision-safe review, private search boundaries, host permission enforcement and Shared Plan authority.
- Retire: UI assumptions that live Plan bodies or Work Records must be repository files and path-based authority reconstructed by adapters.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Development fixture routes alone do not prove real registered-Project navigation; include a live composed browser journey.
- Core package metadata revision and legacy body hashes are different contracts: preserve the authoritative check for each path rather than treating them as interchangeable tokens.
- Cross-request package selection must stay bound to the verified Project/owner; never accept an arbitrary browser path or leak another Project's home content.
- Package presence does not imply admission. Public activation, default migration, desktop-shell changes and Plan 10 execution remain outside this child.
- Update owning PRD scenarios with the tested internally admitted behavior and retained legacy default; do not promote target scope to public support. Existing ADR ownership boundaries remain unchanged.
