# Releasing wld

This document is wld's release policy. It does not define policy for wld users releasing other repositories; in those
repositories, discover and follow the repository's release policy and automation first.

## Release operations

wld supports three release operations:

- **Create Candidate** — publish a prerelease build for dogfooding and validation.
- **Promote Candidate** — rebuild the exact Candidate source commit with Stable identity and publish it as Stable.
- **Create Stable Directly** — exceptional path for a Stable release without a Candidate.

The `/release` prompt asks which operation to run before inspecting this policy in detail. All release commands are
non-interactive so the prompt can own user choices and final confirmation.

## Tags and channels

- Stable tags use `vMAJOR.MINOR.PATCH`, for example `v0.8.12`.
- Candidate tags use `vMAJOR.MINOR.PATCH-rc.N`, for example `v0.8.12-rc.1`.
- Candidate ordinals start at `1` and compare numerically.
- The Candidate tag is the canonical source reference. Do not store a duplicate source commit hash in release metadata.
- A Candidate release must be a GitHub prerelease and must not become GitHub latest.
- Stable releases are non-prereleases and become GitHub latest only after qualification and artifact publication
  succeed.

## Immutability boundary

**An unreleased tag is mutable. A released tag is immutable.** A local or remote tag is only a release attempt. Pushing
the tag or running tag-triggered CI does not make it immutable. The tag becomes immutable only when a GitHub Release
exists for that tag.

Before a GitHub Release exists, you may delete the remote and local tag and recreate it at a corrected commit. The
normal recommendation after failed CI is to move it to the immediate next commit containing the fix, but that is a
recommendation, not a prerequisite or a reason to refuse. Multiple intervening commits, a changed `HEAD`, or a previous
workflow run do not make an unreleased tag immutable.

If moving the tag would include unexpected commits or depart from the normal release operation, you may state that
concern once. If the user then confirms that they understand and still directs the move, you MUST comply. Re-verify
immediately before deletion that no GitHub Release exists for the tag, then perform the requested move.

As soon as a GitHub Release exists—even if qualification, asset upload, or the later notes edit is incomplete—the tag
must continue to identify the same commit forever. Do not delete the GitHub Release to make the tag reusable. Never move
a tag after its GitHub Release has been created.

The default installer and schema URLs use GitHub `/releases/latest`; therefore a Candidate must never displace the
current Stable channel. To dogfood a Candidate explicitly, install by tag:

```bash
bash install.sh vX.Y.Z-rc.N
```

## Required tools and authentication

Release operators need:

- `git` with push access to this repository.
- Bun matching `.bun-version` (1.4.3) for source, Golden, executable and package qualification;
  run `bun run install:locked` first.
- `gh` authenticated to GitHub with permission to read releases before tagging, verify Candidate releases during
  promotion, and edit release notes after CI publishes assets (`gh auth status` should pass for the target account).

## Binary runtime

Release binaries use pinned Bun, frozen root/docs dependency graphs, and the Bun Workspace build.
All five existing release targets and archive names remain supported. Artifact metadata uses the
existing platform triples; the embedded build identity includes the Bun compiler and dependency graph.
`--remote-preflight` reports the executing runtime and its version so qualification rejects a Deno binary
or an unexpected Bun version. Bun runs the source and Golden regression gates and the
native package verification tooling. Legacy Deno lock compatibility runs in a separate qualification lane.
Remote container and historical documentation publishing conversion remain tracked transition work.

The Bun binary gate retains bundled-reference extraction, image resizing, Plans UI, and Plan/code
review checks. Native Windows ZIP and Homebrew checks still gate publication. This compiler change
does not publish to Stable channels during a Candidate release or restore automatic WinGet submission.

## Release source

A new Candidate series uses `release/vMAJOR.MINOR.PATCH` as its Release Branch. RC1 resolves current `HEAD`, then
atomically publishes that commit as both the new Release Branch and the annotated RC1 tag. If the remote branch already
exists while RC1 is absent, the command treats this as a retry or name conflict: it uses the pushed branch tip, shows
that source, and never resets the branch from `HEAD`. The current branch does not need to be `main`, `HEAD` does not
need to match an upstream branch, and the working tree does not need to be clean. Staged, unstaged, and untracked
changes are not released because they are not part of the selected commit.

