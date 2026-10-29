---
planId: "aa0212e8-4f12-4168-a6b8-348a3524acfa"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/session-runtime.js"
    - "src/acp/server.js"
    - "src/cmd/init/index.ts"
    - "src/cmd/plans/index.ts"
    - "src/cmd/plans/share.ts"
    - "src/cmd/plans/pull.ts"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/controller-registry.ts"
    - "src/plan-store.js"
    - "src/shared/workflow/state-transition.ts"
    - "src/shared/work-records/supersession.ts"
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/isolated-publication.ts"
    - "src/shared/collaboration/secrets.js"
    - "src/cmd/plans/doctor.ts"
    - "src/ui/tui/chat-session.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "src/shared/session/session-runtime.test.js"
    - "src/acp/server.test.js"
    - "src/cmd/init/index.test.ts"
    - "src/cmd/plans/index.test.ts"
    - "src/ui/tui/golden-scenarios/initial-scenarios.test.js"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-29T03:04:59.625Z"
status: "validated"
origin: "internal"
parentPlan: "consolidate-project-runtime-state"
order: 6
dependencies:
    - "05-move-project-collaboration-secrets"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
---

# Wire Project Entry Guards

## Context

The migration engine is only safe if every project surface reaches it before normal runtime-store access. Session
Runtime, ACP, Init, direct Plan commands, and collaboration commands enter through different code paths today.

This child Plan wires those surfaces to one project-runtime entry operation while preserving the no-write startup rule
for a new empty TUI. The parent Epic and ADR-017 settle the migration policy. Children 02–05 provide the migration
engine and new store locations; this child makes normal use reach that engine.

