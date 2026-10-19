---
planId: "4ccd11cc-7bc9-4e05-8cce-3448d5862cd6"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "scripts/release.js"
    - "scripts/release.test.js"
    - "scripts/release-policy.test.ts"
    - "docs/releasing.md"
    - "src/prompt-templates/release.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-17"
status: "validated"
origin: "internal"
userVerifiedAt: null
workRecord:
    status: "generated"
    recordId: "cb218bdd-6b7c-4638-bf0c-34f30c0f3988"
    path: "docs/work-records/2026-09-20-isolated-release-candidates-on-release-branches.md"
    lastAttemptAt: "2026-09-20T03:14:45.661Z"
targetBranch: "main"
archivedAt: "2026-09-19T21:47:51.743Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/release-candidate-branches.md"
---

# Isolate Release Candidates on Release Branches

## Context

Today, `scripts/release.js::createCandidate()` tags current `HEAD` for every Candidate. Changes on `main` after RC1 can
therefore enter later Candidates without an intentional release-scope decision.

The owner approved these rules for new series:

- RC1 creates `release/vX.Y.Z` at the confirmed source commit.
- Later RCs tag the pushed release-branch tip, not current `HEAD` or unpushed work.
- Fixes land on the release branch first, then are copied to `main`. Never merge `main` into an active release branch.
- Stable promotion uses the exact tested Candidate commit.
- Existing RC series keep their current behavior. This starts with the next new series.
- Review enforces fixes-only scope. The release command enforces source selection.

