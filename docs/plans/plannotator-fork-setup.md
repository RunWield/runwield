---
planId: "b1af5661-1331-4c06-843c-21857e18c59a"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "LOW"
affectedPaths:
    - "docs/plans/plannotator-fork-extensions.md"
    - "docs/plans/plannotator-host-html-restrictions.md"
    - "docs/plans/plannotator-annotation-context.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-12"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
status: "in_progress"
---

# Set Up the Plannotator Fork and PR Worktrees

## Context

The owner selected repository setup as the first step: fork `backnotprop/plannotator` to `gandazgul/plannotator`, clone it
under `~/web/`, and make separate worktrees for two focused upstream PRs. The [shared proposal](plannotator-fork-extensions.md)
and complete feature Plans preserve the agreed behavior:

- [Host restrictions](plannotator-host-html-restrictions.md): extend the existing sandbox with early resource restrictions
  and non-live bridge enforcement; use self-contained HTML and the inline bridge. Existing callers stay unchanged.
- [Annotation context](plannotator-annotation-context.md): capture bounded generic labels declared by the prototype and
  chosen by the host. Target comments capture at selection; global comments capture when the composer opens.

This session belongs to RunWield, not the new fork. Its workflow cannot be assumed to change projects because a Plan
names another directory. This setup Plan creates and verifies the destination, then hands off the feature Plans. It does
not execute feature code or treat RunWield checks as proof that Plannotator works.