Later Candidates resolve the live pushed Release Branch from `origin` and tag that exact commit. They do not use current
`HEAD`, a local branch, a cached remote-tracking branch, or unpushed fixes. The selected commit must descend from the
previous Candidate. If the Release Branch is missing, changed during preflight, or has unrelated history, stop without
publishing a tag.

Only release fixes belong on an active Release Branch. Apply each fix there first and push it. To explicitly
forward-port the fix to `main`, merge the pushed Release Branch into `main` and push `main` before creating the next
Candidate. Verify that the fix commit is an ancestor of the pushed `main`; do not count a cherry-pick or a conflict
resolution that drops the fix as integration. Never merge `main` into an active Release Branch. Git cannot classify a
commit as a fix; review enforces this scope. A Plan for a release fix must set its target branch to the applicable
Release Branch. Ordinary feature Plans continue to target `main`.

The grandfathered Candidate series `v0.8.16`, `v0.9.0`, `v0.9.2`, `v0.9.3`, `v0.9.4`, `v0.9.6`, and `v0.10.1` retain the
old `HEAD` source rule. This fixed list does not grow automatically. A missing branch does not make a new series legacy.

Direct Stable operations continue to release the commit resolved by `HEAD`. Promotion resolves the Candidate tag from
`origin` and creates the Stable tag at that tag's peeled commit, even if the Release Branch has advanced. It must never
promote current `HEAD` by accident.

Before confirmation, show the selected source commit, target tag, and Release Branch publication when applicable. The
release command tags an explicit commit and does not switch branches or alter working files. GitHub Actions is the
authoritative release qualification environment. Its `release-gate` workflow resolves the tag to one exact commit for
product checks and builds. It runs Ubuntu source quality and Linux Golden checks alongside macOS source and package
checks, Windows x64 and ARM64 source and package checks, container checks, binary smoke checks, and compilation.
Asset preparation follows compilation immediately. Native Linux and macOS checks execute the actual release archives;
Windows ZIP and Homebrew checks also consume the checked release bytes. Publication requires every gate to succeed,
including all reusable platform workflows. A failed, skipped, or cancelled required gate blocks publication.
Preparation never publishes release bytes. Windows ARM64 checks do not add a Windows ARM64 published asset.

## Commands

Use these repository-owned commands instead of hand-writing tag or build commands:

```bash
bun run release:candidate --tag vX.Y.Z-rc.N [--dry-run]
bun run release:promote --candidate vX.Y.Z-rc.N [--dry-run]
bun run release:stable --tag vX.Y.Z [--dry-run]
bun run release:metadata --tag vX.Y.Z[-rc.N]
bun run release:check --build-version vX.Y.Z[-rc.N]
bun run package:homebrew --wld-tag vX.Y.Z --mnemoteca-tag vA.B.C --output <dir>
bun run package:homebrew:check --tap <dir>
bun run package:windows --tag vX.Y.Z --binary <path-to-wld.exe> --output <dir>
bun run package:windows:check --package <dir>/wld-vX.Y.Z-windows-x64.zip
bun run package:winget --tag vX.Y.Z --output <dir>
```

Dry runs perform read-only tag, version, and source preflight and print the proposed tag target and tag push. They must
not require a clean working tree, run local release qualification, create local tags, push remote tags, create host
releases, or leave repository files behind.

## Candidate creation

1. Choose the next Candidate tag.
2. Generate cumulative release notes from the previous Stable tag to the policy-selected source commit. Later Candidates
   keep the cumulative upgrade notes and add validation-relevant changes since the previous Candidate when useful. Do
   not derive notes from unrelated current `HEAD` changes.
3. Run `bun run release:candidate --tag <candidate-tag> --dry-run`. Inspect the source branch, source commit, target
   tag, and planned remote changes.
4. Confirm the branch and tag push. The tag remains a retryable release attempt until its GitHub Release is created.
5. Run `bun run release:candidate --tag <candidate-tag>`.
6. Wait for the tag-triggered GitHub workflow to publish the prerelease assets.
7. Edit the published Candidate release with the curated temporary notes and verify they landed.

After RC1, open the pushed branch for release fixes without changing its source:

