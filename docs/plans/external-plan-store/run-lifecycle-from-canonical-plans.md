---
planId: "60092a58-2a24-443c-8a9e-185544b8a1d6"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/plan-package-store.ts"
    - "src/shared/workflow/plan-location.ts"
    - "src/shared/workflow/planning-worktree.ts"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/workflow/state-transition.ts"
    - "src/shared/workflow/plan-review-actions.ts"
    - "src/shared/workflow/execution-start.ts"
    - "src/shared/worktree-registry.js"
    - "src/cmd/load-plan/"
    - "src/shared/epic-artifacts.ts"
    - "src/shared/workflow/plan-family.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/004-plan-lifecycle-event-module.md"
    - "docs/adr/017-project-runtime-state-under-wld-internal.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 6
dependencies:
    - "external-plan-store/add-canonical-plan-packages"
    - "external-plan-store/import-plans-with-workflow-evidence"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "reviewed"
---

# Run Lifecycle from Canonical Plans

## Context

This child of the [External Project State and Plan Store Epic](../external-plan-store.md) connects the delivered
package store to the existing Plan Lifecycle. The prepared baseline includes delivered import child commit
`aa20c647872ee741834845731e90ac0a77b64202`.

`plan-package-store.ts` already owns strict version-1 metadata, independent document hashes, retained input manifests,
ID relationships and native catalog/Plan locks. `importPlanPackages` preserves legacy controller and attempt evidence
in immutable import records; it deliberately initializes the live package controller to `{}`. Import is not lifecycle
admission. Ordinary `loadPlan`, `resolveWorkflowPlanLocation`, review, and execution still use repository Markdown,
separate controller files, and checkout-scoped transition locks.

Owning requirements and proposed changes:

