# Plan store

`index.ts` is the supported Plan command/query interface. This module owns storage selection, identity checks,
locking, revision comparisons, durable writes, recovery journals, import continuation, and retained inputs. UI, CLI,
Session, Attached, workflow and tool code express an operation; they do not choose a persistence implementation.

The lifecycle rules in `@runwield/plans` determine the changes for each event. The store's event commands apply that policy and persist
its result. Git execution, the worktree registry, Session transport, UI presentation, and publication phase policy retain
their existing owners. They are not moved here merely because they interact with a Plan.

For project-scoped commands, call `openProjectPlanStore(projectId)` from `index.ts`. The returned
[`ProjectPlanStore`](../../packages/plans/store.ts) reads Plans by ID and requires the observed revision for changes.
Workspace uses its active registration for the Board, sidebar, attention dashboard, search, documents, and review routes.
The TUI picker carries the selected Project and Plan IDs into the load operation. Hosted and attached
`plan_written` use `withPlanSubmission` to verify any bound Project and Plan, author through the canonical owner,
and enter the selected workflow for review or submission. The selected workflow can submit definition changes
and reopen review in its verified retained checkout. A request already admitted to that checkout requires
the canonical owner to author prose. Core workflows read richer execution documents through
`planDocumentsForCheckout`, which preserves the selected Plan and its admitted source.
Other hosts can open the same store with an identity admitted by Projects.
The runtime selects the owner and the `@runwield/plans/file-snapshots` driver stores retained workflow inputs.

### Work Record reads

Use `store.workRecords.list()` to browse a Project and `store.workRecords.read(recordId)` to open one record. Both return documents with logical relative paths. ID lookup is case-insensitive, returns `null` for a missing record, and rejects an ambiguous ID. Listing is passive and includes all statuses. The [package contract](../../packages/plans/store.ts) is shared by local and managed owners.

## Supported operations

| Intent                      | Interface examples                                                                            | Invariants owned here                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Author and edit             | `store.create`, `store.revise`, `store.editBody`, `operatePlanFile`                   | Complete authoring generations, protected fields, identity and stale-write refusal          |
| Browse                      | `store.list`, `store.read`, `store.readArchived`, `planDocumentsForCheckout`                           | Admitted live source, passive reads, authorized resource resolution                         |
| Review                      | `applySharedPlanReviewDecision`, `applyPlanReviewForExecution`, `applySequenceReviewDecision` | Required input capture, complete Sequence membership, one guarded decision                  |
| Execute                     | `reservePlanExecution`, `capturePlanExecutionContext`, `readFrozenPlanExecutionDocuments`     | Target binding and reservation under the same lock; exact recorded input and attempt        |
| Persist events and evidence | `recordPlanEvent`, `recordPlanHumanReview`, `savePlanValidationCheckpoint`                    | Central lifecycle policy, named fields and revision/attempt preconditions                   |
| Recover                     | `resetPlanExecutionMetadata`, `restoreRecreatedPlanExecution`, `retainUserVerifiedPlan`       | Revalidated identity, original continuation, fixed recovery writes and compensation         |
| Import and archive          | `importPlans`, `renamePlan`, `archiveSavedPlan`, `restoreSavedPlan`                           | Explicit import, provenance, complete durable units and recoverable changes                 |
| Publish                     | `preparePackageCopies`, `settlePackagePublication`, `finalizePublicationLifecycle`            | Frozen copies, retained receipts and persistence settlement; Git phase policy stays outside |
| Prepare legacy Git effects  | `preparePlanningMergeDocuments`, `preserveUnpublishedPlanCopies`                              | Opaque prepared documents/backups; callers cannot edit a raw persistence payload            |

`openRegisteredPlanDocuments` binds Workspace document, progress, search, and review operations to a Project registration.
The checkout query signatures used to arrange and inspect historical fixtures live in `src/shared/testing/plan-query-fixture.ts`.

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
also belong to the owner: `../plan-store.ts` and `../shared/workflow/execution-plan-file.ts`. They are not alternate
public interfaces. Canonical live packages, retained legacy execution documents, explicit import provenance, and Git
delivery copies are distinct sources inside the module. A missing canonical store never enables checkout fallback.
Managed remote entry selects the initiating laptop service before workflow consumers load. Ordinary local and
manual-SSH entry selects the execution account. Losing the service never enables another personal store.

