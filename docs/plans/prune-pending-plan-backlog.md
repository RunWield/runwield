---
planId: "e0d548d5-c6f0-412c-90c4-0f76be5f47ff"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "MEDIUM"
affectedPaths:
    - "docs/plans/"
    - "docs/plans/forge-change-request-delivery.md"
    - "docs/plans/epic-branch-publication-workflow.md"
    - "docs/plans/isolate-planning-and-reuse-worktrees.md"
    - "docs/plans/finish-injection-seam-ownership-enforcement.md"
    - "docs/plans/archived/"
    - "docs/prd/plan-store-prd.md"
    - "docs/validation-authority.md"
    - "TODO.md"
planDeviations:
    - id: "call_29851ade7bfb4878a4ee24cd81828898|fc_061d82cb739e466c016adfe6e6edc0819695a87f990a3cf356"
      supersededRequirement: "Move forge-change-request-delivery to Draft on the Workspace Plan board. This is the manual_status_change board action, not a front matter edit. Lifecycle operations belong to the owner on the primary checkout before execution starts."
      replacementRequirement: "The Engineer is authorized to complete the remaining lifecycle preconditions, including returning forge-change-request-delivery to Draft through RunWield's supported lifecycle operation, and to make the completed preconditions available to the existing execution checkout. Do not hand-edit protected lifecycle metadata or discard user work."
      reason: "The owner completed the abandonment and archive steps but cannot perform the board action, and explicitly authorized the Engineer to complete the remaining operations."
      approvedAt: "2026-10-26T23:49:00.773Z"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-26"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
routingIntent: "PLANNED_CHANGE"
sessionName: "Pending Plan Cleanup"
status: "reviewed"
---

# Prune the Pending Plan Backlog

## Context

The active Plan backlog has 27 top-level Plans and about 45 child Plans. Many are done, duplicated, or replaced by work
that shipped in a different shape. This makes it hard to see the real pending work. The owner's current priorities are
the Rafael demo, Connect, the Usage dashboard, Workspace SaaS, and Remote SSH. Core is moving to maintenance mode.

A review of every pending Plan against current source, branches, Work Records, PRDs, and ADRs sorted them into four
groups.

**In-flight Epics.** These stay out of this cleanup. Their `origin/epic/*` branches own their Plans. The copies on main
are old snapshots, and the Epic merge replaces them:

- `attached-mode-claude-feature-preview` (Connect): all children verified on the branch, and repair child 14 is
  implemented.
- `reliable-usage-dashboard-and-langfuse-export`: children 01–10 are verified on the branch.
- `remote-ssh-development`: children 01–12 are verified on the branch, and child 13 is in planning.
- `document-usage-comparison-guidance` and `document-usage-gap-comparison-guidance`: both are verified on the Usage
  Epic branch.
- `protect-new-package-extension-consent`: Usage child 06 absorbed this fix and deletes this Plan on the Epic branch.
  The Usage Plans on main still link to it.
- `remote-session-save-proof`: validated and merged, but the Remote SSH Plans on the Epic branch link to it. Archive it
  when that Epic closes.

**Done.** These are archived through RunWield (see Owner Preconditions):

- `acp-chat-menus-for-commands`: verified, Work Record `2026-10-18-acp-chat-menus-for-commands-and-workflow-questions`.
- `acp-mid-turn-steering-extension`: verified, Work Record `2026-10-21-acp-mid-turn-steering-extension`.
- `reviewer-benchmark-discovery-pairs`, with child 03 and `manual-qa.md`: verified, Work Record
  `2026-10-26-full-discovery-corpus-and-case-level-benchmark-adjudication`. Children 01–02 are already archived.
- `fix-recovery-worktree-discard-cleanup`: delivered (`src/shared/worktree.js` keeps rescue branches and refuses to
  discard the primary checkout), Work Record `2026-09-08-main-checkout-and-worktree-recovery-repair`. Its status is
  still `feedback`.

**Duplicate, overtaken, or replaced.** These are deleted. Git history keeps their text.

| Plan                                                                                                                                        | Why it goes                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `usage-live-abandonment-workspace-doc`, `usage-live-interruption-desktop-phone-guidance`, `usage-live-repair-settings-multidevice-guidance` | Test vehicles from the Usage Epic's live acceptance run. The Epic branch already has their guidance. They document a Usage page that main does not have.                                         |
| `focused-semantic-review-after-human-feedback`                                                                                              | Shipped in a different shape: after Code Review feedback, RunWield skips AI review (`validation-semantic.ts`).                                                                                   |
| `guided-validation-repair`                                                                                                                  | Mostly shipped as Engineer follow-up and the Code Review conversation. It depends on the deprecated Plan Workflow Lease. `TODO.md` already marks it done.                                        |
| `offer-semantic-review-intervention`                                                                                                        | The round-limit user choice and the Code Review conversation cover most of it. Not a priority.                                                                                                   |
| `deep-semantic-source-modules`                                                                                                              | A move of about 600 files written for the Deno layout. The Plans it depends on no longer exist.                                                                                                  |
| `plan-packages-and-independent-validation` (Epic and 7 children), `plan-package-frontend-experience-planning`                               | The [Plan Store PRD](../prd/plan-store-prd.md) replaces the in-repo package layout. The build-state copy rule, Slicer journeys, the prototype skill, and the bounded review rounds have shipped. |

