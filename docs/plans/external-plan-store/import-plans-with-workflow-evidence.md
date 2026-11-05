---
planId: "6352d5e5-174f-4db4-8afa-bf8cd64818be"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.js"
    - "src/shared/plan-package-store.ts"
    - "src/shared/plan-package-import.ts"
    - "src/plan-front-matter.ts"
    - "src/shared/workflow/plan-location.ts"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/worktree-registry.js"
    - "src/plan-package-import.test.ts"
    - "src/plan-package-import-recovery.test.ts"
    - "src/plan-package-import-evidence.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/plan-store-prd.md"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 5
dependencies:
    - "external-plan-store/relocate-project-runtime-into-home-storage"
    - "external-plan-store/add-canonical-plan-packages"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "in_progress"
---

# Import Plans with Workflow Evidence

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Copying an old primary Markdown file can overwrite a newer execution-worktree Plan. Explicit import must join document
content with the current controller and execution evidence.

Delivered child 4 supplies `createPlanPackage`, strict version-1 metadata, ID-based relationships, independent document
hashes and metadata revisions, native store locks, and recoverable single-package publication. It does not supply import,
batch visibility, source provenance, or a complete legacy-field mapping. In particular, `CreatePlanPackage` assigns a new
creation time and no archive state; the schema has no Tickets, Sequence type, import provenance, or publication receipt.
The importer must extend that contract deliberately rather than drop fields or loop over ordinary creation calls.

Child 3 relocated ordinary runtime. Controller records, validation checkpoints and worktree/publication records remain
the legacy continuation authorities. `resolveWorkflowPlanLocation`, `inspectControllerView` and strict document reads
already distinguish active execution, registered planning documents and locally available target-branch snapshots.
Normal `loadPlan` and `savePlan` still use repository Markdown.

