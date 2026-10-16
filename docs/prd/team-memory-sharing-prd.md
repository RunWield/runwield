# Product Requirements Document: Team Memories

**Status: Deferred pending customer feedback.** The owner has not decided whether team Memory sharing belongs in
Core, the paid Workspace, or neither. This document preserves a proposal, not a delivery commitment. Revisit product
placement and demand when customer feedback provides evidence; the approach below remains conditional.

## Objective

Allow RunWield teams to share useful Mnemoteca project Memories through normal Git collaboration without committing
Mnemoteca's SQLite database, embeddings, or other derived index state.

RunWield should classify likely team-useful Memories without interrupting the user, materialize them as reviewable text
at safe checkpoints, and reconcile accepted Team Memories into each contributor's local Mnemoteca database. Sharing
should feel automatic while preserving repository review, privacy boundaries, and protection against untrusted memory
injection.

## Problem Statement

Mnemoteca currently gives RunWield durable project and global Memory across Agent Sessions, but its working database is
local to one user. Consequently, a useful project fact learned by one contributor is unavailable to teammates unless it
is repeated elsewhere or communicated manually.

Sharing opaque local storage would make changes hard to review, expose unrelated private information, and create
conflicts between contributors. Teams need readable changes that fit their existing repository review process.

Requiring users to approve or promote every Memory individually would avoid some disclosure risk but create enough
friction that sharing would likely be skipped. RunWield needs an agent-classified, Git-reviewed lifecycle that shares
Mnemoteca Memories without conflating them with CONTEXT, ADRs, PRDs, Plans, Work Records, or other durable artifact
types.

## Resolved Assumptions

### Memory Audience and Importance Are Independent

Project Memories have two independent dimensions:

| Audience | Importance | Meaning                                                                    |
| -------- | ---------- | -------------------------------------------------------------------------- |
| Local    | Ordinary   | Searchable only in the owner's local Mnemoteca context                     |
| Local    | Core       | Local to the owner and injected into every Agent Session                   |
| Team     | Ordinary   | Shared with repository collaborators and retrieved when relevant           |
| Team     | Core       | Shared with repository collaborators and injected into every Agent Session |

- **Local Memory** and **Team Memory** describe audience.
- **Core Memory** describes always-on injection, not sharing.
- Core never implies Team, and Team never implies Core.
- Agents must continue using Core sparingly.
- Global Memories remain local cross-project preferences and do not participate in repository sharing.

### Agent-Classified Sharing

- Agents classify each new project Memory without asking the user whether to share it.
- A stable, repository-safe Memory likely to help another contributor becomes a **Team Memory Candidate**.
- Personal preferences, machine-specific details, transient progress, unresolved speculation, sensitive information, and
  uncertain cases remain Local.
- When classification is uncertain, Local is the safe default.
- Classification guidance applies to every Agent allowed to create project Memories.
- A user may still explicitly request that a Memory remain Local or become a Team Memory Candidate.

### Team Memories Remain a Distinct Mnemoteca Concept

- Team Memories are the shareable form of the concise facts, decisions, and preferences already represented as Mnemoteca
  Memories.
- Promotion does not convert a Memory into CONTEXT, an ADR, PRD, Plan, Work Record, Session Transcript, or another
  artifact type.
- Existing artifact synchronization and indexing retain their current roles.
- RunWield must not use Team Memory promotion as a reason to duplicate or rewrite unrelated durable artifacts.

### Reviewable Repository Text

- Shared Memories appear as human-readable repository text with meaningful diffs and ordinary review.
- Sharing excludes local databases, embeddings, indexes, and machine-specific metadata.
- Contributors can add unrelated Memories in parallel, then edit, replace, or remove accepted Memories without managing
  local database identifiers.
- Reviewed repository text is enough to restore the team's knowledge on a new machine.

### Promotion Uses Git Review Instead of Per-Memory Approval

- A Team Memory Candidate begins as Local Mnemoteca state and remains usable by its author.
- At safe Session or workflow checkpoints, and during Sleep maintenance, RunWield materializes pending candidates as
  canonical-text changes in the working tree.
- Materialization does not automatically stage, commit, push, or merge changes.
- The normal Git diff and pull-request process is the human approval surface.
- RunWield should present candidate changes as one concise batch rather than interrupting for each Memory.
- Reviewers may edit, accept, or remove proposed Team Memories like other repository text.
- A candidate removed or rejected during review must not be proposed repeatedly unless it is materially revised or the
  user explicitly reopens it for sharing; it otherwise returns to Local status.

### Trusted Activation

- Presence in a checked-out branch does not make a Team Memory trusted or active.
- Each project has a configured **Trusted Branch**, normally its reviewed default integration branch.
- Only the accepted committed Team Memory state reachable through the Trusted Branch may be reconciled automatically
  into collaborators' active Mnemoteca indexes.
- Team Memory additions or modifications in an untrusted feature branch or pull request remain visible for review but
  cannot alter active shared retrieval or Core Memory injection merely because the branch was checked out.