- [Plan store](../../prd/plan-store-prd.md#plan-store): implement **Every Plan has one live copy**, **RunWield metadata
  lives beside the documents**, and **Recovery reads the one copy** for explicitly admitted internal package workflows.
- [Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle) and
  [Plan review](../../prd/runwield-core-prd.md#plan-review): preserve existing events, review policy and readiness while
  changing their persistence authority and checking the complete reviewed input.
- [Epic decomposition and hold](../../prd/runwield-core-prd.md#epic-decomposition-and-hold): use package relationships
  and live sibling documents for this path, retaining dependency/order rules and the latest published code baseline.
- [Execution and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve code isolation,
  checkpoints, honest failure/recovery and deliberate abandonment; add owner-wide single-attempt admission and
  recoverable package/registry transitions.

These are proposed changes, not claims of current public support. Child 7 still owns package publication, final
receipts, delivery copies and Recorder sources. Child 10 owns public discovery/default activation and broad Plan/Metadata
terminology. No sibling scope changes are needed.

## Objective

An explicitly admitted package Plan follows the existing review, readiness and execution path using its personal
owner's home documents. Primary checkouts, worktrees and explicitly linked clones see the same content. Only one
unfinished attempt can own that Plan, with a durable binding to the repository that performs its Git work.

The executable slice reaches real execution preparation, implementation dispatch and checkpoint/recovery persistence.
It does not publish a package Plan or declare it `verified`. Legacy delivery remains operational.

## Approach

### One internal admission boundary

Add a typed, explicit package selection at the shared workflow preparation boundary: established `ProjectIdentity`,
Plan ID and expected package revision. The selection is revalidated against the current launch owner and repository;
a string path, matching name, environment flag or package's mere existence cannot select this format. Route that
selection into the existing lifecycle entrypoints rather than implementing another lifecycle engine.

```text
explicit package selection
  preparePlanWorkflow / resolveWorkflowPlanLocation
    package documents + metadata + bound execution evidence
      existing review decision and Plan Event rules
        package metadata commit -> existing execution preparation -> code worktree
```

Keep document authority and code cwd separate in the workflow context. A package-backed view may adapt metadata into
existing typed Plan attributes in memory; it must never serialize invented front matter, infer a project root from
`context.md`, or materialize a compatibility Plan in a checkout. Internal callers/tests can select packages; ordinary
CLI/TUI/Workspace/Connect discovery and activation retain their current source selection until child 10.

**Imported attempts keep one owner.** Read `readPlanImportEvidence` and revalidate repository, Plan and attempt IDs,
registry/Git facts, controller revision and checkpoint applicability before admitting continuation. An unfinished legacy
attempt remains on its existing lifecycle/publication path through settlement. The internal admission result identifies
that continuation; it does not reset the imported package to draft, start a second attempt, or take over an active
legacy writer. Settled legacy evidence can inform a subsequent package workflow only after those checks. Missing,
changed or ambiguous evidence produces a recoverable result with all files retained.

### Separate metadata, documents and evidence

Use `buildPlanEventUpdates` and the existing review policy as the rule owners. Package definition/controller updates
commit together through the package persistence owner, with expected metadata revision. An ordinary document write
uses its resource hash and changes no protected metadata. Reading or saving user prose that resembles YAML never
assigns identity, status or relationships.

At review, readiness and execution, retain and compare the selected package's complete document manifest plus any
parent package documents actually supplied as required context. Resolve relationships by ID. Freeze the exact input
references before dispatch. Recheck document hashes/membership, relevant definition/policy, owner and attempt evidence
at each action boundary. An unrelated controller timestamp does not invalidate content approval; an unrelated sibling
edit does not invalidate the running child's retained inputs.

A substantive content/validation change makes old approval or readiness unusable and requires current review. Apply
the existing formatting-only comparison per document before preserving approval, then capture the new exact bytes;
do not silently bless a different required document set. Reply-only review preserves status. External edits during
execution do not rewrite its frozen input or erase work; the next consequential continuation checks staleness and uses
the existing re-review/recovery path.

Extend `PlanPackageMetadata` and `metadataFrom` with named optional evidence/binding fields needed by this path; old
version-1 packages must remain valid. Retained-input references identify project, Plan and input. Execution references
identify the personal owner, repository and exact attempt, not a guessed cwd. Keep the live controller's scalar
state in `plan.wld.json`; use typed references for attempt-scoped checkpoints and other existing evidence that the
strict package contract keeps outside it. Resolve those references through the existing controller/checkpoint owners,
with one authoritative writer. Do not cast a full `WorkflowControllerState` into the current restricted
`PackageControllerState`, silently discard fields, or treat retained import JSON as mutable controller authority.

### One lock order and recoverable ownership

Package mutation already acquires catalog then sorted Plan-ID native locks. Extend that owner for lifecycle operations
and make `withOrderedTransitionResources` use the same lock identities. Avoid reacquiring a non-reentrant package lock
through `updatePlanPackageMetadata` inside a locked transition. Admit runtime/identity before these locks, then acquire
catalog, sorted package Plan IDs, and stable repository/attempt resources in one documented order. No reverse path may
hold a registry lock while acquiring the package catalog. Reuse the repository registry lock at the final mutation.

The package's owner-wide attempt reference is the admission guard across linked clones, whose registries are distinct.
A registry still owns physical worktree/Git facts. Hold the package guard while reserving the exact repository attempt;
record durable intent before effects, and settle the metadata reference/registry pair from recorded evidence after
interruption. Same-owner retry returns that attempt; another clone cannot adopt it merely by changing cwd. A different
personal owner cannot reuse the binding. Do not add time-based leases or a second attempt registry.

Plan-only journals belong beside the personal store; Git-effect journals stay with their recorded execution owner.
Extend existing transition/reconciliation records with source identity, package revision, input references and exact
attempt binding. Recovery restores only owned metadata and never restores an old document snapshot over editor work.
A missing code worktree requires real Git recovery evidence, but does not hide the canonical Plan.

This reuses existing rule owners while changing their storage boundary. A parallel package state machine or live
checkout projection would duplicate rules and leave the original authority problem intact.

Git worktrees retain separate administrative state while sharing repository refs; separate linked clones remain
separate execution repositories. The fixture design follows the [Git worktree documentation](https://git-scm.com/docs/git-worktree).
No new library is required.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/plan-package-store.ts` and `src/plan-store.js` — strict metadata/reference validation and package mutation
  ownership; preserve explicit import and ordinary legacy APIs.
- `src/shared/workflow/plan-location.ts`, `plan-preparation.ts`, `plan-actions.ts` and `plan-lifecycle.js` — carry explicit
  document authority through existing action evidence and event rules.
- `src/shared/workflow/controller-registry.ts`, `controller-state.ts`, `validation-checkpoint.ts` and
  `state-transition.ts` / `transition-recovery.ts` — metadata/controller routing, typed checkpoint references,
  revision guards, shared locks and restart reconciliation.
- `src/shared/workflow/plan-review-actions.ts`, `plan-executor.ts` and `sequence-review.ts` — coherent review/readiness
  inputs and existing approval policy, including group review when a Sequence is explicitly selected.
- `src/shared/workflow/execution-start.ts`, `execution-setup.ts`, `execution-plan-file.js`, `session-planning-worktree.ts`
  and `planning-worktree.ts` — keep code preparation while bypassing package document worktrees and Plan seeding.
- `src/shared/worktree-registry.js`, `src/shared/worktree.js` and `src/shared/project-runtime-home.ts` — bind physical
  attempts to the owner-wide package guard, with journals/locks resolved through the shared layout owner.
- `src/shared/workflow/plan-family.ts`, `epic-continuation.ts`, `epic-sibling-drafts.ts` and `src/shared/epic-artifacts.ts`
  — live ID-based family/context reads; no branch merging of package documents.
- `src/cmd/load-plan/` — reuse package-capable loading/recovery once an internal selection is supplied; no default
  public package discovery or new command.
- `src/shared/testing/plan-package-fixture.ts` and `plan-package-process-driver.ts`, plus the focused tests below —
  real package/repository races and syscall-boundary interruption.
- `docs/prd/runwield-core-prd.md`, `docs/prd/plan-store-prd.md`, `docs/plan-lifecycle.md`, ADR-004, ADR-017 and the bounded
  delivered-contract notes in ADR-0020 — distinguish internal package lifecycle from legacy/public behavior and later
  publication. The broader ADR-0020 proposal stays proposed.

Public surface redesign, managed-remote transport, delivery-copy settings, publication phases, Recorder sources and
milestone-history retention are outside this child. Leave global Plan/Metadata glossary activation to child 10; update
only a current action-evidence definition if this internal path makes its existing wording inaccurate.

## Reuse Opportunities

- `plan-package-store.ts`: `readPlanPackage`, `readPlanImportEvidence`, `capturePlanPackageInput`,
  `readPlanPackageInput`, durable replacement and catalog/Plan native locks.
- `plan-review-actions.ts`, `plan-actions.ts`, `plan-lifecycle.js`: formatting-only review equivalence, action-time
  evidence and `buildPlanEventUpdates`; preserve these as the only workflow rules.
- `state-transition.ts`, `transition-recovery.ts`, `execution-setup.ts`: journals, owned-write rollback, effect proof
  and restartable preparation. Extend source ownership instead of adding another transition engine.
- `project-identity.ts`, `project-runtime-home.ts`, `worktree-registry.js`: confirmed clone linking, explicit launch
  owner and repository-scoped physical attempts.
- Package subprocess fixtures and `defineCommittedGitFixture` / `makeValidationProjectRoot`: actual files, locks,
  disposable homes and real Git repositories; no injection seams for owned machinery.

## Implementation Steps

1. **Explicit admission reaches existing workflows.** `preparePlanWorkflow` and `resolveWorkflowPlanLocation` accept
   and propagate a typed package selection, returning live home documents independently of execution cwd. Current
   implicit callers keep legacy behavior. A package-only fixture with no repository Plan reaches the real shared
   review/action/event APIs; absent/unsafe/pending packages cannot fall back to a checkout copy. Imported unfinished
   attempts return the original legacy continuation after revalidation and cannot admit a new package execution.
2. **Package lifecycle writes preserve documents and controller truth.** `recordPlanEvent`, review decisions and
   controller writes use the package persistence owner for admitted Plans. Valid definition/controller changes commit
   atomically with a metadata revision check. All fields required by review, execution, hold and recovery survive
   restart; checkpoint references retain the exact generation, open review issues and repair receipts through the
   existing checkpoint representation. Strict parsers accept the named compatible extensions and reject malformed or
   unsupported references. Ordinary saves and metadata-only rollback preserve every current Markdown byte.
3. **Review/readiness/execution prove their inputs.** Shared review and readiness paths retain exact package input
   references, revalidate all required resources and applicable definition/policy, and propagate those references to
   execution dispatch. Stale content, parent context, membership or replaced attempt evidence cannot approve or start
   work. Existing formatting-only and reply-only behavior survives. A metadata-only controller write does not create
   a false content conflict. A later document edit keeps the running attempt's original input and requires current
   evidence before a subsequent consequential continuation.
4. **Package families no longer depend on published Markdown.** Family selection, dependency checks, Epic artifacts
   and Sequence review resolve package IDs and current documents. An edit to an unstarted sibling is visible from
   another checkout immediately, without committing or publishing it. Missing/duplicate order and unsatisfied
   dependencies keep their current behavior. Planning and execution skip package document worktrees, child seeding,
   `ensureExecutionPlanFile` materialization and sibling document merges; code execution still starts from the latest
   fetched target and preserves worktree isolation, setup receipts and existing dirty-work protections.
5. **One exact attempt wins across linked clones.** Existing execution preparation reserves the owner-wide package
   reference and repository registry entry under the shared lock order before code effects. Concurrent processes from
   two explicitly linked clones create one unfinished attempt, while the loser receives its bound continuation.
   Different owners, repositories and Plan IDs cannot steal or substitute that attempt. Restart after reservation,
   worktree creation, registry persistence or package commitment reconciles the same attempt, including a lost
   acknowledgement; it does not create another worktree or repeat completed setup effects.
6. **Recovery uses its recorded owner.** Package-only and Git-effect journals carry validated source/binding evidence
   and use the appropriate store/execution locations. Fresh-process entry reuses the existing reconciler to settle
   provable effects, preserve pending work and refuse false completion. A concurrent editor change survives both
   failure compensation and restart. No repair requires a user to edit locks, metadata or registry files. Missing
   execution directories leave package documents readable while the existing Git recovery path preserves code.
7. **The child boundary is observable.** The internally selected package path reaches implementation dispatch and
   durable implementation/checkpoint recovery. At an unsupported package publication boundary, return an explicit
   nonterminal continuation result retaining the same attempt and inputs; do not call the legacy Git-Plan publication
   path, write delivery copies, produce a final receipt or set `verified`. Legacy workflows and imported unfinished
   legacy attempts retain their existing delivery route. No public default, command, setting or discovery switch is
   enabled, and no sibling Plan is implemented.
8. **Documentation matches the delivered slice.** Update the owning PRD requirements/scenarios and technical lifecycle
   reference for the explicit package path. Reconcile ADR-004's front-matter-only statement and ADR-017's controller
   ownership statement with the bounded package case; keep legacy rules qualified and the larger ADR-0020 proposal
   separate. Update its persistence/import notes without claiming public activation or publication. Preserve all
   deferred Epic outcomes and existing glossary terminology not made true here.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Register new test files in the appropriate isolated-runner
inventory when required by the repository. Proposed focused behavioral suites:

```sh
bun scripts/run-tests.js src/shared/workflow/package-lifecycle.integration.test.ts src/shared/workflow/package-execution.integration.test.ts src/shared/workflow/package-lifecycle-recovery.test.ts
```

These three files are new implementation deliverables, not tests claimed to exist or pass now:

- **`package-lifecycle.integration.test.ts`** — create/import actual packages in disposable home storage; remove
  repository Plan copies, then use explicit admission and the real shared review decision, readiness and event APIs.
  Assert canonical paths/bytes and metadata-only lifecycle writes from primary and linked worktrees. Poison a
  checkout copy and show it is ignored. Change each required resource, remove/add a resource, edit required parent
  context and change execution policy between review/readiness/start; old evidence must fail without advancing status.
  Preserve formatting-only equivalence and reply-only status. A controller-only update must not stale unchanged
  content. Resolve Sequence members and renamed/archived package relationships by ID, not directory ancestry.
- **`package-execution.integration.test.ts`** — use the actual execution-start path with a real local bare Git remote
  and approved package, with no repository Plan to materialize. Assert one isolated code worktree at the fetched target,
  retained input bytes, registry/package binding and real implementation dispatch. Fake only external agent turns or
  tool processes where needed. Exercise a live sibling edit and next-child load from another clone without publication.
  Race two subprocesses from explicitly linked clones: exactly one unfinished attempt/worktree exists, and the loser
  returns that repository's continuation. Reject foreign owner, altered repository binding and same-name/different-ID
  attempts. Editing the live Plan after start leaves the dispatched input intact. Assert the package publication stop
  preserves a resumable attempt, emits no final receipt and never reports `verified`.
- **`package-lifecycle-recovery.test.ts`** — extend the existing subprocess driver at real filesystem/subprocess
  boundaries. Exit after durable intent, metadata replacement, registry reservation, Git worktree creation and final
  reference publication; restart from a fresh process and retry. Assert exact status/revision, one physical attempt,
  unchanged editor bytes, valid checkpoint generation/open issues/repair receipt, no replay over newer metadata and no
  invented delivery. Hold a real native package lock while another process tries lifecycle admission; it must wait,
  not steal the lock or deadlock by reacquiring it. A second package remains readable during pending recovery.
  Import a legacy active/failed attempt with dirty files and checkpoint evidence: prove it continues through the
  recorded legacy owner, cannot start a second package attempt, and cannot be admitted using stale/missing/foreign
  retained evidence. Delete only a fixture execution checkout and prove the Plan stays readable without false code
  recovery or completion.

Focused preservation suites:

```sh
bun scripts/run-tests.js src/plan-package-store.test.ts src/plan-package-concurrency.test.ts src/plan-package-snapshots.test.ts src/plan-package-import-evidence.test.ts src/plan-package-import-recovery.test.ts src/shared/workflow/state-transition.test.js src/shared/workflow/controller-registry.integration.test.ts src/shared/workflow/plan-review-actions.test.ts src/shared/workflow/plan-action-evidence.test.ts src/shared/workflow/plan-location.integration.test.ts src/shared/workflow/execution-start-linked-checkout.test.ts src/shared/workflow/execution-setup.test.ts src/shared/workflow/epic-continuation.test.ts src/shared/workflow/sequence-review.test.ts src/cmd/load-plan/plan-authority.integration.test.ts
bun run seams:check
```

Use `withProcessGlobalTestLock` whenever a fixture changes HOME or cwd. Keep real stores and repository boundaries;
do not replace package writes, lifecycle rules, registry operations, locks or recovery with injected fakes.

**Manual/inspection:** inspect one internally admitted fixture Epic through the same shared review/readiness APIs and
execution preparation. Open its canonical documents, edit an unstarted sibling, and load it through a second linked
checkout. Inspect the retained execution input, registry and package metadata after a restart. The document edit is
visible, metadata transitions did not rewrite prose, code uses its isolated worktree, and no Plan copy or package
metadata was added to Git. A new public UI is not part of this check.

**Counterfeit check:** a resolver-only wrapper over `readPlanPackage` fails real review/metadata writes with no
repository Markdown. A copied checkout Plan fails the poisoned-copy and Git-footprint checks. A per-repository-only
lock fails the two-clone race. An in-memory binding fails fresh-process recovery. Checking only `context.md` fails
validation/parent/resource-membership changes. Calling legacy publication fails the explicit package boundary check.

**Preserve:** allowed events, deliberate closure, approval invalidation, readiness, dependency ordering, Sequence
approval, code isolation, setup retry safety, legacy delivery, import provenance, controller decisions and truthful
recovery. **Retire only for admitted packages:** execution/planning/target-branch document authority, front-matter
lifecycle writes, planning-only document worktrees, and Git transport of live sibling edits. Keep the corresponding
legacy tests; add package variants instead of deleting the old assertions.

Check owning PRD scenarios, ADR qualifications and affected references against actual implementation. Publication,
public activation and managed-remote ownership remain target. The broader CI gate runs through RunWield after
implementation; these focused checks do not replace it.

## Edge Cases & Considerations

- **Reviewable implementation assumption:** internal package admission is an explicit shared-workflow input, with no
  public toggle. This follows the Epic's internal-admission boundary; exact TypeScript field names can follow the
  discovered call graph without adding a second workflow API or rule engine.
- **Owner continuity:** linked clones share personal Plan authority but retain separate repository IDs and refs. The
  losing clone may report the original repository continuation; it must not copy or relocate unfinished code to make
  execution appear local.
- **Legacy settlement:** retained import bytes survive source removal, but retained bytes alone cannot prove a live
  writer stopped or an attempt published. Revalidate live authority before handoff and preserve ambiguous work.
- **Editor races:** native locks coordinate Core writers, not arbitrary editors. Recheck hashes/membership before
  committing action evidence; do not promise an atomic multi-file editor transaction or overwrite the user's edit.
- **Schema evolution:** preserve old version-1 packages and existing import records. Add explicit validators for named
  references; unknown versions/fields remain a refusal rather than an untyped escape hatch.
- **Child boundaries:** package publication stays resumable for child 7 and ordinary public selection remains unchanged
  until child 10. This implementation itself delivers only to `epic/external-plan-store`; it does not merge the Epic
  into main or start another child.
