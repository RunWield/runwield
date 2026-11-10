---
planId: "c6973854-fcb6-4195-bdbb-ec8daa073b79"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/work-records/store.ts"
    - "src/shared/work-records/index-adapter.ts"
    - "src/shared/work-records/auto-generation.ts"
    - "src/shared/work-records/generation.js"
    - "src/shared/work-records/published-source.ts"
    - "src/shared/work-records/supersession.ts"
    - "src/shared/workflow/package-publication.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/plan-package-store.ts"
    - "src/cmd/wr/index.ts"
    - "src/shared/settings.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/plan-store-prd.md"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 8
dependencies:
    - "external-plan-store/publish-from-retained-plan-inputs"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
validatedCommit: "fc51064e129d41152488150c6723ceb6e79c3fce"
status: "verified"
---

# Move Work Records with Delivery Copies

## Context

This Plan implements child 8 of the [External Project State and Plan Store Epic](../external-plan-store.md).
Work Records currently use checkout-relative files and basename-derived index collections. Moving canonical records
without their delivery copies would remove the project's default shared delivery memory.

The delivered publication child supplies `sealPackagePublication`, `preparePackageCopies`, matching delivery receipts
and retained Recorder source. Its assembler accepts prepared Work Record bytes, but package validation skips automatic
recording and package cleanup skips record approval/index settlement. `store.ts` still uses `docs/work-records`,
`getWorkRecordIndexCollectionName` still uses a folder basename, and `runWorkRecordsCommand` has no import action.
Runtime index files already have a home location; that alone does not move the canonical records or stabilize lookup.

