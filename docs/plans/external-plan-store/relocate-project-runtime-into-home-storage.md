---
planId: "6412c132-8bb6-4d24-99fd-7770a8bc8ec8"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/project-runtime-recovery.ts"
    - "src/shared/project-identity.ts"
    - "src/shared/runwield-owned-paths.ts"
    - "src/shared/worktree-registry.js"
    - "src/shared/worktree.js"
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/collaboration/secrets.js"
    - "src/shared/work-records/index-adapter.ts"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/017-project-runtime-state-under-wld-internal.md"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 3
dependencies:
    - "external-plan-store/establish-stable-project-identity"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "in_progress"
---

# Relocate Project Runtime into Home Storage

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
`project-runtime-layout.ts` currently owns primary and selected-checkout paths, including registries, staging, secrets, locks, journals and indexes. Moving only Plans leaves that checkout-bound machinery behind.

Owning requirements: [Project runtime](../../prd/plan-store-prd.md#project-runtime-outside-checkouts),
[Project initialization](../../prd/runwield-core-prd.md#project-context-and-initialization),
[Work protection](../../prd/runwield-core-prd.md#work-protection), and
[Execution recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery).
This child changes **All internal state leaves the project**, **Only configuration remains locally**, and
**Runtime relocation is automatic and recoverable** for ordinary execution. Preserve passive inspection, current
controller decisions, repository-bound publication proof, and the user's exact configuration. These are proposed
changes until implementation; managed-remote transfer and Plan-package adoption remain later children.

Stable identity and Session/Connect lookup are already available through `project-identity.ts`. Runtime layout still
derives `.wld/internal/` from checkout paths. Existing migration coverage explicitly refuses populated fallback
worktrees and cross-filesystem renames; those outcomes must change, while their work-preservation assertions survive.

## Objective

Ordinary local execution and manual SSH execution keep all former `.wld/internal/` state in their account home Project tree, preserving unfinished work and settings. This slice changes physical runtime storage while legacy Plan documents can still retain their current format until the later cutover.

## Approach

The shared layout uses `inspectProjectIdentity` for passive resolution and the identity returned by
`admitProjectIdentity` on deliberate entry. Carry `ProjectLaunchContext` through that boundary; do not reconstruct
ownership from cwd, SSH environment variables, or a mount path. Keep path construction and admission in the existing
runtime owner so registry, controller, sharing, indexing, and diagnostic callers consume one decision.

Use the Epic's owner partition, with internal directory names a reviewable implementation assumption:

```text
~/.wld/projects/<projectId>/
  internal/                         personal secrets, indexes, migration receipts and recovery
    legacy/<repositoryId>/          legacy controller/Plan evidence until package adoption
  execution/<repositoryId>/<owner>/  registry, staging, delivery evidence and relocated fallback worktrees
    checkouts/<checkoutId>/         checkout-owned journals and diagnostics
  execution-locks/                   coordination for the physical repository
```

The `<owner>` segment is a stable, bounded encoding of the explicit personal owner, not an arbitrary supplied path.
Linked checkouts share their repository registry but keep distinct checkout-owned evidence. Explicitly linked clones
share Project identity without sharing registries, Git refs, or unfinished attempts. Until Plan-package adoption,
legacy controller, Plan lock, backup, and transition evidence retain the repository/checkout distinctions needed by
the existing Markdown authority rules; moving files does not merge those authorities or import Plans.

Stage and verify destination bytes and permissions, publish durable ownership and path mappings, then retire only
recorded sources. Resume this protocol after interruption, including existing flat-layout and `.wld/internal/`
migration journals, without replaying a write back into retired checkout storage. Unknown internal files go to a
recorded home recovery area. Quiesce real writers before transfer and acquire native locks at the new authority;
copying a lock file cannot transfer its ownership.

Git-aware relocation preserves both standalone repair clones and registered linked worktrees. The same durable
mapping updates registry paths, `PublicationAttempt.executionCwd`, `publicationRoot`, `failure.repairRoot`, and retained
revalidation paths when they actually move. Keep phase, revisions, commit IDs, and delivery proof intact. Normal
execution worktrees already outside `.wld/internal/` retain their locations. Git documents the distinction between
[worktree move and repair](https://git-scm.com/docs/git-worktree); filesystem copying alone does not repair registration.
Keep copy verification and durable publication separate from the
[filesystem copy operation](https://nodejs.org/api/fs.html#fspromisescpsrc-dest-options).

Managed-remote personal transfer remains behind its explicit version admission until the later laptop-store transport
and activation slices; do not claim remote relocation from a local-path test.
Preserve the managed launch path separately, and verify that it cannot fall through to ordinary-account adoption.
A checkout symlink or rename-only migration is excluded: neither satisfies the owner's home-storage requirement and
the supported cross-filesystem move.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/project-runtime-layout.ts` — complete owner-aware layout and recoverable adoption
- `src/shared/project-runtime-recovery.ts` — recover interrupted old and new layout operations
- `src/shared/project-identity.ts` — consume stable Project, repository, checkout, and launch-owner evidence
- `src/shared/runwield-owned-paths.ts` — retire checkout runtime writers without exempting .wld wholesale
- `src/shared/worktree-registry.js` — home registry and repository-scoped locks
- `src/shared/worktree.js` — retire no-home fallback creation and preserve Git worktree bindings during relocation
- `src/shared/workflow/publication-machine.ts` — relocated staging and repair paths
- `src/shared/collaboration/secrets.js` — private home-owned project secrets
- `src/shared/work-records/index-adapter.ts` — home index location
- `src/shared/workflow/controller-registry.ts` and existing Plan lock/transition callers — retain legacy authority
  semantics while their persistence leaves the checkout
- `src/shared/testing/project-runtime-migration-process-driver.ts` and runtime/publication tests — fresh-process
  failure recovery, real lock contention, and usable relocated Git state
- `docs/domain-language.md` — Project Runtime State and Internal Root definitions
- `docs/prd/runwield-core-prd.md` — initialization and work protection
- `docs/adr/017-project-runtime-state-under-wld-internal.md` — reconcile the old physical-location rule
- `docs/adr/0020-home-project-state-and-launch-mode-ownership.md` and `docs/prd/plan-store-prd.md` — reference the
  accepted ordinary-runtime decision without presenting the remaining proposal as implemented

## Reuse Opportunities

- Reuse checked runtime inspection versus action-owned entry, migration journals, native locks, and Windows atomic replacement.
- Reuse Git worktree/registry helpers and retained publication proof rather than infer completeness from copied paths.
- Reuse `private-json-file.ts` durability/private-directory helpers and the existing subprocess migration driver;
  introduce no persistence or lifecycle injection seam.

## Implementation Steps

1. `resolveProjectRuntimeLayout`, checked inspection, and `enterProjectRuntime` agree on stable home destinations for
   every existing layout field under ordinary ownership. Identity-free passive reads remain fresh/pending without
   creating identity, directories, locks, or ignore rules. Linked checkouts share only repository-owned resources;
   linked clones and different explicit owners cannot collide. Non-Git Projects retain their bindings after Git adoption.
2. All primary and linked-checkout runtime contents have verified home destinations, including unknown and hidden
   files, returning legacy input, and old migration evidence. Destination bytes and private permissions are verified
   before source retirement. Cross-filesystem transfer, durable mapping publication, and cleanup are restartable and
   idempotent; malformed, conflicting, or escaped evidence is preserved with a precise refusal. No marker, alias, or
   replacement runtime directory remains under project `.wld/` after completion.
3. Relocated publication/repair clones and populated fallback worktrees remain usable by Git with the same branch,
   HEAD, index, untracked files, and unstaged changes. Registry and publication references resolve to their new paths;
   publication phase and proof remain unchanged until the normal publication machine advances them. Retrying a
   partially completed move repairs Git registration and mappings before normal mutation resumes. Already external
   execution worktrees are not moved.
4. Admission quiesces active controller, registry, Plan, and Work Record writers and serializes competing migrations
   before publishing one home authority. Native locks are reacquired, not copied. A held old lock prevents cutover;
   a restart after its release recovers automatically. Home access failures preserve source work and report the actual
   prerequisite, including when `resolveWorktreeParent` would previously choose a repository fallback.
5. Controller writes, transition recovery, registry updates, sharing secrets, indexing, diagnostics, and publication
   retries use the shared home layout and cannot recreate `.wld/internal/`. Settings, Agents, Skills, prompts, and
   overrides retain their exact bytes. Git protection still detects tracked legacy runtime and secrets, and does not
   exempt `.wld/` wholesale. SQLite index handles are quiesced before relocation or rebuilt as a derived projection;
   canonical Work Records stay in their current location.
6. Legacy unimported Plans retain their current Markdown/front-matter authority, controller revisions, review decisions,
   transition evidence, and lock isolation after the move. No Plan package or Work Record import happens here. Explicit
   managed-remote context preserves its admitted behavior and never selects an ordinary-account personal store.
7. Core requirements and scenarios, glossary runtime definitions and relationships, and ADR-017 describe the delivered
   ordinary-execution layout. Reconcile affected ADR-0020 references while keeping its broader Plan-store and managed
   transfer proposal distinct. Preserve ADR-016 publication proof and ADR-018 managed-remote ownership. The transient
   Plan Store PRD retains unresolved Epic requirements; this child does not retire it or execute later children.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Add
`src/shared/project-runtime-home.integration.test.ts` and
`src/shared/project-runtime-home-recovery.test.ts` for the home-layout cases below; extend existing migration and
publication suites for their owning behavior. Register new files in the explicit test inventory where required.
Run these focused commands through the isolated runner:

```sh
bun scripts/run-tests.js src/shared/project-runtime-home.integration.test.ts src/shared/project-runtime-home-recovery.test.ts
bun scripts/run-tests.js src/shared/project-runtime-layout.test.ts src/shared/project-runtime-entry.integration.test.ts src/shared/project-runtime-read-scope.test.ts src/shared/project-runtime-passive-access.test.ts src/shared/project-runtime-read-denial.test.ts src/shared/project-runtime-portable.test.ts
bun scripts/run-tests.js src/shared/workflow/publication-machine.test.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-machine-local.e2e.test.ts src/shared/worktree-registry.test.ts src/shared/worktree-creation.test.ts src/shared/collaboration/secrets.test.ts src/shared/work-records/work-records.test.js
```

New coverage is proposed, not an existing passing inventory. Use `defineGitFixture`/`defineCommittedGitFixture`, real
stores, disposable homes, and `withProcessGlobalTestLock` for process-global changes. Keep fault injection in the
subprocess filesystem environment, following the existing migration driver; do not add Core persistence or lifecycle
seams. Failure-point cases must prove their requested boundary was reached before testing restart.

- **Owner and complete inventory** — the home integration suite seeds all layout resources, unknown/hidden files,
  linked-checkout journals, and byte-distinct overrides. After deliberate entry through primary and linked checkouts,
  every runtime item has one recorded home owner, hashes match, and both checkout internal roots are absent. Reopen in
  a fresh process; an explicitly linked clone shares Project identity but sees its own registry and attempt. Cover a
  non-Git Project and subsequent Git adoption. A constant-only redirect fails because seeded legacy state must remain
  readable through the actual controller, registry, and secret APIs.
- **Transfer and restart** — the home recovery suite interrupts after copy staging, destination verification, durable
  ownership/path publication, Git registration repair, each source retirement, and journal cleanup. Restart through
  `enterProjectRuntime`, assert retained bytes and authority, then repeat entry and prove no extra copies or revisions.
  Exercise copy transfer with injected filesystem `EXDEV`, not a mocked migration result; include incomplete and
  already-applied old journals, unknown-file recovery, destination conflicts, and unavailable home access. Replace
  the existing EXDEV-refusal expectation with successful verified recovery and source-preservation-on-failure cases.
- **Locks and passive reads** — actual child processes hold legacy controller/registry/Plan/Work Record locks while
  another tries entry. No authority changes while held; release and retry converge on one home lock namespace. Two
  simultaneous migrations converge without losing data. Snapshot home and checkout files around list/read/Doctor
  inspection before, during, and after migration; passive reads create no files or locks and never resume migration.
  Keep newer-version, symlink, tracked-secret, stale-lock-proof, and returning-controller-decision regressions.
- **Dirty Git and publication** — replace the populated-fallback-refusal test with successful relocation of a real
  registered worktree. Seed a paused publication repair with a committed repair, staged diff, unstaged diff, and an
  untracked file; compare branch, HEAD, binary index/worktree diffs, and file hashes after restart. Verify registration
  using `git worktree list --porcelain`, then resume the actual publication machine against a local fixture target.
  Only normal publication may advance phase or produce verified delivery; a copied directory or rewritten JSON alone
  cannot pass. Keep an already external worktree in the fixture and assert its path remains unchanged.
- **All writers after adoption** — exercise controller/transition writes, registry updates, collaboration secret
  persistence, Work Record indexing, debug output, and publication retry through their real entry points. Verify each
  result is readable from home, no checkout internal root reappears, configuration hashes are unchanged, and canonical
  Plans/Work Records have not been imported. A stale hard-coded writer path must fail this assertion.
- **Launch modes** — an ordinary subprocess with manual-SSH environment variables uses its execution account's home,
  without laptop state. Explicit managed-remote context cannot enter the ordinary-account relocation branch or take
  over another owner's unfinished attempt. Preserve managed-remote version admission; no remote transport is added.
- **Manual** — resume a paused ordinary workflow from a disposable legacy fixture, inspect relocated paths, and
  complete its publication to a fixture branch. Repeat from a manual SSH shell on an available test host with the
  laptop disconnected; record the actual host/account and result, or the missing external prerequisite without
  claiming this transport check passed from a local test.
- **Preserve** — legacy Plan authority and isolation until explicit package adoption; proof-bearing publication;
  recoverable intermediate failures; passive reads without writes; configuration and existing external worktrees.
- **Retire** — ordinary checkout-local runtime writers and markers, no-home fallback creation, EXDEV as an unconditional
  refusal, and refusal solely because a movable fallback worktree is populated. Checkout lock _locations_ retire;
  the existing logical isolation remains until the later Plan-package child changes it.
- **Document review** — owning PRD scenarios, runtime glossary definitions/relationships, and ADR references agree
  with the ordinary layout actually delivered. Later Epic requirements stay target. AI review checks that the tests
  reject path-only redirection, blind directory copying, stale publication references, and checkout fallback.

## Edge Cases & Considerations

- An active old writer must stop before one-way adoption; do not claim mixed-version safety.
- Managed remote may temporarily retain its existing versioned layout during intermediate Epic commits, but the final managed-remote child must retire it.
- A verified destination is not enough to delete a source whose bytes or ownership changed; retain conflicting input
  and report the precise prerequisite rather than choose the newest file.
- Private secret files and SQLite sidecars require their owning resource to be quiescent; source deletion never precedes
  verified persistence or an explicit safe rebuild of a derived index.
- Publication is authorized only into `epic/external-plan-store`. This Plan does not start the next child or merge the
  Epic into `main`.