Discovery confirmed those dependencies on `epic/consolidate-project-runtime-state`. The planning checkout changed during
inspection and does not contain all dependency code. Execute after child 05 on the existing target branch; do not
rebuild missing dependencies in this child. The entry behavior supports Core's
[Session continuity](../../../prd/runwield-core-prd.md#session-continuity) and
[work protection](../../../prd/runwield-core-prd.md#work-protection) requirements.

## Objective

Make project-runtime entry a shared gate for project-local runtime access. A lower-level registry, controller, lock,
journal, publication, or project secret operation must not bypass a migration refusal and perform filesystem
input/output anyway.

## Approach

Expose async `enterProjectRuntime(cwd)` from `../../../../src/shared/project-runtime-layout.ts`. It calls the existing
`migrateLegacyProjectRuntimeState()`, returns the ready layout, or throws a distinct migration refusal error carrying
`reason`, `paths`, `message`, and optional `securityAction`. Do not duplicate preflight or migration rules.

```text
submitted message / Session load / project command
  enterProjectRuntime(selected checkout)
    existing migration engine -> ready layout or refusal
  normal operation
    guarded store -> read / lock / write
```

Keep `resolveProjectRuntimeLayout()` and path getters synchronous and free of migration writes. Normal asynchronous
store operations must invoke entry before filesystem access, or use a successful entry context held by the enclosing
operation. Acquire entry before operation locks. Internal helpers may reuse that operation's context; a caller-supplied
boolean or process-wide 'already entered' flag must not bypass entry. Later independent operations recheck the layout,
including later-entered selected checkouts and legacy state recreated after adoption.

Migration must still inspect and lock exact legacy paths without recursively entering itself. Keep
`inspectWorktreeRegistryAtPath()` and `withWorktreeRegistryLockAtPath()` as narrowly used migration/diagnostic
primitives, not alternate normal-store access. Check all production callers. Migration preflight and bounded diagnostics
are the necessary exception to normal-store access checks; a refusal must stop normal work, not prevent explaining the
refusal.

Secret IO currently accepts only a file path. Carry explicit project/global ownership through its read, write, lookup,
and delete functions: project locations carry their selected checkout root, and global locations retain the existing
home-based behavior. Resolve and guard project locations through the layout owner, including global-to-project fallback.
Do not infer project roots from path strings: test runtime paths can be redirected. Keep `getProjectSecretStorePath()`
synchronous. Do not retain an unguarded path-only project IO overload.

Refusal must survive generic error handling. Plan listing must not report an empty list; recovery must not continue
writing; secret error redaction must not erase safe paths or the refusal reason. ACP new/load must return the reason and
safe paths using existing protocol error conventions, not report a missing Session. No secret values enter diagnostics.

The option set aside is command-only checks. They miss direct store callers and exported collaboration services. The
extra store checks enforce the parent Epic without a second migration implementation.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/shared/project-runtime-layout.ts` — own entry and the shared refusal error; retain migration-only
  exact-path use.
- `src/shared/session/session-runtime.js` — guard deferred materialization, non-deferred creation, and load before
  durable setup. Cover headless and Workspace callers through the same Runtime, not separate migration implementations.
- `../../../../src/acp/server.js` — preserve migration refusal details for new/load instead of the broad
  load-to-not-found mapping.
- `../../../../src/cmd/init/index.ts` — enter before project initialization writes; retain help and empty-directory
  no-op behavior.
- `../../../../src/cmd/plans/index.ts` and subcommands — cover dispatch before list logic, including read, UI, archive,
  prune, and Doctor. Subcommand help remains non-migrating. Doctor only needs safe entry/refusal handling here; broader
  reports remain child 08 work.
- `src/cmd/plans/{share,pull,push,unshare}.ts` and `../../../../src/shared/collaboration/secrets.js` — guard exported
  operations and project secret IO, with explicit store ownership and unchanged global preference/fallback rules.
- `../../../../src/shared/worktree-registry.js`, `../../../../src/shared/workflow/controller-registry.ts` — guard normal
  reads, locks, writes, identity changes, and read-triggered schema updates without recursive migration.
- `../../../../src/plan-store.js`, `../../../../src/shared/workflow/state-transition.ts`,
  `../../../../src/shared/work-records/supersession.ts` — guard selected checkout locks, journals, and transition
  effects; preserve refusal through best-effort read/recovery catches.
- `../../../../src/shared/workflow/publication-machine.ts`, `../../../../src/shared/isolated-publication.ts`, and
  `../../../../src/shared/worktree.js` — guard direct publication/recovery/cleanup access and project-local fallback
  creation, even when supplied saved paths.
- Existing store tests plus entry integration tests, Session/ACP/command tests,
  `../../../../src/ui/tui/chat-session.test.ts`, and initial TUI golden tests — prove refusal, adoption, retry, and
  write-free startup through real filesystem operations.
- `../../../domain-language.md` — define proposed **Project Runtime Entry**, its avoided aliases, and its relationship
  to Project Runtime State and checkout ownership when this behavior lands.
- `../../../prd/runwield-core-prd.md` — add the delivered entry/adoption and refusal acceptance scenarios under work
  protection, and retain empty-composer behavior under Session continuity. Link ADR-017; do not put API details in the
  PRD.

Managed ignore-rule cleanup, Git publication exclusions, and release/Doctor documentation remain children 07–08. This
child does not change Session transcript ownership, workflow conclusions, publication proof, or migration eligibility.

## Reuse Opportunities

- `src/shared/session/session-runtime.js` — preserve existing active workflow and first-message behavior.
- `../../../../src/acp/server.js` — reuse existing session new/load boundaries.
- `src/cmd/plans/*` — reuse command parsing and current error presentation.
- `../../../../src/shared/project-runtime-layout.ts` — reuse the migration result and layout context from the migration
  child Plan.

## Implementation Steps

- [ ] `enterProjectRuntime()` adopts eligible legacy data through the existing engine, returns the correct primary and
      selected layout, and rejects blocked layouts with the shared refusal error. A second entry is byte-stable; a later
      operation can retry after a blocker is removed. No lasting success/failure cache hides changed evidence.
- [ ] Normal registry/controller reads and mutations enter before IO, including migration-report writes and controller
      identity changes. Exact-path migration helpers still work without recursion or becoming normal-access bypasses.
- [ ] Plan/catalog locks, transition journal reads/writes/removal, transition effects, and both Work Record supersession
      lock APIs are guarded. `resource.root` and recorded journal `projectRoot` still select the owning checkout.
- [ ] Publication start, reconciliation, retry, cleanup, and direct isolated publication enter before saved-path IO.
      Project-local fallback worktree creation is guarded. Existing absolute recovery paths and Git proof rules remain.
- [ ] Secret-store operations distinguish project/global ownership and guard all project reads, writes, deletion, ignore
      setup, and fallback. Missing project files cannot bypass refusal. Global-only storage and synchronous getters keep
      their current behavior; arbitrary path-only project access no longer exists.
- [ ] Runtime guards `#prepareDeferredManagedCreation()`, non-deferred `createInteractiveSession()`, and `loadSession()`
      before durable setup. First text, first built-in command, isolated-Agent activation, resume, and headless creation
      reach these checks. Empty deferred creation stays in memory. Initial user/busy rendering still precedes slow work.
- [ ] ACP new/load preserve migration reasons and safe paths, do not create Session records after refusal, and retain
      existing authentication and genuine missing-Session handling. Init help and empty-directory no-op stay before
      entry; initialization enters before project writes or Agent execution.
- [ ] Plan list and every dispatched project subcommand enter before normal access, including exported share/pull/push/
      unshare operations. Help/version do not enter. Doctor can explain refusal without running normal repair
      operations.
- [ ] Best-effort Plan loading, listing, recovery, and secret catches propagate migration refusal rather than returning
      missing/empty data or continuing writes. Refusal preserves work and is a retryable condition, not abandonment.
- [ ] Current-store test fixtures enter normally before seeding new stores. Legacy migration/refusal fixtures seed
      literal legacy files without normal writers. Existing coverage stays active; no guard-disable option or new test
      seam exists.
- [ ] `../../../domain-language.md` defines Project Runtime Entry as the shared migration-or-verification operation
      before normal Project Runtime State access, not Session activation, path resolution, or Workspace registration.
      Its stable relationships preserve primary/selected ownership. Core PRD scenarios describe the delivered behavior,
      not release completion for children 07–08.

## Approval Confirmation

No Work Record replacement is proposed. Scope and migration policy follow the approved parent Epic and ADR-017.

## Verification Plan

Use the sandboxed runner only:

```sh
deno run -A scripts/run-tests.js src/shared/project-runtime-layout.test.ts src/shared/project-runtime-entry.integration.test.ts
deno run -A scripts/run-tests.js src/shared/session/session-runtime.test.js src/acp/server.test.js src/cmd/init/index.test.ts src/cmd/plans/index.test.ts src/cmd/plans/collaboration-commands.integration.test.ts src/ui/tui/chat-session.test.ts src/ui/tui/golden-scenarios/initial-scenarios.test.js
deno run -A scripts/run-tests.js src/shared/worktree-registry.test.ts src/shared/workflow/controller-registry.integration.test.ts src/plan-store.test.js src/shared/collaboration/secrets.test.js src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/isolated-publication.test.ts
deno task seams:check
deno task ci
```

`project-runtime-entry.integration.test.ts` is the proposed cross-store regression file. Run changed transition,
supersession, Doctor, and worktree tests through the same runner as well. Full CI must pass before child 07.

Required evidence:

- **Actual adoption:** seed an inactive legacy registry/controller and project secret in a disposable real Git checkout.
  Enter through a real Plan command and read the migrated values, not just returned paths. Inspect the marker, contents,
  permissions, and absence of old authoritative files. Repeat entry and assert byte stability. Use separate fixtures to
  prove first-message Runtime, ACP new/load, Init, and collaboration entry can proceed after eligible adoption.
- **Refused surfaces:** with a real unsupported marker or malformed legacy registry, exercise first text, first command,
  non-deferred creation, load, ACP new/load, Init, Plan list and dispatched subcommands, and exported collaboration
  operations. Assert the shared reason and safe paths reach the caller, no Agent/network mutation starts, and no Session
  record, normal runtime file, Plan, secret, or `../../../../.gitignore` changes. Existing saved transcripts remain
  unchanged. Cover both named and URL pull and default-global selection with project fallback. Test help separately from
  project work.
- **Direct-store bypass:** without a surface call, attempt normal registry inspect/read/write/lock, controller
  read/write/ identity change, Plan/catalog lock, transition read/write/removal/effects, both supersession locks,
  publication start/ reconciliation/cleanup/direct isolated publication, and project secret read/write/delete/ignore
  setup. Every attempt rejects the blocker before normal work; lock callbacks and transition effects do not run. Supply
  saved publication paths directly in at least one case. Snapshot bytes and directory entries before and after; no files
  or temp locks appear or disappear. Include populated and missing current stores so empty-store fallbacks cannot pass.
  Do not stub migration or store IO. Pure path getters and migration-only inspection are not normal store operations.
- **Retry and checkout scope:** remove the blocker in the same process and rerun the operation successfully. After a
  successful entry, add legacy state and prove a later operation detects it. Enter from primary and linked checkouts and
  adopt a later-created selected checkout; inspect actual marker membership and populated primary/selected files. A
  cached success for one checkout must not authorize another. Concurrent first entries complete without duplicate moves
  or deadlock, and existing migration interruption tests remain active.
- **No-write startup:** open a fresh empty TUI and its resume picker without submitting work. Snapshot project and
  sandbox Session directories; no `../../../../.wld/internal`, migration evidence, project identity, or transcript is
  created. Repeat with eligible legacy state and with a blocker: opening/help/version must neither migrate nor surface a
  refusal. Invoke top-level and subcommand help plus version through real dispatch. Preserve the missing-cwd creation
  and retryable first-turn failure tests, and user/busy event ordering before persistence. First submitted work does
  enter.
- **Error handling:** assert ACP migration failure differs from genuine missing-Session failure and contains safe paths.
  Plan listing must fail, not report no Plans. Transition recovery must stop rather than write an attestation after a
  blocked read. Secret refusal must retain security guidance without exposing keys or capabilities.
- **Semantic review:** walk each normal store's first IO and every refusal catch. Filesystem snapshots prove no writes,
  not absence of reads; inspect that entry precedes normal reads, existence checks, `stat`, and directory scans too.
  Audit exact-path helper callers and any operation context reuse for bypasses and lock ordering. Confirm no new normal
  legacy reads, test seams, or stale process cache. Review actual source on the execution branch, not stale symbol-index
  results.
- **Documentation:** glossary and Core PRD describe the same delivered behavior. Child 07 Git changes and child 08
  release work remain explicitly unfinished.

An entry stub fails adoption; command-only guards fail direct-store tests; unconditional refusal fails successful retry;
checking only the first Session message fails command/resume cases; returning empty data fails error assertions.

Preserve existing controller revisions and locking, registry ambiguity handling, selected-checkout journal recovery,
publication ancestry and saved repair paths, secret atomic writes/permissions/redaction/global fallback, Session
identity, authentication, resume replay, and deferred startup. Only unguarded normal access and swallowed migration
refusal stop being supported. Do not delete those behavior tests when fixture setup or secret signatures change.

Child 03 had a saved-publication-path test that deliberately bypassed migration. A fixture with unfinished legacy
publication state must now assert entry refusal. Preserve retry, ancestry, and exact saved-path cleanup coverage with
adopted current-layout fixtures. Do not weaken migration eligibility to keep a bypass fixture passing.

Manual: in disposable primary and linked checkouts, run a Plan list on eligible legacy data, repeat it, then use a
separate blocked fixture to confirm a clear refusal and unchanged files. Never run migration experiments on this real
checkout during the intermediate Epic.

## Edge Cases & Considerations

- Avoid eager migration during shell startup, help output, and version checks.
- Surface entry errors retain the engine's reason, safe paths, and security guidance. Do not invent new cleanup tasks or
  mark delivery complete/abandoned after refusal. Migration eligibility remains ADR-017 policy.
- Read-triggered registry schema updates and controller imports are writes; entry must precede them.
- Preserve missing-directory Runtime creation: enter before durable setup, but do not require the directory to exist
  earlier than current behavior permits. Help and empty Init still perform no initialization.
- Guard before operation locks and use internal helpers/context for nested work. Never recursively guard migration's
  exact-path inspection or legacy registry lock. A later independent operation must not reuse stale approval.
- Existing current-layout fixtures without a marker become deliberate conflicts. Update ordinary fixture setup, not
  migration policy. For physical-path assertions, use disposable Git fixtures and temporarily clear only runtime
  redirection under `withProcessGlobalTestLock`; restore it and retain sandboxed HOME.
- This slice must not change Session transcript authority, active workflow ownership, or global home-based stores.