```bash
git fetch origin release/vX.Y.Z
git switch --create release/vX.Y.Z --track origin/release/vX.Y.Z
```

If that local branch already exists, switch to it and verify it against `origin` instead of recreating it. After each
pushed fix, merge the Release Branch into `main`, resolve conflicts without dropping the fix, push `main`, and verify
that the fix commit is on remote `main` before creating the next Candidate. Keep the Release Branch while Candidates are
active. After Stable publication, merge its final tip into `main` and delete the branch as described below.

## Candidate promotion

1. Select the Candidate tag to promote.
2. Verify the Candidate GitHub release is published as a prerelease and includes every expected wld asset.
3. Generate Stable release notes cumulative from the previous Stable. Remove Candidate-specific warnings, but do not
   treat promotion as an empty release merely because the source commit is unchanged from the Candidate.
4. Run `bun run release:promote --candidate <candidate-tag> --dry-run` and inspect the Candidate source commit and
   target Stable tag.
5. Confirm the tag push. The tag becomes immutable when its GitHub Release is created.
6. Run `bun run release:promote --candidate <candidate-tag>`.
7. Wait for the Stable tag-triggered GitHub workflow to publish Stable assets.
8. Edit the published Stable release with the curated temporary notes and verify they landed.
9. For a branch-based series, fetch the Release Branch and merge its final remote tip into `main`. Resolve conflicts
   without losing its fixes, push `main`, and verify that the tip is an ancestor of remote `main`. Delete the remote and
   local Release Branch only after that verification. Do not delete it if Stable publication is still incomplete.

Promotion creates a Stable tag at the Candidate tag's peeled commit. The Stable tag annotation may include
`Promoted-From: <candidate-tag>` and must not persist a separate source commit field. The Release Branch may have
advanced past the promoted Candidate; merging its tip into `main` does not change the immutable Stable tag.

## Direct Stable creation

Direct Stable is an exceptional path. Use it only when explicitly chosen and appropriate for the risk of the change. It
uses the confirmed `HEAD` commit, then follows the same tag workflow, GitHub Actions qualification, and post-publication
notes-editing rules. It does not create or use a Release Branch.

## Homebrew tap publication

The macOS Homebrew tap is published from immutable Stable release assets. Candidate releases never update Stable package
output.

Before creating a Candidate or Stable GitHub Release, the workflow validates the exact staged Windows ZIP and runs
Homebrew audit, install, test, upgrade, uninstall, and ownership checks on macOS. Homebrew uses a temporary local asset
server and test-only formulas; Candidate formulas are never published to the Stable tap. Stable credential checks also
run before release creation. The upload set is flat, has unique expected names, and passes checksum validation. Root
build files such as `package.json` are not release assets.

After Stable asset publication succeeds, the release workflow:

1. Renders the Homebrew formulas from the published release assets.
2. Runs the complete package check on macOS.
3. Uploads the verified `runwield-homebrew-tap-<tag>` recovery artifact.
4. Pushes the verified files to `gandazgul/homebrew-tap`.

The `HOMEBREW_TAP_TOKEN` repository secret must contain a GitHub token with write access to `gandazgul/homebrew-tap`.
Publication stops if the credential is absent or any package check fails. To reproduce the check locally, use:

```bash
bun run package:homebrew --wld-tag vX.Y.Z --mnemoteca-tag v0.3.3 --output /tmp/runwield-tap
bun run package:homebrew:check --tap /tmp/runwield-tap
```

The checked formula installs metadata beside `libexec/wld`; a Homebrew-owned `wld update` prints
`brew upgrade gandazgul/tap/wld` and must not run `install.sh`.

`mnemoteca` can be refreshed independently by omitting `--wld-tag` and passing a new `--mnemoteca-tag` against an
existing tap tree. First update `packaging/homebrew/tested-dependencies.json` with the verified macOS URLs, SHA-256
values, license, homepage, and tested helper versions. Base URL overrides require `--test-only`; publishable output must
point at immutable GitHub release URLs. Formula installation does not run Mnemoteca model setup or
`agent-browser install`; those remain first-use operations.

## Windows ZIP and WinGet preparation