- A locally authored candidate may remain active for its author as Local state while awaiting review.
- Trusting Team Memories follows repository authority: anyone able to merge into the Trusted Branch can approve shared
  Agent context.

### Consistent Team Knowledge

- Contributors receive accepted additions, updates, and removals from the Trusted Branch without duplicate Memories.
- Removed or replaced Team Memories stop influencing retrieval and Core context.
- Updating Team knowledge must preserve independent Local Memories, even when their wording is similar.
- A failed update must not activate untrusted or inconsistent content. Explain the problem while preserving access to
  previously trusted knowledge where possible.

## Product Experience

### Creating a Memory

When an Agent stores a project Memory, it evaluates both dimensions independently:

1. Is the Memory important enough to be Core?
2. Is it stable, safe, and useful enough to become a Team Memory Candidate?

The Agent stores the Memory without prompting unless the content itself requires clarification. The normal interaction
should not become a sequence of sharing questions.

### Reviewing Candidates

At the next safe checkpoint, RunWield reports that Team Memory candidates were materialized and points to the resulting
working-tree diff. The user can continue working, edit the text, include it in a normal commit, or discard it. RunWield
does not claim that a candidate is shared merely because text was generated locally.

### Receiving Team Memories

After reviewed Team Memory changes enter the Trusted Branch, each collaborator's RunWield environment reconciles them
into local Mnemoteca state. Ordinary Team Memories become semantically searchable; Team Core Memories become eligible
for normal Core injection. Contributors do not import exports or copy database files manually.

### Branch Review

Checking out an external or unmerged branch may display proposed Team Memory changes, but those changes do not persist
into active shared Memory. Returning to another branch must not leave behind untrusted derived records.

## Privacy and Review Requirements

- Exclude credentials, personal data, sensitive machine details, and content that cannot confidently be shared with the
  repository's audience.
- Agent classification does not replace repository review. Unreviewed Team Core Memories must not influence teammates'
  Agents merely because someone checks out a branch.
- Team Memories have the same audience as the repository; per-Memory access control is outside this proposal.
- Reports identify proposed or accepted Team changes without unnecessarily exposing Local Memory content.

## Delivery

The smallest useful release lets two contributors propose, review, receive, update, and remove shared Memories through
normal Git collaboration. Implementation planning determines storage, export timing, identity, and synchronization.

## Success Criteria

- Two contributors using the same Trusted Branch can retrieve the same accepted Team Memory without sharing a database.
- Creating a Team Memory Candidate does not prompt for individual approval.
- Candidate promotion produces a meaningful text diff and never a binary database diff.
- Parallel contributors can add unrelated Team Memories without resolving a whole-database conflict.
- Repeated reconciliation creates no duplicate derived Memories.
- Editing or deleting a canonical Team Memory converges local derived indexes to the accepted state.
- A Local Core Memory remains private and a Team ordinary Memory remains non-Core.
- Checking out an untrusted branch cannot persistently change shared retrieval or Core injection.
- A fresh local Mnemoteca database can rebuild Team Memory state entirely from trusted repository text.
- RunWield never automatically commits, pushes, or merges Team Memory changes.

## Risks and Mitigations

### Agent Misclassification

An Agent may mark sensitive content as Team or keep useful knowledge Local. Conservative instructions, repository-safe
content checks, batched diffs, and normal review reduce disclosure risk. Sleep may reassess existing Local Memories, but
uncertainty must continue to resolve to Local.

### Review Fatigue

Too many low-value candidates could cause reviewers to ignore Team Memory diffs. Agents should store crystallized
Memories rather than transcripts or temporary state, and checkpoint materialization should consolidate exact duplicates
without combining distinct decisions or losing rationale.

### Persistent Prompt Injection

A malicious pull request could propose misleading Team Core Memories. Trusted Branch activation ensures that merely
checking out or reviewing the branch does not activate them; repository merge authority remains the approval boundary.

### Local and Team Divergence

A Local Memory may overlap with a later Team Memory, or a canonical Team Memory may be revised while an older local copy
exists. Updates must replace the shared version without deleting independent Local knowledge solely because its text is
similar.

## Out of Scope

- Committing or merging Mnemoteca SQLite databases, embeddings, FTS data, vector indexes, WAL files, or local IDs.
- Real-time peer-to-peer or hosted Memory synchronization.
- Sharing Global Memories, personal preferences, Session Transcripts, or arbitrary Agent conversation history.
- Replacing or redefining CONTEXT, ADRs, PRDs, Plans, Work Records, or their existing synchronization behavior.
- Automatically converting other durable artifacts into Team Memories.
- Automatically staging, committing, pushing, merging, or approving Team Memory changes.
- Activating Team Memories from untrusted branches merely to provide branch-specific context.
- Per-Memory team ACLs, encryption for subsets of repository collaborators, or sharing with users who cannot access the
  repository.
- Selecting the final canonical text path, file granularity, or serialization syntax in this PRD.

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