**Kept.** These stay as they are, apart from the reference repairs listed below:

- `automatic-session-context-resilience`, `finish-injection-seam-ownership-enforcement`,
  `require-login-session-context-for-post-login-setup`, `lazy-skill-catalog-retrieval`, and
  `epic-branch-publication-workflow`. Owner decision: keep all five. Fix their stale commands when one of them is picked
  up.
- `side-effect-free-plan-reads` and `isolate-planning-and-reuse-worktrees`. They are still valid, but must be re-planned
  against current main before execution.
- `forge-change-request-delivery`. Owner decision: delete its 13 children, keep the Epic as a draft, and add a notice
  that Architect must review it again before work resumes.

## Objective

After this change, `docs/plans/` holds only real pending work. Each deleted Plan has no remaining inbound references.
Each archived Plan has working relative links. The Forge Epic is a draft with no children and a clear notice for
Architect.

Target top-level active Plans after this change, before the in-flight Epics merge:

```text
docs/plans/
├── attached-mode-claude-feature-preview.md (+ folder)       # in flight, Epic branch owns it
├── reliable-usage-dashboard-and-langfuse-export.md (+ folder) # in flight, Epic branch owns it
├── remote-ssh-development.md (+ folder)                     # in flight, Epic branch owns it
├── document-usage-comparison-guidance.md                    # verified on Usage Epic branch
├── document-usage-gap-comparison-guidance.md                # verified on Usage Epic branch
├── protect-new-package-extension-consent.md                 # Usage Epic merge deletes it
├── remote-session-save-proof.md                             # archive when Remote SSH closes
├── automatic-session-context-resilience.md
├── epic-branch-publication-workflow.md
├── finish-injection-seam-ownership-enforcement.md
├── forge-change-request-delivery.md                         # draft, no children, Architect notice
├── isolate-planning-and-reuse-worktrees.md
├── lazy-skill-catalog-retrieval.md
├── require-login-session-context-for-post-login-setup.md
└── side-effect-free-plan-reads.md
```

That is 15 top-level Plans, down from 27 (this cleanup Plan is not counted). The change deletes 29 Plan files and
archives 4 Plans (6 files).

## Approach

The cleanup has two kinds of work, each with a different owner.

**Lifecycle operations belong to RunWield.** Archiving, abandoning worktrees, and changing Plan status write protected
metadata and runtime state, so an Agent must not edit them by hand. The owner does these on the primary checkout with
RunWield commands before execution starts. See Owner Preconditions.

**File deletions and reference repair belong to the Engineer.** The Engineer deletes the replaced Plans, edits the Forge
Epic body, and repairs every reference so that `bun run doc-links:check` passes.

> [!WARNING]
> **Do not edit in-flight Epic Plans on main**
>
> The Connect, Usage, and Remote SSH Epic branches changed their Plan files. Editing the main copies now causes merge
> conflicts, and the merge replaces those copies anyway. This includes `protect-new-package-extension-consent.md`,
> `remote-session-save-proof.md`, and the two `document-usage-*` Plans.

The alternative was to force-archive the replaced Plans instead of deleting them. Archive Prune only removes archived
Plans that have Work Record coverage, so these would stay in `archived/` forever. The owner's earlier cleanup commit
(`11f783d6f`) deleted an obsolete draft for the same reason.

### Owner Preconditions

Do these on the primary checkout and commit them to `main` before execution starts:

1. Abandon the worktrees of Plans that will be deleted. For each Plan, run `wld load-plan <name>` and choose Abandon:
    - `usage-live-interruption-desktop-phone-guidance` (registry: active)
    - `usage-live-repair-settings-multidevice-guidance` (registry: completed, not merged, do not merge it)
    - `plan-packages-and-independent-validation/01-establish-plan-package-storage` (planning worktree, no commits)
