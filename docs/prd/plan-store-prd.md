# Plan Store

Last updated: 2026-10-05 EDT

## Background

RunWield keeps every Plan as a Markdown file in the project's repository, under `docs/plans/`. Each checkout of that
repository therefore holds its own copy of every Plan: the primary checkout, every planning and execution worktree, and
every branch, including Epic branches. RunWield spends a large and growing share of its workflow machinery deciding
which copy is authoritative and reconciling the others. This proposal moves Plans and Work Records into one
RunWield-managed store outside the repository. Plan documents stay plain, unencrypted, human-readable Markdown, and the
metadata RunWield owns moves into a separate file beside them. Each project chooses separately whether delivered Plans
and Work Records are also committed to the repository.

## Problem Description

**One Plan, many copies.** A Plan's status, metadata, and body can each differ between checkouts. Recurring failures
trace back to that, including several fixed in the last week:

- A new Epic branch is missing its child drafts, so the first child cannot start.
- Planner's edits to sibling Plans stay stranded in one child's worktree until that child's execution starts.
- Lifecycle status is written in an execution worktree and must be carried back to the primary checkout; a stale primary
  copy must never overwrite it.
- Archiving or reading a child silently prepares a planning worktree because the authoritative copy lives on a branch.
- Publication must carry Plan files through merges and treat them specially in conflict and cleanup handling.

Each fix closes one path; the next workflow finds another. The cause is structural: code needs many divergent copies,
but a Plan needs exactly one.

**Plans leave a footprint in other people's repositories.** A contributor who uses RunWield on an open-source project
puts `docs/plans/` files into their branches and pull requests. Some maintainers will not want that, and the contributor
may not want to publish their planning.

**Plans are lost when a folder moves.** RunWield keys Sessions by folder path today. Renaming or moving a project folder
loses Session history; tying Plans to the same key would lose Plans too.

**Goals:**

- Every Plan and Work Record has exactly one live copy, and every RunWield process, Session, worktree, and agent reads
  and writes it.
- Plan documents remain plain Markdown files a person can open, edit, and search with ordinary tools, with no RunWield
  metadata inside them.
- RunWield adds no Plans to a repository unless the project asks for them.
- Work Records, the project's shared delivery memory, are committed to the repository by default, and a project can turn
  that off.
- Plans, Work Records, and Sessions survive folder renames, moves, and remote changes.
- A Plan's important versions are kept and restorable.

**Non-goals:**

- Encrypting or hiding Plans or Work Records.
- Real-time multi-user editing. Workspace Plan sharing remains the team channel.
- Changing the managed `.gitignore` block, which stays as it is.

## Why Are We Building It?

- **Reliability.** Removing Plan copies removes the largest source of workflow and recovery bugs instead of patching
  them one at a time. Walk-away-and-resume becomes simpler because recovery reads one Plan, not a search across copies.
- **Epics work as designed.** Planner can reshape sibling drafts as part of planning, and every later child sees the
  change immediately, with no seeding or carry-over through execution.
- **RunWield is safe to use on any repository.** Open-source contributors can plan with RunWield without publishing
  their Plans or changing the project.
- **The repository stays readable where the owner wants it.** Owners of their own projects can still have the Plan that
  produced each delivered change sit beside the code, and teammates keep finding Work Records in the repository by
  default.
- **Plan bodies belong to the user.** RunWield owns Plan metadata and the user owns the body. Keeping them in separate
  files means RunWield never rewrites a file the user is editing, and repository copies carry no RunWield fields.

This matters now because the Plan Packages Epic is about to redefine Plan storage in its first child. Settling where
Plans live first avoids building packages on the copy model and migrating twice.

## Audience

- **Primary:** developers using RunWield on their own projects, who need Plans that never disagree with themselves and
  survive restarts, folder moves, and long Epics.
- **Primary:** developers contributing to repositories they do not own, who need RunWield to leave no trace there.
- **Secondary:** readers of a repository who benefit from delivered Plans beside the code, when the owner opts in.
- **Out of scope for this version:** teams that want live Plans to appear automatically for every collaborator through
  Git. They use Workspace sharing.

