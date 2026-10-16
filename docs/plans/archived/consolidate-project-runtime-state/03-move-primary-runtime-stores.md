---
planId: "e7e56bbb-79e1-4d99-8187-de58bdf85aaa"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/isolated-publication.ts"
    - "src/shared/worktree.js"
    - "src/shared/worktree-registry.test.js"
    - "src/shared/workflow/plan-execution-runtime-boundaries.integration.test.ts"
    - "src/shared/worktree-creation.test.ts"
    - "src/shared/project-runtime-layout.test.ts"
    - "src/shared/workflow/controller-registry.integration.test.ts"
    - "src/shared/workflow/publication-machine.failure-matrix.test.ts"
    - "src/ui/tui/testing/scenario-runner.js"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-29T03:04:55.060Z"
status: "validated"
origin: "internal"
parentPlan: "consolidate-project-runtime-state"
order: 3
dependencies:
    - "02-add-legacy-runtime-migration-engine"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
---

# Move Primary Runtime Stores

## Context

Primary-owned runtime state is shared through the primary checkout. Today, several stores still construct paths under
`../../../../.wld` directly or inherit the old runtime directory. They must move under the primary checkout's
`../../../../.wld/internal` root.

The Epic branch can be unsafe between child Plans, but CI must pass after this slice. Selected-checkout stores can move
in the next child Plan. Child 02 has implemented the migration engine; normal stores still use the old paths. Shared
project-entry checks remain child 06 work. This slice is not a safe standalone upgrade for legacy projects.

The parent Epic and ADR-017 already settle ownership and the one-way migration policy. The current glossary defines
Primary-Checkout Runtime State and Selected-Checkout Runtime State; this slice does not change those definitions.

## Objective

Move primary-owned runtime readers and writers to the shared internal layout without changing their authority model,
locking rules, revision checks, or publication proof behavior.

## Approach

Change primary-owned stores to use `resolveProjectRuntimeLayout(checkoutRoot).primary` from
`../../../../src/shared/project-runtime-layout.ts`. Do not introduce a second registry or controller protocol, legacy
fallback reads, or duplicate writes.

| Existing path owner                      | Layout property used after this slice                        |
| ---------------------------------------- | ------------------------------------------------------------ |
| `getWorktreeRegistryPath()`              | `worktreeRegistryPath`                                       |
| `getWorktreeRegistryLockPath()`          | `worktreeRegistryLockPath`                                   |
| `migrateLegacyRegistryEntries()` report  | `worktreeRegistryMigrationIssuesPath`                        |
| `controllerRecordPath()`                 | `controllerPlansDir` plus existing encoded identity filename |
| `publicationRootForAttempt()`            | `publicationStagingRoot` plus attempt ID                     |
| `resolveWorktreeParent()` no-home branch | `fallbackWorktreesRoot`                                      |

Keep controller path canonicalization and primary-checkout discovery unchanged. The layout helper preserves
`getRunWieldRuntimeDir()` test sandbox routing; do not change that generic helper to move other stores early.

For new publication attempts, the path travels through:

```text
startPublicationAttempt(selected checkout)
  publicationRootForAttempt -> primary internal staging root
  registry saves absolute publicationRoot
  validation-publication passes saved path to isolated publication
```

An existing attempt keeps its saved `publicationRoot` and repair path. Recovery and cleanup use those exact paths. This
is not permission for the migration engine to move an unfinished legacy publication.

Primary ownership after this slice:

```text
primary .wld/internal
  controller/plans/*.json
  worktrees.json
  worktrees.lock
  plan-staging/<attempt>
  worktree-registry-migration-issues.json
  worktrees/              # only no-home fallback
```