2. Archive the done Plans:
    - `wld plans archive acp-chat-menus-for-commands`
    - `wld plans archive acp-mid-turn-steering-extension`
    - `wld plans archive reviewer-benchmark-discovery-pairs/03-context-fixtures-and-full-discovery-run`
    - `wld plans archive reviewer-benchmark-discovery-pairs`
    - `wld plans archive fix-recovery-worktree-discard-cleanup --force --reason "Delivered; Work Record 2026-09-08-main-checkout-and-worktree-recovery-repair"`
3. Move `forge-change-request-delivery` to Draft on the Workspace Plan board. This is the `manual_status_change` board
   action, not a front matter edit.

## Expected Change Surface

This list is guidance, not an allowlist. Verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent:
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `docs/plans/usage-live-*.md` (3 files), `focused-semantic-review-after-human-feedback.md`,
  `offer-semantic-review-intervention.md`, `guided-validation-repair.md`, `deep-semantic-source-modules.md`,
  `plan-packages-and-independent-validation.md` and its folder, `plan-package-frontend-experience-planning.md`: deleted.
- `docs/plans/forge-change-request-delivery/`: deleted (13 children).
- `docs/plans/forge-change-request-delivery.md`: gets an Architect re-review notice, and its child-decomposition
  references are removed.
- `docs/plans/epic-branch-publication-workflow.md`: its prerequisite references to the deleted Plan Packages Plans are
  replaced with a reference to the Plan Store PRD.
- `docs/plans/isolate-planning-and-reuse-worktrees.md`: the Plan Packages link becomes plain text that says the Plan was
  removed.
- `docs/plans/finish-injection-seam-ownership-enforcement.md`: references to `deep-semantic-source-modules.md` are
  removed from `affectedPaths` and the body.
- `docs/plans/archived/`: relative links in the newly archived Plans are repaired. The 4 broken links that already exist
  in `archived/epic-branches-and-integration-gate.md` are repaired. Its reference to Plan Packages becomes plain text.
- `docs/prd/plan-store-prd.md`: the sequencing paragraph no longer depends on the deleted Plan Packages Epic.
- `TODO.md`: items 9–11 reflect the deletions.
- `docs/validation-authority.md`: no longer names `guided-validation-repair` as current scope.

Left out on purpose:

- `docs/reports/core-prd-gap-audit.md` is a dated point-in-time report. Its Plan mentions are historical, not links.
- `src/shared/workflow/epic-branch.test.ts` uses `plan-packages-and-independent-validation` only as an
  example name string.

## Reuse Opportunities

- `bun run doc-links:check` (`scripts/check-doc-links.ts`) finds every broken relative link and heading fragment.
- Commit `604525587` ("Archive completed Plans and repair links") shows how archived Plan links were repaired before.

## Implementation Steps

- Before any file change, these are true on the execution base: `acp-chat-menus-for-commands.md`,
  `acp-mid-turn-steering-extension.md`, `reviewer-benchmark-discovery-pairs.md`, and
  `fix-recovery-worktree-discard-cleanup.md` exist under `docs/plans/archived/` and not under the top-level
  `docs/plans/`. If any Owner Precondition is missing, stop and report it. Do not move these files by hand.
- These files and folders do not exist: `docs/plans/usage-live-abandonment-workspace-doc.md`,
  `docs/plans/usage-live-interruption-desktop-phone-guidance.md`,
  `docs/plans/usage-live-repair-settings-multidevice-guidance.md`,
  `docs/plans/focused-semantic-review-after-human-feedback.md`, `docs/plans/offer-semantic-review-intervention.md`,
  `docs/plans/guided-validation-repair.md`, `docs/plans/deep-semantic-source-modules.md`,
  `docs/plans/plan-packages-and-independent-validation.md`, `docs/plans/plan-packages-and-independent-validation/`,
  `docs/plans/plan-package-frontend-experience-planning.md`, and `docs/plans/forge-change-request-delivery/`.
- `docs/plans/forge-change-request-delivery.md` starts its body, directly under the title, with a `[!WARNING]` callout
  titled "Architect re-review required before resuming". The callout says:
    - the Epic was first planned on 2026-08-28 under the Deno toolchain;
    - since then RunWield moved to Bun and TypeScript, shipped the Plan Branch delivery setting
      (`plans.autoMergeIntoTargetBranch`), Epic branches and the integration gate, and the `reviewed` checkpoint status;
    - its 13 child Plans were deleted on 2026-10-26 because they were stale and Forge is not a current priority;
    - before work resumes, Architect must re-review the Epic against the current code and PRDs and decompose it again.
- `docs/plans/forge-change-request-delivery.md` keeps its front matter except for the status, which the owner changes on
  the board. No line in it links to or names a file under `forge-change-request-delivery/`.
- `docs/plans/epic-branch-publication-workflow.md` names no deleted Plan. Where it named Plan Packages as a prerequisite
  or sibling, it now says those Plans were removed on 2026-10-26 and that the
  [Plan Store PRD](../prd/plan-store-prd.md) owns the Plan storage direction. Its other content is unchanged.