The release workflow builds `wld-vX.Y.Z-windows-x64.zip` from the compiled Windows binary and pinned helper inventory in
`packaging/windows/tested-dependencies.json`. The ZIP includes `wld.exe`, `runwield-install.json`, bundled helper
executables under `runtime/helpers/`, and notices under `licenses/`. Native Windows package checks must pass before the
workflow publishes the ZIP.

Stable releases also render a `runwield-winget-manifests-vX.Y.Z` artifact. You can regenerate it from published Stable
bytes with:

```bash
bun run package:winget --tag vX.Y.Z --output /tmp/runwield-winget
```

Candidate tags are rejected. Automatic WinGet PR submission is disabled until the owner directs its restoration. Stable
releases still prepare manifest artifacts, but do not submit them to `microsoft/winget-pkgs` or require the
`WINGET_CREATE_GITHUB_TOKEN` secret. No WinGet submission job may run during release recovery while this pause is
active. The retained submission code uses WingetCreate and requires a classic GitHub token with the `public_repo` scope
when restored. For the first public listing, follow `docs/winget-first-release.md`. Git for Windows is a WinGet
dependency. Browser and model downloads remain first-use per-user setup.

## CI tiers

`bun run ci` is the host-native local source and Golden gate. It does not launch Windows, macOS, or container matrices.
`pr-gate` retains the four Ubuntu source/type/lint shards and four Linux Golden shards, with the existing aggregate
status contexts `ci` and `golden`. Ordinary PRs do not run the 23 former platform/container jobs; the duplicate four
Ubuntu source shards are removed rather than repeated in release qualification.

`release-gate` owns broad platform coverage after the Candidate or Stable tag is created. Its internal
`release-unix.yml`, `release-windows.yml`, and `release-containers.yml` workflows are reusable and also support manual
diagnostics at the selected workflow revision. Windows checks use at most two runners concurrently within the matrix.
Manual diagnostics use a synthetic Candidate identity; release calls pass the real version and resolved product SHA.
No new mandatory pre-tag check is introduced. Product fixes belong on the Release Branch and are later explicitly
forward-ported to `main` under the release policy above.

## GitHub workflow ownership

The tag-triggered workflow owns release qualification, builds, GitHub release creation, asset upload, native Windows
package checks, Candidate and Stable Homebrew validation, Stable-only tap publication, and Stable-only WinGet manifest
rendering. Automatic WinGet submission is disabled until further owner notice. Local release commands validate release
metadata, create and push tags, and monitor that workflow. They must not require local qualification and must not call
`gh release create`, `gh release edit`, `glab release create`, or `glab release edit`.

The workflow also exposes a required-tag manual dispatch solely for recovery when a tag cannot or should not be
moved—for example, after its GitHub Release has made it immutable, or when a workflow-only fix on the default branch can
safely retry the existing tagged source. In that mode, the source-quality job runs from the default-branch workflow
revision containing the recovery fix, while metadata validation, release qualification, builds, and publication use the
existing tag, resolved once to its peeled commit SHA. Reusable platform checks also use that product SHA. For the frozen historical product commits of `v0.12.0-rc.1` and
`v0.12.0-rc.2`, manual recovery builds and checks the original Deno container
recipes instead of requiring later Bun-only container tooling. That compatibility path requires the exact recorded
commit; a missing tool on newer source fails normally. Native archive checks compare against the selected product's
Bun pin, not the recovery tooling's pin. Recovery packaging tools come from the workflow revision, not from a changed product source. If a GitHub
Release exists, recovery skips compilation and asset publication. It downloads the existing assets and checks their
completeness, archive checksums, combined checksum file, and GitHub SHA-256 digests before resuming package checks and
publication. It never replaces published files. Missing or inconsistent assets stop recovery for inspection; restore
missing original bytes from retained build artifacts, not a new build. Legacy incidental assets are left intact but are
not packaging inputs. If no Release exists, recovery builds and qualifies the tagged source normally. Never use manual
recovery to bypass a genuine failure in tagged product source. Once a GitHub Release exists, never move its tag to
include a later fix.

After CI publishes a release, Operator edits the release notes from the curated temporary notes file. A release is not
complete until this notes edit is verified. If assets are published but notes editing fails, report the release as
recoverably incomplete and retry with:

```bash
gh release edit <tag> --notes-file <notes-file>
```

