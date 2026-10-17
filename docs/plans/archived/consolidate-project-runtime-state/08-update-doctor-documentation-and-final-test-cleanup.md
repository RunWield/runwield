---
planId: "6ec4a242-ca8e-4d00-ba74-fe141b7159a7"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/plans/doctor.ts"
    - "src/cmd/plans/index.ts"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/runwield-owned-paths.ts"
    - "src/shared/project-runtime-entry.integration.test.ts"
    - "src/plan-store.js"
    - "src/shared/workflow/controller-registry.ts"
    - "src/shared/workflow/state-transition.ts"
    - "src/shared/workflow/transition-recovery.ts"
    - "src/shared/workflow/planning-worktree.ts"
    - "docs/prd/runwield-core-prd.md"
    - "src/cmd/plans/doctor.test.ts"
    - "src/cmd/plans/doctor-messages.test.ts"
    - "docs/architecture.md"
    - "docs/plan-lifecycle.md"
    - "docs/collaboration.md"
    - "docs/validation-authority.md"
    - "docs/adr/005-concurrent-worktree-isolation.md"
    - "docs/adr/016-proof-bearing-publication-state-machine.md"
    - "docs/adr/017-project-runtime-state-under-wld-internal.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-29T03:05:00.286Z"
origin: "internal"
parentPlan: "consolidate-project-runtime-state"
order: 8
dependencies:
    - "07-enforce-git-and-publication-safety"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
status: "validated"
---

# Update Doctor Documentation and Final Test Cleanup

## Context

The earlier child Plans implement the runtime layout, migration, moved stores, entry guards, and Git safety. The final
slice must make the behavior understandable and prove no temporary test skip remains for this Epic.

Plan Doctor and docs must explain blocked migration, tracked legacy files, broad ignore rules, committed secrets, stale
locks, unsupported old-writer activity, and active-publication upgrade stops without deleting uncertain state.

Verified on `epic/consolidate-project-runtime-state` at `bcd6a654`, after the completed merge from `main`: children
01–07 are validated and their code is present. The merged Core PRD retains their runtime requirements under Work
protection. This Plan extends that implementation; no prerequisite branch update or migration reimplementation is
needed.

`runPlansCommand` calls `enterProjectRuntime` before Doctor. That can throw before Doctor explains a refusal, or migrate
files before `--check` prints “No files changed.” Doctor's downstream readers also cause writes: Plan loads can import
controller metadata, resource listing takes a catalog lock, journal reads enter runtime, and target-branch Plan
discovery can fetch into the primary repository. `repair=false` alone does not prevent these effects. `runPlansDoctor`
also serves the validation supervisor, so its programmatic result and safe repair behavior must survive.

Owning product capabilities:

