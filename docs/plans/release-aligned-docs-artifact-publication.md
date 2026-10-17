---
planId: "1b83df5e-6d5a-44bb-9920-f82e96f81968"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - ".github/workflows/release.yml"
    - ".github/workflows/docs.yml"
    - "scripts/reconcile-docs-branch.sh"
    - "scripts/integrate-release-branch.sh"
    - "scripts/release-assets.js"
    - "scripts/verify-docs-source.ts"
    - "scripts/docs-branch-integration.test.ts"
    - "scripts/docs-workflow.test.ts"
    - "scripts/release-assets.test.js"
    - "scripts/release-policy.test.js"
    - "docs/releasing.md"
    - "docs/prd/runwield.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-16"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "plan/release-aligned-docs-artifact-publication"
validatedCommit: "352efe7979e49fea05022306bb3272f4de74a828"
workRecord:
    status: "generated"
    recordId: "3947320a-8ed1-4533-bd1f-9380fa904ae2"
    path: "docs/work-records/2026-10-16-stable-docs-artifacts-and-safe-release-integration.md"
    lastAttemptAt: "2026-10-16T23:48:52.572Z"
status: "verified"
---

# Release Stable Docs as a Release Artifact

## Context

The v0.12.1 Stable release published its product correctly, but the docs deploy failed. The operator then had to run a
manual recovery.

**Why the deploy failed.** `release.yml` calls `docs.yml` as a reusable workflow. The deploy job then runs inside the
tag-triggered run, so GitHub sees `v0.12.1` as the deploying ref. The `github-pages` environment allows only the `main`
and `docs/stable` branches, so GitHub rejected the deployment. The job checks out `docs/stable`, but that does not change
the ref GitHub checks against the environment rules.

**Why `docs/stable` got four commits for one release.** `scripts/reconcile-docs-branch.sh` writes two commits per run: a
"Merge docs/stable into vX.Y.Z" commit, then a "docs: publish vX.Y.Z manual" commit that updates
`docs-site/release.json`. The failed run and the recovery run each added both commits.

**Current flow:**

```text
release.yml (tag push)
  release            publishes product assets
  publish-docs       uses docs.yml (still the tag's run)
    sync             reconcile-docs-branch.sh → 2 commits → push docs/stable
    deploy           rebuild docs → Pages   ✗ rejected: tag ref
operator             merges Release Branch into main, deletes branch
```

