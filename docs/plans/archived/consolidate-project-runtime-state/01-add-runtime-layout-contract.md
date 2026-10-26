---
planId: "c6e653ec-2b3b-43c3-ad8a-107015520e9f"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/constants.js"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/runwield-owned-paths.ts"
    - "src/shared/project-runtime-layout.test.ts"
    - "src/shared/runwield-owned-paths.test.ts"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-29T03:04:53.120Z"
status: "validated"
origin: "internal"
parentPlan: "consolidate-project-runtime-state"
order: 1
dependencies: []
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
---

# Add Runtime Layout Contract

## Context

RunWield currently treats the project `../../../../.wld` directory as both user-derived project configuration and
machine-owned runtime state. The Epic makes `../../../../.wld/internal` the one current project-runtime root, but the
code needs a shared contract before existing stores can move safely.

This child Plan does not move production readers or writers. It creates the path vocabulary and classification rules
that later child Plans will use. During this intermediate slice, existing Git and publication callers must still protect
both the new boundary and known legacy paths.

## Objective

Add a shared project-runtime layout contract that can answer three questions consistently:

- Where is the primary-checkout internal runtime root?
- Where is the selected-checkout internal runtime root?
- Which Git paths are current runtime state versus legacy runtime hazards?

The result must keep `../../../../.wld/settings.json`, `.wld/agents/**`, `.wld/skills/**`, and `.wld/prompts/**` outside
the current runtime classifier.

## Approach

Add `../../../../src/shared/project-runtime-layout.ts` as the owner of the storage-layout names and named paths. Keep
`RUNWIELD_DIR_NAME` and `getRunWieldRuntimeDir()` as the test-routed project `.wld` base during this slice. Add
`PROJECT_INTERNAL_RUNTIME_DIR_NAME = "internal"`; the layout resolver appends it after it resolves checkout ownership.

The module interface is:

```text
resolveProjectRuntimeLayout(selectedCheckoutRoot)
  primary.checkoutRoot
  primary.internalRoot
  primary.controllerPlansDir
  primary.worktreeRegistryPath
  primary.worktreeRegistryLockPath
  primary.worktreeRegistryMigrationIssuesPath
  primary.publicationStagingRoot
  primary.projectSecretStorePath
  primary.fallbackWorktreesRoot

  selected.checkoutRoot
  selected.internalRoot
  selected.planLocksDir
  selected.planCatalogLockPath
  selected.transitionJournalsDir
  selected.workRecordSupersessionLockPath
  selected.workRecordSupersessionRecoveryLockPath
```

`ProjectRuntimeLayout` and its primary/selected object types use named properties. Dynamic leaf naming remains with its
current owner: Plan lock slugs, controller record keys, transition IDs, publication attempt IDs, and atomic temp tokens
are not moved into the layout module.

Split classification into three explicit answers:

```text
isCurrentProjectRuntimePath(path)       -> .wld/internal and descendants only
isLegacyProjectRuntimeHazardPath(path)  -> bounded pre-0.10.0 paths only
isRunWieldOwnedRuntimePath(path)        -> temporary Git-safety aggregate of both
```

Keep the aggregate pathspec and managed-block exports safe for old writers in this intermediate slice. The later Git
safety child removes legacy entries from the generated managed block after writers have moved. A legacy hazard must not
be presented as a current write target.