`@runwield/plans/format` exposes storage-free parsing, normalization and presentation helpers.
The parser keeps its existing missing-date defaults and bounded text revision cache.

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

## Managed owner transport

`PreparedProjectStore` executes named commands through this owner. Trusted local code registers it on one
`startRemoteControlService` connection; HTTP cannot register a path, an owner or a serialized admission handle.
`registerHomeProjectOwner` records a Project/repository binding in the laptop account's `project.wld.json` without a
checkout. Its distinct identity has no checkout path. Every operation revalidates that binding; execution APIs still
require a real execution checkout. The existing cwd registration adapter keeps ordinary local admission checks.

| Wire command                                     | Owner operation                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `read`                                           | `readPlanDocuments`                                                                     |
| `save-document`, `save-prose`, `save-definition` | Corresponding named document/definition commands                                        |
| `record-event`                                   | `recordPlanEvent`, restricted to review approval/feedback and reset from hold           |
| `seal-publication`, `read-frozen`                | `sealPackagePublication` and checked immutable publication/input reads                  |
| `read-collaboration`                             | Owner-side capability lookup and authenticated Shared Space metadata read               |
| `save-record`                                    | Retained delivery source, existing Work Record generation/persistence and Plan backlink |
| `read-record`, `search-records`                  | Canonical record lookup and confidence-filtered owner index search                      |
| `reconcile-record-index`                         | Existing canonical record/index reconciliation                                          |
| `reconcile`                                      | Durable operation receipt inspection/recovery                                           |

Execution reservation, checkpoints, child authoring, Sequence decisions, Epic projections and artifacts, explicit
imports, archive operations, recovery, doctor repair, and collaboration are named owner commands. Collaboration performs its authenticated external requests on the personal
owner; capabilities remain there. A completed collaboration request leaves a durable result and receipt. The execution
host archives its pending pointer after receiving that result, so a later pull can see newer feedback. An ambiguous
external creation is not retried automatically; this preserves the external Plan Server's existing request semantics.

Publication freezes the execution repository's Plan-copy, Work Record-copy and generation settings. Git publication
stays on the execution host. Before lifecycle or record settlement, the laptop independently probes the registered
remote runtime for the exact attempt, candidate and target evidence. Retained proof supports post-cleanup checks;
a client success claim does not. Original pre-cutover attempts retain their registered checkout and controller identity
through publication and recording without implicitly importing their repository Plan into the canonical catalog.

Owner HTTP requests and replies are limited to 1 MiB; record searches return at most 20 results. The separate private
SSH import/proof probe accepts at most 8 MiB for source inventory and prepared imports. The service has no operation
cache. Durable ID reservations and receipts remain for the life of the owner store; this slice introduces no receipt
pruning. Deleting or corrupting a receipt does not release its reserved ID. A pending canonical effect retains at most
16 MiB of bounded replacement evidence until native-lock reconciliation settles it; completed receipts retain only
identity, request digest, revision and immutable snapshot references. Later writers reconcile pending effects before
advancing the resource. Record indexing can remain pending after canonical persistence and reconcile from that record.

The client keeps the original operation ID through uncertainty. A fresh authenticated connection can inspect or retry
that identity. Closing a connection prevents new admission; it does not assert rollback of an admitted mutation.
Production remote startup registers the service from independently inspected remote Project and repository identity.
Passive inspection does not register or adopt state; deliberate admission performs staged runtime adoption. Remote
Git registries, worktrees, publication staging and effect journals stay under the remote account home. Personal
controllers and collaboration secrets are activated on the laptop only after exact staged bytes and ownership verify.

The process fixture is `src/shared/remote/project-store-process.ts`. Run its bounded save/restart/reconnect scenario
with `./scripts/with-bun.sh scripts/run-tests.ts src/shared/remote/project-store.integration.test.ts`; it uses separate owner/client
processes and client homes, then compares the retained outcome and canonical owner bytes.
