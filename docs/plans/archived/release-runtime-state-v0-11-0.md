---
planId: "9128ddfd-8601-4602-bec2-bc59e41d1d14"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/project-runtime-layout.test.ts"
    - "src/shared/testing/project-runtime-migration-process-driver.ts"
    - "src/shared/collaboration/secrets.js"
    - "src/cmd/plans/collaboration-commands.integration.test.ts"
    - "src/shared/isolated-publication.test.ts"
    - "src/shared/workflow/publication-machine.failure-matrix.test.ts"
    - "src/cmd/plans/doctor.ts"
    - ".github/workflows/release.yml"
    - "scripts/release-policy.test.js"
    - "docs/adr/017-project-runtime-state-under-wld-internal.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/releasing.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-09-16T22:58:37-04:00"
origin: "internal"
targetBranch: "epic/consolidate-project-runtime-state"
status: "user_verified"
userVerifiedAt: "2026-09-24T13:58:40.293Z"
userVerificationNote: "this was done as part of the PR for 0.11 and its now out."
archivedAt: "2026-09-24T15:30:52.585Z"
archivedFromStatus: "user_verified"
archivedFromPath: "docs/plans/release-runtime-state-v0-11-0.md"
---

# Repair and Release Project Runtime State as 0.11.0

## Context

The [runtime-state Epic](consolidate-project-runtime-state.md) reports all eight children complete. The original review
found migration safety gaps and publication refusal for `CLAUDE.md -> AGENTS.md`. Those repairs now exist on the Epic
branch. This re-review, requested on 2026-09-19, retains their requirements but does not ask the Engineer to rebuild
them.

Current evidence:

- [PR #78](https://github.com/gandazgul/runwield/pull/78) is open from `epic/consolidate-project-runtime-state` to
  `main`, at `22fb0fddb46405009063fd7469c132b463984768`. The owner reports that the PR was reviewed. GitHub has no
  formal approving review recorded; do not invent one.
- `234bef3a` implements repairs 1–5 and their regression tests. Later commits include review fixes and test stability
  fixes. The Epic copy of this Plan is marked validated; that does not prove Candidate publication or installation.
- [PR gate run 35317201103](https://github.com/gandazgul/runwield/actions/runs/35317201103) passed at `22fb0fdd`.
  [Native Windows run 35242972855](https://github.com/gandazgul/runwield/actions/runs/35242972855) passed for earlier
  source `a56d754570e7c0ca9b9a43f4fb79c6f3c58ba4fd`. Neither run qualifies a future combined commit.
- Local `main` is `2de48a8b`, with 19 commits absent from the Epic branch. These include publication-retry repairs,
  release-package qualification, and Workspace changes. Runtime consolidation is not yet on local `main`. A later read
  of live remote refs returned `origin/main` at `d567e900`; fetch and inspect that newer source during execution. No
  `release/v0.11.0` branch or `v0.11.0-rc.1` tag was present in that remote read.
- The linked-secret integration fixture preserves a dummy legacy record but uses a newly created capability for its
  collaboration round trip. It still needs to prove that the migrated capability itself works.

This planning session inspected source and existing run results. It did not run tests or change runtime state.

The owner approved repairs, review against `main`, and a new `v0.11.0-rc.1` Candidate before Stable promotion. Versions
0.9 and earlier are outside the supported recovery scope. This is not a new old-version recovery project.

Released `v0.10.0` and `v0.10.1-rc.9` still store project runtime files directly under `.wld/`. Both normally place
execution worktrees under `~/.wld/worktrees/`; the project-local worktree path is only the no-`HOME` fallback. Do not
move normal execution worktrees or imply that all 0.10 worktrees need relocation. Preserve the existing inactive-state
adoption path for 0.10. The Epic already corrects the release boundary to 0.11. Preserve that correction when
integrating current `main`, whose guidance still names 0.10.0.

Owning capabilities:

- [Work protection](../../prd/runwield-core-prd.md#work-protection): repair **Enter project runtime state before use**,
  **Keep Project Runtime State out of repository changes**, and **Preserve user work and require deliberate destructive
  actions**. Preserve the Epic's scenarios for ordinary repository symlinks, linked-checkout adoption, and tracked
  current secrets. Close the migrated-capability verification gap.
- [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve
  delivery and retry for repositories containing symlinks; do not turn a migration failure into deletion or abandonment.
- [Installation and updates](../../prd/runwield-core-prd.md#installation-and-updates): preserve the 0.10-to-0.11 upgrade
  boundary, **Isolate Candidate stabilization from ongoing feature work**, and **Qualify release packages before
  publication and preserve published bytes**. Follow current package ownership and release automation; do not restore
  older package-publication restrictions from the Epic branch.

## Objective

Preserve the implemented repairs, close the migrated-capability test gap, integrate current `main`, and qualify the
combined source for merge and an explicitly confirmed `v0.11.0-rc.1` publication. Stable promotion uses the tested
Candidate source, not a later `HEAD`.

## Approach

Keep the existing layout owner, migration journal, store guards, and release commands. Do not introduce another storage
format, a compatibility service, or an alternative release pipeline.

```text
0.10 project entry
  inspect primary + selected/registered checkouts
  refuse unsafe state before moving files
  adopt eligible state through the existing journal
  use the current primary and selected internal roots

publication checkout containing CLAUDE.md -> AGENTS.md
  validate runtime authority paths, not repository payload symlinks
  publish through the existing Git proof and retry flow
```

Implemented repairs to preserve and verify after integration:

1. **Repository symlinks:** `findSymlinkBlocker()` previously scanned publication repository contents as runtime files.
   The Epic now stops inspection at repository checkout boundaries. Treat repository contents as repository data, not
   runtime authority files. Validate the runtime root, authority paths, and checkout-root boundaries without traversing
   repository symlink targets. Keep rejection of symlinked runtime authorities and paths outside their owning checkout.
   Do not special-case `CLAUDE.md`.
2. **Linked secret adoption:** discover legacy project secret sources in the primary and selected/registered checkouts.
   Adopt a single source into the primary internal store. Independently populated sources or destinations cause a
   non-destructive conflict, not a merge or silent choice. Include later-entered checkouts and interrupted adoption.
   Preserve existing secret schema, global-store behavior, permissions, and redaction.
3. **Primary selected-state checks:** include the primary checkout in selected-state preflight even when entry starts in
   a linked checkout. Its Plan and Work Record locks and journals must not be skipped while shared state moves.
4. **Tracked current secrets:** recognize both old and current project secret paths, including their atomic temporary
   files, as secret exposure. Entry and Doctor must report paths plus history-removal and capability-rotation guidance,
   never secret values.
5. **Project-local fallback worktrees:** retain removal of the unsafe generic move for populated legacy worktree roots.
   Do not add relocation or recovery for old worktrees. If such a root contains work, refuse before any migration effect
   and preserve it. An absent or empty root must not block ordinary adoption. A journal from a failed attempt must not
   bypass this check or resume an unsafe rename. New no-home worktrees still use the primary internal root.

The fifth repair is a narrow preservation check, not support for recovering 0.9 or earlier. The option set aside is
moving Git worktrees and rewriting all recorded paths with interruption recovery; that is disproportionate to this
release. Do not delete older data, infer its installed version from its folder name, or remove the bounded legacy Git
hazard checks merely because old-version recovery is unsupported.

This Plan still targets `epic/consolidate-project-runtime-state`, not `main`. Integrate current committed `main` into
that branch before final validation. Do not include unrelated uncommitted work from the owner's checkout. Recheck live
branch tips; the 19-commit difference is evidence from this review, not a fixed merge input.

Both branches now enable native Windows checks. Preserve current `main` release policy and automation: native Windows
and macOS Homebrew checks before GitHub publication, immutable published assets during recovery, and Stable package
publication. Do not restore an old workflow from the Epic to resolve a conflict. PR review and a green older gate are
useful evidence, not a reason to skip review and checks of the combined source. Merge to `main` remains a separately
confirmed release step.

Before integration, add a real migrated-capability round trip to the existing collaboration fixture. A successful new
share after migration does not prove an old share remains usable. Keep the five repairs unless this test or integration
checks show a specific fault. Rebuilding them would add risk without improving the intended result.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/project-runtime-layout.ts` and its tests/process driver — preserve the implemented source discovery,
  symlink inspection, selected-root checks, safe refusal, and journal replay. Change production code only for a proved
  remaining fault or integration conflict.
- `src/shared/collaboration/secrets.js`, its tests, and `src/cmd/plans/collaboration-commands.integration.test.ts` —
  prove the same capability stored before migration remains usable from linked checkouts, without creating a new
  capability or relying on a global secret copy.
- `src/shared/isolated-publication.test.ts`, publication failure-matrix/e2e tests, and runtime-entry integration tests —
  exercise actual publication and restart with ordinary repository symlinks. Change production publication code only if
  the layout-owner fix is insufficient.
- `src/cmd/plans/doctor.ts` and tests — current secret warnings, correct upgrade-version guidance, and preserved
  report-only inspection behavior.
- `.github/workflows/release.yml`, `scripts/release-policy.test.js`, and package checks as needed — preserve current
  `main` qualification and publication rules during integration. Verify both native package gates. Reuse existing
  diagnostic workflows if needed; do not create a replacement pipeline.
- `docs/adr/017-project-runtime-state-under-wld-internal.md`, relevant ADR-005 references, `docs/releasing.md`,
  `docs/usage.md`, architecture/collaboration guidance, and the owning Core PRD capabilities — correct the release
  boundary and document the narrowed fallback rule in the same change. Historical Work Records stay historical.
- `docs/plans/consolidate-project-runtime-state/manual-qa.md` — record new final-state checks with actual results; do
  not mark obsolete intermediate-child checks complete as if they apply to the finished layout.
- `.gitignore` — reconcile only the known managed runtime block as an explicit code change. Never stage local runtime or
  secret files exposed by removal of the old ignore entries.

No domain terms or ownership relationships change. Verify `docs/domain-language.md` remains consistent; no glossary
rewrite is planned. Home-directory state, normal home-based worktrees, browser design, manual first-listing work, and
0.9-or-earlier recovery are out of scope. No new package-distribution implementation is planned; the existing release
workflow's package checks and Stable publication remain required.

## Reuse Opportunities

- `resolveProjectRuntimeLayout()`, `resolvePrimaryCheckoutRoot()`, and existing Git worktree discovery retain checkout
  ownership. `preflight()`, `buildOperations()`, and journal validation remain the migration authority.
- `defineGitFixture`, existing migration process-driver cases, and collaboration HTTP fixtures provide real filesystem,
  Git, and capability round trips. Do not add public test-injection hooks for owned machinery.
- `docs/releasing.md` and `scripts/release.js` already own Candidate creation, exact-source promotion, and retry policy.
- `deno task pr:check` already combines the full source gate and Golden TUI tests. Release qualification adds compiled
  binary checks; passing child Plans is not a substitute.

## Implementation Steps

The original repairs are implemented on the Epic branch. The open steps below describe remaining work, not a reset of
that completed implementation.

- [ ] A collaboration integration test seeds a valid existing shared Plan and matching 0.10 secret only in a linked
      checkout. After entry, the same migrated content key decrypts the shared content and the same maintainer
      capability authorizes a push. No new share, replacement capability, or global secret copy can satisfy the test.
      Run through the normal named pull/push commands so they load the migrated store; do not pass fixture credentials
      directly to the client. Removing or corrupting that record makes the same command round trip fail, not merely a
      separate store-read assertion. Fix production code only if it fails.
- [ ] Repairs 1–5 and their behavioral tests remain intact on the combined source. Journal restart still preserves
      secret-source identity and rejects unsafe fallback moves. Existing test coverage is retained, not replaced with
      helper-only assertions.
- [ ] Current committed `main` is integrated into the Epic with a recorded reviewed commit. Preserve its publication,
      Session, dependency, Workspace, release-package, and Golden-test fixes, plus the Epic's approved side Plans. No
      unrelated user changes or runtime files enter commits.
- [ ] Both native package checks remain enabled and publication requires their success. Before merge, workflow tests
      confirm those dependencies. During tagged release qualification, the selected source passes actual Windows and
      macOS Homebrew checks. A failed check remains a release blocker, never permission to skip the gate.
- [ ] Current ADRs, PRD scenarios, runtime messages, and user guidance retain the 0.11 boundary and supported 0.10
      adoption while keeping newer `main` requirements. Current references agree after integration. Historical version
      references stay historical; unresolved requirements remain explicit. Release notes explain the breaking change
      relative to the previous Stable.
- [ ] The combined candidate-to-merge commit passes the automated source checks below. Review and test evidence identify
      the exact source, commands, outcomes, and remaining limitations. The Plan's repairs land on the Epic branch. Merge
      of the Epic branch to `main` occurs only after this gate and separate owner confirmation; any intervening source
      changes require renewed review and affected validation.
- [ ] The release handoff identifies the committed source containing the merged repairs, proposed Candidate tag,
      cumulative notes, exact commands, and operator confirmation checkpoints. Candidate publication and later Stable
      promotion follow the sequence below; neither is claimed complete from a prepared checklist or pushed tag alone.

### Candidate and Stable handoff

Follow [repository release policy](../../releasing.md). On 2026-09-19, GitHub reports `v0.10.3` as latest Stable and
`v0.10.4-rc.1` as the newest published Candidate. Recheck releases, tags, and `release/v0.11.0` before publication. Keep
`v0.11.0-rc.1` as the proposed tag, subject to that preflight.

1. Prepare temporary cumulative notes from the previous Stable to the intended source. Include the one-way project
   layout change, preserved settings/Agents/Skills/prompts, unsupported downgrade or mixed versions, and safe handling
   of unfinished 0.10 work. Verify claims against production code. Do not list internal Plans as features.
2. After the separately confirmed merge, from the intended committed source containing the repairs:
   `deno task release:candidate --tag v0.11.0-rc.1 --dry-run`. RC1 normally creates `release/v0.11.0` and its tag
   atomically from `HEAD`. If that remote branch already exists, the command selects its pushed tip instead. Verify the
   resolved source is the qualified source; do not assume the current checkout controls a retry.
3. Show the resolved source, Release Branch, tag, notes file, and command. Obtain explicit confirmation before
   `deno task release:candidate --tag v0.11.0-rc.1`. Monitor the tag workflow through native Windows and macOS Homebrew
   qualification and asset publication. Edit notes with
   `gh release edit v0.11.0-rc.1 --notes-file <temporary-notes-file>` and verify them.
4. Verify all workflow-defined assets and checksums, Candidate binary identity, `isPrerelease: true`, and unchanged
   GitHub latest Stable. Install by explicit Candidate tag in an isolated user environment and run the checks below.
5. After successful Candidate checks and a separate owner go-ahead, prepare cumulative Stable notes and run
   `deno task release:promote --candidate v0.11.0-rc.1 --dry-run`. Confirm the proposed tag and source before
   `deno task release:promote --candidate v0.11.0-rc.1`.
6. Verify Candidate and Stable tags peel to the same commit, Stable binaries report `v0.11.0`, qualification and assets
   succeeded, latest now names that Stable, and the curated Stable notes landed. Verify the workflow's existing Stable
   Homebrew publication and WinGet submission outcomes. A submitted WinGet PR is not proof of Microsoft acceptance. No
   new distribution system or manual first-listing project is part of this Plan.

If Candidate testing needs a source fix, apply and push it first to `release/v0.11.0`, publish a later Candidate from
that pushed branch, and explicitly forward-port the fix to `main`. Never merge `main` into the active Release Branch.
Any release-fix Plan must target that Release Branch. Use the tested Candidate consistently in promotion. Released tags
are immutable. Unreleased failed attempts follow the repository's retry policy; never delete a published release to
reuse its tag. Assets published with notes still pending means an incomplete release, not success.

## Approval Confirmation

No Work Record supersession is proposed. The owner approved repairs and Candidate-first release. Plan approval does not
replace the separate source/tag confirmation before publication or the later Stable-promotion decision. Recommend an
Engineer with paired checkpoints for final merge readiness and release operations.

## Verification Plan

Use the safe runner, never `deno test` directly. Use disposable repositories and sandboxed home directories; do not run
migration against this working checkout or the owner's actual runtime state to prove correctness.

Before merge, run the automated source checks below and review the combined diff. After confirmed tagging, verify native
package runs, published assets, and installed Candidate behavior. These later checks cannot be claimed from the
pre-merge results. Record each result against its exact source commit.

```sh
deno run -A scripts/run-tests.js src/shared/project-runtime-layout.test.ts src/shared/project-runtime-entry.integration.test.ts src/shared/collaboration/secrets.test.js src/cmd/plans/collaboration-commands.integration.test.ts src/cmd/plans/doctor.test.ts src/shared/isolated-publication.test.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-machine.e2e.test.ts src/shared/worktree-creation.test.ts scripts/release-policy.test.js scripts/release.test.js
deno task pr:check
deno task release:check --build-version v0.11.0-rc.1
```

`pr:check` runs `ci` and Golden TUI tests, including the zero-seam check through `ci`. `release:check` exercises the
compiled binary and additional release checks; tagged GitHub Actions remains the authoritative release environment.
Native Windows verification uses `deno task package:windows:check --package <built-candidate-zip>` on Windows, not a
Unix stand-in.

Required discriminating evidence:

- **Symlink success:** commit `AGENTS.md` and `CLAUDE.md -> AGENTS.md` in a real repository. Publish a real changed
  commit through local and remote-backed publication; assert target ancestry, content, retained symlink target, and
  successful cleanup. Interrupt/retry with the populated publication checkout still present and prove delivery works.
  This protects against reintroducing the old recursive scanner and cannot pass if publication is a success stub.
- **Symlink safety:** symlink the internal root, a runtime authority file/directory, or a publication checkout root to
  an external sentinel directory. Entry must refuse before reading/writing external runtime data. Ordinary payload
  symlinks, including directory links, must not be followed by migration inspection. Prove both sides; deleting all
  symlink checks is not a fix.
- **Secrets:** seed a real 0.10-format secret only in a linked checkout, without a global copy, for a shared Plan
  already present in the collaboration HTTP fixture. Enter, pull/decrypt its known content, and push a change using that
  exact migrated record. The server must validate the original maintainer capability. Do not call share again or supply
  a capability URL that repopulates secrets. Assert returned content, remote revision, and primary storage
  bytes/permissions. Normal named pull/push commands must load the migrated store. Corrupting or removing its record
  must fail those same commands; a separate store-read assertion is not enough. Test primary-only, multiple conflicting
  sources, populated destination, later selected checkout, and process interruption after rename/before marker.
  Conflicts preserve every source and do not leak values.
- **Primary locks:** enter from an unregistered linked checkout while another process holds each relevant primary legacy
  Plan/Work Record lock. Assert refusal with no migration or normal-store effects. Release the lock and repeat; primary
  and selected journals adopt, recorded roots are correct, and retry succeeds.
- **Secret exposure:** force-stage old and current secret paths and representative temporary paths. Both entry and
  Doctor report security guidance and exact paths, preserve the index and bytes, and never print sentinel secret values.
- **No fallback relocation:** use a real Git worktree under the legacy project-local root, including dirty/untracked
  work and registry references. Assert refusal before any move, unchanged worktree registration/paths/refs/content, and
  unchanged migration/index/ignore files. Repeat with a pending journal that names the unsafe rename. Absent/empty roots
  permit adoption; ordinary home-based worktrees still operate at their original paths.
- **Release gates:** assert the parsed workflow enables native Windows and macOS Homebrew qualification and requires
  both for publication. Confirm the actual tagged run executes both checks successfully for the selected source. A
  skipped job, an older PR run, or a green build-only run is insufficient. Verify Candidate checks do not publish to
  Stable package channels and that Stable follows the existing publication workflow.

Manual Candidate checks, with recorded outcomes:

- Install the explicit Candidate in an isolated user environment. Exercise a fresh project and a disposable 0.10 project
  with inactive runtime records and custom ignore rules; use an actual 0.10-generated fixture where practical. Confirm
  one adoption, unchanged settings and capability content, one internal ignore entry, and a byte-stable second entry.
- Run the owner's symlink publication journey with the compiled Candidate. Verify delivery, not only successful startup.
- Inspect an unfinished 0.10 publication and a blocked layout with `doctor --check`; named work remains preserved.
  Confirm help, version, and an empty unsubmitted TUI do not migrate. Do not test downgrade against adopted data.
- Verify package-owned update guidance and compiled Workspace/Plan Review checks from the existing release suite remain
  intact. Record gaps as blockers, not passed checks.

Existing coverage must still protect lock ownership, atomic journal restart, publication proof and retry, secret schema
and redaction, selected versus primary ownership, tracked-runtime refusal, report-only Doctor inspection, and global
state. Replace tests that expect broad repository-symlink rejection, skipped primary roots, or movement of populated
fallback roots with the corrected behavioral assertions; do not drop their preservation checks. Confirm the PRD/ADR
changes match this scope and the glossary still describes implemented ownership.

## Edge Cases & Considerations

- The current checkout is dirty, including unrelated workflow code, docs, and UI changes. The Plan's status change to
  `feedback` is intentional. Preserve all unrelated changes and the revised Plan during branch integration; do not
  replace it with the Epic's older validated copy. `.gitignore` was dirty during the original review, but is not dirty
  now. Use explicit staging; never `git add .`, broad cleanup, or forced migration as release preparation.
- Published 0.10 uses the old project layout despite the Epic's original 0.10.0 wording. The layout marker version is a
  storage-format version, not the package version; do not bump it merely to match 0.11.
- Symlink success must not weaken runtime path containment. Repository payload and runtime authority need separate
  inspection boundaries even when both are physically beneath `.wld/internal/`.
- No new promise of 0.9-or-earlier recovery, automatic worktree relocation, secret-store merging, or downgrade support.
  Preserve uncertain data rather than resetting it. Existing old-format recognition remains useful for Git safety.
- Readiness is commit-specific. Recheck remote `main`, tags, workflows, and assets at execution time; the planning SHAs
  and release inventory are evidence from one date, not permanent source selections.
- A failed package check, missing credential, failed publication, or pending notes edit remains an explicit incomplete
  step. Keep truthful evidence and obtain the needed repair or operator action before declaring release completion.
