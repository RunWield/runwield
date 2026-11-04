---
planId: "07f18d9a-b269-4ab3-979b-1099c8d5d85f"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/shared/plan-package-store.ts"
    - "src/plan-front-matter.ts"
    - "src/shared/project-runtime-home.ts"
    - "src/shared/epic-artifacts.ts"
    - "src/shared/workflow/controller-state.ts"
    - "src/shared/private-json-file.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/plan-store-prd.md"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 4
dependencies:
    - "external-plan-store/establish-stable-project-identity"
    - "external-plan-store/relocate-project-runtime-into-home-storage"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "implemented"
---

# Add Canonical Plan Packages

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Later imports and workflows need a package persistence contract that keeps editable documents separate from Core
metadata. This Plan prepares that contract for review; implementation still requires the user's browser decision.

The prepared workspace includes delivered child 3 at `8ae28f1bf8b53ebdd8fc11ac59b923c9890d877d`:

- `inspectProjectIdentity` supplies stable Project, repository, checkout, and personal-owner identities.
- `homeProjectRuntimeLayout` moves ordinary runtime into home storage. Legacy controller records remain under
  `internal/legacy/<repositoryId>/<owner>/controller/plans`; legacy Plan locks remain checkout-scoped.
- `getPlansDir`, `loadPlan`, and `savePlan` still use repository Markdown and front matter. Controller preparation is
  a separate runtime operation. Runtime relocation has not imported a Plan or created a canonical package.