**Owning PRD capability:** [Public documentation](../prd/runwield.md#public-documentation). Its requirements stay the
same: _Read documentation for the latest Stable release_ and _Correct documentation independently_. Its
failed-deployment scenario also stays: the last valid manual stays live, and an older release cannot replace a newer
one. This Plan adds one requirement: a Stable release publishes its manual as part of the release, with no operator
recovery. The capability's maturity line still says "Target until `docs.runwield.dev` is deployed". The site is live now,
so that line changes in the same change.

**Decisions from planning:**

- Docs are a qualified **Stable release artifact** like the binaries. The workflow builds them before publication and
  deploys those exact bytes. It does not rebuild them at deploy time.
- `docs/stable` gets **exactly one merge commit per Stable release**. Retries reuse that commit.
- Only the **Stable promotion commit** goes into `docs/stable`, which is the peeled commit of the Stable tag. Candidates
  do not publish docs, add commits to `docs/stable`, or attach a docs asset.
- After Stable publication, **CI merges the Release Branch into `main`**. CI checks that the branch tip is an ancestor of
  remote `main`, then deletes the Release Branch. These steps replace operator steps in `docs/releasing.md`.

## Objective

A Stable tag push publishes the binaries, the docs archive, the updated `docs/stable` branch, the live manual, and the
`main` integration in one run. The run needs no Pages settings change and no operator recovery. A retry of any part adds
no commits to `docs/stable`.

## Approach

Build the docs inside the release gate. Then deploy from a run whose ref is `docs/stable`, which Pages already allows.

```text
release.yml (Stable tag push)
  docs-artifact        prepare 1 merge commit (not pushed) → build → archive + git bundle
  assets               adds runwield-docs-vX.Y.Z.tar.gz(+.sha256) to the checked upload set
  release              publishes all assets (docs-artifact must succeed for Stable)
  publish-docs         push merge commit to docs/stable (fast-forward only, or reuse)
                       gh workflow run docs.yml --ref docs/stable -f tag=vX.Y.Z → wait for success
  integrate-release-branch
                       merge origin/release/vX.Y.Z into main → push → verify ancestry → delete branch

docs.yml (dispatched on docs/stable)
  deploy               download docs asset → verify checksum + source → Pages (no rebuild)
```

> [!NOTE]
> **Why dispatch works**
>
> Pushes made with `GITHUB_TOKEN` do not start other workflows, but `workflow_dispatch` is the documented exception. The
> calling job needs `actions: write`. The dispatched run's ref is `docs/stable`, so the existing Pages environment rule
> accepts it. That run uses the `docs/stable` copy of `docs.yml`. After the merge, that copy is the released tag's
> version.

**One commit per release.** `reconcile-docs-branch.sh` makes one merge commit. Its parents are the peeled Stable commit
and the current `docs/stable` tip. Its tree already has `docs-site/release.json` with `version`, `releaseUrl`, and
`sourceRef`. A commit cannot contain its own SHA, so the committed `sourceRef` changes meaning: it records the peeled
release commit. The build still stamps the docs commit SHA into the built `release.json`, as the deploy step does today.

```diff
 reconcile(tag)
-  merge → commit "Merge docs/stable into tag"
-  write release.json → commit "docs: publish tag manual"
-  push docs/stable
+  if docs/stable tip is already the merge for tag → reuse it
+  else merge tree + release.json → one commit (parents: tag commit, docs/stable tip)
+  print commit SHA (the publish-docs job pushes it)
```

**When docs are corrected during a release.** The workflow prepares the merge commit early and pushes it about an hour
later. A docs correction can land on `docs/stable` in between. In that case, `publish-docs` prepares the merge again on
the new tip. The release still adds only one commit. The deploy step deploys the release asset only when the asset's
recorded source matches the `docs/stable` tip. If they differ, it builds `docs/stable` through the existing correction
build path. Either way, the published manual includes the correction.

**Integrating `main`.** CI merges the Release Branch tip into `main`, not the tag commit. This keeps every pushed release
fix, as `docs/releasing.md` requires today. The `main` ruleset blocks only deletion and force-push, so `GITHUB_TOKEN` can
push the merge. A merge conflict fails only this job. The Release Branch stays, the release stays published, and the
failure message gives the operator the manual merge steps.

**Option not chosen:** allow `v*` tags in the `github-pages` environment. That one settings change stops the rejection.
But deploy still rebuilds instead of using qualified bytes, every retry still adds commits, and a settings script
becomes part of the release.

## Expected Change Surface

This list is guidance, not an allowlist. Check the real footprint during implementation, and change whatever the
Implementation Steps need, including files not named here. Stop and report only if discovery changes the approved
intent. That means the change reaches another subsystem, public behavior or architecture shifts, migration or
compatibility risk grows, or the Verification Plan no longer proves the objective.

- `.github/workflows/release.yml` — new Stable-only `docs-artifact` job. `assets` and `release` gating changes.
  `publish-docs` changes from a reusable `docs.yml` call into a push-and-dispatch job. New `integrate-release-branch`
  job.
- `.github/workflows/docs.yml` — new deploy path for dispatched runs: deploy the release's docs asset from a
  `docs/stable` run. Remove the `workflow_call` entry and the `sync` job that pushes. Keep the build path for pushed
  corrections.
- `scripts/reconcile-docs-branch.sh` — one commit per release, reuse on retry, no push. Keep the bootstrap mode.
- `scripts/integrate-release-branch.sh` (new) — the merge, ancestry check, and deletion steps for `main`. They live in a
  script so tests can run them against real Git fixtures, the same way `reconcile-docs-branch.sh` is tested today.
- `scripts/release-assets.js` — the Stable upload set includes the docs archive and its checksum. Published recovery of
  a Stable tag released before this change does not require them.
- `scripts/verify-docs-source.ts` — accepts the single-commit form. Its product-path check is unchanged.
- `scripts/docs-branch-integration.test.ts`, `scripts/docs-workflow.test.ts`, `scripts/release-assets.test.js`,
  `scripts/release-policy.test.js` — regression coverage, listed below.
- `docs/releasing.md` — Candidate promotion steps 7–9, _Stable documentation publication_, and _Recovery_.
- `docs/prd/runwield.md` — the Public documentation capability.

`scripts/release.js` does not change. `expectedReleaseAssetNames` remains the Candidate asset contract that
`assertCandidatePublished` checks during promotion. Candidates gain no docs asset. The generic
`src/prompt-templates/release.md` stays policy-neutral and does not change. GitHub repository settings do not change.

## Reuse Opportunities

- `scripts/build-stable-docs.ts` (`prepareStableDocs`, `buildStableDocs`) — build the merge commit's checkout. In
  release CI, the tag's own tooling is the tooling.
- `scripts/release-assets.js` `prepareReleaseAssets` — already checks the flat unique upload set, `SHA256SUMS`, and
  published digests. Extend it; do not write a second checker.
- `homebrew-package` job pattern in `release.yml` — `tar` + `shasum -a 256` + `upload-artifact` for the docs archive.
- `scripts/docs-workflow.test.ts` helpers `jobBlock`, `jobCondition`, `stepRun`, `evaluateReleaseCondition` — they run
  real workflow conditions and shell steps against fake `gh` boundaries.
- `scripts/docs-branch-integration.test.ts` Git fixtures — real repository, real origin, real merges.

## Implementation Steps

- `scripts/reconcile-docs-branch.sh <tag>` creates exactly one commit when `origin/docs/stable` does not yet document
  `<tag>`. The commit's first parent is `<tag>^{commit}`, and its second parent is the `origin/docs/stable` tip. Its
  tree contains `docs-site/release.json` with `version` set to `<tag>`, the matching `releaseUrl`, and `sourceRef` set to
  the peeled tag commit. The script prints the commit SHA and does not push.
- If the `origin/docs/stable` tip is already a commit for `<tag>` (its `release.json` `version` equals `<tag>`, and the
  peeled tag commit is one of its parents), `reconcile-docs-branch.sh <tag>` prints that tip's SHA and creates no commit.
- `reconcile-docs-branch.sh` still preserves `docs/stable` corrections. It resolves a conflict that touches only
  `docs-site/release.json`, and stops on any other conflict. It accepts both the old two-commit history (today's
  `docs/stable`, whose `sourceRef` is a merge commit) and the new single-commit history as the previous release. The
  bootstrap mode works as before.
- `release.yml` has a `docs-artifact` job that runs only when `needs.metadata.outputs.kind == 'stable'`. It runs
  `reconcile-docs-branch.sh` and builds the resulting commit's checkout with `scripts/build-stable-docs.ts`. The build
  stamps the commit SHA into the built `release.json`. The job uploads `runwield-docs-<tag>.tar.gz` and
  `runwield-docs-<tag>.tar.gz.sha256` as a workflow artifact that the `assets` job collects. It also uploads a
  `git bundle` that contains the prepared commit.
- `scripts/release-assets.js` `releaseAssetNames(tag)` includes `runwield-docs-<tag>.tar.gz` and its `.sha256` for Stable
  tags and excludes them for Candidate tags. `SHA256SUMS` covers the docs archive. Published-release recovery of a Stable
  tag that has no docs asset (any release before this change) still passes.
- The `release.yml` `release` job publishes a Stable release only when `docs-artifact` succeeded. A skipped
  `docs-artifact` is valid only for Candidates. A failed, cancelled, or skipped `docs-artifact` on a Stable tag blocks
  publication.
- In `release.yml`, `publish-docs` runs only for Stable after `release` succeeds. It pushes the prepared commit to
  `docs/stable` with a non-forced push, or it reuses the tip if the tip already documents the tag. If `docs/stable`
  advanced since preparation, it runs `reconcile-docs-branch.sh` again on the new tip and pushes that single commit. It
  then runs `gh workflow run docs.yml --ref docs/stable -f tag=<tag>` with `actions: write`. It waits for that run and
  fails if the run fails. `release.yml` has no `uses: ./.github/workflows/docs.yml` and no `github-pages` environment.
- `docs.yml` no longer has `workflow_call` and no longer pushes to `docs/stable`. A `workflow_dispatch` run deploys only
  when `github.ref` is `refs/heads/docs/stable`. That run deploys only when the requested tag is GitHub latest and equals
  the `version` in the `docs/stable` tip's `release.json`. If those checks pass, it downloads `runwield-docs-<tag>.tar.gz`
  and verifies the file against the release's published SHA-256 digest. If the archive's recorded docs commit equals the
  `docs/stable` tip, the run uploads the extracted bytes to Pages without rebuilding. Otherwise, it builds `docs/stable`
  through the existing correction build path. For a release that has no docs asset, it also builds `docs/stable`.
- The `docs.yml` push trigger on `docs/stable` still builds and deploys corrections with the default-branch tooling. The
  existing stale-build and latest-release checks still run before `deploy-pages`.
- `scripts/integrate-release-branch.sh <tag>` derives `release/vMAJOR.MINOR.PATCH` from the Stable tag. If the branch is
  missing on `origin`, the script logs a skip and exits successfully. This covers direct Stable releases, grandfathered
  legacy series, and branches that are already deleted. Otherwise, it merges the branch's remote tip into
  `origin/main`. It creates a merge commit unless `main` already contains the tip. It pushes `main` without force and
  confirms the tip is an ancestor of the freshly fetched `origin/main`. Only after that check does it delete the remote
  Release Branch. If the merge conflicts or the push is rejected, it pushes nothing, keeps the branch, and exits non-zero
  with the manual steps.
- `release.yml` has an `integrate-release-branch` job. It runs `scripts/integrate-release-branch.sh` for Stable after
  `release` succeeds, with `contents: write`. It does not depend on `publish-docs`.
- `docs/releasing.md` describes the new flow. CI publishes the docs archive and deploys it from `docs/stable`. The
  operator still edits the release notes. CI merges the Release Branch into `main`, checks ancestry, and deletes the
  branch. Candidates never touch docs. _Recovery_ names `gh workflow run docs.yml --ref docs/stable -f tag=<stable-tag>`
  and the manual merge steps for an integration conflict. It no longer names the `--ref main` docs retry.
- `scripts/release-policy.test.js` asserts the revised policy phrases. Assertions on phrases that this change retires on
  purpose (the operator-run merge and branch deletion, and the `--ref main` docs retry) are replaced, not just deleted.
- In `docs/prd/runwield.md` _Public documentation_, the maturity line states that the capability is current. The
  capability adds the requirement **Release the manual with Stable**: a Stable release publishes its manual and archive
  without operator recovery, and `docs/stable` gains one commit per Stable release. It adds scenarios for a Candidate
  (no docs change) and a retried Stable publication (no new `docs/stable` commit). Existing requirements and scenarios
  stay.

## Verification Plan

**Automated (focused):**

```bash
bun scripts/run-tests.js scripts/docs-branch-integration.test.ts scripts/docs-workflow.test.ts \
  scripts/release-assets.test.js scripts/release-policy.test.js scripts/build-stable-docs.test.ts
```

**New behavioral tests (real Git fixtures and real workflow steps, with fake `gh` only):**

- `docs-branch-integration.test.ts`: run `reconcile-docs-branch.sh` twice for the same tag against a real origin. After
  the first push, `docs/stable` has exactly one new commit. Its parents are the tag commit and the previous tip, and its
  `release.json` documents the tag. The second run prints the same SHA and creates nothing. This fails against today's
  script, which writes two commits.
- `docs-branch-integration.test.ts`: the previous release is in the old two-commit form, as today's `docs/stable` is.
  Reconciling the next tag still preserves a correction made after the previous release.
- `docs-workflow.test.ts`: the `publish-docs` condition in `release.yml` is true only for a successful Stable release.
  The job dispatches `docs.yml` with `--ref docs/stable`, and `release.yml` contains no `github-pages` environment or
  `docs.yml` call. This fails against the current reusable-workflow call.
- `docs-workflow.test.ts`: run the `docs.yml` dispatch deploy steps with a fake `gh`. A ref other than `docs/stable`
  fails. A checksum mismatch fails. A matching asset takes the no-rebuild path. A tag older than latest fails.
- `docs-workflow.test.ts`: a Stable `release` condition with `docs-artifact` set to `failure`, `cancelled`, or `skipped`
  is false. A Candidate with `docs-artifact` set to `skipped` is true.
- New test for `integrate-release-branch.sh`, with a real origin, real `main`, and a real Release Branch:
    - The success case merges the branch, makes its tip an ancestor of `origin/main`, and deletes the remote branch.
    - A conflicting `main` exits non-zero, leaves `origin/main` unchanged, and keeps the branch.
    - A missing branch exits zero with no changes.
    - A test that skipped the ancestry check, or deleted the branch before pushing, would fail.
- `release-assets.test.js`: the Stable upload set includes the docs archive and its checksum, and the Candidate set does
  not. Published recovery of a Stable release without a docs asset passes.

**Behavior that must stay protected:** existing `docs-workflow.test.ts` checks for latest-release selection, API-error
stops, incomplete-asset rejection, separation of historical source from tooling, and pinned runtime resolution. Existing
`docs-branch-integration.test.ts` checks for correction preservation across divergent release branches, conflict stops,
and rejection of stale or product-changing sources. Existing `release-policy.test.js` channel and recovery checks.

**Behavior expected to stop existing:** the `docs.yml` `sync` job and its `workflow_call` entry. The second "docs:
publish" commit. The `--ref main` docs retry in policy. The operator-run Release Branch merge and deletion after Stable.
Rewrite tests that assert these against the new shape; do not delete them.

**Manual (next Stable release):**

- The `release-gate` run has `docs-artifact`, `publish-docs`, and `integrate-release-branch` all green, with no Pages
  rejection.
- The release lists `runwield-docs-vX.Y.Z.tar.gz` and its `.sha256`.
- `git log origin/docs/stable` shows one new commit for the release.
- A dispatched `publish-docs` run on `docs/stable` succeeded, and `https://docs.runwield.dev/` shows `Stable vX.Y.Z`.
- `origin/release/vX.Y.Z` is gone, and its last tip is an ancestor of `origin/main`.
- Rerun the Stable docs dispatch. `docs/stable` gains no commit.
- A Candidate tag run changes neither `docs/stable` nor the live site.

**PRD check:** the Public documentation scenarios map to the tests above. The PRD describes only behavior that the code
delivers.

## Edge Cases & Considerations

- **Docs build failure blocks a Stable release.** This is intended, because docs are an artifact like the binaries. No
  GitHub Release exists yet, so the tag can still move. Fix the problem on the Release Branch (or on `docs/stable`, for a
  docs conflict) and move the tag under the existing policy.
- **Candidates do not build docs.** A docs break therefore shows up first at promotion. _Reviewable assumption:_ no
  Candidate-only docs build check is added, because you said Candidates should not take part in docs.
- **Existing extra commits on `docs/stable`** from v0.12.1 stay. `docs/stable` is never rewritten.
- **First release with this change:** before the merge, the `docs.yml` copy on `docs/stable` comes from v0.12.1. The
  `publish-docs` push merges in the new `docs.yml` before the dispatch, so the dispatched run already uses the new
  workflow.
- **Concurrency:** `docs.yml` keeps its `runwield-docs-pages` concurrency group, so a correction deploy and a release
  deploy cannot overlap.
- **Integration conflict:** only `integrate-release-branch` fails. The release, the docs, and the Release Branch all stay
  as they are. The operator merges by hand and deletes the branch after the ancestry check, as the policy describes
  today.
- **Pushes from `GITHUB_TOKEN` to `main` do not start `pr-gate` or `golden`.** This is acceptable: the merged content
  already passed release qualification as the Release Branch.
