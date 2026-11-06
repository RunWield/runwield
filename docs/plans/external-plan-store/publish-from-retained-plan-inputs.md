---
planId: "a7c63f74-260c-40dd-9768-aedcbfc3e779"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/plan-package-store.ts"
    - "src/shared/workflow/package-workflow.ts"
    - "src/shared/workflow/validation-supervisor.ts"
    - "src/shared/workflow/plan-lifecycle.js"
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/workflow/publication-attempt.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/workflow/publication-receipt.ts"
    - "src/shared/isolated-publication.ts"
    - "src/shared/publication-lifecycle.ts"
    - "src/shared/work-records/published-source.ts"
    - "src/shared/settings.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/016-proof-bearing-publication-state-machine.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 7
dependencies:
    - "external-plan-store/run-lifecycle-from-canonical-plans"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "in_progress"
---

# Publish from Retained Plan Inputs

## Context

This child of the [External Project State and Plan Store Epic](../external-plan-store.md) continues the delivered
canonical lifecycle at Epic commit `068742322b6d6d21fd817f9429e123cac1890d0b`. Plan 6 already admits packages explicitly
through `withPackageWorkflow`, retains complete review/readiness inputs, binds one owner-wide execution attempt, and
stores controller evidence without rewriting home documents.

Publication is the remaining boundary. `runValidationAttempt` currently pauses every admitted package before the
validation loop, and `recordPlanEvent` rejects package completion events. Legacy publication requires nonempty Git Plan
paths, stages reviewed Markdown, then writes verified metadata into a target commit. Recorder reconstructs delivered
Plans and Epic children with `git show`. Removing those assumptions requires retained delivery inputs and store
settlement together; removing only the pause would enter the legacy document path.

Owning requirements and proposed changes:

- [Delivery copies](../../prd/plan-store-prd.md#repository-footprint-and-delivery-copies): implement the internal
  package contract for optional Plan copies, frozen copy policy, remembered destination paths and one copies commit.
  Preserve the rule that copies are never live authority.
- [Plan store](../../prd/plan-store-prd.md#plan-store) and
  [Execution and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): complete an admitted
  package only after applicable proof; recover lost acknowledgements without repeating publication or overwriting prose.
- [Work Record store](../../prd/plan-store-prd.md#work-record-store) and
  [Work records](../../prd/runwield-core-prd.md#work-records): retain exact Recorder source and pending evidence after
  code checkout removal, preserving provenance, completion confidence and Epic Ticket aggregation.

These are proposed implementation outcomes. Child 8 still owns canonical Work Record persistence, index relocation,
import and default-on Work Record copies. Child 10 owns ordinary public selection and complete copy-setting activation;
later children own managed-remote transport, history and pruning. No sibling scope changes are needed.

## Objective

An explicitly admitted package completes real validation and publication from immutable store inputs, with optional
Plan delivery copies, durable matching receipts and recoverable Recorder sources. Git proof, retries and cleanup keep
their existing guarantees. No new public setting may disable a required copy before its canonical store is ready.

## Approach

### Retain the source before publication

Reuse Plan 6's explicit selection and `workflow.attempt.input`; do not infer a package from a name, path, copy or
environment flag. Route that admitted context through the existing validation supervisor and publication owner.
Mechanical checks, AI review, Code Review policy, checkpoint recovery and code revalidation still run. Replace the
package completion guard with evidence checks, not unconditional permission to set `verified`.

`capturePlanPackageInput` currently retains documents, hashes and a metadata revision, not the metadata values needed
by Recorder. Add an attempt-scoped immutable publication manifest owned by the personal store. It references the
validated retained documents and includes exact source metadata, required parent/relevant child snapshots, Tickets,
owner/Project/Plan/repository/attempt identities, copy policy and destination paths. Validate required document and
definition evidence before sealing; a live edit is not permission to recapture unreviewed content. Once sealed, retries
read this manifest, not current documents or settings. A changed code candidate follows existing revalidation and
seals a new attempt record; it cannot reuse proof for the old commit.

Commit and verify retained bytes before a registry or controller reference can point to them. Missing, corrupt,
foreign-owner or mismatched inputs remain recoverable failures; never substitute a repository copy. Retain references
needed by publication, Recorder, index retry and recovery independently of optional milestone history. Pruning policy
itself remains child 15.

```text
explicit package attempt + validated retained input
  durable publication input and frozen copy policy
    existing publication phases: code + optional copies -> Git target proof
      matching package receipt and lifecycle settlement
        checkout cleanup; Recorder retries from the retained source
```

### Keep one publication owner and one copies commit

Extend the existing `PublicationAttempt` contract with an explicit package-input variant and strict validation. Old
records, including `deliveryMetadataVersion: 1`, keep their original interpretation. The registry still owns mutable
publication phases; package metadata retains a final receipt and source reference, not another phase machine.

The package variant permits an empty copy set. Its sealed code boundary and retained manifest prove artifact
preparation without a fabricated Plan path or empty artifact commit. With enabled copies, assemble exactly one
artifacts-only commit after implementation and before target publication. Plan copies contain the sealed Markdown
resources at `docs/plans/<frozen-plan-name>/`; never include `plan.wld.json`, controller files or synthesized front
matter. Store the actual repository/path association for later cleanup. A renamed Plan retains the attempt's frozen
destination while its live identity remains the Plan ID.

Expose one typed assembly input for Plan documents and the next child's prepared Work Record documents. An internal
fixture can supply both payload kinds to prove composition, but this child does not relocate Work Record storage or
enable its public settings. The internal Plan-copy policy defaults off; effective policy and paths are captured once.
With no payload there is no copies commit. Rebuilding an unpublished integration after target movement reuses the
sealed payload and leaves one copies commit in the final ancestry, not one per retry.

Adapt `isolated-publication.ts` and `publication-lifecycle.ts` so package publication skips the legacy target Plan
metadata commit. For the package variant, reconciliation proves the exact code/copy candidate and target ancestry;
it does not require a Git document saying `verified`. After fresh proof, atomically settle the applicable package
receipt, status, recording reference and copy locations through the existing package/controller owner. Preserve live
document bytes and unrelated/newer metadata. A lost acknowledgement resumes this settlement without another push.

Release the owner-wide attempt guard only from matching settled evidence, before registry pruning loses that evidence.
Keep enough durable intent for interruption between receipt, guard release and registry cleanup; an absent registry
entry alone cannot free the package or prove delivery. Reopening or starting a new execution invalidates applicability
of an old receipt while preserving its historical source. Maintain Plan 6's catalog, sorted Plan-ID and repository
resource lock order; do not acquire package locks while holding the registry lock.

Git remains authoritative for code delivery. Preserve independent remote ancestry checks, exact push leases, local-only
publication protections and non-Git in-place verification. The [Git push documentation](https://git-scm.com/docs/git-push)
defines the expected-ref lease; [merge-base](https://git-scm.com/docs/git-merge-base) supplies the ancestry test. No new
library or delivery mode is needed.

### Recover recording without repository Plan reads

Teach `retainPublishedWorkRecordSource`, `loadPublishedWorkRecordSource` and `readPublishedDeliverySources` to use the
package publication reference. Keep delivered child identity separate from its Epic recording owner. Resolve metadata,
relevant children and Tickets from that attempt's retained source, including after live edits, rename or checkout
cleanup. Backlinks use canonical package metadata and optimistic checks; never recreate checkout Markdown. Legacy
attempts continue using their existing Git source and private refs until settlement.

Pending Recorder/index evidence must remain addressable independently of an execution directory. Failure to generate
or index a record does not revoke confirmed code delivery or release its source references. Child 8 will consume this
contract for canonical record generation and index relocation; this child proves the retained input/retry handoff.

A compatibility Markdown projection would preserve the wrong authority and duplicate lifecycle rules. Reuse the
existing owners with an explicit input variant instead. Broad Plan/Metadata/Work Record glossary changes remain at
public activation; describe this bounded package contract in the PRDs and ADRs now.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/plan-package-store.ts` and `src/shared/workflow/package-workflow.ts` — retained publication manifest,
  strict references, final metadata settlement and evidence-based release of the owner-wide attempt.
- `src/shared/workflow/validation-supervisor.ts`, `plan-lifecycle.js`, `validation-publication.ts` and
  `publication-revalidation.ts` — replace the package stop with the existing validation/delivery flow and preserve
  package context across continuation, repair and code revalidation.
- `src/shared/workflow/publication-attempt.ts`, `publication-machine.ts` and `publication-receipt.ts` — explicit input
  variant, no-copy evidence, monotonic Git proof, restartable settlement and cleanup.
- `src/shared/isolated-publication.ts`, `src/shared/publication-lifecycle.ts` and `src/shared/worktree.js` — one frozen
  copies payload, exact candidate evidence and package publication without a target lifecycle-metadata commit.
- `src/shared/workflow/controller-state.ts` and `controller-registry.ts` — typed retained recording/receipt evidence
  through the existing package controller owner; preserve legacy controller reads.
- `src/shared/work-records/published-source.ts`, `src/shared/workflow/validation-host-recorder.ts` and existing delivery
  handoffs — exact package Recorder input and pending recovery after checkout removal, without record-store migration.
- `src/shared/settings.js` — internal independent copy-policy resolution if needed; no public/default legacy switch.
- Package fixtures and publication process drivers — real store, Git and fresh-process failure coverage listed below.
- `docs/prd/runwield-core-prd.md`, `docs/prd/plan-store-prd.md`, `docs/plan-lifecycle.md`, ADR-016 and the bounded contract
  notes in `docs/adr/0020-home-project-state-and-launch-mode-ownership.md` — qualify legacy Git metadata rules, document the
  delivered internal package slice and leave the broader proposal/public activation distinct.

## Reuse Opportunities

- `capturePlanPackageInput` / `readPlanPackageInput`, package controller evidence and private atomic file persistence
  already provide durable document bytes, digests and typed references; extend them instead of creating live copies.
- `withPackageWorkflow`, `packageWorkflowLocks`, lifecycle events and controller writes already enforce the admitted
  owner and metadata boundaries; preserve those rules during settlement.
- Publication phase/revision guards, independent remote ancestry checks, exact target leases and revalidation already
  own Git safety; extend their evidence contract rather than creating a package publisher alongside them.
- `plan-package-fixture.ts`, `publication-process-driver.ts` and existing fault-matrix tests supply real stores,
  subprocesses and repositories. Use `defineGitFixture` / committed fixtures where appropriate.

## Implementation Steps

1. **A publication reference names durable, validated inputs.** The package store retains the complete immutable
   publication manifest described above, including metadata values and relevant family/Ticket inputs that current
   document snapshots omit. The attempt stores a validated identity/digest reference only after durable persistence.
   Malformed, missing, tampered or foreign inputs cannot publish, fall back to live copies or acquire completion status.
   Metadata parsing remains strict and existing version-1 package/input records remain readable.
2. **Real validation reaches package publication.** `runValidationAttempt` uses the existing supervisor, checks,
   reviews and checkpoint/recovery path for explicitly admitted packages; `recordPlanEvent` permits only completion
   backed by applicable evidence. The retained Plan 6 continuation resumes its exact repository attempt, not a new
   worktree. Unfinished imported legacy attempts keep their legacy owner and publication contract. Ordinary public
   discovery and selection do not change.
3. **The attempt contract represents optional copies truthfully.** `PublicationAttempt` parsing, phase validation and
   reconciliation distinguish package sources from legacy Git-Plan sources. Package attempts may prepare zero copies
   without nonempty `planPaths`, a fake path, an empty commit or an invented effect. Existing records retain their
   original `deliveryMetadataVersion` semantics and required evidence. Unknown/mixed formats are refused recoverably.
4. **One frozen assembly produces the only copies commit.** The package path writes enabled Markdown resources to
   frozen `docs/plans/<plan>/` destinations, excludes personal metadata and unrelated files, and accepts prepared Work
   Record documents through the same typed assembly contract. No payload produces no copies commit. Retry and target
   advancement preserve the exact bytes/policy and one copies commit in final ancestry. Package publication bypasses
   legacy metadata finalization without weakening legacy checks or admitting a newer code candidate without validation.
5. **Matching proof settles personal state before cleanup forgets ownership.** Fresh local/remote Git evidence binds
   candidate, published commit, target, owner, repository, Plan, attempt and retained input. Package receipt, verified
   state, recording reference and copy locations persist through the existing metadata/controller owners without
   changing Markdown. Restart after push or any settlement write reconciles the same operation; no duplicate push,
   copies commit or metadata-only target commit occurs. The owner-wide guard is released from settled evidence before
   registry pruning; a missing entry or stale/foreign receipt cannot free it. Reopening/new execution invalidates old
   effective completion. Non-Git completion retains its explicit in-place evidence rather than inventing Git proof.
6. **Recorder source survives code cleanup.** Package branches of the published-source APIs read exact retained
   metadata/documents and relevant Epic children/Tickets, with distinct delivered-child and recording-owner identities.
   They work from a fresh process after the execution checkout, source branch and temporary publication clone are gone;
   they do not read or recreate `docs/plans` copies. Pending recording/index evidence retains its source references
   through failure and retry. No general record persistence/index migration or pruning implementation is added here.
7. **Regression coverage distinguishes the new authority.** The package suites below execute actual validation,
   publication, settlement and recovery, including no repository Plan, copy settings, corrupt references and process
   interruption. Replace only Plan 6 assertions that package validation/completion must always pause; retain all its
   owner isolation, exact-input, single-attempt and truthful-completion protection. Preserve legacy publication suites.
8. **Documentation matches only this delivered slice.** Update Core execution/recovery and Work Record source
   scenarios, the Plan Store proposal's mixed maturity, lifecycle reference and ADR-016. Qualify the legacy requirement
   for a committed verified Plan and target metadata commit; state the package receipt/retained-input rule. Refresh
   ADR-0020's bounded delivered-contract notes without changing its broader proposed status. Prepare Delivery Copy
   terminology there; do not claim public settings, canonical Work Records, managed-remote activation or pruning shipped.

## Approval Confirmation

No Work Record supersession is proposed. Execution owner: `engineer`; collaboration recommendation: `autonomous`.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Register new suites in the applicable isolated-runner
inventory. The following package suites are implementation deliverables, not tests claimed to exist or pass now:

```sh
bun scripts/run-tests.js src/shared/workflow/package-publication.integration.test.ts src/shared/workflow/package-publication-recovery.test.ts src/shared/work-records/package-published-source.test.ts
```

- **`package-publication.integration.test.ts`** — prepare a real package through shared review/readiness/execution
  APIs, complete implementation, then drive `runValidationAttempt` through actual mechanical validation and external
  review-turn fixtures into publication to a local bare remote. No repository Plan exists. Assert published code
  ancestry, exact retained input, package receipt/status, released attempt guard and eventual registry cleanup. Missing
  validation/review evidence cannot publish. This fails at the current supervisor pause even if a new low-level helper
  appears correct. Repeat in local-only mode and non-Git mode with their existing distinct evidence contracts.
- In that integration suite, exercise Plan copies off and on. Inspect commit trees and changed paths: off adds no Plan
  copy; on adds only sealed Markdown under the frozen package path; metadata never appears in Git. Exercise the unified
  assembler with neither payload, Plan-only, prepared Work Record-only and both payloads: zero or exactly one
  artifacts-only commit, with implementation unchanged by reverting that commit. The prepared Work Record fixture
  tests the contract, not child 8's automatic generation/default setting. Edit live documents/settings and rename the
  Plan after sealing, advance the target, then retry: original bytes and destination survive; live edits remain intact.
  Reject path escapes, duplicate destinations and collisions with unrelated target content without overwriting it.
- **`package-publication-recovery.test.ts`** — extend real subprocess drivers to interrupt after retained bytes become
  durable, attempt reference persistence, copies-commit effect/receipt, integration effect/receipt, push effect/receipt,
  proof, package receipt write, guard release and registry cleanup. Where writes occur inside one call, intercept the
  actual filesystem/subprocess boundary in the fixture, not a new Core-owned dependency seam. Restart in a fresh
  process and prove exact target ancestry, no duplicate copies commit or repeated push after confirmed effect, durable
  source references, preserved primary/editor bytes and eventual settlement of one attempt. Run the copyless branch
  too; commit-marker-only recovery cannot silently require a Plan artifact.
- Recovery coverage also corrupts/removes the retained manifest, changes identity/digest, presents a stale receipt,
  and attempts continuation from a linked clone/foreign owner. No substituted source, false verified status or second
  attempt may result. Remove the registry entry before proven settlement: absence alone must not release ownership.
  For recoverable refusals, restore the exact fixture input or external prerequisite, then restart and successfully
  complete the same attempt; a permanent refusal is not a passing recovery test. Concurrent editor bytes must survive
  both the refusal and successful retry.
  Exercise target movement after publication, unavailable upstream history, source rewriting before integration and
  interrupted revalidation. Preserve fresh proof and no blind replay. A settled receipt remains readable after cleanup,
  but reopening/new execution cannot inherit effective completion.
- **`package-published-source.test.ts`** — deliver a child and a terminal Epic with distinct IDs and relevant children,
  Tickets and truthful completion metadata. Remove their execution checkout/branch/publication clone, change live
  documents and edit or delete optional repository copies, then read Recorder source from a fresh process. Assert the
  exact delivered text, source IDs, child-to-Epic ownership, Ticket aggregation and pending-versus-approved confidence.
  Loading source must neither recreate repository Plans nor overwrite current package documents/backlinks. Simulate an
  external Recorder/index failure and retry: delivery stays confirmed and the same source remains readable. Retained
  bytes without matching delivery proof must never be promoted to a verified source.

Focused preservation suites (existing files):

```sh
bun scripts/run-tests.js src/shared/workflow/package-execution.integration.test.ts src/shared/workflow/package-lifecycle-recovery.test.ts src/plan-package-snapshots.test.ts src/shared/workflow/publication-attempt.test.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-revalidation.test.ts src/shared/workflow/publication-index-recovery.test.ts src/shared/workflow/validation-publication.test.ts src/shared/work-records/published-delivery-source.test.ts src/shared/attached/delivery-recorder-input-recovery.test.ts src/shared/isolated-publication.test.ts src/shared/publication-lifecycle.test.ts
bun run seams:check
```

Use real stores/repositories and disposable homes; use `withProcessGlobalTestLock` for HOME/cwd mutations. Fake only
external agent turns, index/network processes or other genuine external capabilities. Do not inject Plan writes,
lifecycle rules, registry writes or locks. RunWield runs the full CI gate after implementation.

**Manual/inspection:** use the internal package fixture/driver, not a new public command. Deliver with Plan copies
disabled and enabled; inspect Git history, copy bytes and canonical metadata. Interrupt after target publication but
before store acknowledgement, restart, and observe the same receipt and no second push. Remove only the fixture's
execution checkout, read its retained Recorder input, and confirm a subsequent package execution can acquire the
settled owner guard. Check that ordinary public selection still uses its existing path.

**Counterfeit check:** a wrapper that still reads live or Git Plans fails the absent/poisoned-copy and post-cleanup
source tests. Removing only the supervisor guard fails real validation and no-copy publication. In-memory receipts
fail fresh-process settlement. Candidate ancestry without frozen artifact verification fails tampered copies.
Re-generating artifacts on retry fails exact bytes/commit-count checks. Releasing ownership on missing registry alone
fails the two-owner/settlement tests.

**Preserve:** confirmed-publication completion, target advancement, source/primary preservation, code revalidation,
legacy evidence interpretation/import continuation, owner-wide single-attempt admission, Code Review policy and
local-only/non-Git behavior. **Retire only for admitted packages:** unconditional publication pause, Git Plan source
reconstruction, required nonempty Plan paths and target metadata commits solely representing Plan status.

Review owning PRD scenarios and ADR qualifications against actual behavior. Package delivery may be marked current
only as an internal contract; public selection/copy settings, Work Record relocation, remote transport and retention
remain target. No glossary statement should promote those remaining proposals.

## Edge Cases & Considerations

- **Durability and locks:** references must follow durable content; settlement uses Plan 6's shared lock order and
  journal/controller owners. Store unavailability cannot create a replacement authority inside a checkout.
- **A retry versus a new candidate:** unchanged retries retain inputs/settings. Rewritten code requires existing
  revalidation; an unrelated live Plan edit never silently changes the sealed delivery or authorizes unreviewed content.
- **Receipt applicability:** historical proof does not authorize overwriting newer state, adopting another owner or
  completing a new execution. Keep exact identities, retained source and irreversible Git effect distinct.
- **Copy collisions:** frozen destination validation must reject unsafe paths and preserve unrelated repository edits.
  Repair remains recoverable work; it must not silently replace frozen bytes with live content to resolve a conflict.
- **Work Record boundary:** the composer accepts a prepared record payload and retains Recorder input; canonical
  persistence, all public copy-setting combinations and derived-index relocation are child 8/activation work.
- **Ownership:** direct SSH followed by `wld` uses that host's personal Plan store; laptop-managed `wld remote host`
  uses the laptop's store. Carry the selected owner in retained references; this child adds no remote service or fallback
  to the execution account's home.
- **Scope:** retain existing publication modes; Forge delivery remains out of scope. This child publishes its own
  implementation only to `epic/external-plan-store`, without starting child 8 or merging the Epic into `main`.
