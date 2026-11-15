# Plan store

`index.ts` is the supported Plan command/query interface. This module owns storage selection, identity checks,
locking, revision comparisons, durable writes, recovery journals, import continuation, and retained inputs. UI, CLI,
Session, Attached, workflow and tool code express an operation; they do not choose a persistence implementation.

`../shared/workflow/plan-lifecycle.js` remains the authority for event rules. The store's event commands apply that policy and persist
its result. Git execution, the worktree registry, Session transport, UI presentation, and publication phase policy retain
their existing owners. They are not moved here merely because they interact with a Plan.

## Supported operations

| Intent                      | Interface examples                                                                            | Invariants owned here                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Author and edit             | `authorLocalPlan`, `savePlanDefinition`, `savePlanProse`, `operatePlanFile`                   | Complete authoring generations, protected fields, identity and stale-write refusal          |
| Browse                      | `loadPlan`, `listPlans`, `readPlanResource`, `readPlanDocumentLink`                           | Admitted live source, passive reads, authorized resource resolution                         |
| Review                      | `applySharedPlanReviewDecision`, `applyPlanReviewForExecution`, `applySequenceReviewDecision` | Required input capture, complete Sequence membership, one guarded decision                  |
| Execute                     | `reservePlanExecution`, `capturePlanExecutionContext`, `readFrozenPlanExecutionDocuments`     | Target binding and reservation under the same lock; exact recorded input and attempt        |
| Persist events and evidence | `recordPlanEvent`, `recordPlanHumanReview`, `savePlanValidationCheckpoint`                    | Central lifecycle policy, named fields and revision/attempt preconditions                   |
| Recover                     | `resetPlanExecutionMetadata`, `restoreRecreatedPlanExecution`, `retainUserVerifiedPlan`       | Revalidated identity, original continuation, fixed recovery writes and compensation         |
| Import and archive          | `importPlans`, `renamePlan`, `archiveSavedPlan`, `restoreSavedPlan`                           | Explicit import, provenance, complete durable units and recoverable changes                 |
| Publish                     | `preparePackageCopies`, `settlePackagePublication`, `finalizePublicationLifecycle`            | Frozen copies, retained receipts and persistence settlement; Git phase policy stays outside |
| Prepare legacy Git effects  | `preparePlanningMergeDocuments`, `preserveUnpublishedPlanCopies`                              | Opaque prepared documents/backups; callers cannot edit a raw persistence payload            |

The full explicit export list is in `index.ts`. No public arbitrary metadata updater, package CAS, lock acquisition,
controller writer, or raw filesystem writer is exported. Generic atomic file replacement belongs to
`../shared/atomic-text-file.ts`; it is not a Plan API.

## Context and bootstrap contracts

`selectPlanAccess`, `capturePlanAccess`, `withPlanAccess` and `resumePlanAttempt` carry an opaque admission handle.
Existing serialized handles retain their shape for Session/restart compatibility. Opacity is encapsulation, not a
security token: the owner rechecks Project, personal owner, repository, Plan and recorded attempt on use. Strict action
admission rejects a stale revision. `capturePlanReadContext` refreshes the same admitted identity for a long-lived read
surface, so a browser reload can see a newer title while an old approval is refused.

`withLocalPlanWorkflow`, `withLocalProjectAction`, `readLocalHomeStore` and `withPlanReadScope` coordinate an operation
without exposing storage objects or mutable metadata. The caller's callback may use public commands or genuine external
effects. These scopes neither authorize arbitrary state patches nor replace the preconditions of named commands.

`recoverLegacyPlanControllers` is the bootstrap integration used by the two runtime-layout migration owners. It accepts
already bounded, non-symlink migration locations under their migration lock. It performs controller discovery, inode
locking, report-only reconciliation, backup and atomic replacement without recursively admitting runtime storage.
Generic runtime transport and registry reconciliation remain outside this module.

## Private implementation and formats

All implementation files in this directory are private except `index.ts`. Two retained compatibility implementations
also belong to the owner: `../plan-store.js` and `../shared/workflow/execution-plan-file.js`. They are not alternate
public interfaces. Canonical live packages, retained legacy execution documents, explicit import provenance, and Git
delivery copies are distinct sources inside the module. A missing canonical store never enables checkout fallback.
Managed-remote admission retains its existing ownership behavior; this consolidation does not activate the later remote
store transport.

`../plan-format.ts` exposes storage-free parsing, normalization and presentation helpers. Actual implementations live in
`../plan-format-implementation.ts` and `../plan-format/`; they do not import persistence at runtime. The parser retains
its existing missing-date defaults and bounded text revision cache. Storage-free does not mean every parser default is
time-independent.

## Enforcement and qualification

`bun run plan-store:check` runs in `bun run ci`. Its TypeScript AST inspection covers the entire source tree, including
Workspace, static/dynamic imports, reexports, type queries and constructed constant module paths. It rejects private
imports, direct Plan-path filesystem calls in production, and production imports of Plan fixture helpers. It also walks
the format runtime graph to prevent a pure-looking facade from importing persistence.

`../../scripts/plan-store-boundary-qualification.ts` records exact existing private qualification modules and reasons.
There is no blanket test exemption for private imports. Owner unit/corruption/crash tests may exercise private
implementation. Consumer fixtures arrange historical or interrupted real-store evidence; behavior under assertion uses
public commands. Fixture access is test-only, including its dependent process and Golden drivers. Filesystem path
inspection is a guard against recognizable Plan paths, not a proof about arbitrary computed strings; the source audit
and behavioral tests remain necessary.

`operations.test.ts` exercises public authoring concurrency, protected-field refusal, stale exact edits, prose/definition
CAS, serialized/cross-Project access, fresh read contexts, and target reservation with immutable execution inputs. It is
listed in the required isolated runner inventory. Existing package, transition, recovery, consumer and composed browser
qualification remains necessary: a module boundary alone cannot prove behavior.