## Product Fit, Prototypes, and Descriptions

Today a user opens `docs/plans/my-feature.md` in the project. After this change they open
`.wld/plans/my-feature/context.md` in the same project, the same way, in the same editor. That path is a link to the
project's store, so the file they edit is the one RunWield uses everywhere.

Each Plan is a folder. `plan.wld.json` holds everything RunWield owns: identity, status, lifecycle and controller state,
Epic relationships, Session associations, and links. The Markdown documents beside it hold everything the user owns,
with no front matter.

```text
~/.wld/projects/<project>/
  plans/
    my-feature/
      plan.wld.json                       RunWield-owned metadata
      context.md                          the Plan body: the only copy RunWield reads
      validation.md                       validation instructions
      manual-qa.md                        manual QA steps, when the Plan has any
    my-epic/
      plan.wld.json
      context.md
    my-epic-first-child/                  a child is its own Plan; its parent is in plan.wld.json
  history/
    my-feature/
      2026-10-02T14-05-approved/          frozen copy of the Plan folder at each milestone
      2026-10-04T09-30-delivered/
  work-records/
    my-feature.md                         the live Work Record

<project folder>/
  .wld/plans  →  ~/.wld/projects/<project>/plans/   (never shown as a repository change)
  docs/plans/my-feature/context.md                 delivery copy, only when Plan copies are on
  docs/work-records/my-feature.md                  delivery copy, unless Work Record copies are off
```

Journeys:

- **Planning and running.** Planner writes the draft into the store. Review, execution, validation, and delivery read
  and update the same files. Worktrees contain code only.
- **Editing a Plan by hand.** The user edits `context.md` in any editor. RunWield's status and links stay in
  `plan.wld.json`, so the user never sees or breaks them, and RunWield never rewrites the file the user has open.
- **Epics.** While planning one child, Planner edits a sibling's draft in the store. The next child's Planner session
  sees the change at once.
- **Delivery copies.** As the last step of publication, RunWield adds one commit to the delivery branch with the
  delivered Plan documents in `docs/plans/` and the Work Record in `docs/work-records/`, each only when its setting is
  on. The implementation commits stay pure, so a maintainer can drop or revert the copies on their own. RunWield writes
  the copies and never reads them again. A reader browsing `main` sees the Plan that produced the code and what came of
  it.
- **Open-source contribution.** A contributor turns both settings off for a project they don't own. Branches and pull
  requests contain only the code. Plans and Work Records stay in the store and are pruned under the retention settings.
- **Bringing in a Plan.** A user who has a Markdown spec from anywhere — a teammate, an issue, an older `docs/plans/`
  file — points RunWield at it, and RunWield copies it into the store as a draft.
- **Upgrading.** After upgrading, an existing user sees no Plans until they run `wld plans import docs/plans/` once, and
  no Work Records until they run `wld wr import docs/work-records/` once. The release notes say so. RunWield then asks
  whether to keep delivered Plans in `docs/plans/` for this project.
- **Moving the project.** The user renames the project folder. RunWield still finds its Plans and Sessions.

## Capability Requirements

These are proposed changes. The owning Core capabilities are linked for each; implementation updates them in the same
change that delivers the behavior.

### Plan store

