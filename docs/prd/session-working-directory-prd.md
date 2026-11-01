# Session Working Directory and Checkout Context

## Background

Users need to move a RunWield Session between packages in a monorepo and between existing worktrees of the same Project.
A shell `cd` changes one command's location; it does not move the Session. This proposal adds one Agent-facing tool to
inspect the current checkout or move the Session, plus harness-supplied checkout context in the system prompt.

**Status: Proposed.** The requirements below are agreed target behavior, not claims of delivery. Core's
[Session continuity](runwield-core-prd.md#session-continuity) and
[Project context and initialization](runwield-core-prd.md#project-context-and-initialization) are the intended lasting
owners. This proposal does not replace the separate [Plan Store proposal](plan-store-prd.md#plan-store).

## Problem Description

**The Agent can work in the wrong checkout without knowing its role.** Current harness Git context reports the branch
and clean/dirty state. It does not explain whether the Session is in a linked worktree or identify its Plan or Epic.

**Command-local navigation does not move the conversation's working location.** Users need subsequent file operations,
commands, and applicable instructions to follow the selected package or checkout without starting another Session.

**Plans can be stranded on a branch.** The owner described adding an Epic child while in another worktree. Moving to
the Epic worktree can improve the code context, but it does not guarantee discovery of an uncommitted child Plan today.
The Plan Store proposal addresses Plan storage and discovery; this proposal addresses the Session's working location.

Goals:

- Let Agents inspect and deliberately change the Session's working location within one Project.
- Make worktree identity and known Plan/Epic ownership visible before the Agent acts.
- Preserve the conversation and resume location after a successful move.
- Prevent manual Session moves from disrupting execution, review, repair, or publication.

Non-goals:

- Moving a Session to another Project.
- Creating, deleting, merging, or publishing worktrees through this tool.
- Moving files, carrying uncommitted edits between checkouts, or changing branches in place.
- Changing Plan storage or claiming that a Session move makes a new Plan discoverable.
- Taking control of an External Agent Host's working directory through RunWield Connect.

## Why Are We Building It?

**Users can keep one conversation while changing where they work.** A monorepo user can move from the repository root
to a package. A Planner can inspect the Epic's code rather than an unrelated child's checkout.

**The harness supplies facts that Agents should not guess.** Clear ownership context reduces planning against the
wrong code. Mechanical restrictions keep an Agent's directory choice from redirecting an active delivery workflow.

## Audience

Developers using RunWield Sessions in monorepos or repositories with multiple worktrees. Planner is a key beneficiary,
but inspection and movement are not limited to that Agent.

## Product Fit and Journey

1. A user opens or resumes a Session in a package or worktree.
2. The system prompt identifies the working location and known checkout ownership.
3. The Agent uses the tool to inspect more detail or select an existing destination within the same Project.
4. When movement is allowed, the Session moves. Later tools and applicable instructions use the destination.
5. When a protected workflow phase is active, inspection still works, but movement is refused without changing location.

Illustrative prompt text, not a required format:

> Current folder: `<path>`. This is a linked worktree for child Plan `<child>` of Epic `<epic>`.
> Epic planning worktree: `<epic-path>`.

The prompt supplies essential context without requiring a tool call. The tool gives current information and performs
explicit moves. It does not automatically move the Session merely because an Epic relationship exists.

## Capability Requirements

### Checkout inspection and prompt context

**Scope and maturity:** Target addition to Core Project context.

**Requirement: The harness identifies the current checkout.** At Session start, resume, and after a working-location
change, the system prompt reports the current folder, checkout root, branch, and whether the checkout is primary or a
linked worktree. Existing clean/dirty information remains available. Non-Git locations are not described as worktrees.

**Requirement: Ownership comes from known RunWield state.** For a managed worktree, context identifies its associated
Plan or Epic when known. For an Epic child, it identifies the parent Epic and its planning worktree location when
available. Unknown ownership and an unavailable Epic worktree are stated clearly, not inferred from branch names or
filled with a guessed path.

**Requirement: One tool supports inspection and movement.** Its inspection operation reports the current location,
checkout identity, known ownership, and whether a Session move is currently allowed. Inspection remains available during
execution, Plan review, AI review, code review, repair, and publication.

**Acceptance scenarios:**

- Given a user starting a Session in a linked worktree, when the first Agent turn begins, the prompt identifies the
  linked worktree rather than only reporting that Git is clean or dirty.
- Given a user planning in an Epic child's managed worktree, when the Agent inspects the checkout, it receives the
  child's identity, parent Epic, and available Epic planning worktree location.
- Given a user in an unmanaged worktree or an Epic whose planning worktree is unavailable, when context is supplied,
  the Agent receives the known facts and an explicit unknown or unavailable result, not a fabricated owner or path.
- Given a user whose Plan is being repaired, when the Agent requests checkout information, inspection succeeds and
  reports that movement is unavailable during repair.

### Same-Project Session movement

**Scope and maturity:** Target addition to Core Session continuity.

**Requirement: Movement changes the Session, not one command.** The Agent can select an existing folder in the current
Project, including a monorepo package or another worktree of that Project. After success, relative file tools, shell
commands, and other cwd-dependent Agent capabilities use the selected location. Applicable instructions and project
configuration are refreshed for that location.

**Requirement: The conversation and Project stay the same.** A move preserves the Session identity, history, and Project
association. It does not create another Project or move project memory and Plans to another owner. Resuming the Session
restores the selected location, subject to existing workflow-owned continuation behavior.

**Requirement: The result is clear and consistent.** A successful move reports the resulting location and checkout
context. An invalid, inaccessible, or cross-Project destination is refused with a clear reason. A failed move leaves the
previous working location and its tools and instructions usable; it must not report success with mixed locations.

**Acceptance scenarios:**

- Given a user exploring a monorepo from its root, when the Agent moves the Session to a package, subsequent relative
  reads and commands use that package and the Agent receives its applicable instructions without losing conversation
  history.
- Given a user planning additional Epic work from an unrelated child checkout, when the Agent moves to the existing
  Epic worktree, subsequent code exploration uses that checkout and the prompt reflects the new location. This outcome
  does not claim that checkout-local Plan writes become visible to every other checkout.
- Given a user who closes a Session after a successful move, when that Session resumes with no workflow-owned checkout
  transition required, it uses the selected location and matching instructions.
- Given a user whose Agent requests a missing folder or another Project, when the tool handles the request, it refuses
  the move and subsequent tools still use the previous location.

### Workflow-bound movement restrictions

**Scope and maturity:** Target constraint on Agent-requested Session moves. Existing workflow-owned checkout
transitions remain supported.

**Requirement: Protected phases block all Session moves.** The harness refuses movement while the Session is executing,
reviewing, repairing, or publishing work. Review includes Plan review, AI review, and code review, including an active
review waiting for a decision. The restriction applies to package-folder moves as well as moves between checkouts.
It depends on workflow state, not only on the selected Agent's name or whether a model turn is running.

**Requirement: Inspection and command-local navigation remain available.** A refusal explains the active phase and
preserves the Session location. Commands can still target subdirectories without moving the Session. The tool does not
silently pause, abandon, or bypass a workflow to permit a move.

**Requirement: A move does not redirect delivery ownership.** The tool cannot change a Plan's execution, validation,
repair, or publication checkout. RunWield's existing workflow-owned transitions continue to select those locations.
Once no protected phase is active, ordinary same-Project movement is available again.

**Acceptance scenarios:**

- Given a user with active execution, Plan review, AI review, code review, repair, or publication, when the Agent requests
  a Session move, the harness refuses it, names the phase, and preserves the Session and workflow locations.
- Given a user waiting for a Plan review decision with no model turn running, when a move is requested, it remains
  blocked because the review is still active.
- Given a user whose Agent needs a command in a package during execution, when it runs that command in the package,
  the command can use that directory without changing the Session cwd.
- Given a user whose protected workflow phase has ended and no other protected phase is active, when the Agent requests
  a valid same-Project move, it succeeds without restarting the Session.

**Shared requirements:** Preserve Core's
[execution, validation, and recovery](runwield-core-prd.md#execution-validation-and-recovery) and
[Session continuity](runwield-core-prd.md#session-continuity) requirements.

## Success Measures

The primary evidence is completion of the acceptance journeys above: package and worktree moves keep tools and context
aligned; resume preserves the location; protected phases cannot be bypassed. Owner trials should check whether Agents
stop using manual path workarounds to compensate for a stale Session cwd.

No usage baseline, numeric adoption target, or observation period has been agreed. This proposal does not require a new
analytics system. Fewer stranded Plans is a Plan Store outcome, not a success claim for this tool alone.

## Delivery

The smallest useful release includes both operations of the tool, automatic prompt context, same-Project checks,
consistent resume behavior, and all protected-phase restrictions. These are Core Session capabilities, not a TUI-only
shortcut.

The Plan Store can proceed separately. This feature must work with current storage and must not claim to fix branch-local
Plan discovery. Cross-Project moves and External Agent Host cwd control remain outside scope.

Hand this PRD to Planner to define executable work. The implementing change must update the owning Core capabilities
and affected references. After delivery, consolidate lasting requirements into Core and remove this transient proposal
under the repository's PRD policy. No implementing Plan exists yet.

## Evidence and Limits

- Owner discussion: clarified Session movement rather than shell `cd`; requested harness-detected worktree and Epic
  context; approved same-Project scope and the four protected phases, including Plan and code review.
- [Current Git prompt context](../../src/shared/git.ts): `readGitPromptState` and `formatGitPromptState` report branch and
  clean/dirty state, not Plan/Epic ownership.
- [Existing Agent switching](../../src/shared/session/agent-switching.js): `switchActiveAgent` can rebuild for another
  cwd and rebind the Session. This is internal support, not proof of a complete Agent-facing movement capability.
- [Epic child discovery](../../src/shared/workflow/planning-worktree.ts): `readTargetBranchPlansByParent` can read the
  committed target branch instead of uncommitted files in a separate Epic worktree. The reported incident was not
  reproduced; the code supports the failure path.
- [Plan Store proposal](plan-store-prd.md#plan-store): proposes one live Plan copy shared by all Sessions and worktrees.
  It does not select the code checkout that Planner should inspect.

## Risks and Mitigations

- **Partial moves leave tools in different locations.** Require one consistent reported result and preserve the prior
  working context on failure.
- **Stale ownership sends Planner to the wrong code.** Use current harness evidence and show unknown or unavailable
  relationships rather than guessing.
- **A move bypasses workflow restrictions.** Enforce restrictions in the harness, including waiting review phases;
  do not rely on prompt compliance.
- **Users expect this to solve lost Plans.** Keep the Plan Store dependency explicit and do not equate correct code
  context with shared Plan visibility.

## Proposed Domain Language

No new domain term is required. Extend the documented behavior of **Session**: its working directory can change within
its existing **Project** without changing Session identity. A selected worktree's **Plan** or **Epic** association is
context, not a transfer of workflow ownership. Avoid calling a Session move a Project switch or a shell `cd`.
The implementing work must update the applicable glossary only when this behavior is delivered.

## Open Questions

No unresolved product-scope decisions. Tool naming, transition mechanics, and verification details belong to planning.
