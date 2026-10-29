---
planId: "2055cb08-5938-4c85-bddd-50bb3c816386"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/workflow/planning-worktree.ts"
    - "src/shared/workflow/plan-actions.ts"
    - "src/cmd/plans/"
    - "src/cmd/load-plan/"
    - "src/ui/workspace/server/"
    - "docs/adr/017-project-runtime-state-under-wld-internal.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-27"
origin: "internal"
status: "ready_for_work"
userVerifiedAt: null
---

# Side-Effect-Free Plan Reads

## Context

Reading Plans can currently change the Project. Workspace lists and search reach `listPlanResources` and `listPlans`.
Those readers can enter runtime migration, reconcile `.gitignore`, import controller state, and fetch target branches.
Dashboard and progress reads also reach registry migration and remote publication checks.

The owner requires these effects to run only from explicit user actions or RunWield processes intended to perform them.
The owner accepts a pending read state for unmigrated Projects or Plans. The earlier Workspace search speed and
missing-ID fix is separate existing work; preserve it and other uncommitted changes.

Owning requirements and proposed changes:

- [Core Plan authoring and external adoption](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption): extend
  read-only browsing beyond the existing `/load-plan` picker. Preserve external Markdown, body ownership, identity,
  ordering, and explicit adoption.
- [Core Work protection](../prd/runwield-core-prd.md#work-protection): change **Enter project runtime state before use**
  to distinguish passive inspection from mutation admission. Preserve all migration security and work protection.
- [Core execution, validation, and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve
  automatic recovery by the owning action or workflow. Browsing is not permission to run that recovery.
- Workspace [Local Plan management](../prd/runwield-workspace-prd.md#local-plan-management),
  [Attention dashboard](../prd/runwield-workspace-prd.md#attention-dashboard), and
  [Durable knowledge search](../prd/runwield-workspace-prd.md#durable-knowledge-search): expose pending read information
  without hidden Project changes. Preserve current-source checks, partial results, and explicit saves/actions.

These are proposed changes, not claims that read purity has shipped. ADR-017 currently requires entry before normal
runtime reads and must change with the implementation.

## Objective

Plan listing, indexing, browsing, and passive workflow metadata reads inspect existing evidence without changing their
sources. Actions and workflow owners retain guarded initialization, migration, repair, and publication.

A passive read must not create, modify, rename, or delete Plan/runtime files; reconcile ignore rules; assign IDs; fetch
or clone Git data; change refs/worktrees; acquire writer locks; clean journals; or enqueue those effects for later.
In-memory caches and the search service's own derived index/status writes remain allowed. This is not a ban on every
write made by a running Workspace or on unrelated Session operations.

## Approach

Separate checked inspection from action-owned preparation in the existing owners. Do not replace rich Plan reads with
local Markdown parsing: that would lose registered worktree authority and current controller decisions.

```text
List / browse / index / progress
  checked read access
  existing local document + controller + registry + cached Git evidence
  result or pending/unavailable notice; no repair scheduled

Selected Plan load / save / workflow recovery / publication
  guarded runtime entry and required preparation
  current evidence recheck
  existing locked mutation
```

### Checked read access

`resolveProjectRuntimeLayout` only resolves paths. It is not proof of safe access. Reuse validation from
`inspectProjectRuntimeLayout`, but separate read checks from action admission. Its current `pending` result combines
several cases and is not a safe authority map. Its controller-lock probe also opens a file for writing and briefly locks
it; passive readers must not use that probe.

The runtime owner decides what can be read:

- **Fresh Project:** return local documents and empty runtime facts without creating storage or a marker.
- **Adopted, safe state:** read current authority, including registered document worktrees. Returning legacy files do
  not override adopted decisions or require recovery merely to browse them.
- **Unmigrated or partly migrated state:** show safe local document information with workflow details pending. Do not
  combine legacy and current stores, infer journal completion, or restore missing files. Use the same pending result
  when a Plan requires controller import or identity adoption.
- **Unsafe or unreadable authority:** retain the specific safe diagnostic. Never turn a symlink escape, newer marker,
  identity conflict, or unreadable registry into an authoritative empty catalog. Safe local document browsing may remain
  available, but it is not a fallback source of workflow truth.

Pure inspection and mutation-entry caching must be distinct. Inspection never satisfies a later writer's entry check.
Keep operation-local reuse and expiry for nested reads; do not cache Plan contents or workflow facts across requests.

### Readers and mutation owners

Reuse exact-path registry/controller readers behind checked access. Consolidate the state projection shared by
`inspectControllerView` and `loadControllerView`; preserve fields such as `worktreeBaseCommit`. Move legacy import and
obsolete-recovery cleanup into a named preparation operation owned by deliberate Plan writes, selected loads, or
workflow recovery. No `readOnly`, `importLegacy`, or `refreshRemote` switch should let a nominal reader mutate.

Make registry list/find APIs pure. Keep schema/identity migration in a named mutation operation called by repair and
mutation admission. Replace `listPlanResources({ backfillMissing: true })` usage with explicit identity/adoption
operations such as `ensurePlanIdentity`; ordinary listing has no backfill mode.

Target-child discovery reads locally available Git refs and objects, with existing identity and worktree precedence.
Fetch stays in explicit planning/workflow preparation. `inspectTargetBranchPlansByParent` is not a safe replacement: its
temporary clone/fetch also has effects. Missing local target evidence is unavailable, not proof of no children.
Target-only `commit:path` entries must remain readable through local Git objects rather than filesystem loaders.

Progress reads must not invoke `isCommitPublishedToTarget` when it clones or fetches. Show saved evidence and its
limits. Do not substitute a stale local tracking ref for fresh remote publication proof. If available evidence cannot
establish completion, show it as unconfirmed; the existing publication/recovery owner obtains fresh proof and records
progress. This changes read-time verification, not the publication success contract in ADR-016.

### Pending presentation

> [!NOTE]
> **Pending is not a Plan lifecycle status**
>
> Carry read availability separately from Front Matter. Never write `pending` into Plan status or treat missing workflow
> facts as permission to execute, publish, or change lifecycle state.

Use a small shared read-availability result through CLI output, Workspace summaries/details, dashboard/progress, and
search status. Suggested copy: **Workflow details pending. Load this Plan to prepare its workflow.** Exact wording and
internal field names are reviewable implementation assumptions. Reuse existing notice and degraded-state components; no
board redesign or new lifecycle column is needed.

Safe local documents remain visible by their existing name/path navigation, including ID-less documents on the board.
Search continues to skip ID-less Plans without writing them. When canonical authority is pending, search must not index
or return a primary copy as current workflow evidence; show the Project's safe status and retain healthy results.
Explicit selected-Plan load remains available to perform automatic preparation. Other mutation requests recheck
authority at action time; pending metadata cannot authorize them. Refresh after the action clears the notice when
evidence is ready.

Using document-only listings everywhere was rejected because it loses current authority. A complete legacy/interrupted
migration reader was set aside because the owner accepted pending information instead. No new maintenance daemon,
mandatory Doctor ceremony, or background repair triggered by a read is part of this Plan.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/project-runtime-layout.ts` — checked passive access, writer-only admission, separate cache lifetimes.
- `src/shared/worktree-registry.js`, `src/shared/workflow/controller-registry.ts` — pure read projections and explicit
  schema/identity/controller preparation; retain locked mutation authority.
- `src/plan-store.js`, `src/shared/workflow/planning-worktree.ts` — pure active/archived catalogs, local target
  evidence, resource hydration, and explicit adoption/preparation.
- `src/shared/workflow/plan-location.ts`, `plan-actions.ts`, `state-transition.ts`, and publication owners — verify
  preparation occurs at action/recovery boundaries, not inside evidence readers.
- `src/cmd/plans/index.ts`, read/UI/Doctor commands, and `src/cmd/load-plan/` — remove passive dispatch entry, preserve
  selected-Plan recovery and read-only picker/autocomplete behavior.
- `src/ui/workspace/server/{plan-adapter.js,workspace-search.ts,owner-dashboard.ts,owner-plan-progress.ts,project-artifacts.ts}`
  and their routes/renderers — preserve authorization and current results while exposing pending information.
- `src/ui/tui/tutorial-guidance.ts` and affected read callers — avoid controller mutation during passive guidance.
- Focused store, runtime, CLI, workflow, Workspace, and composed TUI tests — prove both purity and retained actions.
- `docs/domain-language.md`, the owning PRD capabilities above, `docs/plan-lifecycle.md`, ADR-017, and ADR-016 — align
  read/entry language and publication display limits. Reuse `docs/design-system.md` patterns; change it only if a new
  shared pattern is necessary.

Session storage, collaboration protocol, Work Record generation, and the earlier search optimization are not redesign
scope. Shared helper callers in those areas must retain required action preparation if their helper contract changes.

## Reuse Opportunities

- `listPlanDocuments`, document-only strict parsing, `inspectPlanFileStrict`, and `inspectControllerView` already
  separate some reads from repair. Reuse their logic, but add checked authority rather than calling unchecked paths
  directly.
- `inspectWorktreeRegistryAtPath` and `readControllerRecordAtPath` supply non-mutating reads after validation.
- `enterProjectRuntime`, controller/registry locks, selected-load recovery, and publication owners retain mutation
  rules.
- Existing `/load-plan` snapshot tests, Doctor `--check` tests, `defineGitFixture`, and sandboxed test runner supply
  real evidence without injecting substitutes for RunWield-owned code.

## Implementation Steps

1. **Passive runtime access is checked and non-mutating.** The runtime module distinguishes safe current authority,
   empty fresh state, pending adoption/recovery, and blocked access. It shares security rules without taking writer
   locks. Pending adoption never selects partly moved authorities. Adopted current authority remains usable when only
   legacy recovery input returns. Read caches expire per operation; writers always run their own admission checks.
2. **Controller and registry readers no longer prepare state.** Read/list/find calls use checked local evidence and
   preserve shape, revisions, integrity diagnostics, and authority. Controller import, recovery-hint cleanup, registry
   upgrades, and identity migration have named mutation owners. Registry mutations enter before locking and do not
   re-enter migration while holding the registry lock. Read APIs have no mutation-enabling flags.
3. **Plan catalogs and evidence reads are pure and complete for available local authority.** Active/archived listing,
   strict loads, ID lookup, summaries, action evidence, and worktree path authorization use the pure owners. They retain
   ordering, hierarchy, archive suppression, duplicate/mismatch rejection, and authoritative document precedence.
   Target-only resources hydrate from local Git objects; target discovery never fetches. Identity backfill moves to
   explicit adoption calls. Missing authority produces a typed pending/unavailable result, not false absence.
4. **Actions still perform required automatic preparation.** `savePlan`, deliberate external adoption, selected/named
   `/load-plan`, lifecycle/edit/review actions, execution, recovery, and publication enter and prepare before relying on
   runtime facts. Direct callers do not depend on an earlier list to initialize them. Existing locks, revision checks,
   body preservation, recovery journals, and publication proof remain effective. Init, Session activation, and explicit
   Doctor repair keep their current intentional preparation; Doctor `--check` stays passive.
5. **Production read surfaces expose the new contract.** CLI list/read/UI dispatch, Workspace board/detail/search,
   dashboard/progress and passive TUI guidance perform no source mutation, fetch, clone, or repair scheduling. Pending
   notices are visible without changing lifecycle metadata. Existing read navigation and selected-load actions remain
   usable. Search retains query-local catalog reuse and ID-less skipping. Progress reports evidence limits without
   weakening remote proof. Route-level tests cover the actual composition, not only isolated readers.
6. **Documents match the delivered boundary.** Update the named PRD requirements/scenarios and affected references in
   the same change. Revise ADR-017 in place, preserving migration/security rules. Clarify ADR-016's passive display
   versus action-owned fresh proof. Update Project Runtime Entry and related definitions, avoided aliases, and
   relationships in `docs/domain-language.md`; pending read availability is not lifecycle or adoption. Keep any unmet
   scope explicit.

## Approval Confirmation

No Work Records are proposed for supersession. Approval covers the owner's pending-state decision and the read/action
boundary above, not removal of migration or automatic recovery.

## Verification Plan

**Prove unchanged sources and useful results together.** Seed fixtures with raw files, not `savePlan` or loaders that
can migrate before the test starts. Snapshot Project/selected-worktree files, sandboxed runtime files, `.gitignore`, Git
index/refs/worktree registrations, controller records, marker/journals, and lock paths. Compare after repeated reads and
after asynchronous work settles. Allow only the tested search service's derived store to change.

- Exercise `listPlans`, resource/ID/archived reads, CLI list/read dispatch, and real Workspace board/detail/search and
  dashboard/progress routes. Cover fresh, legacy, interrupted adoption, ready, and ready-with-returning-legacy states.
  Require actual documents/current fields or the specified pending notice. An empty catalog cannot pass.
- In a ready fixture, make primary, registered worktree, cached target, and controller evidence deliberately differ.
  Assert the correct document/state wins, including `worktreeBaseCommit`, archive suppression, target-only body
  hydration, stable ordering, and ID conflicts. Mutate authoritative evidence between requests and assert fresh results.
- Use a local Git remote with newer target data plus Git subprocess/transport tracing to assert no read invokes fetch,
  clone, or mutating Git commands, including temporary repositories. Filesystem snapshots alone cannot detect a clone
  that is removed later. Hold real catalog/registry locks in another process and show reads do not wait on them. Run a
  passive-reader child with no filesystem write permission to catch transient lock/write attempts; do not mock owned
  modules. Search uses its normal writable derived store in its separate integration test.
- Pending fixtures keep local documents browseable and show a notice. Search withholds uncertain Plan evidence and
  retains healthy Project results; ID-less Plan bytes remain unchanged. Unsafe markers, symlinks, conflicts, or missing
  registered execution documents must not fall back to stale primary workflow evidence or authorize an action.
- Then invoke real selected-load/preparation and mutation flows in the same fixtures. Assert migration/import/repair
  occurs, body and original age survive, current decisions are not overwritten, and a later read becomes ready. Preserve
  interruption/retry, concurrency, selected-checkout ownership, and lock-order tests. Prove a fresh action rechecks
  authority even when a prior read in the same async chain succeeded.
- For progress, absent registry plus unreachable upstream must not fetch or claim newly confirmed delivery. Existing
  publication/recovery tests must still require fresh remote proof before success/cleanup. Saved facts remain visible.
- Source review traces every passive entry listed above through its callers: no indirect preparation or queued repair.
  This complements behavioral tests; renaming a mutating helper does not satisfy the objective.

Focused commands (include new focused test files beside these owners):

```sh
deno run -A scripts/run-tests.js src/plan-store.test.js src/plan-store-locks.test.ts src/shared/project-runtime-layout.test.ts src/shared/project-runtime-entry.integration.test.ts src/shared/project-runtime-read-scope.test.ts src/shared/worktree-registry.test.ts
deno run -A scripts/run-tests.js src/shared/workflow/controller-registry.integration.test.ts src/shared/workflow/planning-worktree.test.ts src/cmd/plans src/cmd/load-plan
deno run -A scripts/run-tests.js src/ui/workspace/server src/ui/workspace/owner-workspace.test.js src/ui/workspace/owner-dashboard-stream.test.ts
deno task seams:check
```

Retain the existing composed `/load-plan` picker/autocomplete preservation test and affected publication/recovery tests.
Run them through `scripts/run-tests.js`, never `deno test`. Use `getHomeDir`/`getCwd` and `withProcessGlobalTestLock`
when tests alter HOME or cwd. Do not re-baseline new injection seams.

**Coverage changes:** migration-on-list, import-on-read, fetch-on-list, and read-time remote verification are expected
to stop. Move their mutation assertions to the owning action tests; do not delete authority, security, recovery, or
freshness coverage. Existing picker behavior, ID-less search handling, current-source checks, and per-query search reuse
survive.

**Manual:** use a sandbox Project and isolated Workspace process, not BrandChef.ai or the owner's live store. In a
headed browser, inspect board/detail, search, and progress at desktop and phone widths. Confirm pending text is
readable, is not a lifecycle column, and leaves local document navigation usable. Repeated refresh must preserve source
snapshots. Load the Plan deliberately, then refresh and confirm the notice clears when preparation succeeds. Check
console/network errors and normal ready-state controls. Use the production Workspace command with sandbox HOME and a
spare port; the Astro fixture server alone does not prove runtime purity. For component-only inspection,
`deno task workspace:dev` serves `http://127.0.0.1:5173/dev`.

**AI review:** verify the read/action separation, positive action coverage, truthful pending/publication display, and
same-change PRD/ADR/glossary synchronization. Passing old tests alone is not proof.

## Edge Cases & Considerations

- Legacy controller inode lock files are not proof of an active writer. Passive inspection cannot probe them with an
  exclusive lock; action admission retains the real lock protocol.
- Inspection concurrent with migration may temporarily report pending. It must neither join mixed authorities nor
  perform recovery. A later request rechecks; no persistent ready cache is allowed.
- A missing local target ref costs freshness until an owning preparation action fetches. Do not silently claim an Epic
  has no children or use a stale ref as proof of remote publication.
- ID-less documents are valid local drafts. A pending notice does not mint identity, mark corruption, or add them to
  durable-ID search results.
- The new preparation boundary must not create circular imports or lock re-entry. Keep authoritative decisions in the
  existing runtime/controller/registry owners, not duplicated per UI surface.
- No production migrations, service restarts, or source edits are part of planning. Preserve pre-existing dirty files.
