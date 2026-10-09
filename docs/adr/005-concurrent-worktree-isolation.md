---
status: accepted
---

# ADR-005: Concurrent Execution Isolation via Git Worktrees

## Context

Executing Plans in the user's primary checkout lets concurrent sessions overwrite one another's edits. Keeping a second
copy of execution bookkeeping in Plan Front Matter also makes continuation depend on which copy was written last. A
restart, stale checkout, or ordinary Plan edit must not lose the connection to an existing execution.

ADR-004 defines Plan lifecycle events. [ADR-016](016-proof-bearing-publication-state-machine.md) defines publication and
its durable receipts. This decision defines the execution boundary and where each kind of state belongs.

## Decision

### One worktree per Planned Change execution attempt

Each saved Planned Change executes in its own linked Git worktree and `worktree/` branch. A PROJECT organizes child
Planned Changes; it does not force independent children to share an execution checkout. Agents working on one attempt
share its execution directory.

The Plan's `targetBranch` names an actual branch. Execution resolves that branch before creating the worktree; neither
the primary checkout's current branch nor a hard-coded `main` overrides an explicit target. Managed worktree directories
live under RunWield's home-directory worktree area, grouped by project, with a unique attempt identifier.

### Separate document and controller ownership

| Data                                                                                                                                       | Authority                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Plan definition, identity, human lifecycle status, `targetBranch`, `validatedCommit`, relationships, archive and user-verification history | Plan Markdown                                       |
| Validation checkpoints and counters, review decisions, execution mode, runtime timestamps and delivery evidence                            | `<primary-project>/.wld/internal/controller/plans/` |
| Attempt ID, branch, path, base ref/commit/tree, execution status and publication receipts                                                  | `<primary-project>/.wld/internal/worktrees.json`    |
| Commit contents, ancestry, checked-out branches and remote target                                                                          | Git                                                 |

The summary shown in lists is derived from the Plan's Context section. It is not a second stored definition in YAML.
Runtime fields may appear in an in-memory joined Plan view for consumers, but saving Markdown does not serialize them.
The joined view does not make Front Matter another owner of registry state.

Before execution, the project Plan is the editable document. For a targeted Epic child, RunWield can first create a
planning worktree from the current target branch. That worktree owns the selected child document during planning, but it
is not active execution and does not make the Plan `in_progress`. Once execution starts, the same worktree is promoted
and its Plan is authoritative. The primary copy may remain stale, missing, malformed, or dirty from unrelated user work.
RunWield does not mirror status or execution metadata into that copy and does not require it to agree with the selected
document.

Document operations lock and update the selected document. Registry operations resolve the primary project's shared
runtime directory even when called from a linked worktree. Callers must distinguish the document directory, execution
directory, and shared registry directory; one `cwd` cannot stand for all three.

Workspace body edits use the same document lock as lifecycle changes. Composite child completion locks and reads each
sibling with a registered attempt in its own directory; it does not substitute the completing child's copy. Archive and
restore also select the authoritative document, preserve the primary copy, and keep archived execution documents out of
active discovery.

A registered document that is missing or archived never selects the older primary copy as a fallback. Execution start
also resolves the live attempt from the registry; Session memory cannot reactivate a retired attempt. Child completion
discovers the family from the primary project catalog plus registered execution documents, including children that have
not started and therefore have no worktree yet. Completed siblings whose worktrees were cleaned up may come from the
completing attempt's recorded target commit, backed by exact committed document bytes rather than a permanent controller
receipt. An arbitrary status in a copied document cannot override an unstarted sibling in primary.

Restoring with a different name updates the document's registry address while preserving its Plan ID, attempt ID,
branch, and directory. Ordinary registry updates still cannot change these addresses. A saved publication binds its
original Plan path, so renaming during publication is refused with guidance to restore without renaming and finish
publication first. Stale primary copies with the same Plan ID remain hidden after a rename.

### Lifecycle

1. **Plan child work:** when a targeted Epic child is opened for planning, resolve the latest target branch, create or
   reuse one planning worktree, and bind Planner tools to that directory. This records document ownership only.
2. **Prepare execution:** after approval, promote that planning worktree or create a new execution worktree for ordinary
   Plans. Materialize the Plan and record the execution baseline before implementation starts.
3. **Execute:** agents, editing tools, checks, diffs, and repair sessions use the explicit execution directory. RunWield
   does not change the process working directory to route an operation.
4. **Checkpoint:** commit implementation changes, excluding RunWield runtime files. Record `implemented` in the
   execution Plan and `completed` for the attempt. A failed checkpoint leaves the attempt recoverable.
5. **Validate:** run CI and review against that execution. Store retry/repair progress in the controller, not Markdown.
   Successful validation leaves the execution Plan at `reviewed`; publication is a separate operation.