Owning requirements: [Work Record store](../../prd/plan-store-prd.md#work-record-store),
[Delivery copies](../../prd/plan-store-prd.md#repository-footprint-and-delivery-copies), and
[Work records](../../prd/runwield-core-prd.md#work-records). This child adds the internal home-record/import contract,
default Work Record copies, independent copy policy and stable retrieval. Preserve truthful completion confidence,
recoverable best-effort recording, current-record filtering and explicit supersession. Public activation, surface work,
managed-remote transport and retention remain with their existing siblings; no sibling scope moves.

## Objective

Canonical Work Records, explicit import and retrieval work on the admitted-package path in the personal Project store,
and the same change supplies default-on repository delivery copies. Both copy settings work together without creating
a second authority. Command adapters remain preparatory until the local activation child enables the complete public
workflow. Deliver only this child into `epic/external-plan-store`.

## Approach

Retain the existing Work Record schema and eligibility semantics while changing its store owner. Resolve record paths,
copy/import metadata and native record locks once at the shared store boundary. All generation, retrieval and
supersession callers use that owner; they must not reconstruct `docs/work-records` paths themselves.

```text
explicit internal Project/package admission
  personal Project/work-records/<record>.md       canonical content and existing front matter
  personal Project/internal/                    record locks, copy/import metadata, derived index
  publication retained input                    exact source, prepared record, policy and destinations
    one final copies commit                     enabled Plan and Work Record Markdown only
    confirmed target proof                      approve canonical record, apply supersession, index
```

### One owner and explicit import

Use the stable `ProjectIdentity` and existing personal-store layout. Reuse `withPackageWorkflow` admission for delivery
and an explicit owner-bound internal record operation for Project-level import/read/index adapters; importing records
must not require a dummy Plan. Merely finding a Project identity, home directory or package does not switch ordinary
public commands. Unfinished imported legacy attempts retain their existing legacy owner.

Store canonical files under the owner's `~/.wld/projects/<projectId>/work-records/`. A missing/unavailable admitted
store never falls back to repository copies. Passive lookup does not initialize identity, import documents or repair
runtime ownership. Keep the derived-index bootstrap behavior, limited to canonical files in the selected store.

The internal `wld wr import <path>` adapter accepts an explicit Markdown file or directory. Validate through the
existing parser, preserve original and imported Markdown bytes, IDs, links, confidence and status, and retain source
path/digest evidence separately from the record text. Draft and pending imports remain draft and pending; import is
neither human approval nor publication proof. Reject malformed or conflicting same-ID content without overwriting live
records. Identical repeat imports resume without duplicates, including after canonical persistence but before index
or metadata settlement. Different IDs sharing a filename use the existing collision-safe naming convention.

Record copy/import locations in Core-owned metadata keyed by stable record ID: selected personal owner, Project,
repository binding, repository-relative path when applicable, and source/copy digest. Keep arbitrary external import
paths as provenance, never as future repository-delete authority. This metadata belongs to the record store, survives
loss of the derived index, and does not change the existing public Markdown schema. Actual pruning remains child 15.

### Prepare once, publish once, settle from proof

Extend the existing package publication path; do not introduce a second publisher. Split source capture from final
copy assembly only as needed to let Recorder consume retained documents/metadata/family inputs before sealing its
output. Persist accepted Recorder sections and record identity before the final immutable manifest references them.
Ordinary and Attached recording use the same generation/persistence rules. Resume the same prepared record after
interruption rather than calling Recorder again or reading newer live Plans.
Retain source, policy and destinations before the Recorder turn; a resumed turn cannot silently consume newer inputs.
Keep existing version-1 package/publication references readable and interpret old manifests with their original
policy; absence of newly added fields must not retroactively enable copies on an already sealed attempt.

Resolve effective copy policy from the executing repository binding using the existing settings precedence. Proposed
internal keys are `plans.deliveryCopies` (default false) and `workRecords.deliveryCopies` (default true); they are
independent of `workRecords.autoGenerateOnPlanCompletion`. Freeze both values and the intended paths with the attempt.
Do not expose these settings as an activated public home-store workflow in this child.

For an eligible source, automatic generation writes a canonical `pending_verification` record and supplies its exact
Markdown to `preparePackageCopies` when Work Record copies are enabled. The existing assembler produces zero or one
artifacts-only commit containing enabled resources, never `plan.wld.json`, private record metadata or index files.
No eligible record, disabled generation or failed Recorder means no fabricated copy. Preserve the existing behavior
that recording failure is reported separately and does not block code publication.

> [!NOTE]
> **Copies preserve preparation-time confidence**
>
> A pre-publication record copy remains the frozen pending representation. Confirmed delivery approves the canonical
> record without changing its body or adding a second repository finalization commit. Importing that copy alone cannot
> claim verified delivery. The Epic requires truthful provisional evidence and a single copies commit.

After fresh matching publication proof, settle canonical approval, record backlinks, copy locations and declared
supersession through their existing owners. Only then make the record eligible for ordinary retrieval. Retain enough
attempt/record evidence to resume interrupted settlement from a fresh process after execution cleanup; missing registry
entries, snapshot presence or copied Markdown cannot authorize approval. Idempotent settlement must preserve later
archive/supersession decisions, editor changes and a reopened Plan's newer execution state.

Recorder or index failure keeps the retained source and a retryable outcome without revoking confirmed delivery.
Post-delivery retry uses `loadPublishedWorkRecordSource` and produces/reuses the canonical record; it never republishes
code or appends a late copies commit. A failed Recorder therefore leaves an explicit missing-copy outcome for that
delivery. Index rebuild can repair retrieval independently. Non-Git completion retains its explicit in-place evidence
and canonical recording, without inventing a Git commit or repository publication.

Preserve top-level and Epic eligibility: an intermediate child does not produce a standalone Work Record. A terminal
Epic records its retained relevant children and deduplicated Tickets, with delivered-child identity distinct from the
recording owner. User verification and closure keep their existing confidence notices.

### Stable derived lookup

Bind the admitted index collection and database to stable Project/personal-owner identity, and hydrate candidates by
`recordId` from canonical files. Accepted linked clones share the owner's records while keeping their repository copy
locations distinct; another owner or Project with the same basename cannot see them. Renames and remote URL changes
must not rename the collection. Do not migrate general Memory namespaces. A compatibility mirror would preserve the
wrong authority and create two sets of mutation rules; reuse the current store and search owners instead.

Use existing filesystem durability primitives and native locks, respecting catalog/Plan/repository lock order. The
[Node filesystem documentation](https://nodejs.org/api/fs.html) describes the file synchronization and rename/link
operations already used by the store; no new persistence library is needed.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/work-records/store.ts` and a focused import module if needed — admitted canonical persistence,
  byte-preserving explicit import and durable record-ID metadata; legacy ownership remains available until activation.
- `src/shared/work-records/index-adapter.ts`, `search.ts` and `list.ts` — stable owner-bound index, rebuild and canonical
  result paths; the search tool must return the home record, not a nonexistent checkout-relative path.
- `src/shared/work-records/auto-generation.ts`, `generation.js`, `published-source.ts` and `in-place-completion.ts` —
  exact retained-source generation, eligibility, retries and proof-dependent approval after delivery.
- `src/shared/work-records/supersession.ts` and the relevant layout owner — shared native record locks and recoverable
  relationships across linked checkouts, with no lock-path split between admitted callers.
- `src/shared/workflow/package-publication.ts`, `publication-machine.ts`, `validation-publication.ts`,
  `validation-host-recorder.ts` and `src/shared/plan-package-store.ts` — prepared record retention, one immutable copies
  payload, post-proof canonical settlement and durable failed/pending recording references.
- `src/cmd/wr/index.ts` and shared Work Record tool adapters — import/retrieval wiring through explicit internal
  admission; no ordinary public-command cutover, browser work or remote service in this child.
- `src/shared/settings.js` — independent internal Plan/Work Record copy resolution, frozen at publication preparation.
- `docs/prd/runwield-core-prd.md`, `docs/prd/plan-store-prd.md`, ADR-016 and ADR-0020 — tested internal contract,
  confidence/copy behavior and recovery rules, leaving public activation and retention target. Prepare proposed
  Work Record/Delivery Copy wording there; `docs/domain-language.md` keeps its current public authority until activation.
- New package record suites and existing record/publication fixtures — behavioral coverage and isolated-runner inventory.

## Reuse Opportunities

- Reuse record schema, provenance, confidence labels, Ticket aggregation, supersession and existing search adapter.
- Reuse retained attempt inputs and the single copies-commit assembly from publication.
- Reuse stable Project identity and the package persistence/lock conventions; extend typed metadata rather than storing
  authoritative fields in Mnemoteca tags or `WorkRecordResource.relativePath`.
- Reuse `plan-package-fixture.ts`, Git fixtures, `publication-process-driver.ts` and the existing Mnemoteca port fixture.

## Implementation Steps

1. **The shared record store enforces admitted ownership.** Reads, writes, listing, replacement, deletion and
   supersession resolve one personal Project store and native lock scope. Linked checkouts cannot create divergent
   canonical records or bypass supersession serialization. No repository fallback, automatic document import or
   ordinary public cutover follows identity discovery. Existing legacy execution paths continue using their owner.
2. **Explicit import is repeatable and preserves evidence.** The internal `runWorkRecordsCommand` import branch reaches
   real shared file/folder import, preserves exact bytes and existing identity/status/provenance, reports conflicting
   same-ID content, and resumes interrupted writes without duplicate records or overwritten sources. Paths remain
   contained; symlinks or path escapes cannot redirect writes. Invalid input identifies its file and preserves existing
   records. Completed members of an interrupted directory import are reused on retry.
3. **Record locations survive independently of indexes.** Core metadata retains imported origins and published copy
   destinations with Project/record/owner/repository identity and digest. Only recorded repository-relative destinations
   are eligible for later repository cleanup; arbitrary external origins are not. This child performs no pruning.
4. **Actual package validation prepares eligible records.** Ordinary and Attached Recorder paths consume retained
   attempt inputs, save accepted sections and stable record identity, and prepare a pending canonical record before
   sealing the copy manifest. Retries reuse it. Nonterminal children remain ineligible; terminal Epic records aggregate
   exact retained family/Tickets. Disabled generation and Recorder failure remain separate truthful outcomes.
5. **Independent frozen settings feed one assembler.** Default Plan-off/Work-Record-on behavior and all four boolean
   combinations flow through `sealPackagePublication` and `preparePackageCopies`. The final candidate contains exactly
   the enabled prepared Markdown resources in one artifacts-only commit, or no copies commit when there is no payload.
   Live edits/settings changes cannot alter a retry. Personal metadata never enters Git. Preexisting unrelated or
   edited copy destinations remain protected by the publication child's ownership checks.
6. **Only applicable completion proof finalizes canonical records.** Package settlement approves the exact prepared
   record without rewriting its body, links the recording owner by Plan ID, stores copy locations and applies confirmed
   supersession once. It preserves later record edits/archive/supersession and newer Plan attempts. Fresh-process retry
   after each persistence boundary completes the same operation without a second push, copy commit or Recorder turn.
   Non-Git completion uses its existing explicit evidence. Pending records never leak into default retrieval.
7. **Recording recovery outlives execution cleanup.** Failed recording and index synchronization retain source and
   pending work independently of execution directories. Targeted retry/backfill and index rebuild work from the same
   retained source after checkout removal, preserve confidence and do not re-enter delivery. Missing/tampered/foreign
   source or receipt fails recoverably without approving a record; restoring valid evidence lets the same work finish.
8. **Derived lookup uses stable identities.** Admitted collections survive Project folder/remote changes and accepted
   clone links. Rebuild from home Markdown retains record IDs and filters fresh canonical status, even with stale index
   tags or changed repository copies. Same-basename Projects and other personal owners remain isolated. General Memory
   collections do not move. Command and Agent retrieval return canonical paths and notices through the shared owner.
9. **Documentation and tests describe the bounded delivered contract.** Update the owning Core requirements/scenarios,
   proposal maturity and affected ADR qualifications in the same change. Preserve public glossary authority and prepare
   proposed Work Record/Delivery Copy relationships for activation. Register and pass the new focused suites below;
   replace only package assertions that automatic recording is absent, retaining all existing publication safety and
   record eligibility coverage.

## Approval Confirmation

No Work Record supersession is proposed for this implementation Plan. Execution owner: `engineer`; collaboration
recommendation: `autonomous`. The internal setting names are a reviewable implementation assumption; the Epic already
sets their independent defaults and behavior.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Register new suites in the applicable isolated-runner
inventory. These new suites are implementation deliverables, not tests claimed to exist or pass now:

```sh
bun scripts/run-tests.js src/shared/work-records/package-store.test.ts src/shared/work-records/package-import.test.ts src/shared/work-records/package-index.test.ts src/shared/workflow/package-work-record-delivery.integration.test.ts src/shared/workflow/package-work-record-recovery.test.ts
```

- **`package-store.test.ts`:** exercise real admitted read/write/list/replace and supersession from linked checkouts.
  Poison or remove repository copies, remove the admitted store, and attempt foreign-owner access: no repository
  substitution or cross-owner data appears. Concurrent record mutations share native locks. Confirm ordinary public
  calls remain legacy and passive lookup creates no identity, admission, import or repaired runtime state.
- **`package-import.test.ts`:** call the actual command adapter under explicit internal admission with a file and
  directory containing approved, draft, pending, archived and superseded records. Compare source and canonical bytes,
  IDs, links and completion labels. Repeat after process interruption between file publication and metadata/index
  settlement; one canonical identity and complete location evidence remain. Test same-ID changed content, different-ID
  filename collisions, malformed Markdown, symlinks and external origins. No prior canonical/source bytes change.
- **`package-index.test.ts`:** import, rename/move the Project, change its remote, then read/search through the actual
  shared command/Agent retrieval path. Delete the derived database and rebuild from canonical files. Assert unchanged
  collection, canonical paths, IDs, provenance, confidence and filtering. Edit repository copies and return stale index
  status tags: canonical status wins. Test a linked clone, unrelated same-basename Project and different owner. Verify
  copy/import metadata survives index deletion and ordinary Memory namespaces remain untouched.
- **`package-work-record-delivery.integration.test.ts`:** drive `runValidationAttempt` through real admitted package
  validation and publication to a local bare remote, using only external review/Recorder/index fixtures. No repository
  Plan exists. Do not inject a prepared Work Record payload: automatic generation must produce it. Exercise absent
  settings (Plan off, record on), all four explicit combinations, and existing setting precedence. Inspect final Git
  trees and commit paths: only enabled Markdown copies, one copies commit when payload exists, none with both off,
  unchanged implementation when the copies commit is reverted, and no private metadata. Canonical record remains
  retrievable when both copies are off. Inspect pre-push pending exclusion and post-proof approved status with equal
  bodies; Git copy remains the frozen preparation representation, with no finalization commit.
- In that delivery suite, exercise ordinary and Attached Recorder paths, accepted-section reuse, disabled automatic
  generation, repeated Recorder failure, an intermediate child, terminal Epic and local-only/non-Git completion.
  Assert no fabricated record/copy for ineligible or failed sources, separate recording failure notice, terminal Epic
  ownership and retained Ticket aggregation. Exercise user-verified/closed records through their existing completion
  paths so the store change preserves labels and notes. Confirm copy settings do not disable canonical generation.
- **`package-work-record-recovery.test.ts`:** use real fresh-process drivers to interrupt after retained source capture,
  accepted Recorder sections, canonical pending write, record backlink, manifest sealing, push effect, canonical
  approval, location metadata, supersession and index synchronization. Resume with the same identity and exact bytes;
  no duplicate record, Recorder call after accepted output, copy commit or push results. Remove the execution checkout,
  branch and publication clone, rename/edit live Plans, and edit/delete delivery copies before recording/index retry:
  source and confidence still come from retained evidence. A reopened Plan's newer attempt and later record archive,
  supersession or editor changes survive old settlement replay. Verify eventual successful recovery after restoring
  corrupt/missing retained evidence or the failed external index, without changing established code-delivery proof.
- Repeat recovery with both copy settings off, with a failed Recorder followed by targeted post-cleanup retry, and
  with target movement before publication. No-copy recovery still finalizes a canonical record. Late Recorder retry
  creates no late Git copies commit and does not republish code. Copy destinations and policy remain frozen; collisions
  with unrelated/edited files refuse without overwriting them. Resume a pre-change version-1 manifest without adding
  default copies or rewriting its retained inputs.

Focused preservation suites (existing files):

```sh
bun scripts/run-tests.js src/shared/work-records/work-records.test.js src/shared/work-records/supersession.test.ts src/shared/work-records/auto-generation.test.ts src/shared/work-records/passive-index.test.ts src/shared/work-records/remote-index.test.ts src/shared/work-records/package-published-source.test.ts src/shared/workflow/validation-work-record-handoff.test.ts src/shared/workflow/package-publication.integration.test.ts src/shared/workflow/package-publication-recovery.test.ts src/shared/workflow/publication-index-recovery.test.ts src/cmd/wr/index.test.ts
bun run seams:check
```

Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Fake
only external agent turns, network/index processes and other genuine external capabilities. Do not add injection seams
for persistence, lifecycle rules, registry writes or locks. RunWield runs the full CI gate after implementation.

**Manual/inspection:** through the internal package driver, deliver an eligible standalone Plan with default settings;
inspect the pending repository copy and approved home record. Disable both copies, deliver again, remove the execution
checkout and retrieve the canonical record through the shared Agent search operation under admission. Import the first
delivery copy into an isolated owner: its pending confidence survives and is not silently approved. Ordinary public
commands remain on their existing path; this child is not a public activation demo.

**Counterfeit check:** merely changing a path getter fails real automatic delivery and restart tests. A prepared fake
record fed straight into the assembler fails the automatic-generation requirement. Repository fallback fails poisoned
copies; basename indexing fails move/isolation tests; an in-memory import ledger fails fresh-process deduplication;
unconditional approval fails pre-push and stale-receipt tests; rerunning Recorder fails accepted-output reuse; index-only
provenance fails database deletion; a second copy/finalization commit fails Git history inspection.

**Preserve:** record provenance, current-record filtering, draft approval, pending exclusion, archive/supersession,
completion labels, permanent record body, Ticket/deviation aggregation, confirmed-publication proof, copy collision
protection and legacy/import continuation. **Retire only for admitted operations:** repository-owned live Work Record
authority, basename collection lookup and automatic package-recording bypasses.

Check owning PRD scenarios and ADR qualifications against actual behavior. Public settings/admission, surface access,
managed-remote service and retention remain target; current glossary definitions must not imply their activation.

## Edge Cases & Considerations

- Importing an edited delivery copy must not overwrite a live record with the same ID.
- Managed-remote record mutations and index commands will execute on the personal owner in the later service/activation slices.
- Durable record metadata and frozen copies do not authorize deletion of arbitrary imported files. Keep cleanup scope
  tied to a recorded repository binding and safe relative path; implement no cleanup in this child.
- A prepared copy cannot promise a future push. Keep canonical pending state until proof; distinguish missing record
  output from disabled copies, and do not make best-effort recording a new delivery gate.
- A new execution may legitimately produce a new record; retrying one attempt may not. Keep record identity tied to
  the prepared source/attempt and preserve current-record supersession rules across re-execution.
- Native lock relocation must not leave old and new admitted callers writing the same record under different locks.
  Do not acquire package/catalog locks while holding a record lock if another path takes them in the reverse order.