- `docs/plans/isolate-planning-and-reuse-worktrees.md` has no link to `plan-packages-and-independent-validation.md`.
  The sentence names the removed Plan as plain text. Its other content is unchanged.
- `docs/plans/finish-injection-seam-ownership-enforcement.md` has no `deep-semantic-source-modules` entry in
  `affectedPaths` and no body sentence that depends on that Plan. Its other content and its front matter `status` are
  unchanged.
- `docs/prd/plan-store-prd.md` no longer links to the Plan Packages Epic. The sequencing paragraph says the Plan Store
  is planned through Architect, and does not claim that a later Epic will build packages in the Plan folder.
- `TODO.md` items 9, 10, and 11 no longer list the deleted Plans as pending. Item 11 still names
  `epic-branch-publication-workflow.md` as pending.
- `docs/validation-authority.md` no longer lists `guided-validation-repair` as current scope.
  `classify-validation-operational-errors` stays in the list.
- Every relative link and heading fragment in the newly archived Plans and in
  `docs/plans/archived/epic-branches-and-integration-gate.md` resolves. That file names the Plan Packages Plan as plain
  text.
- No file changes under `docs/plans/attached-mode-claude-feature-preview*`,
  `docs/plans/reliable-usage-dashboard-and-langfuse-export*`, `docs/plans/remote-ssh-development*`,
  `docs/plans/document-usage-*.md`, `docs/plans/protect-new-package-extension-consent.md`, or
  `docs/plans/remote-session-save-proof.md`.

## Verification Plan

- Automated:
    - `bun run doc-links:check` passes. It fails today with 4 broken links in
      `archived/epic-branches-and-integration-gate.md`. It also fails if a deleted Plan is still linked.
    - This command prints no lines:
      `git grep -n -E "focused-semantic-review-after-human-feedback|offer-semantic-review-intervention|guided-validation-repair|deep-semantic-source-modules|plan-packages-and-independent-validation|plan-package-frontend-experience-planning|usage-live-|forge-change-request-delivery/" -- . ':!docs/plans/archived' ':!docs/work-records' ':!docs/reports' ':!src/shared/workflow/epic-branch.test.ts'`
    - `git diff --name-status main...HEAD -- docs/plans/attached-mode-claude-feature-preview* docs/plans/reliable-usage-dashboard-and-langfuse-export* docs/plans/remote-ssh-development* docs/plans/document-usage-* docs/plans/protect-new-package-extension-consent.md docs/plans/remote-session-save-proof.md`
      prints nothing.
    - `ls docs/plans/*.md` prints exactly the 15 Plans in the Objective's target tree, plus this Plan
      (`prune-pending-plan-backlog.md`).
    - `bun run fmt:check <each edited Markdown file>` passes.
- Manual, by the owner after publication:
    - `wld plans` lists the 15 top-level Plans and their in-flight children, with no deleted Plan.
    - `wld plans archive` lists the 4 newly archived Plans.
    - `wld plans doctor` reports no orphan worktree or controller record for the deleted Plans.
    - The Forge Epic opens in Workspace as a Draft that shows the Architect notice and has no children.

## Edge Cases & Considerations

- **Owner Preconditions not done.** The first Implementation Step stops execution. This keeps the Engineer from moving
  archived files by hand and writing protected archive metadata.
- **Abandon menu has no planning-worktree option.** If `wld load-plan` does not offer Abandon for the Plan Packages child
  01 planning worktree, delete the files anyway. After publication, resolve any orphan that `wld plans doctor` reports
  through its offered repair.
- **Leftover branches.** `worktree/usage-live-abandonment-workspace-doc-e0b521dc` has no registry entry. The branches
  `worktree/acp-shared-slash-commands-94eaf837`, `worktree/local-skill-precedence-da12d972`, and
  `worktree/fix-project-vision-fallback-submission-62d4278b` contain work that already landed on main. Branch deletion is
  outside this documentation change. The owner can remove them with `git branch -D` at any time.
- **`side-effect-free-plan-reads` worktree.** It holds uncommitted code on a base about 3,500 commits behind main. This
  change keeps the Plan and the worktree as they are. The owner decides whether to salvage the code when the Plan is
  re-planned.
- **Follow-up after the Epics merge.** After the Usage merge, archive the two `document-usage-*` Plans. After the Remote
  SSH Epic closes, archive `remote-session-save-proof` and repair its inbound links.
- **Assumption:** removing references to deleted Plans from the kept Plans is reference maintenance. It does not change
  their scope. This follows the owner's "keep as they are" decision.