6. **Publish:** follow ADR-016. Commit the final Plan and Work Record, assemble the target integration in a separate
   publication checkout, finalize its owned metadata as `verified`, push with a lease, verify the target, then clean up.
   Only confirmed target publication establishes verified delivery; the sealed execution candidate remains `reviewed`.
   The Plan does not gain a `published` status or get rewritten after publication.

Remote publication never stages, stashes, resets, rebases, merges, or writes the user's primary checkout. The user
updates that checkout separately after publication. For a repository without a remote, the explicit local-only exception
in ADR-016 prepares the integration separately and advances the checked-out target only when its tracked files are
clean; non-overlapping untracked files remain untouched.

### Continuation and review

Loading a Plan locates its document through the controller's attempt, then reads workflow state from the controller.
Hold, resume, review, validation, and approval use that same document selection. A healthy execution Plan must remain
usable even if the primary copy cannot be parsed.

Full code review uses one shared proposed branch patch from the common ancestor of the attempt's recorded target and
execution HEAD to the execution worktree's current files. Semantic review, repair context, and human review use that
same patch source. This matches a pull request or merge request while still including uncommitted work. Target-only
changes do not appear as proposed reversals. The target and execution commits are resolved once per computation, so a
reload can reflect newer commits. Missing target, missing HEAD, or absent ancestry fails closed without substituting
`main`, an alternate diff, or an old snapshot. The execution baseline remains separate and immutable for recovery;
pre-repair snapshots remain separate for repair checks.

Reopening for review preserves the execution attempt, its branch, commits, and uncommitted changes. It invalidates prior
approval and validation evidence, not the implementation. Approve & Run discovers the existing live attempt by Plan
identity in the registry and continues from the approved revision in that same directory, including after restart.
Automatically abandoning it was rejected because review feedback revises existing work; it is not permission to start
over. Only explicit user reset or abandonment retires an unfinished attempt. Published attempts are not reused.

The controller keeps a document-location reference to the registry entry separately from active execution. That
reference survives hold/resume and moves to the new attempt when execution starts. After that attempt is published and
removed, an older retired directory cannot become the document authority again.

Before mutating an attempt, RunWield still checks actual identity, Git location and concurrent writes. These checks
protect different Plans and competing operations; they must not compare duplicated bookkeeping in Plan Front Matter.

### Durability and recovery

Controller and worktree registry files are ignored runtime state, shared by every linked worktree of a project. Writes
use locks and atomic replacement; controller updates and publication receipts reject stale revisions. Lifecycle
transactions record and roll back their own changes without overwriting another operation's newer controller state.
Collaboration body/revision/hash updates use that same recoverable transaction boundary: a failed document write must
not leave the controller claiming the new body was saved.

Legacy runtime YAML can seed the controller once. When a live attempt exists, only its execution document may supply
that import. An unreadable registry or multiple live attempts are not evidence that there is no attempt: document reads
must not persist guessed state from a stale primary copy. Retired attempts likewise cannot seed a new active identity.
Imported recovery hints are removed once the registry owns the recovered attempt.

Execution and validation failures keep the isolated files and branch available. Publication resumes from the last proven
phase without rerunning validation or regenerating committed artifacts. Cleanup removes the attempt record only after
Git proves publication and the checkout/branch cleanup has completed. Explicit discard/recreate actions require the
user's confirmation; normal continuation never resets unrelated primary-checkout files.

Explicit discard clears both the execution reference and the document-location reference. Before offering another
action, the Session reloads the surviving document in full; it must not keep the deleted document's status or revision.
After confirmed publication, the execution document no longer owns Plan reads. Load-plan reads the surviving project
Plan and opens its action menu, without removing branches, moving files, or recreating a deleted execution worktree.
Cleanup runs during publication or when the user explicitly selects removal of the published worktree and branch. That
action uses the publication receipt and fresh Git proof, not the primary Plan's potentially older status, to authorize
cleanup. A failed cleanup leaves the menu available and keeps the remaining files. Loading is navigation, not permission
to move or remove files; automatic cleanup on load was rejected because it surprises the user and can prevent the
requested menu from opening.

## Consequences

- Independent Plans can execute concurrently without writing through the primary checkout.
- Ordinary Plan editing cannot erase controller checkpoints or change an attempt's identity.
- Restarts use durable records and Git evidence, not remembered Session metadata.
- Worktree directories and retired branches consume disk until published cleanup or explicit discard.
- Truly unreadable or ambiguous controller records can still require recovery; RunWield must preserve the files and
  describe the specific problem instead of guessing which attempt to mutate.

## Verification

Real-Git tests cover execution authority with stale/missing/malformed primary Plans, hold and re-open through load-plan,
review from either checkout, fresh execution after a retired attempt, and refusal to import legacy state from an
uncertain registry. They assert document preservation and branch/attempt identity, not only displayed messages. The
composed TUI journey and multi-process publication restart matrix required by ADR-016 remain complementary checks.