The target [Plan import](../../prd/plan-store-prd.md#plan-import) requirements supply identity/status/relationship
preservation, unchanged originals, plain-Markdown drafts and repeat safety. This child adds their internal import
capability to [Core authoring](../../prd/runwield-core-prd.md#plan-authoring-and-external-adoption), with recovery governed
by [Core execution and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). Public import,
path-loading, store-only discovery and the delivery-copy question remain target behavior.

Child 6 owns package lifecycle/controller routing, child 7 owns new-format publication, and child 10 owns public local
activation. This child neither changes those boundaries nor edits their Plans. The proposed broader
[home-state ADR](../../adr/0020-home-project-state-and-launch-mode-ownership.md) remains proposed.

## Objective

An explicit internal import can commit a file or folder as complete packages, preserving existing Plan identity,
relationships, source prose and continuation evidence. A restarted operation returns the same result, and every package
read sees a whole committed batch or a pending result. Existing packages and original files cannot be overwritten by a
repeat import. Public `wld plans import` and path-loading activation remain with the local cutover child.

## Approach

Expose a typed internal import operation through `src/plan-store.js`, with legacy inventory and translation in proposed
`src/shared/plan-package-import.ts`. Keep package persistence, uniqueness, locking and recovery in
`src/shared/plan-package-store.ts`; the adapter must not become a second store or lifecycle engine.

```text
explicit file/folder + established ordinary Project identity
  -> inventory selected sources and resolve existing document/runtime authority
  -> retain source bytes, evidence revisions and one name-to-ID relationship map
  -> stage complete packages under the existing store owner
  -> durable batch intent -> publish all members -> one committed batch result
```

Resolve all parent/dependency names before publication, including archived members and existing imported IDs. A file
selection imports that file; a folder selection recursively inventories its Markdown and recognized Epic artifacts.
Relationships outside that selection must resolve to existing packages or produce an actionable diagnostic. Authority
lookup may read the selected Plan's registered worktree or target snapshot; it is not permission to import unrelated
repository files.

Retain an immutable import record under Project internal storage: source identity/path and digest, original bytes,
chosen authority, allocated IDs, relationship mapping, and exact evidence references. For repository sources, record
repository binding plus repository-relative path; for external files, use a normalized source locator. Persist ID-less
allocations before package publication. Retries consult that record, not a newly generated UUID or source mtime.

Extend the store's existing intent and read protocol to cover a batch. Stage on the destination filesystem and hold the
catalog lock before ordered Plan-ID locks. A durable commit boundary gates all members for both name and ID lookup.
Passive catalog scans must detect a batch that starts **and finishes during the scan**, then retry or report pending;
checking only whether an intent exists at the start/end can expose a partial family. Unrelated healthy packages remain
readable. Read retries are bounded rereads, with no locks, writes or repair; continued changes return pending evidence.
Deliberate recovery completes the recorded transaction; passive reads never repair it.

Capture controller and execution evidence without transferring their mutable ownership in this child. Store supported
Plan-owned fields plus typed, resolvable references to retained controller/checkpoint and repository attempt evidence.
Revalidate document hashes, controller revisions, registry/attempt identity and source membership before commitment.
Changed or uncertain evidence produces a retry/pending result, never a stale-primary fallback. Existing legacy workflows
continue through their current owners; child 6/activation must recheck the retained binding before admitting execution.

The selected public behavior remains explicit import, not an automatic repository scan disguised as migration.
Repeated single-package creation was rejected because a crash between children would publish a partial family.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/plan-store.js`, proposed `src/shared/plan-package-import.ts` — explicit import facade, source inventory, field
  translation and result/diagnostic contract; preserve all existing legacy exports.
- `src/shared/plan-package-store.ts` — schema extensions, preserved creation/archive facts, batch intent, publication,
  provenance and read/recovery coherence through the same persistence owner.
- `src/plan-front-matter.ts`, `src/shared/front-matter.ts`, `src/shared/epic-artifacts.ts` — reuse field and resource
  inventories; preserve exact body bytes and distinguish Epic resources from executable Plans.
- `src/shared/workflow/plan-location.ts`, `controller-registry.ts` and `src/shared/worktree-registry.js` — bounded
  authority/evidence inspection and revalidation; no general lifecycle rerouting or registry relocation.
- Proposed `src/plan-package-import.test.ts`, `src/plan-package-import-recovery.test.ts` and
  `src/plan-package-import-evidence.test.ts`, plus `src/shared/testing/plan-package-process-driver.ts` and its fixture —
  behavioral import, restart, concurrent-reader and evidence tests through real boundaries.
- `docs/prd/runwield-core-prd.md`, `docs/prd/plan-store-prd.md` and
  `docs/adr/0020-home-project-state-and-launch-mode-ownership.md` — record the internal import guarantee and schema/
  transaction rationale while retaining deferred public behavior and the ADR's proposed broader decision.

CLI, browser surfaces, Agent prompts, managed-remote transport, Work Record import, public glossary changes and delivery
copy settings stay with their assigned children. No new public domain term is introduced here.

## Reuse Opportunities

- `parsePlanFrontMatter` and `inspectPlanFileStrict` provide current normalization and diagnostics. Inspect raw YAML as
  well: normalization strips some historical fields and cannot alone prove lossless import.
- `resolveWorkflowPlanLocation`, `inspectControllerView` and `readControllerRecord` supply authority and persisted
  evidence. Do not use Session/UI projections or newest-file timestamps to choose a winner.
- Package path/schema checks, `openNativeFileLock`, atomic private writes and existing recovery own publication. Extend
  these mechanisms for batches instead of nesting public package mutations while holding their locks.
- `defineGitFixture`, package fixtures and subprocess syscall-boundary fault injection provide real repositories,
  stores and interruption tests without seams for Core-owned Plan writes, locks or lifecycle.

## Implementation Steps

1. The import facade accepts an established ordinary Project identity and an explicit file/folder selection. Its typed
   result distinguishes committed imports, existing identities, changed-source/name conflicts and unavailable or pending
   evidence. Inventory is deterministic, rejects unsafe paths and identity collisions, and never mutates source files,
   invokes public adoption, fetches target refs or silently treats malformed Plan metadata as plain Markdown.
2. A checked legacy-to-package mapping preserves ID, age, classification/Sequence type, canonical status, order, target
   and delivery intent, Tickets, supersedes/deviations, closure/hold facts and archive/restore facts. Parent and dependency
   references become IDs; archived storage prefixes do not become new identities or parent names. Extend the strict
   named schema explicitly for missing supported facts and test existing version-1 packages remain readable;
   unsupported versions still fail. Every legacy field is mapped, retained as
   non-authoritative provenance, or reported before commitment. Retired objective-check fields remain inert provenance,
   never reactivated. Mutable worktree/publication state remains with its current owner.
3. `context.md` contains the exact post-front-matter body; plain Markdown, including generic non-RunWield YAML, keeps
   its complete bytes and becomes an external draft. Source bytes are retained independently of normalized fields.
   Required `validation.md` points to verification instructions in `context.md`, without moving or duplicating prose.
   Recognized `manual-qa.md` and `integration-report.md` belong to their Epic package and never receive Plan IDs.
4. Durable import provenance maps each ID-less source to one allocated ID across process restarts and overlapping
   file/folder selections. Same-ID repeats return the existing package without rewriting documents, metadata or workflow
   evidence, including after a package rename or edit. A changed ID-less source at the same locator reports a conflict;
   a different source locator remains a separate draft. Proven primary/worktree copies resolve through recorded
   authority; unrelated conflicting duplicate IDs fail the batch rather than use timestamp precedence. Name collisions
   and unresolved or ambiguous relationships prevent publication of the selected batch; no arbitrary suffix or dropped
   edge hides them.
5. The store publishes all newly imported members through one recoverable batch transaction. Preexisting packages remain
   untouched. ID/name reads and catalog scans never return a partially committed family. Recovery after staging, ID
   reservation, partial movement, commit or lost acknowledgement completes the same result without new IDs; a second
   retry is a no-op and cannot roll back newer package edits. Source deletion after commitment does not prevent reading
   packages, resolving provenance or recovering a committed operation.
6. For every unfinished local Plan, bounded authority selection uses the registered planning/execution document or
   locally available published target snapshot, plus persisted controller and repository evidence. Preserve checkpoint
   attempt/generation, pending repair/review/Recorder continuation, Session references where recorded, recording source,
   receipts and worktree/publication bindings as supported facts or typed retained references. A reference must resolve
   after restart; a bare checkpoint ID is insufficient because current checkpoints are embedded in controller records.
   Evidence races invalidate capture before commitment. Missing/foreign documents, unreadable registries, mismatched
   IDs and competing active attempts remain explicit recovery results; none selects a stale primary copy.
7. Import never reseals, advances, abandons or cleans an existing publication attempt. Its exact candidate commits,
   phase/revision, target, repository binding, paths and repair content survive unchanged. Retained legacy-format
   evidence remains distinguishable from future package publication inputs. Current controller/registry records are
   not deleted or converted into a second mutable authority; import makes no completion claim from a status alone.
8. Import records repository-relative source paths for later best-effort pruning, but performs no pruning or delivery
   copies work. Core authoring/recovery requirements and acceptance scenarios describe the internal capability delivered
   here. The proposal and ADR references preserve pending lifecycle admission, public import/empty lists, the delivery
   copy question and managed-remote behavior. Existing public discovery/adoption and legacy settlement remain intact.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Add the three proposed import test files below and run them
through the isolated runner; these are implementation deliverables, not claims of existing passing tests:

```sh
bun scripts/run-tests.js src/plan-package-import.test.ts src/plan-package-import-recovery.test.ts src/plan-package-import-evidence.test.ts
bun scripts/run-tests.js src/plan-package-store.test.ts src/plan-package-concurrency.test.ts src/plan-package-recovery.test.ts src/plan-package-snapshots.test.ts src/plan-store.test.js src/shared/workflow/plan-location.integration.test.ts src/shared/workflow/controller-registry.integration.test.ts
```

Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules. Extend the existing subprocess driver at external
filesystem boundaries; do not add production pause callbacks. Register new tests in explicit runner inventories when
required by `scripts/bun-test-files.json`.

- **Source and metadata (`plan-package-import.test.ts`)** — import an Epic and Sequence with ordered children, a
  dependency by short name and full name, archived/restored members, Tickets, closure/deviation facts and both Epic
  resources. Compare exact source trees before/after, exact context bytes, metadata values and all ID relationships
  after reopening in a new process. Include CRLF, BOM, Unicode, YAML-looking body text, plain Markdown and generic YAML.
  Inspect required validation content and retained unmapped metadata; malformed/unsupported input cannot silently lose
  data or publish another member. Existing schema fixtures remain readable.
- **Identity and conflicts (same file)** — import an ID-less file, retry from a fresh process, then include it in a
  folder import: one ID. Edit/rename the live package and retry: no revision or document change. Change the original:
  explicit conflict, no overwrite. Copy its bytes to a distinct source: a new draft. Exercise same-ID aliases,
  conflicting duplicate IDs, names/case collisions, traversal, symlink escapes and missing/ambiguous relationship
  targets. For every refused batch assert no newly visible package, unchanged preexisting packages and unchanged sources.
- **Restart and visibility (`plan-package-import-recovery.test.ts`)** — terminate a writer after durable ID allocation,
  staged packages, batch intent, one member's move, all moves before commit, and commit before acknowledgement. From a
  fresh process list and read every member by ID and name: all committed or pending, never a successful subset. Compare
  trees around passive reads to prove no repair. Resume, then retry again: one package per ID, complete relationships,
  unchanged originals and no replay over a newer package edit. Repeat after removing sources once committed.
- **Reader/writer races (same file)** — coordinate a reader so an entire import commits between its first and last
  directory reads; it must not return a partial family. Run overlapping imports from two worktrees and deliberately
  linked clones, plus import against ordinary create/rename of a colliding name/ID. Exactly one allocation/publication
  wins, losers return existing/conflict results, and unrelated packages remain readable while a batch is pending.
- **Authority and continuation (`plan-package-import-evidence.test.ts`)** — build real registered planning and active
  execution worktrees with stale primary copies, target-only children, archived children and relocated controller
  records. Import and restart: chosen prose/status, attempt IDs, checkpoint generation/open issues, pending repair and
  Recorder facts, Session references and receipts match persisted authority. Change document/controller/registry
  evidence during capture and require retry with no stale committed snapshot. Missing or foreign registered worktrees,
  corrupted registry and duplicate live attempts cannot fall back to primary. Restore valid evidence through existing
  owners and retry successfully without manual package bookkeeping.
- **Sealed evidence (same file)** — seed a real sealed legacy publication with exact Git candidate and repair bytes;
  repeat with published/cleanup evidence and a mismatched receipt. Import/retry leaves registry and Git refs byte-for-byte
  unchanged, retains resolvable typed evidence, and neither promotes status nor reclassifies its attempt. Exercise the
  existing receipt/checkpoint applicability rules on the recovered facts; stale proof cannot authorize another target
  or attempt. This verifies preservation, not new-format lifecycle/publication, which later children own.
- **Admission boundaries (same files)** — ordinary list/load/save behavior stays legacy; passive reads initialize no
  import, identity or runtime. Explicit managed-remote owner input refuses local package persistence. No import creates
  `.wld/internal/`, a Plan symlink, checkout package copies, a public command or a delivery-copy preference.
- **Counterfeit check** — stripping YAML and calling `createPlanPackage` in a loop fails the age/archive/metadata,
  partial-family and restart assertions. Returning IDs without durable provenance fails overlapping-selection retries.
  Copying primary files or projected controller fields fails the active-worktree and continuation assertions.
- **Manual** — use the internal import operation in a disposable fixture containing a mixed family and an unfinished
  execution. Interrupt at a recorded filesystem boundary, reopen from another process and inspect its result and
  ID/hierarchy/evidence mapping. Remove committed source files and reopen each package. Do not present this as a public
  CLI/browser journey.
- **Preserve** — current lifecycle/publication proof, source body ownership, Tickets, archive identity, native lock
  lifetime, optimistic package conflicts and passive-read isolation. **Retire** — no public legacy contract in this
  child. Review changed PRD/ADR passages against these boundaries; later Epic outcomes remain target.

## Edge Cases & Considerations

- **Reviewable assumption:** initialize `validation.md` with a short instruction to use the verification guidance in
  `context.md`. The entire legacy body remains there; arbitrary Markdown needs no heading extraction or invented tests.
- A copied ID-less file at another locator is a new draft; changed bytes at the recorded locator need an explicit
  content decision. This child reports that conflict and does not add an overwrite/prompt policy or public option.
- Imported packages are available to explicit internal operations. Continuing legacy writes after import can make the
  recorded evidence stale; later lifecycle admission must revalidate/quiesce those writers, not silently mirror them.
- Unknown fields and historical proof require retained source/evidence bytes, not permissive live metadata. A damaged
  journal or unresolved authority preserves evidence and reports recoverable unavailability rather than choosing a
  newest-looking source or dropping one family member.
- Filesystem moves are not a multi-file transaction. Node's [filesystem documentation](https://nodejs.org/api/fs.html)
  requires coordination for concurrent modifications; durable batch visibility is Core's responsibility. Bun's
  [test documentation](https://bun.sh/docs/test) supports preload/subprocess testing; repository policy still requires
  the isolated wrapper and pinned Bun version above.
- This Plan is for review before implementation. Subsequent delivery targets `epic/external-plan-store`; it does not
  start child 6 or authorize merging the Epic into `main`.