The originating requirement is [interactive prototype review](../prd/product-planner-prd.md#interactive-prototype-review),
with lasting ownership in [Workspace browser review](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow).
Setup delivers no product capability. Those requirements remain targets; no PRD or glossary changes belong in this step.

## Objective

A verified fork clone exists at `~/web/plannotator`, with two independent worktrees based on the same current upstream
commit and the agreed feature Plans available for execution in the Plannotator project. RunWield source, submodule,
and dependency pin remain unchanged.

## Approach

Use GitHub CLI and Git. The owner approved fork creation and the local setup; no separate authorization is needed for
those actions. Recheck before creating anything, because another process may have completed setup since discovery.

```text
~/web/plannotator/                         origin: gandazgul/plannotator
  .worktrees/                             upstream: backnotprop/plannotator
    host-html-restrictions/                feat/host-html-restrictions
    annotation-context/                   feat/html-annotation-context
```

**Reviewable naming assumptions:** use the worktree directories and branch names above. Both branches start from one
freshly fetched `upstream/main` commit; do not stack the context branch on the restrictions branch. Keep the fork's main
checkout free of product edits. Exclude `.worktrees/` through the clone's local Git exclude file.

Create the fork with `gh repo fork backnotprop/plannotator --clone=false`, then clone explicitly with
`git clone https://github.com/gandazgul/plannotator.git ~/web/plannotator`. Configure `upstream` as
`https://github.com/backnotprop/plannotator.git` and fetch its main branch. Resolve its exact commit once, then use that
commit for both `git worktree add -b` calls. Do not blindly execute creation commands against existing paths or branches.

Copy the two feature Plan definitions and their shared proposal into the fork's `docs/plans/` and make them available in
the corresponding worktrees. Include this setup Plan as handoff context. Preserve owner decisions and supported Plan
metadata; do not hand-edit protected lifecycle fields to make the Plans ready or approved. Keep planning artifacts out
of the two upstream feature diffs. Before later submission, use the project's normal Plan loading/adoption path.

Resolve relative links that point to RunWield-only documents as explicitly external source references during handoff.
Do not copy RunWield PRDs, Agents, storage, policy files, or workflow machinery into Plannotator. Read current upstream
project guidance and report its verification commands; installing dependencies or running product tests is not required
for this repository-only setup.

The alternative—developing inside RunWield's submodule—would keep execution attached to the wrong project and couple the
PRs to a downstream pin update. The owner chose a separate fork instead.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- GitHub `gandazgul/plannotator` — create the upstream fork if absent; verify its parent and push access.
- `~/web/plannotator` and its Git configuration — clone, origin/upstream remotes, local excludes, and worktree registrations.
- `~/web/plannotator/.worktrees/` — separate feature checkouts at the same recorded upstream base.
- The four `docs/plans/plannotator-*.md` documents named here — transfer the settled request and execution handoff without
  changing feature scope or claiming implementation.

No RunWield product code, dependency pins, Plannotator product source, package installation, or PR publication changes.

## Reuse Opportunities

- Existing authenticated `gh` and Git commands; no new setup tool or cross-project workflow feature.
- Existing Plan loading/adoption for the future Plannotator sessions.
- The two complete feature Plans; do not repeat the product interview or redesign their accepted contracts during setup.

## Implementation Steps

1. **The fork identity is verified.** `gandazgul/plannotator` exists, GitHub identifies it as a fork of
   `backnotprop/plannotator`, and the authenticated owner has push access. If creation or access fails, report the actual
   external prerequisite; do not substitute another repository or claim success.
2. **The clone and remotes are correct.** `~/web/plannotator` is the fork's Git checkout, `origin` points to the fork,
   `upstream` points to the original project, and current upstream main has been fetched. Existing content is preserved;
   a conflicting directory or remote is reported rather than overwritten.
3. **Two independent worktrees are real and usable.** Both named worktrees are registered under that clone with separate
   feature branches and the same recorded upstream base. Local exclusions keep worktree contents out of the primary
   checkout's Git status. Existing work is never reset, deleted, or force-replaced.
4. **The implementation handoff is complete.** Both worktrees contain the relevant settled feature Plan and its linked
   planning context. External RunWield references remain identifiable and do not become broken local links. Report the
   verified fork URL, base commit, branch/worktree mapping, current Plannotator verification guidance, and which Plan to
   load first. Do not start either feature from the RunWield workflow.

## Approval Confirmation

No Work Records are proposed for supersession. Fork creation, cloning at `~/web/plannotator`, separate worktrees, and
current-upstream contribution bases were selected by the owner. Directory/branch names are reviewable implementation
assumptions. This setup does not authorize changes to the RunWield pin or implementation outside the two feature Plans.

## Verification Plan

These checks prove setup; no product tests are claimed:

- `gh api repos/gandazgul/plannotator --jq '{full_name, fork, parent: .parent.full_name, push: .permissions.push}'`
  must identify the selected fork, the correct parent, and push permission.
- `git -C ~/web/plannotator remote -v` must show the selected origin and upstream for fetch/push as configured.
- `git -C ~/web/plannotator worktree list --porcelain` must list the primary checkout and both requested feature paths
  with their separate branches. Resolve symlinks/physical paths when comparing.
- `git -C ~/web/plannotator rev-parse upstream/main` and `git -C <each-worktree> rev-parse HEAD` must match the recorded
  base immediately after new-worktree creation. If reusing a worktree with commits, inspect and preserve its work; do not
  reset it to manufacture a passing equality check. Report its real base and additions.
- From each worktree, `git rev-parse --git-common-dir` must resolve to the clone's common Git directory. An unrelated
  clone or empty directory does not satisfy the worktree requirement.
- Read back the transferred Plans. Confirm the host restrictions, explicit labels, target-selection timing,
  global-comment opening-time capture, generic interface, and out-of-scope RunWield integration are intact.
- Inspect tracked changes to confirm setup did not modify RunWield's submodule/pin or Plannotator product source. Verify
  planning copies and nested worktree directories will not be included in the upstream feature diffs.
- Re-read Plannotator's current `AGENTS.md`, `packages/ui/AGENTS.md`, package scripts, and relevant CI workflows. Record
  supported commands in the handoff; do not reuse RunWield's full verification command for feature execution.

## Edge Cases & Considerations

- Existing fork, clone, branch, or worktree: inspect and reuse only when identity matches. Preserve all existing work.
- GitHub authentication or permissions can block fork creation. Report the concrete failure and leave partial successful
  setup intact for a retry; do not delete the fork or clone as cleanup.
- Upstream may advance during setup. Both new branches use the exact commit fetched and recorded for this operation.
- No automatic cross-project continuation is promised. Subsequent implementation sessions must be attached to the
  Plannotator project/worktrees so their source changes and verification use the correct repository.
- Setup is complete only when its remote, clone, worktree, and handoff evidence is checked—not when commands are started.
