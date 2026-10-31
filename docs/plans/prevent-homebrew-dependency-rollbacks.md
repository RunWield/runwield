---
planId: "274d740a-4fd9-4152-824d-d2e90d84f5e3"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - ".github/workflows/release.yml"
    - ".github/workflows/homebrew-prepare.yml"
    - "scripts/package-homebrew.ts"
    - "scripts/package-homebrew.test.ts"
    - "scripts/release-policy.test.ts"
    - "docs/releasing.md"
    - "packaging/homebrew/README.md"
    - "docs/prd/runwield-core-prd.md"
tickets:
    - url: "https://github.com/RunWield/runwield/issues/466"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-30"
origin: "internal"
status: "ready_for_work"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
---

# Prevent Homebrew Dependency Rollbacks

## Context

RunWield releases overwrite an independently released Mnemoteca package. Issue #466 records the rollback from
Mnemoteca v0.3.4 to v0.3.3 during RunWield v0.11.5 publication. Direct inspection of the public tap during planning
confirmed that it still contains Mnemoteca v0.3.3 with RunWield v0.14.2. Mnemoteca's latest release is v0.3.4.

The cause is ownership, not a bad checksum:

- Both RunWield release jobs pass `--mnemoteca-tag v0.3.3`.
- `packageHomebrew` rebuilds both formulas when `wldTag` is supplied. Its input file pins Mnemoteca v0.3.3.
- Publication copies both formulas and the whole manifest into a newly checked-out tap.
- Mnemoteca's own release workflow writes its formula and patches `mnemotecaTag` in that same manifest.
- Existing tests validate generated packages, but do not protect an independently updated dependency.