**Scope and maturity:** Target. Changes
[Plan authoring and external adoption](runwield-core-prd.md#plan-authoring-and-external-adoption) and every capability
that reads Plans from a checkout.

**Requirement: Every Plan has one live copy.** RunWield keeps each project's Plans in one store outside the repository.
Every Session, worktree, agent, and client reads and writes that copy. No checkout or branch holds a live Plan, so no
Plan can disagree with itself.

**Requirement: Plans stay plain Markdown.** Plan documents in the store are ordinary unencrypted Markdown files with
their existing structure. The user can open, edit, search, and copy them with ordinary tools. Edits made outside
RunWield are the Plan's content from then on, with the same body-ownership rules as today.

**Requirement: RunWield metadata lives beside the documents, not in them.** Each Plan is a folder holding
`plan.wld.json` and its Markdown documents: `context.md` (the Plan body), `validation.md`, and `manual-qa.md` when the
Plan has manual QA. `plan.wld.json` holds everything RunWield owns, including identity, status, lifecycle and controller
state, Epic relationships, Session associations, and links. The Markdown documents carry no front matter. RunWield
changes status and metadata without writing to any Markdown document, and a hand edit to a document can never change or
corrupt RunWield's metadata. The Plan Packages work builds on this folder rather than defining another layout.

**Requirement: Plans are reachable from the project.** The project folder contains a link, `.wld/plans`, to the store,
so editors and agents limited to the project folder can reach Plans. The link never appears as a repository change.

**Requirement: Recovery reads the one copy.** Restarting, crashing, or walking away and returning resumes from the
store's copy at every status, from draft through delivery, with no reconciliation between copies.

**Acceptance scenarios:**

- Given Planner editing a sibling draft while planning one Epic child, when the next child's planning starts, it sees
  the edit without any execution or publication step.
- Given a Plan edited in an editor through `.wld/plans`, when the user loads it, RunWield uses the edited content.
- Given a Plan whose `context.md` is open in an editor, when RunWield moves the Plan from review to execution, only
  `plan.wld.json` changes and the open document is untouched.
- Given a user who deletes or rewrites the top of `context.md`, when they load the Plan, its status, identity, and Epic
  relationships are unchanged.
- Given an external host whose file access is limited to the project folder, when it reads a Plan through `.wld/plans`,
  it reads the live Plan.
- Given a project with the link, when the user runs `git status`, the link does not appear.
- Given a crash during a review turn, execution, or publication, when the user loads the Plan again, RunWield resumes
  from the store's status without consulting any checkout's copy.

### Plan history

**Scope and maturity:** Target.

**Requirement: Milestone versions are kept.** When a Plan is approved, delivered, and closed or archived, RunWield keeps
a frozen copy of its folder, with readable Markdown documents, in the project's history. History works without Git, in
every project.

**Requirement: A kept version can be restored.** The user can restore a kept version as the live Plan, through RunWield
or by copying the file.

**Acceptance scenarios:**

- Given an approved Plan that Planner later rewrites, when the user looks at its history, the approved version is there
  unchanged.
- Given a machine without Git, when a Plan reaches a milestone, its version is kept.
- Given a crash between a Plan change and its next milestone, when RunWield restarts, the live Plan is intact and the
  next milestone keeps it.

### Project identity

**Scope and maturity:** Target. Changes [Session continuity](runwield-core-prd.md#session-continuity).

**Requirement: Plans and Sessions belong to the project, not its folder.** RunWield identifies a project by an identity
it creates once and keeps with the project's local repository configuration, or in a small file for a folder without a
repository. Renaming or moving the folder, or adding, changing, or removing a remote, keeps the same Plans and Sessions.
Worktrees of a project share its identity.

**Requirement: A fresh clone can join its project's Plans.** When a new clone matches a known project by repository
remote, RunWield asks once whether to use that project's Plans. Otherwise the clone starts a new project.

**Requirement: Identity leaves no repository footprint.** The identity is never committed. A folder that later becomes a
repository keeps its identity, and the identity file is removed from the working tree so it cannot be committed by
accident.

**Acceptance scenarios:**

- Given a project with Plans and Sessions, when the user renames its folder, RunWield shows the same Plans and Sessions.
- Given a local project with no remote, when the user adds a remote, RunWield keeps the same Plans.
- Given a folder without Git that later runs `git init`, when RunWield next opens it, it keeps the same Plans and the
  working tree has no identity file to commit.
- Given a second clone of a repository whose remote matches a known project, when RunWield first opens it, the user is
  asked once whether to link it; declining starts a separate project.

### Repository footprint and delivery copies

**Scope and maturity:** Target. Changes
[Keep Project Runtime State out of repository changes](runwield-core-prd.md#work-protection).

**Requirement: Plan and Work Record copies have separate project settings.** Each project has one setting for Plan
delivery copies, off by default, and one for Work Record delivery copies, on by default. Either can be changed without
affecting the other.

**Requirement: RunWield adds no Plans to a repository by default.** With the Plan setting off, RunWield writes no Plan
files, branches, or commits for Plans into the repository.

**Requirement: Work Records reach the repository by default.** With the Work Record setting on, the delivered Plan's
Work Record is copied to `docs/work-records/`, so teammates find the project's delivery memory in the repository. With
it off, Work Records stay in the store only.

**Requirement: Delivery copies arrive in one final commit.** As the last step of publication, before the delivery branch
is merged or its change request is opened, RunWield adds one commit containing the copies whose settings are on: the
delivered Plan's Markdown documents under `docs/plans/<plan>/` and its Work Record under `docs/work-records/`. The
commit contains nothing else, and `plan.wld.json` is never copied. With both settings off, no such commit exists.
Implementation commits never contain copies.

**Requirement: RunWield never reads delivery copies.** RunWield writes the copies at delivery and never reads, lists, or
compares their content afterwards. Editing them changes nothing in RunWield.

**Requirement: RunWield remembers where each copy went.** When RunWield commits a delivery copy, it records the copy's
repository path in the Plan's `plan.wld.json` or in the Work Record's metadata. Importing a file records the imported
file's path the same way, so a record or Plan brought in from `docs/` is tracked as if RunWield had written it. The path
is used only to tidy up when the item is pruned.

**Acceptance scenarios:**

- Given a project with default settings, when a Plan is delivered, the delivery branch ends with one commit that adds
  only `docs/work-records/<record>.md`.
- Given a project with both settings off, when a Plan is delivered, the delivery branch contains only implementation
  commits.
- Given a project with the Plan setting on, when a Plan is delivered, the final commit contains its Markdown documents
  under `docs/plans/<plan>/` as delivered, without `plan.wld.json`, and the live Plan is unchanged.
- Given a delivered project, when a maintainer reverts the final commit, the implementation is unaffected.
- Given a delivery copy edited by hand, when the user loads the Plan or Work Record, RunWield uses the store's copy.
- Given a publication retried after a crash, when it completes, there is exactly one copies commit, and it matches the
  Plan version the attempt started with, even if the Plan was edited in between.

### Work Record store

**Scope and maturity:** Target. Changes [Work records](runwield-core-prd.md#work-records), which today calls them
repository-owned.

**Requirement: Work Records live in the store.** RunWield writes, lists, searches, and retrieves Work Records from the
project's store, alongside its Plans. Their identity, links, completion labels, and retrieval rules are unchanged. The
repository copy is a delivery copy, as for Plans.

**Requirement: Work Record import is one explicit command.** `wld wr import <path>` copies a Work Record file or a
folder of them into the store and leaves the originals untouched. Imported records keep their identity, links, and
completion labels. Importing the same record twice does not create a duplicate. As with Plans, nothing is imported
automatically.

**Requirement: Work Records have their own retention, by count first.** Work Records use the same rule as archived
Plans, with their own settings: a record is pruned only when it is outside the newest `workRecords.retentionKeepLast`
(default 100) and older than `workRecords.retentionDays` (default 90). The count is a floor that age never overrides, so
a project that delivers once a month still keeps its newest records however old they are, and a busy project keeps every
record from the recent window however many there are. Setting the days to 0 prunes by count alone. A Work Record that
still covers an unpruned archived Plan is kept.

**Requirement: Pruning works like Plan pruning.** RunWield reminds the user when records are due and prunes them with
`wld wr prune`, which supports `--dry-run` and asks before deleting. It does not prune on its own.

**Requirement: Pruning tidies the repository copy too, on a best-effort basis.** Committed records are pruned like any
other. When a pruned Plan or Work Record has a tracked repository path, RunWield deletes that file from the project's
working tree and leaves the deletion for the user to commit. A missing file, a file already deleted, or a path that is
no longer in the repository is skipped silently and never stops pruning.

**Acceptance scenarios:**

- Given a delivered Plan in a project with Work Record copies off, when Planner later retrieves relevant records, it
  finds that Plan's Work Record in the store.
- Given an upgraded project with records in `docs/work-records/`, when the user runs `wld wr import docs/work-records/`,
  every record appears in the store with its identity and links, the originals are untouched, and each record tracks its
  original path.
- Given a project with 30 Work Records, the newest a year old, when pruning runs with default settings, nothing is
  pruned.
- Given a project with 400 Work Records from the last month and default settings, when pruning runs, nothing is pruned
  until records pass 90 days, and then only those outside the newest 100.
- Given a committed Work Record that is due, when the user runs `wld wr prune`, it leaves the store and its file in
  `docs/work-records/` is deleted from the working tree, uncommitted.
- Given a due record whose tracked file was already deleted or renamed by hand, when pruning runs, the record leaves the
  store and pruning completes without an error.
- Given an archived Plan still within its retention, when Work Record pruning runs, the Plan's Work Record is kept.

### Plan import

**Scope and maturity:** Target. Replaces
[External Markdown Plans are first-class](runwield-core-prd.md#plan-authoring-and-external-adoption). This is a one-time
breaking change for existing users.

**Requirement: RunWield lists Plans from the store only.** Nothing outside the store is found, listed, or imported
automatically. A file in `docs/plans/`, from this project or anyone else's, is an ordinary file until the user imports
it.

**Requirement: Import is one explicit command for a file or a folder.** `wld plans import <path>` copies Markdown into
the store and leaves the originals untouched. A file with RunWield front matter keeps its identity, status, and Epic
relationships: the front matter moves into the Plan's `plan.wld.json` and the rest becomes `context.md`. A file without
it becomes a draft with its prose unchanged. A delivery copy carries no metadata, so importing one creates a new draft.
Importing the same Plan twice does not create a duplicate. Loading a Markdown file by path is the same import for one
file.

**Requirement: Import offers delivery copies once.** After importing a folder of Plans from the project's repository,
RunWield asks once whether to keep delivered Plans in `docs/plans/` for this project, with yes preselected. The answer
sets the project's delivery copy setting.

**Requirement: Upgrading is announced, not automated.** The release that introduces the store tells existing users to
run `wld plans import docs/plans/` once per project. RunWield does not detect, offer, or perform the import on its own.

**Acceptance scenarios:**

- Given an upgraded project with Plans in `docs/plans/`, when the user opens RunWield without importing, no Plans are
  listed and the repository files are unchanged.
- Given that project, when the user runs `wld plans import docs/plans/`, every RunWield Plan appears in the store with
  its identity, status, and Epic relationships, the originals are untouched, and RunWield asks whether to keep delivered
  Plans in `docs/plans/`.
- Given a Markdown file without RunWield metadata, when the user imports it or loads it by path, it becomes a draft with
  its prose unchanged.
- Given a Plan already in the store, when the user imports the same file again, no duplicate appears.
- Given a fresh clone of someone else's repository with `docs/plans/` files, when the user opens it in RunWield, nothing
  is imported and nothing is offered.

## Success Metrics

- **Copy-related defects stop.** Baseline: the recurring class of Plan-copy defects described above. Target: no new
  defects of that class after release. Measured from bug reports and fixes over the following months.
- **No repository footprint by default.** Observable directly: a change request from a project without the setting
  contains no RunWield files.
- **Rename survival.** Observable directly: Plans and Sessions remain after a folder rename.

The capability scenarios above show the behavior is present; these measures show it helped.

## Delivery

The smallest useful release is the store with the metadata split, project identity, the project link, and explicit
import, released with a note telling existing users to run `wld plans import docs/plans/` once. Work Records may move
into the store only in the same release as Work Record delivery copies, so default projects never stop putting Work
Records in the repository. Plan delivery copies, Work Record retention, and milestone history can follow without
changing the store.

This work changes Plan storage and settles the Plan folder layout. Hand this PRD to Architect to plan an Epic against
the current implementation.

## Attached Research and Other Evidence

- The 2026-10-01 Epic branch and integration gate work (`epic-branches-and-integration-gate`) needed seeding child
  drafts onto Epic branches, read-only Plan resolution for archive and Work Records, parent-Epic lookup across
  checkouts, and carrying sibling edits through execution preparation. Each was a Plan-copy problem.
- The document-location and recovery machinery in Core (`plan-location`, controller document worktrees, execution Plan
  materialization, publication Plan paths) exists to choose between Plan copies.
- The owner's own use: across building RunWield with RunWield, the external-adoption-by-folder feature was never used.

## Risks and Mitigations

- **Plans are tied to one machine.** A second machine or a teammate's clone does not see live Plans automatically.
  Mitigation: Workspace Plan sharing; the user can also synchronize the store directory with tools of their choice.
- **Losing `~/.wld` loses Plans and Work Records.** Mitigation: milestone history, delivery copies, and Work Record
  copies on by default; state the store location plainly so users can back it up.
- **Pruning removes Work Records for good.** Pruning removes the store copy and tidies the repository copy, so a pruned
  record is gone except in Git history. Mitigation: Work Records have their own count-first retention with a generous
  floor, a record covering an unpruned archived Plan is kept, pruning never runs on its own, and repository deletions
  are left uncommitted for the user to review.
- **Tools that expect front matter in Plan files.** Agents, prompts, and external hosts that read or write Plan front
  matter break when it moves to `plan.wld.json`. Mitigation: RunWield's own agents change Plan status only through its
  tools, and the import moves existing front matter into `plan.wld.json`.
- **The project link can break on platforms without symbolic links or with restricted permissions.** Mitigation: a
  directory junction on Windows; report a broken link with a one-step repair instead of failing silently.
- **Agents may read a stale delivery copy in a worktree.** Mitigation: agents are always given the live Plan's path,
  Plan delivery copies are only written in projects that opt in, and Work Record retrieval reads only the store.
- **Users upgrade with work in progress.** Plans imported with their status keep their identity, so RunWield's runtime
  records for in-progress work still apply. Mitigation: the release note recommends finishing or pausing in-progress
  Plans before upgrading, and the import keeps every Plan's status as it was.
- **Users miss the release note and think their Plans are gone.** Mitigation: when the store is empty and the project
  has `docs/plans/`, the empty Plan list says how to import. It does not import.

## Proposed Domain Language

These terms are proposed. The implementing work updates `docs/domain-language.md` when they become true.

- **Plan Store:** the one RunWield-managed location holding a project's live Plans and Work Records, outside the
  repository. _Avoid:_ Plan database, plans folder. Replaces `docs/plans/` as the meaning of "where Plans live."
- **Plan Metadata:** the RunWield-owned facts about a Plan, kept in its `plan.wld.json` and never in its Markdown
  documents. _Avoid:_ front matter, which no longer describes where this lives.
- **Project Identity:** the identity RunWield creates once per project and keeps with its local repository configuration
  or folder, used to find its Plan Store and Sessions. _Avoid:_ project path, repo ID.
- **Plan History:** the frozen Markdown versions a Plan keeps at its milestones. _Avoid:_ Plan revisions, backups.
- **Delivery Copy:** a Plan's Markdown documents or a Work Record as delivered, written into the final publication
  commit when the project's setting for it is on, and never read by RunWield. _Avoid:_ mirror, synced Plan, snapshot
  Plan.
- **Affected existing terms:** External Markdown Plans become explicitly imported; Plan front matter becomes Plan
  Metadata; Work Records are no longer repository-owned; Epic Branch no longer carries child drafts; Epic Artifacts move
  with their Epic into the store.