The main option set aside is changing `getRunWieldRuntimeDir()` to point at `../../../../.wld/internal` and letting all
callers inherit it. That would be smaller, but it would hide the primary-versus-selected ownership rule and move
production writers before their owning child Plans.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/constants.js` — define `PROJECT_INTERNAL_RUNTIME_DIR_NAME` while preserving the existing test-routed
  project `.wld` base.
- `../../../../src/shared/project-runtime-layout.ts` — add `ProjectRuntimeLayout`, its named primary/selected path
  types, and `resolveProjectRuntimeLayout()`.
- `../../../../src/shared/runwield-owned-paths.ts` — expose separate current and bounded legacy-hazard
  catalogs/classifiers, plus a temporary combined Git-safety aggregate while legacy writers remain.
- `../../../../src/shared/project-runtime-layout.test.ts` — prove exact normal and sandboxed path resolution from
  primary and linked selected checkouts.
- `../../../../src/shared/runwield-owned-paths.test.ts` — prove the three-way current, legacy-hazard, and trackable path
  matrix, including temp-file shapes.
- `../../../domain-language.md` — define Project Runtime State, Project Internal Root, Primary-Checkout Runtime State,
  and Selected-Checkout Runtime State without claiming migration or writer cutover is active.

## Reuse Opportunities

- `../../../../src/shared/primary-checkout.ts` — reuse `resolvePrimaryCheckoutRoot()`; do not add repository-root
  discovery.
- `../../../../src/constants.js` — reuse `RUNWIELD_DIR_NAME` and `getRunWieldRuntimeDir()` test sandbox routing instead
  of reading `Deno.cwd()` or `HOME`.
- `../../../../src/shared/runwield-owned-paths.ts` — reuse Git-path normalization and managed-block replacement
  behavior.
- `../../../../src/shared/git-test-fixture.ts` — use a real linked worktree to prove primary and selected checkout
  ownership without adding an injection seam.

## Implementation Steps

- [ ] `../../../../src/constants.js` exports `PROJECT_INTERNAL_RUNTIME_DIR_NAME = "internal"`;
      `getRunWieldRuntimeDir(projectRoot)` keeps its current normal and sandboxed base-path behavior.
- [ ] `resolveProjectRuntimeLayout(selectedCheckoutRoot)` resolves the primary checkout through
      `resolvePrimaryCheckoutRoot()` and returns typed, named primary and selected layouts. In normal use their internal
      roots are `<primary>/.wld/internal` and `<selected>/.wld/internal`; under tests each is below its project-keyed
      `WLD_TEST_SANDBOX_HOME` runtime base.
- [ ] The primary layout names the controller Plans directory, registry file and lock, registry migration report,
      publication staging root, project secret file, and no-home fallback worktrees root below one primary internal
      root.
- [ ] The selected layout names the Plan locks directory, catalog lock, transition journals directory, and both Work
      Record supersession lock files below one selected internal root.
- [ ] Dynamic record, attempt, journal, Plan-lock, and atomic-temp leaf names remain owned by their current store
      modules; the layout module exposes no generic public path-join function.
- [ ] `isCurrentProjectRuntimePath()` accepts exactly normalized `../../../../.wld/internal` and descendant Git paths.
      It rejects `.wld`, similarly prefixed paths, and every legacy path outside the internal root.
- [ ] `isLegacyProjectRuntimeHazardPath()` recognizes the bounded old directory/file catalog, registry temp-file shape,
      project-secret temp-file shape, and both Work Record supersession locks. It does not classify them as current
      paths.
- [ ] `isRunWieldOwnedRuntimePath()` and aggregate pathspec/managed-block exports temporarily protect the union of
      current paths and legacy hazards so existing writers remain excluded from commits until later child Plans move
      them.
- [ ] `../../../../.wld/settings.json`, `.wld/agents/**`, `.wld/skills/**`, and `.wld/prompts/**` return false from
      current, legacy, and aggregate runtime classifiers.
- [ ] Production readers and writers still use their existing paths after this slice; migration, marker/lock filenames,
      one-entry `../../../../.gitignore` reconciliation, and writer cutover remain owned by later child Plans.
- [ ] `../../../domain-language.md` defines the four project-runtime layout terms, their primary/selected ownership
      relationships, and avoided aliases without claiming migration or writer cutover is active.

## Approval Confirmation

The completed Work Record `dc1e7c94-a38a-418d-9c63-4550fb3583ca` established runtime staging and merge isolation. This
Plan preserves that outcome while adding a new layout contract, so it overlaps but does not materially replace the
record. No `supersedes` relation is proposed.

## Verification Plan

- Automated:
  `deno run -A scripts/run-tests.js src/shared/project-runtime-layout.test.ts src/shared/runwield-owned-paths.test.ts src/constants.test.ts`.
- Automated: `deno task seams:check`.
- Automated: `deno task ci` must pass before the next child Plan starts.
- Path-layout proof: a real linked-worktree test calls `resolveProjectRuntimeLayout()` with the linked checkout and
  proves every primary property is below the primary checkout's test-routed internal root, every selected property is
  below the linked checkout's test-routed internal root, and exact leaf names match the contract. This fails if the
  resolver returns one generic root, ignores primary-checkout resolution, or returns placeholders.
- Classifier proof: a table test checks `../../../../.wld/internal`, nested internal paths, each legacy directory/file
  and temp-file shape, close-prefix counterexamples, and the four trackable project paths against all three classifiers.
  This fails if current and legacy answers are aliases or pass-throughs.
- Compatibility proof: existing `RUNWIELD_GITIGNORE_BLOCK`, pathspec, and dirty-path behavior continue to exclude both
  current and legacy runtime state during this intermediate slice; the block is not yet required to contain only one
  line.
- Preserved behavior: production runtime readers and writers keep their current locations; sandboxed tests keep separate
  project lock namespaces; user-derived `.wld` files remain outside every runtime classifier.
- Behavior expected to stop: callers can no longer use one undifferentiated catalog when they need to decide whether a
  path is current layout state or only a legacy migration/Git hazard.
- Glossary check: the glossary describes only the implemented path contract and does not claim project entry, migration,
  single-entry `../../../../.gitignore` reconciliation, or writer cutover is active.
- No skipped test is expected. If one is unavoidable, mark it for the Epic's final cleanup child and do not skip
  behavior owned by this Plan.

## Edge Cases & Considerations

- `getRunWieldRuntimeDir()` currently returns the project `.wld` base, despite its broad name. Do not change its meaning
  in this slice; the new resolver is the only API that calls the appended `internal` directory a runtime root.
- Test sandbox routing must not collapse primary and selected projects into one lock namespace. Tests must derive
  expected roots through `getRunWieldRuntimeDir()` rather than assume physical checkout paths.
- `.wld/plan-backups/` and project `.wld/debug/` are reserved legacy hazards with no current production writer. Keep
  them in the legacy catalog; do not expose them as active named layout paths.
- Home state, including normal `~/.wld/worktrees/`, global collaboration secrets, Sessions, and home debug output, is
  outside this contract.
- The contract must not create directories, follow symlinks, choose migration marker/lock names, or decide migration
  safety. Those belong to the migration child Plan.
- The intermediate aggregate Git-safety exports can contain both current and legacy entries. The final one-entry
  `../../../../.gitignore` block belongs to the later Git-safety child after all writers move.