The owning capability is [Core: Installation and updates](../prd/runwield-core-prd.md#installation-and-updates).
This fix makes its independent Mnemoteca package requirement explicit: a RunWield release must not change another
package's version or formula. Add acceptance scenarios for independent updates and concurrent tap changes. Preserve
**Install through a shell installer or a package manager** and **Qualify packages before publication and keep published
bytes**, including Candidate isolation and recovery from immutable assets. No requirement is removed.

## Objective

A RunWield release updates only its own Homebrew formula and package metadata. It qualifies against the Mnemoteca
formula already in the tap, without replacing it from a local pin. Restore the public Mnemoteca formula to v0.3.4
without changing the current RunWield package. The owner approved direct publication of the verified tap repair.

## Approach

Add the missing RunWield-only mode to the existing generator. Do not introduce a second formula generator or a new
release service.

```text
release job
  read tap at revision A
  copy package files to a disposable check directory
  refresh only wld from verified release assets
  run the full macOS package check
  apply verified wld files to the publication checkout at A
  push normally; reject if the remote advanced
```

Omitting `--mnemoteca-tag` selects RunWield-only refresh. At least one package tag is required. Keep explicit two-tag
preparation and Mnemoteca-only refresh compatible. Normal RunWield release jobs use only RunWield-only refresh.

RunWield-only mode preserves the existing Mnemoteca formula byte-for-byte. It merges `wldTag`, `testOnly`, and
`generatedAt` into the manifest instead of rebuilding it. It preserves `mnemotecaTag`, `testedDependencies`, additional
fields, README, other formulas, and Git metadata. It does not read or download the pinned Mnemoteca inputs.

The checker must use a disposable copy: `ensureGitTap` stages and commits every change in its input. The publication
checkout stays separate and remains based on the revision used for qualification. Do not fetch a newer tap and copy
an older generated manifest over it. A rejected push is an incomplete publication; recovery starts with a fresh tap
snapshot and repeats qualification. No force-push or automatic conflict resolution is allowed.

A pin-only update was rejected because the next independent Mnemoteca release would cause the same bug. Reading the
tap's tag and regenerating both formulas also fails: `validateInputs` requires that tag to match the local input file.

### Public tap repair

The source fix alone leaves the current v0.3.3 formula in place. Repair the separate
[`RunWield/homebrew-tap`](https://github.com/RunWield/homebrew-tap) repository after the preventive workflow is active.
Use a fresh checkout and preserve all unrelated content. Do not rerun an old RunWield workflow revision.

**Owner decision:** Publish the verified repair directly to the tap. No separate tap pull request is required.
The preventive RunWield workflow fix must be active first. Use an ordinary push from the checked base; if the tap
advances, reload it, preserve the newer content, and repeat verification before publication.

Do not claim the public issue is fixed until the repair reaches the tap's main branch. If the source fix is not yet
active, prepare the repair and report the remaining rollout step instead of publishing it early.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `scripts/package-homebrew.ts` — parse single-package selection; preserve the existing tap during RunWield-only refresh.
- `.github/workflows/release.yml` — qualify and publish from the same tap base; stop rendering or publishing Mnemoteca.
- `.github/workflows/homebrew-prepare.yml` — support either single-package mode with an existing tap; remove the implicit
  v0.3.3 selection and keep Git credentials out of artifacts.
- `scripts/package-homebrew.test.ts`, `scripts/release-policy.test.ts`, and focused publication tests — prove package
  preservation, actual publication behavior, and workflow wiring.
- `scripts/package-homebrew-check.ts` and its tests — retain full qualification; add a check that the installed Mnemoteca
  version matches the manifest. Do not weaken checks to make the new flow pass.
- `docs/releasing.md`, `packaging/homebrew/README.md`, and generated README guidance — explain independent refresh,
  fresh-snapshot recovery, explicit two-package preparation, and public repair.
- `docs/prd/runwield-core-prd.md#installation-and-updates` — add the independent-package requirement and scenarios;
  correct the stale statement that Homebrew publication is still pending, using current public evidence.
- External `RunWield/homebrew-tap`: `Formula/mnemoteca.rb` and `runwield-homebrew-package.json` — narrow v0.3.4 repair.

Do not redesign Mnemoteca's release workflow, change the `gandazgul/tap` install identity, migrate the manifest schema,
change Windows publication, or alter released asset bytes. The local Mnemoteca input remains an explicit preparation
input, not authority for normal RunWield releases. No new domain term or ADR is needed for this bounded repair.

## Reuse Opportunities

- `packageHomebrew`, `parsePackageHomebrewArgs`, `verifiedRunWieldAsset`, and `assertStableTag` — retain rendering,
  checksum verification, release license selection, and production URL rules.
- `readExistingRunWieldPackage` — use its existing counterpart-preservation checks as a pattern for RunWield-only mode.
- `makeReleaseFixture` in `scripts/package-homebrew.test.ts` — serve real fixture bytes at the network boundary.
- `package:homebrew:check` — keep audit, install, formula tests, upgrade, uninstall, reinstall, and ownership checks.
- `defineGitFixture` in `src/shared/git-test-fixture.ts` — use real repositories and a local bare remote to test pushes.
- Existing workflow recovery — restart package publication using the released tag and assets, not a new product release.

## Implementation Steps

1. **A regression test reproduces the ownership failure before the fix.** Seed a tap with a newer Mnemoteca formula,
   manifest metadata, README, another formula, and Git metadata. Run the real generator through the proposed wld-only
   arguments with stale or unavailable Mnemoteca inputs. The test must require an updated wld formula and unchanged
   dependency content. Record its initial failure; a test that only searches the workflow for a version string is not enough.

2. **RunWield-only refresh changes only its owned output.** `parsePackageHomebrewArgs` accepts either tag or both and
   rejects calls with neither tag. `packageHomebrew` validates an existing Mnemoteca formula and manifest before any writes, verifies
   both wld assets, and preserves all other files. A publishable refresh rejects a test-only base, malformed or missing
   metadata, mismatched formula release URLs and `mnemotecaTag`, or an incomplete pair of macOS assets. Accept immutable
   Mnemoteca URLs under both the historical `gandazgul/mnemoteca` and current `RunWield/mnemoteca` repository names.
   Preserve production URL restrictions, Candidate rejection outside test-only mode, and historical license behavior.
   Do not delete the output directory in single-package mode. Existing two-tag and Mnemoteca-only calls still work.

3. **Both release jobs qualify the tap dependency rather than a local pin.** `homebrew-check` and `homebrew-package`
   obtain a tap snapshot before rendering and call the generator without `--mnemoteca-tag`. The pre-publication job
   retains local wld asset URLs and `--test-only`; the Stable job uses immutable released wld URLs. Both run the full
   macOS checker. The checker verifies the installed Mnemoteca version against `mnemotecaTag` through Homebrew's
   installed-package metadata, in addition to existing checks. No Mnemoteca download is added to wld formula generation.

4. **Publication preserves the qualified base.** The Stable job retains a separate publication checkout at the tap
   revision used for the disposable check. It publishes only the verified `Formula/wld.rb` and the manifest with
   wld-owned fields updated. It asserts that Mnemoteca formula bytes and non-owned manifest values match that base.
   It never copies Mnemoteca or README into the publication checkout. A remote advance makes the ordinary push fail
   without replacing any remote content. Keep credential checks, check-before-push ordering, Stable-only publication,
   and the verified recovery artifact. Recovery takes a fresh snapshot and rechecks it before another push.

5. **Manual preparation has explicit package selection.** `homebrew-prepare.yml` has no default Mnemoteca version;
   either tag can be supplied, but at least one is required. Single-package preparation obtains the existing tap.
   Two-tag preparation keeps its explicit input validation. Artifact names work in every mode, and archives include
   package files only, never `.git`, checkout credentials, or repository configuration.

6. **Regression coverage protects the generator and the actual publication path.** Tests execute the production
   publication shell step or a small extracted publication command against real Git fixtures, not a duplicated test
   implementation. Prove a newer Mnemoteca release survives wld publication. Exercise two races: the second writer
   advances after qualification but before publication checkout, and after publication checkout but before push.
   Both stale attempts must reject; a fresh-snapshot retry preserves the update. Workflow policy tests prove
   both jobs select wld-only mode, checkout precedes rendering, and publication uses the checked base. Retain existing
   macOS, trust, credential, recovery-source, Candidate, checksum, and license assertions.

7. **Documentation matches the delivered boundary.** The owning Core requirement and acceptance scenarios cover
   independent package updates and concurrent publication. Release and packaging instructions show cloning the tap
   before single-package refresh and distinguish that operation from explicit two-tag preparation. Recovery instructions
   use the corrected workflow revision, not historical workflow reruns. Public Homebrew availability is accurate;
   paused Windows behavior and all unrelated requirements remain unchanged.

8. **The verified public repair is published directly.** From a fresh tap, verify the v0.3.4 macOS archives against
   release checksums and GitHub asset digests. Update only Mnemoteca's URLs, checksums, manifest tag, and generation
   timestamp as needed; preserve wld and other manifest fields. Use the full macOS check on a disposable copy. Publish
   the repair directly to tap main only after the preventive fix is active. Use an ordinary push and recheck from a fresh
   base if another writer advances the tap. If the tap already has v0.3.4 or a newer release, verify it and do not downgrade
   it. Report the source fix and confirmed public repair as separate outcomes; a prepared local commit is not completion.

## Approval Confirmation

No Work Records are superseded. The owner selected direct publication of the verified public tap repair during review.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Do not run `bun test` directly.

- **Focused automated checks:** `bun scripts/run-tests.js scripts/package-homebrew.test.ts scripts/package-homebrew-check.test.ts scripts/release-policy.test.ts scripts/homebrew-tap-access-policy.test.ts`.
  Include any new publication test file in this command and the repository's explicit test inventory when required.
- **Primary regression:** a v0.3.4 Mnemoteca tap plus stale v0.3.3 inputs produces the requested new wld formula while
  Mnemoteca bytes and tag remain unchanged. Repeat with a later synthetic Mnemoteca tag to rule out a v0.3.4 special case.
  Run with a nonexistent inputs path and assert no Mnemoteca asset request. A no-op generator fails the wld assertions;
  the current two-package generator fails the preservation assertions.
- **Failure safety:** missing, malformed, mismatched, or test-only base data and corrupt wld checksums fail without any
  file changes. Omitting both tags fails argument validation. Production URL overrides and Candidate publication still fail.
- **Compatibility:** existing two-tag generation and Mnemoteca-only refresh still pass; preserve counterpart formula
  protection, test-only propagation, version inference for local and release URLs, and release-specific licenses.
  Retire only the expectation that ordinary RunWield releases also regenerate Mnemoteca from the local pin.
- **Publication integration:** execute the real publication code against a local bare remote. Inspect the remote tree,
  not just exit status. Advance Mnemoteca both before the publication checkout and, in a separate case, after checkout.
  Each stale attempt rejects without publishing wld. A fresh-snapshot retry qualifies the new dependency and succeeds.
  The successful commit changes wld and permitted manifest fields only. An unpinned late checkout or a stale
  whole-manifest copy must fail these tests.
- **Checker version regression:** an installed Mnemoteca version different from `mnemotecaTag` fails even when its formula
  test and the wld checks succeed. A matching version passes. Exercise the real checker with subprocess-boundary fixtures.
- **Native qualification:** on disposable macOS infrastructure, seed the tap with Mnemoteca v0.3.4 and run
  `bun run package:homebrew --wld-tag <existing-stable-tag> --output <tap-copy>` followed by
  `bun run package:homebrew:check --tap <tap-copy>`. Use concrete tags and paths in execution evidence. Verify Mnemoteca's
  installed version, wld update guidance, and full package lifecycle. Never untap or replace the owner's working install
  to run this check. Repeat Candidate qualification with local wld assets and prove it never publishes to the Stable tap.
- **Public repair evidence:** verify both macOS archive digests against the release; the reported v0.3.4 values are
  `b8e4a21c40ff3288b0792034e4cb847d7237c8c985c1c99989a8aac044479174` (arm64) and
  `550d1c9a9f5acd8921d9658b0ed14ad0529ae3d79dc329b210e0c6108490cacb` (amd64). After approved publication, fetch the tap
  again and confirm its formula and manifest agree while wld is unchanged. Record the confirmed remote commit; a local
  commit or successful preparation alone is not publication.
- **AI review:** trace snapshot → render → check → publish and inspect recovery artifacts. Confirm no unchecked
  Mnemoteca rewrite or late whole-manifest replacement remains. Confirm the PRD and instructions describe delivered
  behavior and do not claim that an unmerged public repair is complete.

## Edge Cases & Considerations

- **Cross-repository writers:** GitHub concurrency groups do not serialize Mnemoteca's separate workflow. Snapshot-based
  normal pushes prevent lost updates without a new distributed lock or retry service.
- **Historical workflows:** rerunning an old job can still contain the old overwrite code. Use recovery dispatched from
  the corrected workflow, and account for any old in-flight publication before repairing the tap. Do not rewrite tags.
- **Separate publication permissions:** source access does not prove tap write access. If publication is blocked, retain
  the verified repair and report the exact external prerequisite; do not claim success.
- **Mutable dependency between checks:** pre-release and post-release jobs can observe different tap snapshots. Each
  qualifies its own snapshot; the post-release snapshot is the one eligible for publication.
- **Manifest provenance:** `generatedAt` records this output refresh. Preserve existing dependency metadata; do not
  relabel old tested helper versions as newly measured facts.
- **Bounded scope:** this fix does not add a general policy against explicitly publishing an older wld version, nor
  redesign all release ordering. It prevents RunWield from changing the independently owned Mnemoteca package.
- **Planning evidence:** code, workflow, issue, and current remote metadata were inspected. No regression tests or native
  package checks have run in this planning session.