The target [Plan store requirements](../../prd/plan-store-prd.md#plan-store) supply **one live copy**, **plain Markdown**,
**metadata beside documents**, and **recovery from that copy**. This child proves their persistence foundation through
internal package operations, without claiming those user journeys are active. The current
[Core body ownership and passive-read requirements](../../prd/runwield-core-prd.md#plan-authoring-and-external-adoption)
must survive; [Core recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) owns automatic repair.

The Epic already assigns import to child 5, lifecycle binding to child 6, publication to child 7, surfaces to child 9,
and ordinary activation to child 10. Managed-remote persistence and milestone history remain later children. No scope
moves between siblings are needed.

## Objective

Core can create, read, edit, rename, archive, and restore a canonical home Plan package in real fixtures with independent
document and metadata ownership. It can retain consistent document inputs for later lifecycle consumers. These operations
survive competing processes and interrupted writes without duplicating a live Plan or losing committed data.

This is a preparatory capability; public default Plan discovery is activated only after import, lifecycle, publication,
and Work Records are ready.

## Approach

Put package identity, name, lifecycle/controller facts, and relationships in versioned `plan.wld.json`; keep generated
Markdown documents front-matter-free. An editor's later Markdown, including YAML-looking text, is opaque content and
cannot assign metadata. IDs own relationships and references; names locate packages.

Use a cohesive TypeScript owner, proposed as `src/shared/plan-package-store.ts`, exposed through `src/plan-store.js` for
explicit package operations. It owns path containment, schema validation, revision checks, locking, and recovery. Callers
provide an established Project identity and Plan identity; they do not reconstruct home paths or choose lock scope.

```text
established ordinary Project identity + Plan ID
  -> package store
     -> ~/.wld/projects/<projectId>/plans/<name>/
        plan.wld.json       Core metadata and metadata revision
        context.md          editable Plan body
        validation.md       editable validation instructions
        manual-qa.md        optional manual QA
     -> Project internal storage: package locks, recovery intent, retained inputs
```

Package locks belong to the personal Project store, independent of repository/checkout identity and mutable Plan names.
Reuse `openNativeFileLock`; do not reuse legacy `withPlanLock` unchanged because it locks by checkout and name. Catalog
operations acquire the Project catalog lock before any Plan locks; multi-Plan locks use stable ID ordering. No repository
execution lock or remote call is needed for these operations. Legacy writers keep child 3's existing isolation.

Document edits compare the selected document's byte hash. Metadata edits compare its own revision and update only
`plan.wld.json`. Core-controlled multi-file creation, rename, and snapshot publication use durable staging and recoverable
intent. Reads report incomplete operations; deliberate package mutations/recovery settle them without user bookkeeping.
Do not introduce callbacks that replace Core-owned persistence for tests.

Capture copies every required document, its hash, optional-document presence, Plan identity, and metadata revision into
an immutable input. Recheck source bytes and the document set before publishing it; a detected edit or missing required
file produces no usable handle and requires a fresh capture. Commit the complete input before returning or storing a
reference. This child supplies durable capture; child 6 decides when approval/execution may bind it, and child 7 seals
publication inputs. No approval, execution, delivery, or milestone transition is added here.

**Reviewable implementation assumptions:** use an explicit version-1 schema with named fields, and keep ID lookup inside
the store rather than adding an authoritative database/catalog. If a lookup index is needed, make it rebuildable from
packages; loss or staleness cannot select another Plan. Preserve existing metadata field meanings using
`WorkflowControllerState` and the front-matter inventory; do not copy derived worktree/publication state into authority.

The existing store facade remains the caller entry point. Internal package operations are directly exercised by fixtures
and available to later children; ordinary callers keep their admitted legacy path. There is no automatic fallback,
shadow write, import, feature setting, or second writable representation of the same admitted Plan. Rewriting all legacy
callers now would pull lifecycle and activation into this child and expand its verification beyond persistence.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store.js` and proposed `src/shared/plan-package-store.ts` — explicit package operations with one persistence
  owner; preserve legacy exports and semantics.
- `src/plan-front-matter.ts` and `src/shared/workflow/controller-state.ts` — reuse field meanings and types while keeping
  legacy parsing and projected execution facts outside package document authority. Actual import/routing waits.
- `src/shared/project-runtime-home.ts` and the identity/layout boundary — reuse established Project/personal-owner
  evidence and centralize package paths without changing child 3's legacy runtime mapping.
- `src/shared/epic-artifacts.ts` — share reserved-resource rules and support package-owned artifact paths without
  switching existing Epic workflows. Keep `integration-report.md` a non-Plan resource as well as `manual-qa.md`.
- `src/shared/private-json-file.ts`, `src/shared/native-file-lock.ts`, and package recovery internals — reuse durable
  replacement and real locks; change shared primitives only if the package invariants require it.
- New package behavior, concurrency, recovery, and snapshot tests; `scripts/bun-test-files.json` — register concrete
  isolated-runner coverage in the normal inventory.
- `docs/prd/runwield-core-prd.md`, `docs/prd/plan-store-prd.md`, and
  `docs/adr/0020-home-project-state-and-launch-mode-ownership.md` — explain the preparatory contract and remaining target
  scope. Update affected references without promoting the broader proposed ADR or unfinished journeys to current.

No UI redesign, public command activation, managed-remote transport, Work Record relocation, or Plan glossary replacement
belongs here. The activation child still owns the public meaning of Plan and Plan Metadata.

## Reuse Opportunities

- Reuse `getPlanRevisionForText`/hashing and `StalePlanWriteError` semantics from `src/plan-store.js`; a package document
  hash covers all bytes, without interpreting front matter.
- Reuse `writeTextAtomically`, `writeJsonAtomically`, and `syncParentDirectory` for complete durable files. These do not
  themselves make several files one transaction; the package owner supplies that ordering.
- Reuse `openNativeFileLock`, established identity inspection, and the subprocess/real-filesystem fixture patterns in
  `src/shared/testing/project-runtime-home-process-driver.ts`.
- Reuse reserved Epic artifact rules and existing Plan ID validation. Keep body ownership, lifecycle transition policy,
  and controller field ownership with their established owners.

## Implementation Steps

1. `src/plan-store.js` exposes package create/read/list/edit/metadata-update/rename/archive/restore/capture operations
   backed by one TypeScript owner. Creation durably publishes `context.md`, `validation.md`, optional `manual-qa.md`, and
   versioned `plan.wld.json`; IDs and names are unique within the personal Project store. Two processes creating the same
   ID or name cannot publish two packages. Existing unimported Plans remain exclusively legacy-owned.
2. Package metadata has a validated schema, stable Plan ID, normalized name, independent metadata revision, ID-based
   parent/dependencies, archive facts, and supported Plan/controller fields. It holds references to external execution
   facts rather than a second mutable registry. Generated Markdown contains no Core front matter. Reading or editing
   Markdown cannot change identity, relationships, status, or controller state.
3. Document saves reject a stale expected document hash and leave newer bytes intact. Metadata mutations reject a stale
   metadata revision and preserve every document byte, including concurrent editor changes. A successful metadata edit
   does not stale an otherwise current document save; a body edit does not stale an otherwise current metadata mutation.
   Package locks serialize Core writers across worktrees and linked clones without depending on their cwd.
4. Rename updates location/name while keeping Plan ID, relationships, Session/reference IDs, and archive facts stable.
   Child and dependency lookup uses IDs rather than directory ancestry. Archive/restore only changes metadata and
   visibility; neither makes another live copy nor archives children implicitly. Duplicate destinations fail without
   overwrite. Interrupted create/rename operations recover to one authoritative package on a deliberate operation;
   passive inspection does not repair or serve an unresolved old/new ambiguity as success.
5. Strict package reads distinguish loaded, missing, malformed/unsupported metadata, missing required document, unsafe
   path, and pending recovery without changing lifecycle status. One damaged package does not hide healthy ones. Passive
   list/read/capture-preflight inspection creates no identities, directories, locks, repairs, or repository artifacts.
   Optional `manual-qa.md` may be absent; reserved document/artifact names never appear as executable Plans.
6. Snapshot capture retains exact required bytes, document membership, hashes, identity, and metadata revision. Changes
   detected during capture discard/retry the candidate; missing input never becomes an empty substituted document.
   Returned/stored references resolve only to complete durable inputs after process restart. A later live edit cannot
   mutate retained bytes. Interrupted staging is invisible to normal reads and recoverable; capture assigns no lifecycle
   status or approval. Epic artifacts use explicit resource roles, including any captured integration report.
7. Real fixture callers through the store facade prove the package contract and the legacy boundary. Public
   `getPlansDir`/`loadPlan`/`savePlan`, default listings, controller routing, and Epic workflows keep their existing
   admitted behavior. No checkout copy or `.wld/plans` alias is created by package operations; explicit managed-remote
   identity cannot silently select the execution account's store.
8. The owning Core authoring/recovery requirements and scenarios describe only the delivered preparatory capability.
   The transient Plan Store proposal and ADR-0020 retain import, lifecycle, public activation, remote ownership,
   publication, history, and retention as targets. Existing glossary definitions remain true for public behavior.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Proposed new test files, implemented by this child and
added to `scripts/bun-test-files.json`:

```sh
bun scripts/run-tests.js src/plan-package-store.test.ts src/plan-package-concurrency.test.ts src/plan-package-recovery.test.ts src/plan-package-snapshots.test.ts
```

Existing regressions to preserve:

```sh
bun scripts/run-tests.js src/plan-store.test.js src/plan-store-locks.test.ts src/plan-store-passive-reads.test.ts src/shared/epic-artifacts.test.ts src/shared/project-runtime-home.integration.test.ts
```

Use `defineGitFixture` and `makeValidationProjectRoot` where Git/legacy Plans are involved, disposable homes, and
`withProcessGlobalTestLock` whenever a test changes HOME or cwd. Resolve them with `getHomeDir()`/`getCwd()`. Tests must
call the real store and native locks. A subprocess driver can coordinate actual filesystem operations or terminate at
filesystem boundaries; do not add production pause hooks, injected Plan writers, or lifecycle fakes.

- **Package behavior (`plan-package-store.test.ts`)** — create a Plan and Epic/children through the facade; inspect exact
  files and metadata; reopen from a new process. Edit the top of `context.md`, including YAML-looking text, and verify
  unchanged identity/status/controller facts. Metadata updates preserve byte-identical Markdown. Rename the Epic,
  resolve each child and dependency by ID, archive/restore it, and verify children and non-Plan artifacts remain
  independently addressable. Test name/ID collisions, unsupported schema, malformed metadata, missing `validation.md`,
  absent optional QA, traversal, and symlink escape without overwrite or effects outside the store.
- **Real races (`plan-package-concurrency.test.ts`)** — synchronize two processes after both read the same metadata
  revision, then release their updates: exactly one wins and the other receives a stale-write result. Repeat for one
  document hash. Race a metadata update with a document save: both succeed and both changes survive. Race creation by
  equal name and by equal ID/different names. Run from two worktrees and a deliberately linked clone to demonstrate a
  common package lock; hold that lock in a process, verify another waits, kill the holder, and verify progress without
  stealing a still-held native lock. Distinct personal stores remain independent.
- **Crash recovery (`plan-package-recovery.test.ts`)** — terminate a writer after package files are staged but before
  publication, after durable rename intent, after the directory move but before name/reference reconciliation, and after
  committed metadata replacement but before acknowledgement. A fresh passive read reports only complete or explicit
  pending results and changes no bytes. A fresh deliberate operation recovers, then a second retry changes nothing:
  exactly one ID/name mapping, no lost committed documents, no duplicate live directory, and no leftover intent that
  can revert newer metadata. Failed creation exposes no partial successful package.
- **Retained inputs (`plan-package-snapshots.test.ts`)** — coordinate an ordinary filesystem editor between source reads
  and final capture validation. Change each required document, remove one, and add/remove optional QA in separate cases;
  no handle may describe mixed observed inputs. Terminate after staging and after durable snapshot publication but before
  reference acknowledgement. Restart and verify every visible reference resolves to all bytes with matching hashes;
  unreferenced staging is never a usable input. After successful capture, edit live documents and prove retained content
  is unchanged. Repeat with an Epic integration report to verify its resource role.
- **Passive and admission boundaries** — compare filesystem trees and Git status before/after package inspection in a
  fresh/missing store and a store with one corrupt package. Reads create no home runtime or checkout files and healthy
  entries remain visible. Ordinary legacy listing/loading/saving still uses its existing Plan; a package write does not
  mirror it into `docs/plans/` or join legacy controller state. Explicit managed-remote context cannot write locally.
- **Counterfeit check** — an implementation that merely strips YAML or delegates to `savePlan` fails the exact-file,
  metadata-byte-preservation, cross-checkout race, and restart assertions. Returning a hash without durable captured
  bytes fails the snapshot restart and live-edit assertions. Existing regressions alone cannot satisfy this Plan.
- **Manual** — in a disposable ordinary Project fixture, create a package using its internal operation, open
  `context.md` in an ordinary editor, change prose, then advance metadata through the store. Reopen it from another
  checkout and inspect both independent results. This proves persistence; it does not claim a public browser workflow.
- **Preserve** — Plan ID integrity, body ownership, legacy archive/recovery behavior, reserved artifacts, optimistic
  conflicts, native lock lifetime, passive-read isolation, and child 3's ordinary runtime relocation.
- **Retire** — no public legacy reader or lifecycle contract yet. Package operations never interpret Markdown as
  lifecycle metadata. Verify PRD/ADR references and glossary scope against that exact boundary.

## Edge Cases & Considerations

- Filesystem locks cannot stop an ordinary editor. Revalidate observed source bytes and membership before capture
  commits; do not claim arbitrary multi-file editor writes form an atomic transaction. Later lifecycle consumers must
  recheck current content before acting on a captured revision.
- New file format versions need explicit rejection or migration, never permissive interpretation. Passive reads do
  neither. An unsupported version or inaccessible home is not an invitation to fall back to repository Plans.
- Durable file replacement is not a multi-file transaction. Keep staging and rename on the same store filesystem and
  make interrupted publication/reconciliation recoverable. Windows replacement and native-lock behavior must retain
  existing portable contracts.
- Names may change and may contain existing supported relative segments; hierarchy is always metadata. Reserved names,
  symlinks, and duplicate IDs cannot redirect a package operation or overwrite another Plan.
- Node's [filesystem documentation](https://nodejs.org/api/fs.html) cautions that concurrent modifications need explicit
  coordination. Bun's [test documentation](https://bun.sh/docs/test) describes runner/preload support; repository policy
  still requires the isolated wrapper above. These references support the chosen primitives, not crash-safety proof.
- Review of this child does not start child 5 or authorize an Epic merge into main. Any later implementation of this
  child lands only in the existing `epic/external-plan-store` workflow after its review decision.