- [Core: Work protection](../../../prd/runwield-core-prd.md#work-protection) — preserve user work and deliberate
  destructive actions. Reconcile the Epic's existing runtime-exclusion scenarios here: runtime files stay out of
  commits, tracked runtime files cause refusal without index changes, and broad user ignore rules remain untouched.
- [Core: Execution, validation, and recovery](../../../prd/runwield-core-prd.md#execution-validation-and-recovery) —
  preserve repair of RunWield-owned bookkeeping, truthful evidence, and recoverable workflows. Doctor is an optional
  diagnostic tool, not a new mandatory user-operated recovery step.
- [ADR-017: One-way migration](../../../adr/017-project-runtime-state-under-wld-internal.md#one-way-0110-migration) —
  accepted upgrade behavior. Add its user-visible safe-adoption and protected-stop scenarios to Core Work protection.
  Link that guidance from [Core: Installation and updates](../../../prd/runwield-core-prd.md#installation-and-updates)
  without duplicating requirements or changing package-manager behavior.

Add acceptance scenarios for non-mutating Doctor inspection, useful refusal guidance, and secret-safe output within
these existing sections. No product requirement is removed. Preserve the merged central capability structure and its
automatic-recovery requirements. Keep updates local to affected capabilities and references; no unrelated PRD rewrite.

## Objective

Finish the Epic branch so it is ready for final delivery to `main`: diagnostics are actionable, docs name the new
canonical paths, ADRs stay consistent, and CI passes with no temporary skipped tests from this Epic.

## Approach

Update diagnostics and docs after behavior exists, then run a final cleanup pass over tests introduced or skipped during
the child sequence. Keep default Doctor repair, explicit `--repair`, and `--check` precedence unchanged.

```text
plans doctor dispatch (no eager migration)
  Doctor inspects layout through the shared layout owner
    blocked -> return diagnostic issues; no normal store access or repair
    adoption needed + --check -> report pending adoption; do not migrate
    safe + repair -> guarded entry, then existing proven repairs
    adopted + --check -> read-only inspection; do not reconcile or write
```

Give the layout owner a read-only inspection operation that shares its refusal checks and typed reason/path/security
results with migration. Do not call migration to obtain a diagnostic result. Inspection is advisory; repair must still
run guarded entry and repeat its checks before mutation. A blocked inspection may report the first safe blocker; do not
read beyond a symlink or malformed authority to gather more findings. Report ignore-rule warnings through the same pure
reconciliation logic used by `runwield-owned-paths.ts`, without writing the proposed content.

Make Doctor own this ordering for both CLI and direct callers. Keep normal store entry guards intact. For an unadopted
layout, report that adoption is pending and stop the ordinary store scan rather than reading legacy stores as current
state. For an adopted layout, ensure diagnostic reads cannot create migration metadata, rewrite ignore rules, or
reconcile journals. Reuse existing read-only store inspection where possible; any needed diagnostic access remains owned
by its store and is not a test injection hook.

The inspected call path determines the additional work:

| Current Doctor dependency                                                                                   | Required diagnostic behavior                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadPlanStrict` / archived loads → `withControllerMetadata` → `loadControllerView`                         | Read existing authoritative controller/registry facts without importing legacy fields, clearing recovery hints, or writing revisions. Report pending repair instead of performing it. Preserve execution-document selection. |
| `listPlanResources({backfillMissing:false})` → `withPlanCatalogLock`                                        | Inspect resources without creating catalog locks or backfilling identities. Keep duplicate/missing identity findings and archived/linked-worktree coverage.                                                                  |
| `inspectWorktreeRegistry` → runtime entry                                                                   | After safe layout inspection, reuse `inspectWorktreeRegistryAtPath` on the inspected authoritative path. Do not weaken normal guarded registry access.                                                                       |
| `listTransitionRecoveryRecords` / `reconcileTransitionRecoveryRecords({apply:false})` / `buildEffectProver` | Inspect journals and Plan facts without runtime entry or mutating Plan loads. Share the existing evidence rules; only repair applies cleanup.                                                                                |
| Target-branch Plan discovery → `resolveExistingTargetSnapshot`                                              | Keep discovery of target-branch children, but do not fetch into the inspected repository. Obtain fresh remote evidence in disposable scratch storage when needed.                                                            |

Here, read-only means no changes to project files, runtime stores, inspected Git repositories, or persistent user state,
including transient lock files. Existing remote inspection may create a disposable temporary clone outside those roots,
fetch into that clone, and remove it. Preserve `isCommitPublishedToTarget` and the test for a published remote commit
while the local branch is behind. Do not replace remote proof with a local-only guess or drop target-branch children.
This is the existing inspection model, not permission to run migration against a copy and treat it as current authority.

`--check` shows detailed findings. Keep ordinary repair summaries short; on migration refusal, also show the reason,
affected paths, safe next action, and what retry will do. Never print secret contents or recommend Git restoration of an
ignored runtime registry. Repair removes only locks proven stale by their owning protocol, rechecks the observed lock
before removal, and reports success only after confirmed removal. Age alone must not override positive evidence of a
live holder; uncertain locks are not disposable.

The final user-facing story should be:

```text
.wld/settings.json, agents, skills, prompts -> user-trackable project content
.wld/internal/**                            -> RunWield machine-owned runtime state
legacy runtime paths                        -> migration/safety hazards only
```

The main option set aside is making documentation a separate ninth child Plan. Keeping final docs and test cleanup
together makes this the clear release-readiness slice.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/cmd/plans/doctor.ts` and `../../../../src/cmd/plans/index.ts` — make diagnostics reachable before
  mutation; report migration blocks, conflicts, broad `../../../../.wld` ignore rules, tracked files, exposed secrets,
  stale locks, and old-writer activity.
- `../../../../src/shared/project-runtime-layout.ts` — share migration inspection facts without performing migration or
  creating a second migration policy. Keep refusal checks and guarded entry authoritative.
- `../../../../src/shared/runwield-owned-paths.ts` — reuse pure ignore-rule analysis for report-only warnings.
- `../../../../src/plan-store.js` and `../../../../src/shared/workflow/controller-registry.ts` — support diagnostic
  Plan/controller reads without catalog locks, metadata import, recovery-hint cleanup, or loss of authoritative document
  selection.
- `../../../../src/shared/worktree-registry.js` — reuse exact-path inspection after layout checks; retain guarded normal
  access.
- `../../../../src/shared/workflow/state-transition.ts` and `../../../../src/shared/workflow/transition-recovery.ts` —
  share journal/effect evaluation with diagnostic Plan reads while leaving mutation on the repair path.
- `../../../../src/shared/workflow/planning-worktree.ts` — keep target-branch child discovery without fetching into the
  inspected repository. Reuse the scratch-inspection pattern in `../../../../src/shared/isolated-publication.ts`;
  preserve publication proof.
- `../../../../src/shared/project-runtime-entry.integration.test.ts` and layout tests — prove real dispatch and direct
  Doctor callers preserve entry safety and report-only behavior.
- `../../../prd/runwield-core-prd.md` — align owning capability requirements and scenarios with delivered behavior,
  retaining unresolved recovery requirements as targets rather than claiming this diagnostic change fulfills them all.
- `../../../../src/cmd/plans/doctor.test.ts` and `../../../../src/cmd/plans/doctor-messages.test.ts` — prove the
  diagnostic messages are specific and non-destructive.
- `../../../architecture.md` — describe the new project-runtime boundary and authority split.
- `../../../plan-lifecycle.md` — describe Plan locks, transition journals, controller records, and registry locations
  under the new layout.
- `../../../collaboration.md` — describe project-local and global secret store locations and cleanup/security guidance.
- `../../../validation-authority.md` — describe validation and publication authority with the new internal paths.
- `../../../adr/005-concurrent-worktree-isolation.md` and `../../../adr/016-proof-bearing-publication-state-machine.md`
  — retain decisions but name the new canonical locations.
- `../../../adr/017-project-runtime-state-under-wld-internal.md` — keep the accepted decision aligned with
  implementation details if needed.
- `../../../domain-language.md` — reconcile glossary terms with implemented behavior.
- Tests changed during this Epic — remove any temporary skip or ignore markers introduced to keep intermediate slices
  green.

## Reuse Opportunities

- `../../../../src/cmd/plans/doctor.ts` — reuse existing diagnostic structure and recovery-action style.
- `../../../../src/shared/project-runtime-layout.ts` — reuse `ProjectRuntimeMigrationBlockedResult`,
  `ProjectRuntimeEntryRefusedError`, layout resolution, and preflight checks. Its existing `preflight` is private;
  expose a cohesive read-only inspection operation, not individual migration internals.
- `../../../../src/shared/runwield-owned-paths.ts` — share `reconcileGitignore` warning calculation with the writing
  entry point.
- `inspectWorktreeRegistryAtPath` and `inspectPlanIdentityDocuments` — existing non-mutating inspection, used only after
  layout safety checks. Share parsing/evidence rules with normal reads rather than duplicating the storage model.
- `isCommitPublishedToTarget` — existing remote proof through a temporary clone, without modifying project refs.
- `../../../../src/shared/lock-file-snapshot.ts` and `../../../../src/shared/process-liveness.ts` — reuse lock identity
  and holder evidence for safe stale-lock cleanup, respecting each owning lock protocol.
- `defineGitFixture`, existing migration fixtures, and `withProcessGlobalTestLock` — real Git and filesystem evidence
  with sandboxed home/cwd. Do not add dependency-injection seams for RunWield-owned behavior.
- Existing documentation pages and ADRs — update canonical paths without reopening accepted decisions.

## Implementation Steps

- [ ] CLI dispatch and direct `runPlansDoctor` calls inspect layout before normal store access. `--check` never migrates
      or repairs. Pending adoption is reported without claiming the ordinary store scan completed. Blocked migration
      returns diagnostic issues, not a blind throw or a clean result. All normal store guards remain enforced.
- [ ] Adopted-layout checks preserve controller records and recovery hints, create no catalog locks, leave journals and
      Plan identities unchanged, and do not fetch into inspected repositories. They still discover archived Plans,
      authoritative execution documents, and target-branch children, and still prove remote publication through scratch
      inspection. Shared read/evidence rules prevent Doctor from becoming a second storage implementation.
- [ ] Doctor maps every existing migration refusal reason to useful guidance, including newer layout, malformed
      evidence/registry, invalid registered checkout, unsupported move, old/new authority conflict, tracked runtime or
      secrets, symlink, live old writer, unfinished publication, and saved repair root. It preserves reason and safe
      paths. Unfinished legacy publication retains pre-0.10.0 finish-or-deliberately-abandon guidance; no recovery state
      is moved or deleted to clear the stop.
- [ ] Default repair and `--repair` still perform safe adoption and proven repairs. A refusal reports what prevents
      progress and what retry continues. `--check` still wins when both flags are supplied. Broad `../../../../.wld`
      rules are reported and retained in both modes.
- [ ] Stale-lock diagnostics distinguish proven stale state from live or uncertain state. Repair rechecks lock identity,
      never deletes a proven live holder's lock because it is old, and counts only completed removals. Proven abandoned
      locks and settled transition records remain automatically repairable; uncertain work stays intact.
- [ ] Messages name exact safe paths, never print secret bytes, and explain untracking versus history exposure and
      capability rotation. Existing short normal repair summaries remain short. No message suggests restoring the
      ignored registry from Git or manually deleting an uncertain lock.
- [ ] Architecture, lifecycle, validation-authority, collaboration, and troubleshooting or release-facing docs describe
      `../../../../.wld/internal` as the machine-owned project-runtime boundary.
- [ ] ADR-005 and ADR-016 retain their decisions but name the new canonical runtime locations.
- [ ] ADR-017 remains consistent with the final implementation.
- [ ] `../../../domain-language.md` keeps the existing Project Runtime State, Project Runtime Entry, Project Internal
      Root, Primary-Checkout Runtime State, and Selected-Checkout Runtime State definitions. Their avoided aliases and
      stable relationships match the final implementation; diagnostic inspection is not described as completed adoption.
      No duplicate or speculative terms are added.
- [ ] Owning Core PRD capabilities and affected references match verified behavior. Runtime exclusion, report-only
      diagnostics, safe adoption, blocked-upgrade preservation, and secret-safe guidance have acceptance scenarios.
      Automatic recovery requirements remain authoritative; unmet work is still labeled target or deferred.
- [ ] A review of the child-series test diffs and history accounts for skips, ignored tests, TODOs, deleted tests, early
      returns, excluded files, and removed assertions. Each Epic workaround is gone. Each removed case has an active
      replacement or a specific obsolete-behavior reason recorded in execution evidence. A changed path or fixture is
      not a reason to delete coverage. Do not remove unrelated platform skips.
- [ ] Final CI and the separate golden TUI task pass with runtime migration, interruption recovery, path ownership, Git
      safety, Doctor, Session Runtime, ACP, Init, and collaboration coverage active.

## Verification Plan

### Behavioral checks

Use real filesystem/Git fixtures through `runPlansCommand(["doctor", ...])` as well as direct `runPlansDoctor` calls.
Capture stdout and stderr. Seed raw legacy files without first calling a current writer that would migrate them. For
no-change assertions, compare file sets, bytes, modes and mtimes, `../../../../.gitignore`, Git index, refs, and
preserved publication/repair paths; ignore access times. Include linked checkouts and symlink targets in preservation
checks. The no-write scope includes inspected repositories and persistent home state; disposable remote-inspection
clones are allowed only outside those roots and must be cleaned. Snapshot project remote-tracking refs and `FETCH_HEAD`
too.

| Starting condition and action                                                                                                                                  | Required evidence                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inactive legacy state plus custom ignore rules; run `--check`                                                                                                  | Pending adoption is explicit; no marker, directory, lock file, migration, ignore rewrite, or ordinary store repair occurs. A normal repair/entry then adopts once; a repeated entry is stable.                                                               |
| Adopted layout with a repairable journal and stale lock; run `--check`                                                                                         | Findings identify the actual files; all files stay unchanged. Default repair resolves the proven-safe facts; a second check is clean.                                                                                                                        |
| Adopted layout with importable legacy Plan metadata, an absent controller record, or an existing record with obsolete recovery hints                           | Check reports the relevant facts without creating a controller record, changing its revision, clearing hints, backfilling Plan IDs, or creating a catalog lock. Existing authoritative execution documents still control findings.                           |
| Sequence/completion journals, and a separate journal with no completed effects whose Plan has importable legacy metadata or obsolete controller recovery hints | Check evaluates both the effect-proof branch and the before-state comparison branch without mutating controller or Plan state. A normal `loadPlan` hidden in either branch fails this test. Repair retains the same proof rules before cleanup.              |
| Epic target branch and published commit exist remotely while local refs are behind                                                                             | Check finds the remote child Plans and proves publication without changing project refs, `FETCH_HEAD`, objects, or index. Temporary clones are cleaned. No local-only fallback can report the full check as successful.                                      |
| Each refusal reason supported by the layout owner; run Doctor check and repair                                                                                 | Actual fixture evidence yields the matching reason, safe paths, and useful action. No normal store access after refusal and no destructive change. Use exhaustive message tests for reason coverage plus real fixtures for each reachable preflight refusal. |
| Unfinished publication or saved repair checkout                                                                                                                | Both CLI modes explain the pre-0.10.0 recovery route; registry, controller, clone, refs, and ignore files remain unchanged.                                                                                                                                  |
| Independently populated old/new authorities, malformed registry, newer marker, or legacy state recreated after adoption                                        | Doctor does not report clean, silently choose an authority, or delete either copy.                                                                                                                                                                           |
| Tracked current/legacy runtime files and a tracked secret containing a unique sentinel                                                                         | Exact affected paths appear; neither output stream contains the sentinel. File/index/history stay unchanged. Guidance distinguishes untracking from rotation and history remediation.                                                                        |
| Broad user `../../../../.wld` rule                                                                                                                             | Warning says it hides settings, Agents, Skills, and prompts. Neither mode removes the rule. A configuration-only control is not reported as runtime exposure.                                                                                                |
| Dead holder, old live holder, uncertain holder, or replaced lock                                                                                               | Only proven stale, unchanged locks can be removed. Live/uncertain/replaced locks survive. A failed removal is not counted as repaired. Use real holder processes and existing lock snapshot tests, not an injected remover.                                  |
| Primary and linked selected checkout                                                                                                                           | Messages name the correct primary-shared and checkout-local paths; inspection creates no second registry or secret store and does not move selected locks/journals.                                                                                          |
| `doctor --help`, and `doctor --check --repair`                                                                                                                 | Help makes no runtime changes. Combined flags remain report-only.                                                                                                                                                                                            |

The dispatch tests fail if the eager entry call remains. Pending/adopted no-change tests fail if inspection delegates to
migration or normal mutating reads. Refusal fixtures fail if Doctor returns an empty report or hard-coded generic text.
The successful repair test fails if Doctor becomes a report-only stub. Inspect call ordering as well as snapshots:
snapshots alone cannot prove forbidden reads did not occur or transient files were never created. Trace the Plan,
controller, registry, journal, and target-discovery calls listed above. The new adopted-layout tests must fail if they
retain mutating `loadControllerView`, catalog locking, or project-local fetches behind a diagnostic wrapper.

Retain existing tests for malformed/duplicate Plan identities, registry conflicts, archived Plans, safe settled-journal
repair, unclaimed-worktree preservation, and local/remote Git ancestry as publication evidence. Retain migration
process-stop recovery, refusal/retry, direct-store guards, permissions, empty TUI deferral, primary/selected ownership,
and tracked/staged/renamed/deleted runtime Git safety from earlier children. Expected removals are only normal legacy
write-target assumptions, enumerated generated ignore entries, and tests requiring unsafe cleanup or guard bypass.
Re-express their still-valid outcomes against the new layout rather than deleting whole scenarios.

### Commands and cleanup review

- Focused diagnostics and entry:
  `deno run -A scripts/run-tests.js src/cmd/plans/doctor.test.ts src/cmd/plans/doctor-messages.test.ts src/shared/project-runtime-layout.test.ts src/shared/project-runtime-entry.integration.test.ts src/shared/runwield-owned-paths.test.ts`.
- Diagnostic dependency regressions:
  `deno run -A scripts/run-tests.js src/plan-store.test.js src/shared/workflow/transition-recovery.test.ts src/shared/workflow/planning-worktree.test.ts src/shared/isolated-publication.test.ts`.
- Cross-store and surface coverage:
  `deno run -A scripts/run-tests.js src/shared/worktree-runtime-state-isolation.test.ts src/shared/worktree-registry.test.js src/shared/workflow/controller-registry.integration.test.ts src/shared/workflow/state-transition.test.js src/shared/work-records/supersession.test.ts src/shared/collaboration/secrets.test.js src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/session/session-runtime.test.js src/acp/server.test.js src/cmd/init/index.test.ts src/cmd/plans/collaboration-commands.integration.test.ts`.
- Review test history from the Epic branch point through all eight children, not only the final diff or comments naming
  the Epic. Record each disabled/deleted/weakened case and its final disposition. Inspect test-runner exclusions too. No
  Epic-specific skip, early return, empty test, or reduced assertion may stand in for working behavior.
- Gates: `deno task seams:check`, `deno task ci`, and `deno task test:golden-tui`. The normal test task excludes golden
  TUI directories, so CI alone is not evidence for that coverage. Never run `deno test` directly.

### Manual and document checks

- In disposable Git projects, follow the documented `--check` and upgrade sequence for inactive legacy state and saved
  unfinished publication. Verify the matrix outcomes, custom ignore preservation, and repeat-entry stability.
- Repeat from a linked execution worktree. Inspect primary-shared versus selected-checkout paths and retained user
  settings, Agents, Skills, and prompts. Global `~/.wld` data and normal home-based worktrees do not move.
- Compare each current path in architecture, lifecycle, collaboration, validation authority, ADR-005/016/017, and the
  glossary with the implemented layout. Old paths may remain only when clearly identified as legacy/historical examples.
  Do not mechanically rewrite global paths or unrelated externally configured storage paths.
- Follow affected PRD/ADR links. Confirm named requirements and scenarios match these checks and preserve the merged
  central capability structure. Better diagnostics must not be presented as completion of unimplemented automatic
  recovery. The Installation and updates link must lead to the owning Work protection scenarios.
- Semantic Review checks the test-disposition evidence and actual assertions, not merely a green summary or absence of
  skip text. Expected result: documentation and diagnostics describe the final behavior, not intermediate branch states.

## Edge Cases & Considerations

- Do not remove a user's broad `../../../../.wld` ignore rule automatically.
- Do not claim tracked secrets are made safe by moving them; explain rotation and repository-history remediation can be
  required.
- Documentation must distinguish project-local runtime state from global `~/.wld` state.
- Read-only inspection cannot promise that a writer will not appear later. Guarded entry rechecks before repair; Doctor
  reports any resulting refusal instead of proceeding with stale inspection facts.
- Keep the one-way 0.10.0 boundary and accepted ownership model. This Plan does not translate active publication clones,
  support downgrade, redesign recovery, publish a release, or rewrite repository history.
- This final slice removes temporary skips from earlier slices; after it, the Epic branch should be ready for final
  delivery review. No skip was found by the initial added-line scan, but that is not proof of complete coverage.