The related product capability is Core
[Installation and updates](../../prd/runwield-core-prd.md#installation-and-updates). Add a named **Isolated Candidate
stabilization** requirement and an acceptance scenario for continued feature work on `main` while a release receives
fixes. Keep operational details in [release policy](../../releasing.md). Preserve Candidate versus Stable channel
behavior, package ownership, and Stable-only package publication. These additions are proposed, not evidence of
delivery.

## Objective

New Candidate series have one release branch per full version. Creating later RCs cannot accidentally tag the caller's
feature work. Release fixes remain available to `main` through explicit forward-porting.

## Approach

Keep the existing commands and tag-triggered build workflow:

```text
/release -> repository policy -> release:candidate -> createCandidate
  RC1: confirmed HEAD -> origin release/vX.Y.Z + annotated RC1 tag
  RC2+: origin release/vX.Y.Z -> annotated RC tag at that exact commit
release:promote -> origin Candidate tag -> Stable at the same commit
```

### Branch and source rules

- Derive `release/vX.Y.Z` from the parsed Candidate version. RC1 still permits a non-main or dirty checkout. Only
  committed content enters the release. Do not switch branches, stash, reset, or alter the index or working files.
- Publish the initial remote branch and RC1 tag with an atomic Git push. Require the remote branch to be absent rather
  than moving an existing branch. Do not fall back to separate pushes if atomic publication fails. Local tracking
  checkout creation is not required; document how to open the branch for fixes.
- If the remote branch already exists and RC1 is absent, treat this as a retry or name conflict, not a new cut from
  `HEAD`. Use the existing pushed branch as the proposed source, show it explicitly, and never reset it. A user who
  needs another source must resolve that branch deliberately before retrying.
- For later RCs, resolve the live `origin` branch, not a cached remote-tracking ref or local branch. Obtain its commit
  objects without moving the caller's branches. Require the previous remote Candidate commit to be an ancestor of the
  selected tip; equality is allowed. Missing branch, missing remote predecessor, or unrelated history stops tagging.
- Show the branch, resolved commit, tag, and planned remote changes in dry-run and execution output. Recheck the remote
  branch before tag publication; if it changed during preflight, stop for a fresh preflight. Tag the explicit resolved
  commit, never a moving name. This does not lock the branch against a later concurrent push.
- Keep RC ordering, duplicate-tag checks, GitHub Release absence checks, and version rules. Fixes must be pushed before
  a later RC operation. Do not automatically push local fixes or copy fixes to `main`.

### Compatibility and recovery

Use a fixed, documented legacy-series list, not the absence of a release branch, to select the old HEAD-based behavior.
The series observed on `origin` during planning are `v0.8.16`, `v0.9.0`, `v0.9.2`, `v0.9.3`, `v0.9.4`, `v0.9.6`, and
`v0.10.1`. Verify the list before implementation; any additional series that started before rollout must be explicitly
recorded. Do not add new series dynamically. Existing version checks still apply to legacy series.

Keep the existing boundary: an unreleased tag can be removed and retried at a corrected source; a tag with a GitHub
Release remains immutable. The normal retry keeps the same RC number after confirming release absence and deleting the
failed tag. For branch-based series, push the correction to the release branch first. Preserve deliberate owner-directed
exceptions described in the policy; do not add an automatic fallback to `HEAD`. Do not delete published Releases or move
published tags as part of this change.

Promotion remains tied to the selected remote Candidate tag, even if the branch has since advanced. Direct Stable
remains an explicit exceptional HEAD-based operation, and still refuses versions that already have Candidates. Keep
release branches after promotion; automatic cleanup and ongoing patch-maintenance workflows are outside this change.

### Scope boundary

This is repository release tooling, not a change to Planned Change publication or worktree management. Keep the bundled
`/release` prompt generic: it follows each repository's policy. Add only a concise instruction to include a
policy-defined source branch and branch creation in confirmation, and to derive notes from the selected release source
rather than the caller's checkout.

Keep `.github/workflows/release.yml` tag-driven. It already checks out the requested tag for qualification, builds, and
publication. Its `checkout -B main "$GITHUB_SHA"` does not import newer `main` commits. Server-side branch protections,
manual-tag provenance enforcement, and automatic classification of fixes versus features are not promised here. This
avoids adding a new publication gate while changing the supported release command. Review still checks release scope. No
existing architectural decision record governs this release-source choice; a new one is not needed for this bounded
policy change.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `scripts/release.js` — Candidate source selection, branch creation, ancestry checks, and source reporting.
- `scripts/release.test.js` — real Git coverage for branch publication, source isolation, retry, and compatibility.
- `scripts/release-policy.test.ts` — preserve generic prompt and workflow ownership; replace obsolete assertions that
  prohibit Candidate branch checks. Text checks supplement, not replace, behavior tests.
- `docs/releasing.md` — branch workflow, confirmation, notes ranges, fixes-first flow, legacy list, and recovery.
- `src/prompt-templates/release.md` — generic source-branch confirmation and release-source notes guidance only.
- `docs/prd/runwield-core-prd.md#installation-and-updates` — lasting isolation requirement and observable scenarios.
- `docs/domain-language.md` — concise Release Candidate and Release Branch definitions; distinguish a Release Candidate
  from the existing Publication Candidate used by Planned Change delivery.
- `.github/workflows/release.yml` — inspect and preserve tag-pinned builds and channel rules; no new gate is planned.

## Reuse Opportunities

- `parseReleaseTag`, `stableTagForCandidate`, `listAllReleaseTags`, `resolveRemoteTagCommit`, and
  `assertHostReleaseAbsent` already own version parsing, tag discovery, and publication preflight.
- `createAndPushTag` and `promoteCandidate` already tag explicit commits. Preserve that property.
- Existing `repoDeps()` and Git test helpers provide real Git execution with simulated GitHub responses. For new
  fixtures, follow `src/shared/git-test-fixture.ts::defineGitFixture` conventions and use a temporary bare remote. Fake
  external GitHub responses or subprocess failures, not release-owned decisions. Add no new injection seam.

## Implementation Steps

1. Candidate preflight deterministically selects initial HEAD, a pushed release-branch commit, or the fixed legacy path.
   Later Candidates never use caller HEAD as a fallback. Output identifies the actual source and proposed publication.
2. RC1 publishes its release branch and annotated tag together without changing the caller's checkout. Existing-branch
   retries preserve that branch. Later tags resolve to the verified remote tip and preserve previous Candidate ancestry.
   Failed publication cannot silently move an existing branch or claim success.
3. Real-Git tests prove feature exclusion, pushed-fix inclusion, remote authority, initial publication, and failure
   cases. Existing promotion, direct-Stable, dirty-checkout, version, channel, and duplicate protections remain covered.
4. Release policy and generic prompt agree on source confirmation, source-based notes, fixes-first work, explicit
   forward-porting, legacy compatibility, and retry rules. Document that release fix Plans must explicitly target the
   release branch; ordinary feature work continues on `main`. Do not change global Plan targeting defaults.
5. The owning Core capability, glossary definitions and avoided aliases, and affected references match implemented
   behavior in the same change. Preserve unmet package-availability requirements and unrelated PRD content.

## Approval Confirmation

No Work Records are proposed for supersession. Approval covers the owner-confirmed branch workflow. Reviewable scope
assumption: command enforcement plus fixes-only review is sufficient; no hosted branch-protection setup or manual-tag
publication gate is included.

## Verification Plan

Run tests through the sandboxed runner only:

```sh
deno run -A scripts/run-tests.js scripts/release.test.js scripts/release-policy.test.ts scripts/release-check.test.js
deno task ci
```

Required behavior tests use disposable repositories and a bare origin. Never publish test tags to the real repository.

- **Decisive isolation journey:** create RC1 through the real Candidate function. Assert remote branch and peeled tag
  both equal the initial commit. Add a feature file on `main`, push a fix file on the release branch, then invoke RC2
  from `main`. Read RC2's tree from the remote: it contains the fix, excludes the feature, and equals the pushed branch
  commit. The current HEAD-based implementation must fail this test.
- **Remote authority:** advance the release branch from a second clone while the caller has stale tracking refs and
  different local/unpushed work. RC2 uses the pushed commit. Cover fetching a commit absent from the caller's object
  database. Unpushed work is excluded even when the caller is on the local release branch.
- **Work preservation and dry-run:** capture current branch, HEAD, index diff, unstaged diff, untracked contents, and
  local/remote refs. They remain unchanged after dry-run; the output reports the correct source and proposed refs.
  Normal publication also preserves checkout, index, and working files. Object fetches may occur for inspection but must
  not move user refs or leave temporary files/refs behind.
- **Refusal paths:** missing branch for a new series, unrelated branch history, absent remote predecessor, wrong RC
  ordinal, duplicate tags, and an existing GitHub Release all stop before publication. Deleting a new series' branch
  must not classify it as legacy. A changed remote branch during preflight must not publish a tag from caller HEAD.
- **Atomic creation and retry:** make a bare-remote hook reject the initial tag push. Neither remote branch nor tag is
  published. Check the reported local state and retry after safe local-tag cleanup. Also cover a branch created by
  another actor before publication: it is not overwritten. An existing-branch RC1 retry uses its pushed source even when
  HEAD differs. An unpublished later tag can be removed and its RC number reused after a pushed fix; no new automatic
  tag-deletion command is required.
- **Legacy compatibility:** parameterize an explicitly grandfathered version with a suitable earlier Stable baseline;
  later RCs retain the old source rule. A non-grandfathered series with tags but no branch must fail instead of gaining
  legacy behavior.
- **Preserved behavior:** promotion's Stable tag equals the selected Candidate even after branch and HEAD advance;
  incomplete Candidate assets and stale local Candidate tags still fail. Direct Stable retains its existing source and
  version checks. Candidate metadata remains prerelease/not-latest; Stable packaging and recovery remain tag-pinned.

Semantic review must trace `main()` through `createCandidate()` into real Git publication, not accept a branch helper
that is never called. Check that obsolete "every Candidate uses HEAD" test expectations are replaced, not that
dirty-tree or exact-commit protections are deleted. Confirm docs, glossary, and PRD scenarios agree and do not claim
server-side fixes-only enforcement.

Manual verification is a disposable-repository walkthrough of RC1, divergent main feature work, pushed release fix, RC2,
and promotion with simulated GitHub responses. Inspect dry-run output and Git history. Actual release publication needs
separate owner confirmation and is not part of executing this Plan.

## Edge Cases & Considerations

- Git cannot determine whether a change is a fix. Review is responsible for keeping features and broad merges out of the
  release branch. Copy fixes to `main` explicitly so future versions do not lose them.
- A remote failure can leave a local tag. Report the exact remaining state; preserve existing refs and use the
  documented release-absence checks before cleanup. Atomic push support is required for the initial branch-and-tag
  publication.
- A remote branch can advance after the last check. The tag must still identify the explicit verified commit; do not
  claim a branch lock or alter the tag after publication.
- Release notes must inspect the selected release commit and previous Stable/Candidate tags, not current `HEAD`.
- The fixed legacy list prevents accidental bypass when a new branch is missing. Older series are not migrated.
- No production branch or release tag is created during planning or implementation verification.
