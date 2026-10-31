---
planId: "6412559b-2b74-4121-bb1c-f7c1d5e6d793"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/runwield-owned-paths.ts"
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/publication-attempt.ts"
    - "src/shared/project-runtime-layout.test.ts"
    - "src/shared/worktree-registry.test.js"
    - "src/shared/workflow/publication-machine.e2e.test.ts"
    - "src/shared/testing/project-runtime-migration-process-driver.ts"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-29T03:04:53.911Z"
status: "validated"
origin: "internal"
parentPlan: "consolidate-project-runtime-state"
order: 2
dependencies:
    - "01-add-runtime-layout-contract"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
---

# Add Legacy Runtime Migration Engine

## Context

Version 0.10.0 must adopt inactive project-local runtime state from legacy `../../../../.wld` paths into
`../../../../.wld/internal`. It must stop without changing files when the old state is active, ambiguous, tracked,
symlinked, or tied to unfinished publication recovery.

The previous child Plan created the layout contract. This child Plan adds the migration engine, but does not need every
command surface to call it yet.

## Objective

Implement a serialized, durable, idempotent migration that can run before normal project runtime access. The engine must
preserve primary-checkout and selected-checkout ownership and must never silently merge two authorities.

## Approach

Keep migration policy and durable migration state in the layout owner. Export one migration operation with a
discriminated result:

```text
migrateLegacyProjectRuntimeState(selectedCheckoutRoot)
  -> ready { layout, migrated, adoptedSelectedCheckoutRoots }
  -> blocked { reason, paths, message, securityAction? }
```

Expected blocker reasons include a newer layout, malformed migration evidence, old/new authority conflict, active legacy
writer, malformed registry, unfinished publication, saved repair root, tracked runtime, tracked secret, symlink, invalid
registered checkout, and unsupported filesystem move. Unexpected input/output failures can still throw; known safety
conditions must return `blocked` without partial adoption.

The safe order is:

```text
read-only preflight
  inspect exact legacy registry bytes without identity migration
  validate registered checkout roots against Git worktree evidence
  inspect publication records, Git tracking, symlinks, and legacy locks

serialized adoption
  create/acquire primary .wld/internal/layout-migration.lock
  acquire the exact legacy worktrees.lock
  repeat preflight while both locks are held
  write and sync layout-migration.json intent
  rename one durable leaf; sync parents; write its receipt
  retire proven-stale transient locks
  atomically write and sync layout.json
  release and retire the legacy registry lock
  remove the completed journal
```

`layout.json` is the completed version-1 marker. It records the canonical primary checkout root and the sorted canonical
selected checkout roots that were checked and adopted. `layout-migration.json` is a separate version-1 journal. Each
operation names a source and destination derived from the layout contract, its action (`rename` or `retire`), and its
pending/completed state. A journal is never allowed to supply an arbitrary path: every path is rebuilt and compared with
the current primary root, Git-registered selected roots, and the bounded legacy catalog before use.

Write the journal intent before each effect. On restart, `source present/destination absent` repeats a rename;
`source absent/destination present` records the completed rename; any other pair refuses. A retirement is complete when
the exact stale lock is absent. The completed marker stays valid while a later-entered selected checkout is adopted; the
journal covers that added root until the marker is atomically updated.

Use atomic rename only. Legacy and destination leaves share one routed `.wld` base, including under the test sandbox. An
`EXDEV` or equivalent cross-device failure returns a recoverable blocker before the source is retired; this Plan does
not add a copy protocol.