The main option set aside is moving primary and selected stores together. The user accepted unsafe middle states on the
Epic branch, so this slice stays smaller and leaves selected-checkout stores for the next child Plan.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/shared/worktree-registry.js` — resolve registry, lock, temp write, and migration-report paths through
  the primary internal root.
- `../../../../src/shared/workflow/controller-registry.ts` — move controller records below the primary internal root
  while preserving locks, revisions, and atomic writes.
- `../../../../src/shared/workflow/publication-machine.ts` — create new publication staging below the primary internal
  root.
- `../../../../src/shared/isolated-publication.ts` and `../../../../src/shared/workflow/validation-publication.ts` —
  verify that publication, retry, and cleanup use saved absolute paths. Change these consumers only if needed; do not
  replace their existing recovery behavior.
- `../../../../src/shared/worktree.js` — keep normal `~/.wld/worktrees/`; move only the no-home project fallback below
  primary `../../../../.wld/internal`.
- Registry, controller, publication, and worktree tests — update expected paths and prove no second authority is
  created. `controller-registry.integration.test.ts` covers controller ownership and revisions;
  `plan-execution-runtime-boundaries.integration.test.ts` protects dispatch, not file placement.
- `../../../../src/shared/project-runtime-layout.test.ts` — keep legacy migration fixtures at explicit legacy paths. Its
  publication fixtures currently use normal registry/publication writers, which will no longer seed legacy data after
  this slice.
- `../../../../src/plan-store.test.js`, `../../../../src/shared/workflow/plan-action-evidence.test.ts`, and
  `../../../../src/cmd/load-plan/plan-recovery-flow.test.ts` — update current-store fixtures that construct registry
  paths directly.
- `../../../../src/ui/tui/testing/scenario-runner.js` and
  `../../../../src/ui/tui/golden-scenarios/planned-change-workflow.js` — make scenario registry reads and expectations
  use the current store, rather than silently treating a missing old file as empty.

Selected-checkout stores, project secrets, entry checks, Git exclusions, and release documentation remain in their
assigned later child Plans.

## Reuse Opportunities

- `../../../../src/shared/project-runtime-layout.ts` — use the existing `resolveProjectRuntimeLayout()` result; no new
  path API.
- `../../../../src/shared/git-test-fixture.ts` and existing controller/publication fixtures — use real Git checkouts and
  filesystem operations, not injected store implementations.
- `../../../../src/shared/worktree-registry.js` — retain existing registry serialization and CAS-like update behavior.
- `../../../../src/shared/workflow/controller-registry.ts` — retain existing OS file locking, revision checks, and
  atomic writes.
- `../../../../src/shared/workflow/publication-machine.ts` — retain monotonic publication phase behavior.

## Implementation Steps

- [ ] Normal worktree registry reads, writes, locks, temporary files, and migration reports use the named primary
      internal paths. `inspectWorktreeRegistryAtPath()` and `withWorktreeRegistryLockAtPath()` still use the exact path
      supplied by migration; they do not resolve or redirect it.
- [ ] Controller records, their locks, and temporary files use `controllerPlansDir` and the existing identity filename.
      Primary and linked checkout callers read the same persisted state and still reject stale revisions.
- [ ] New publication attempts record staging paths below primary `../../../../.wld/internal/plan-staging`, including
      when started from a linked checkout. Real publication creates and uses that staging checkout.
- [ ] Existing publication attempts retain recorded absolute staging and repair paths. Retry, reconciliation, and
      cleanup still use those paths without moving the checkout or losing commits.
- [ ] Explicit worktree-root overrides and normal home-based execution worktree placement remain unchanged. With HOME
      absent, both primary and linked invocations resolve the fallback to primary `.wld/internal/worktrees/`.
- [ ] Real linked-worktree tests prove cross-checkout reads and writes share one registry, lock, controller record, and
      staging location. Normal store operations do not recreate legacy paths or duplicate these stores in the linked
      checkout.
- [ ] Current-store fixtures and TUI scenario readers use the new layout. Legacy migration fixtures still contain
      literal legacy files and continue to prove unfinished-publication refusal and inactive-state adoption.
- [ ] CI passes with the behavior owned by this slice fully tested. Any temporary skip for a later child's scope is
      named with its owning child and cleanup requirement; it cannot replace a check listed below.

## Approval Confirmation

No Work Record replacement is proposed. Scope and ownership follow the approved parent Epic and ADR-017.

## Verification Plan

Run through the sandboxed test runner only:

```sh
deno run -A scripts/run-tests.js src/shared/project-runtime-layout.test.ts src/shared/worktree-registry.test.js src/shared/workflow/controller-registry.integration.test.ts src/shared/worktree-creation.test.ts
deno run -A scripts/run-tests.js src/shared/workflow/publication-machine.test.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-machine.e2e.test.ts src/shared/isolated-publication.test.ts src/shared/workflow/plan-execution-runtime-boundaries.integration.test.ts
deno task seams:check
deno task ci
```

Required evidence:

- **One shared store:** in a disposable real primary checkout and linked execution checkout, write a registry entry and
  controller state through one checkout, read and update through the other, then read back through the first. Assert the
  persisted content and literal primary `../../../../.wld/internal` placement, not only equality between helper results.
  Assert no corresponding old primary store or duplicate linked store exists after normal operations. Preserve sandbox
  routing tests as well; for literal placement use the existing locked fixture pattern that temporarily disables only
  project-runtime redirection, restores it, and keeps all operations inside disposable roots.
- **Shared locking and revisions:** hold the primary registry lock, start a linked-checkout mutation, and prove it
  cannot complete until release. Retain controller stale-write rejection, cross-process reads, identity binding, and
  rollback tests. Inspect registry/controller lock and temporary-write construction to confirm they remain beside the
  new authoritative files; retain atomic-write behavior rather than replacing it with a direct write.
- **Migration reports:** seed an unresolved registry identity in the new store, invoke the existing identity-migration
  read from the linked checkout, and assert the expected issue data appears only at the primary internal report path.
- **New publication:** start and run a real publication from linked-checkout invocation. Assert the saved staging path
  is under primary `.wld/internal/plan-staging/<attempt>`, the Git staging checkout is actually used, and the target
  contains the validated commit. Capture path evidence before normal cleanup removes staging.
- **Saved recovery:** seed a valid current registry record whose absolute staging/repair path is explicitly a legacy
  `.wld/plan-staging/` path. Exercise real retry and cleanup, not just a path getter. Verify the same saved checkout is
  used, no replacement internal staging checkout is created, and cleanup removes the recorded path only after verified
  publication. Advance the target during pending repair and assert both target and execution commits remain ancestors of
  the final result. This test bypasses migration deliberately; unfinished legacy migration must still refuse.
- **Worktree placement:** deliberately remove HOME within `withProcessGlobalTestLock`, restore it in `finally`, and
  assert the no-home fallback from both checkouts is the primary internal path. Keep the runner's sandbox marker.
  Separately prove a configured override wins and a normal home keeps the existing home-based path. Do not use a test
  that merely branches on whichever environment happened to run it.
- **Migration boundary:** preserve explicit legacy fixtures for unfinished publication and repair refusal before
  mutation, completed publication adoption, and exact-path registry inspection/locking. Normal writer changes must not
  make these fixtures silently test current-layout data instead.
- **Semantic review:** verify each owner uses the named layout property, including temporary files and report writes;
  scenario readers find populated current registry entries; imports of both registry and layout still load without
  initialization errors. There is no new normal legacy fallback, duplicate writer, or test-only injection seam.

The placement and cross-checkout tests must fail if the old path constructors remain. The real publication test must
fail if only the path getter changes while publication still stages elsewhere. Existing publication phase/revision,
process-stop recovery, primary-checkout preservation, and concurrent-publisher protection remain covered. Only old
normal-store locations and inconsistent selected-checkout placement of primary stores stop being supported in this
slice; their business behavior does not stop being tested. CI must pass before the next child starts.

## Edge Cases & Considerations

- Do not change primary-checkout discovery or nested invocation behavior.
- Do not rewrite publication records that contain absolute recovery paths.
- Dirty-path filtering and publication exclusion remain child 07 work; do not broaden this slice into that policy.
- The layout module imports exact-path registry inspection and locking for migration. A registry import of the layout
  helper forms a module cycle. Keep calls lazy, avoid top-level cross-module calls, and verify both import entry orders.
  Do not move migration behavior into normal registry access to solve the cycle.
- Tests that create only `../../../../.wld` before writing a resolved registry path must instead create the resolved
  parent.
- Never run an upgrade experiment on the real checkout during this intermediate slice. Use disposable fixtures.