## Stable documentation publication

A successful Stable release calls the reusable documentation workflow with the selected release tag. Candidate releases,
`main` pushes, and failed release publication do not update `docs.runwield.dev`. The workflow verifies that the selected
tag is still GitHub latest, merges it into `docs/stable` without force-pushing, records the documented version, checks
the Starlight build, and deploys that exact branch commit through GitHub Pages.

Documentation corrections can publish from `docs/stable` without creating or moving a product tag. Keep those changes to
the public guide allowlist and docs-site tooling, then forward-port them to `main`. A later Stable merge must preserve
them. If it conflicts, repair the named documentation files and retry; do not reset the branch or overwrite the live
manual. A product hotfix still uses the ordinary Candidate/Stable or direct Stable patch process above.

Use the `publish-docs` manual workflow to retry the latest Stable deployment. If a tag-triggered release run merges and
pushes `docs/stable` but Pages rejects the tag under environment branch rules, dispatch `publish-docs` from the allowed
`main` branch with the Stable tag. Do not merge or push the release again:

```bash
gh workflow run docs.yml --ref main -f tag=<stable-tag>
```

Use its bootstrap option only once when `docs/stable` does not exist; it starts from the actual latest Stable tag and
brings over only the reviewed public docs site support. Run `scripts/setup-docs-pages.sh` for the one-time GitHub Pages
and DNS cutover. An older tag, an API failure, a failed build, or a rejected non-fast-forward push must leave the
current Pages deployment unchanged.

## Recovery

- **Initial atomic branch-and-tag push failed**: the local tag remains. Inspect the remote branch and tag because a
  transport failure can be reported after the server accepts the push. The atomic push guarantees that its two remote
  ref updates were both accepted or both rejected. Delete only an unpublished local tag, then rerun. Never replace the
  atomic push with two separate pushes.
- **Local tag created but not pushed**: delete the local tag after confirming no remote tag exists, repair the issue,
  and rerun the command.
- **Remote tag pushed, workflow failed, and no GitHub Release exists**: the tag is mutable. For a branch-based series,
  apply and push the correction to its Release Branch first. After confirming release absence, delete the remote and
  local tag and reuse the same Candidate number at the corrected pushed branch tip. Prefer the immediate next fix
  commit. If the user directs another allowed target, state any concern once; if they confirm, recheck release absence
  and comply. Never fall back to current `HEAD` automatically.
- **GitHub Release exists**: the tag is immutable, including when qualification, asset upload, or notes editing later
  fails. Keep the tag at its original commit and recover the existing release. If a workflow fix is required, dispatch
  `release-gate` manually with that tag after the recovery commit reaches the default branch.
- **Candidate published but should not be promoted**: leave it as a prerelease and publish a later Candidate tag.
- **Assets published but notes pending**: do not recreate the release. Retry the notes edit and verify the published
  notes.

Golden qualification starts beside source quality, binary smoke checks, and compilation. Source and Golden suites each
use four required shards; no shard can cancel or substitute for another. It stops scheduling new test files after the
first failure, but lets active files finish so their evidence remains valid. The workflow retains test logs, Golden
diagnostic files, per-file timing data, and per-test JUnit results as artifacts. Recovery still uses the tagged test
runner: older tags that delete their diagnostic files retain only the surviving failure logs. A timeout remains a failed
gate; it does not trigger an automatic retry or a reduced check.

## Verification expectations

- RC1's tag and new Release Branch identify the same source commit.
- A later Candidate identifies the pushed Release Branch tip selected during preflight, includes its pushed fixes, and
  excludes unrelated later `main` changes.
- Candidate binaries report the Candidate identity, for example `runwield v0.8.12-rc.1 (...)`.
- Promoted Stable binaries report the Stable identity, for example `runwield v0.8.12 (...)`.
- Candidate and promoted Stable tags peel to the same source commit.
- Candidate publication leaves GitHub latest on the prior Stable.
- Every pushed Release Branch fix is on remote `main` before the next Candidate is created.
- After Stable publication, the final Release Branch tip is on remote `main` before the branch is deleted locally and
  remotely.
- Local branches, index, working-tree changes, and untracked files remain untouched by the release command; the required
  merge and branch cleanup are separate operator steps.