The main option set aside is translating unfinished publication recovery into the new layout. That could make upgrades
smoother, but it risks losing the authority for validated unpublished work if a process stops mid-translation.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/shared/project-runtime-layout.ts` — own the migration result, lock, marker and journal schemas,
  read-only preflight, leaf mapping, durable rename/retirement effects, and restart reconciliation.
- `../../../../src/shared/runwield-owned-paths.ts` — expose the bounded legacy hazard names and temp-file shapes used by
  preflight; keep user-derived `.wld` paths outside migration.
- `../../../../src/shared/worktree-registry.js` — factor exact-path, strict, read-only registry inspection and
  exact-path lock acquisition from the existing project-root wrappers. Existing callers keep their behavior and legacy
  identity migration remains disabled during layout preflight.
- `../../../../src/shared/workflow/publication-attempt.ts` — remain the schema and phase validator used to reject
  malformed, non-cleaned, or repair-bearing publication records; change it only if a small named predicate avoids
  duplicated phase rules.
- `../../../../src/shared/project-runtime-layout.test.ts` — cover inactive primary and linked-checkout adoption,
  second-entry stability, conflicts, tracked paths and secrets, symlinks, lock evidence, marker versions, and every
  restart state.
- `../../../../src/shared/worktree-registry.test.js` — prove exact-path inspection and locking do not migrate
  identities, tolerate no malformed top-level shape, and preserve all current project-root callers.
- `../../../../src/shared/workflow/publication-machine.e2e.test.ts` — seed publication records through the real
  publication machine and prove every phase except `cleanup_complete`, plus every saved repair root, blocks layout
  migration.
- `../../../../src/shared/testing/project-runtime-migration-process-driver.ts` or an equivalent test-only driver — run
  migration in a separate process so process death and lock ownership use real operating-system behavior.

Normal store cutover, project-entry wiring, `../../../../.gitignore` reconciliation, and user-facing recovery text
remain in later children. No production command calls the migration operation in this child.

## Reuse Opportunities

- `../../../../src/shared/project-runtime-layout.ts` from child 01 — reuse named primary/selected paths and the current
  versus legacy classifiers; do not recreate checkout ownership with string joins.
- `../../../../src/shared/worktree-registry.js` — reuse atomic write, directory sync, stale-lock recovery, and
  non-mutating inspection. Add an exact-path layer so child 03 can move normal registry access without losing legacy
  inspection.
- `../../../../src/shared/process-liveness.ts` — use host and process evidence for the frozen legacy Plan-lock protocol.
  Use the legacy Work Record heartbeat/age rules and operating-system `tryLockSync` for persistent controller lock
  inodes; file existence alone is not active-writer evidence.
- `../../../../src/shared/workflow/publication-attempt.ts` — reuse `assertPublicationAttempt()` and `cleanup_complete`
  as the only publication state safe to migrate. Plan status and directory names are not evidence.
- `../../../../src/shared/git-test-fixture.ts` and existing worktree test helpers — use real repositories and linked
  worktrees for tracking and root-validation tests. Git checks use checkout-relative `.wld` paths even when runtime
  storage is routed through `WLD_TEST_SANDBOX_HOME`.

## Implementation Steps

- [ ] `../../../../src/shared/project-runtime-layout.ts` exports
      `migrateLegacyProjectRuntimeState(selectedCheckoutRoot)` and named `ready`/`blocked` result types. Known safety
      refusals include stable reason codes and exact non-secret paths; the tracked-secret result also carries
      capability-rotation and repository-history guidance for later surfaces.
- [ ] The primary internal root reserves `layout.json`, `layout-migration.json`, and `layout-migration.lock`. Atomic
      writes sync file and parent directory. The lock uses holder identity, heartbeat, stale recovery, and
      ownership-safe release; two processes cannot adopt the same project or append a selected root concurrently.
- [ ] Read-only preflight runs before internal-root creation, then runs again while the migration lock and exact legacy
      registry lock are held. A static blocker leaves no internal root, marker, journal, renamed leaf, retired source,
      or `../../../../.gitignore` edit. Lock acquisition/release is the only permitted transient effect.
- [ ] Exact-path registry inspection validates the top-level object, schema version 1 or 2, entries array, required
      traversal fields, duplicate IDs, ambiguous live attempts, and publication shape without writing registry bytes,
      identity backfills, migration reports, or Plan documents. A valid schema-1 entry without `planId` remains
      byte-preserved; missing identity alone does not trigger the existing Plan-document migration.
- [ ] Every attached selected root comes from the requested checkout or the intersection of registry paths and real
      `git worktree list --porcelain` evidence. Existing registry paths that resolve to a non-worktree, a symlinked
      authority, or an unexpected repository refuse; missing retired paths are not read or recorded as adopted.
- [ ] Preflight rejects every valid publication phase before `cleanup_complete`, every `failure.repairRoot`, every
      malformed/unsupported publication record, and any unexplained non-empty legacy publication-staging directory.
      Registry bytes, Git refs, publication/repair directories, and the primary worktree remain unchanged.
- [ ] Git preflight checks both primary and selected checkouts for tracked or staged current/legacy runtime paths,
      including intent-to-add. It returns exact paths. A tracked project secret gets the distinct security result. It
      never treats `../../../../.gitignore` as proof that a path is untracked.
- [ ] Filesystem preflight uses `lstat` for `.wld`, the internal root, every legacy authority, and descendants that
      would be inspected or adopted. Any symlink, special file where a regular file/directory is required, or
      canonical-path escape refuses before content is read or moved.
- [ ] Live-writer checks follow each legacy protocol: registry acquisition owns `worktrees.lock`; Plan locks use
      hostname/PID plus heartbeat age; Work Record supersession locks use token heartbeat and their separate stale
      windows; controller `.lock` inodes use an operating-system non-blocking exclusive lock. Proven-stale transient
      locks are journaled for retirement. Unlocked controller lock files move with controller data.
- [ ] The journal contains only derived, validated operations. Durable primary leaves and selected-checkout journals are
      renamed into their matching internal roots. Reserved legacy directories are preserved under the same leaf name;
      transient registry, Plan, and Work Record locks are retired only when their protocols prove that safe. A secret
      temp file or any unknown transient shape refuses as ambiguous rather than moving or deleting it.
- [ ] Each rename is preceded by a synced pending receipt and followed by parent-directory sync plus a completed
      receipt. Restart reconciliation accepts only the source/destination combinations defined in Approach. A partial
      destination without matching journal evidence remains an authority conflict.
- [ ] `layout.json` records layout version 1, canonical primary root, sorted adopted selected roots, and completion
      time. A supported complete marker with no legacy reappearance is byte-stable. A later selected root is adopted
      under a new journal and appended atomically. A newer marker, malformed marker/journal, root mismatch, or legacy
      state that reappears after completion returns `blocked` without choosing an authority.
- [ ] Migration preserves file and directory bytes and modes through same-device rename. The internal root and new
      metadata use restrictive permissions where supported. `EXDEV` and other non-atomic move failures keep the source
      authoritative and return recoverable evidence; no copy fallback or overwrite exists.
- [ ] Focused tests use real filesystem, Git, operating-system locks, and subprocesses. They add no dependency-injection
      seam and define no `any`, `unknown`, or complex inline TypeScript type.

## Approval Confirmation

Work Record `dc1e7c94-a38a-418d-9c63-4550fb3583ca` established Git isolation for the existing enumerated runtime paths.
This Plan preserves that behavior while adding one-way storage adoption. It overlaps the record but does not materially
replace it, so no `supersedes` relation is proposed. Its historical CI deviations are not accepted as a new baseline;
this child must pass current CI.

## Verification Plan

- Automated:
  `deno run -A scripts/run-tests.js src/shared/project-runtime-layout.test.ts src/shared/worktree-registry.test.js src/shared/workflow/publication-attempt.test.ts src/shared/workflow/publication-machine.e2e.test.ts src/shared/worktree-registry-restore.test.ts`.
- Automated: `deno task seams:check`.
- Automated: `deno task ci` must pass before child 03 starts.
- Adoption proof: a real primary repository plus linked worktree starts with legacy controller, registry, transition,
  fallback, reserved, and secret bytes. Migration moves each leaf to the correct primary or selected internal root,
  preserves byte content and modes, removes legacy authorities, writes the exact marker roots, and makes a second call
  produce no byte or directory-entry changes. This fails if the implementation is a marker-only stub or moves all state
  to one checkout.
- Refusal proof: snapshot bytes, modes, directory entries, Git index, refs, and `../../../../.gitignore` before each
  malformed registry/publication, active phase, repair root, non-empty orphan staging, tracked path, tracked secret,
  symlink, special-file, invalid worktree, live-lock, newer-marker, and old/new conflict case. After `blocked`, the
  snapshot is unchanged except for transient lock creation/removal. Tests assert the reason code and exact paths.
- Restart proof: use a subprocess and direct fixture construction to cover every journal operation with pending and
  completed receipts and every valid source/destination pair. At least one real subprocess is terminated after each
  effect class (journal commit, primary rename, selected rename, stale-lock retirement, marker replacement, journal
  cleanup). Restart must reach the same final bytes as uninterrupted migration or return the defined blocker while all
  source/destination bytes remain recoverable.
- Lock proof: one subprocess holds each real legacy lock protocol while another attempts migration. It must block or
  return `active_legacy_writer`; an unlocked persistent controller lock inode must migrate. A registry-lock test changes
  registry bytes while migration waits, then proves the locked second preflight sees the new blocker.
- Publication proof: create attempts through `startPublicationAttempt()` and advance them through the real state
  machine. All phases before `cleanup_complete` and any saved repair root block; only a validated `cleanup_complete`
  record is eligible. This fails if migration checks Plan status, registry status, or directory names instead of
  publication evidence.
- Preserved behavior: registry inspection remains read-only and existing registry callers keep schema-2 reads, ambiguity
  reporting, locking, compare-and-set publication updates, and optional legacy Plan-identity migration.
- Behavior expected to stop: inactive recognized runtime state is no longer left at legacy paths after direct migration;
  a complete marker cannot make reappeared legacy state writable; unsafe state cannot be auto-merged or overwritten.
- Manual: no command surface invokes this engine yet. The disposable-project upgrade journeys remain in the entry-guard
  and final verification children; this child proves the callable engine directly.
- No skipped test is expected. Any unavoidable temporary skip must name `consolidate-project-runtime-state` and cannot
  cover behavior owned by this child.

## Edge Cases & Considerations

- The test sandbox routes runtime files outside the checkout. Migration path selection must still use the layout
  contract, while Git tracking checks must query the real checkout-relative `.wld` names.
- A registry entry can name an absent retired worktree. Do not enter that path. An existing path must be proven as a
  worktree of the same repository before selected state is inspected.
- Empty new directories are not an independent authority. Populated new leaves without a valid journal or complete
  marker are conflicts.
- Atomic rename is expected because each source and destination share one routed `.wld` base. Do not silently add a copy
  fallback; it would need a separate write-sync-verify-retire protocol.
- Persistent but unlocked controller lock files do not counterfeit a live writer. Recent malformed Work Record locks
  remain active until their owning stale window expires; use each protocol's rule rather than one generic timeout.
- Migration does not reconcile `../../../../.gitignore`, move normal store callers, or make project entry mandatory.
  Later children own those outcomes.
- Downgrade and mixed 0.9/0.10 use remain unsupported. If an old process recreates legacy state after `layout.json`
  commits, the next 0.10 entry refuses instead of selecting or merging an authority.
