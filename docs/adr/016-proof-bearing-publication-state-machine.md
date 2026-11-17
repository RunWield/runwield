---
status: accepted
---

# ADR-016: Publication Is a Proof-Bearing State Machine

## Local home-store activation

Ordinary local and manual-SSH Plan and Work Record access now uses the executing account's personal Project store
under [ADR-0020](0020-home-project-state-and-launch-mode-ownership.md). Project catalog authority is separate from
revision-checked workflow selection. Explicit import preserves original execution ownership until publication is proven
or the user deliberately abandons the attempt; it never starts a replacement attempt or weakens publication evidence.
Session bundle authority and managed-remote personal ownership retain their existing contracts.

## Decision

Plan validation and Git publication are different facts.

The [Core completion contract](../prd/runwield-core-prd.md#execution-validation-and-recovery) requires confirmed
publication or deliberate user abandonment as the only delivery conclusions. A failed publication phase remains
recoverable work. RunWield reconciles proof and repairs internal storage, locks, settings, and synchronization
automatically; exposing an error and a repair command is not completion. Evidence requirements still forbid fabricated
success, blind replay, or loss of user work.

- Public Plan status separates finished implementation (`implemented`), passed review (`reviewed`), and confirmed
  delivery (`verified`). CI success stays in controller `validationPhase`; it does not add a public status.
- For legacy repository Plans, the sealed execution Plan remains `reviewed`. After merging its candidate into the publication target, RunWield
  finalizes the owned Plan as `verified` and any prepared Work Record as approved in a target metadata commit. Remote
  publication assembles that commit privately, then pushes and proves it before reporting delivery.
- The matching `.wld/internal/worktrees.json` entry owns intermediate publication progress in one `publication` record.
- Git commits and refs supply proof. A status string, error, Session memory, or transition journal cannot substitute for
  delivery evidence. Candidate `validatedCommit` and the final published commit are distinct identities.
- Confirmed delivery retains a permanent controller `publicationReceipt` identifying the candidate, published commit,
  and target branch, plus `verifiedAt`. It survives attempt cleanup and preserves effective completion when a remote
  publication leaves the user's primary checkout behind. The receipt records established proof; it does not authorize
  overwriting later user changes or replaying publication.
- Registry cleanup waits for confirmed publication and recoverable bookkeeping. Work Record indexing has durable retry
  state and does not revoke successful code delivery. The attempt can be removed after cleanup settles; absence of an
  attempt alone never proves delivery. There is no separate Plan `published` status. Non-Git completion verifies in
  place after checks and review.

Explicitly admitted home packages use the same phase machine with a typed retained-input variant. Their immutable
manifest names owner, repository, Plan, attempt and reviewed candidate, and retains exact documents, metadata,
family/Tickets, copy policy and destinations. Persistence and validation precede any reference. Empty payloads need no
artifacts commit; Plan Markdown and prepared Work Record payloads compose into one artifacts-only commit. A subsequent
delivery may replace a prior copy only when retained delivery evidence proves the same repository/Plan/path, published
ancestry and unchanged prior bytes. An unchanged proven payload reuses the validated code boundary without an empty
commit. Externally edited copies refuse replacement until their exact prior bytes are restored. Package
publication skips the legacy target lifecycle-metadata commit. Fresh Git proof checks the candidate ancestry and exact
copy bytes, then an atomic package write settles receipt/status and releases the attempt guard before registry pruning.
The manifest remains Recorder authority after code cleanup, including after live edits or rename. Missing or foreign
inputs are recoverable refusals, never permission to substitute repository documents. This bounded contract does not
activate public package selection/copy settings, remote transport or pruning.

For admitted packages, Recorder preparation is a separately retained input to that same publisher. Source and copy
policy are frozen before the turn; accepted sections and record identity become durable before the final manifest.
This separation lets ordinary and Attached recording resume without another turn or newer live Plan input. Canonical
records, native mutation locks, location provenance and the derived index share explicit personal Project ownership;
Project-level import does not need a dummy Plan. Basename namespaces and repository fallback would create a second
authority, so neither participates in admitted retrieval.

Default Work Record copies carry pending preparation confidence. Matching fresh publication proof settles the canonical
record and its relationships, preserving body bytes and later edits, without another repository commit. Imports retain
that confidence and do not stand in for proof. Recorder failure leaves the retained source for a post-delivery retry;
a successful late retry creates canonical memory only. Version-1 manifests without recording policy retain their original
payload and do not acquire default copies retroactively.

Runtime checkpoints, receipts, and index retry state remain outside Plan Markdown. Legacy target verified status is
portable in Git; a package's verified state lives in its personal metadata. The controller receipt supports recovery. Reopening for review or starting a new
execution invalidates prior completion evidence. Legacy `validated_ci` resumes as implemented with semantic review
ready; `validated_reviewer` becomes reviewed. Legacy `validated` means verified only with delivery evidence; an
unfinished publication or unmerged Epic integration pass remains reviewed.

An Epic integration gate records reviewed work and its final target. It becomes verified only after that checked work is
proven on the final target. Explicit done-enough closure uses `closed_without_verification` with its completion mode; it
does not manufacture publication proof.

Older unstamped Plans can be recognized by exact completed document content already committed on their target; arbitrary
working-copy status edits do not qualify. Committed archived history without an active attempt is not an instruction to
restart publication when an old feature branch or pre-squash commit is no longer reachable. Doctor omits such
non-actionable history rather than calling it broken. This diagnostic rule neither proves publication nor permits
deleting unmerged commits.

The record advances monotonically through these proven phases:

| Phase                  | Required evidence                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `candidate_sealed`     | Reviewed implementation commit and target head observed at sealing                             |
| `artifacts_committed`  | Legacy sealed Plan/artifacts, or package exact optional copies and validated code boundary     |
| `target_integrated`    | Exact target base and assembled commit; legacy finalized metadata or package exact code/copies |
| `target_published`     | Exact local or remote target commit and publication mode                                       |
| `publication_verified` | A fresh Git read proves the target contains the finalized publication commit                   |
| `cleanup_complete`     | Execution checkout, branch, and temporary publication clone are settled                        |

Every registry update uses a compare-and-swap revision under the existing registry lock. A stale process cannot
overwrite newer proof. A failure annotates the current phase without moving it backward.

The target may advance after an integration is assembled but before it is published. Until `target_published`, RunWield
may replace the `target_integrated` evidence with a newly assembled commit whose target-base commit is the new exact ref
head. This is another revision of the same phase, not a backward transition. Once publication succeeds, the integration
identity is immutable.

Before integration, rewritten source ancestry or changed sealed files invalidate the candidate's validation evidence.
RunWield durably records a revalidation request in that publication record, preserves the record and any publication
checkout, resets the execution Plan to `implemented`, clears its candidate/completion evidence and review approval, and
retires the old record with a revision check. Validation then creates a fresh publication record from the current files.
The request survives interruption between these operations, including after moving the checkout or resetting the Plan.
For a package, revalidation first retains the current code candidate and separates only the proven unpublished copies
commit from its ancestry. The newly reviewed candidate reuses frozen payload policy and receives one copies commit.
This retires an invalid candidate; it does not move a proven publication phase backward. The current validation owner's
checkpoint remains claimed while its next phase changes to Mechanical Validation.

Recovery deliberately reruns validation even for a content-equivalent source rewrite. Matching commit messages or trees
alone does not repair the saved candidate identity or prove the rewritten ancestry is suitable for publication; fresh
checks and sealing avoid carrying those stale identities forward. This costs another validation pass. Ordinary unchanged
retries retain their completed checks. Integrated and published records are excluded from this reset because a push may
already have happened; losing ancestry after publication does not authorize replaying work removed from the target.

On restart, RunWield reads the record and current Git facts. It may advance a missing receipt only when Git proves the
external effect already happened—for example, the saved publication clone contains the candidate and all intended
finalized Plan/Work Record metadata, or the remote target contains that recorded publication commit. Candidate ancestry
alone cannot prove legacy metadata finalization or a package's exact frozen copy payload. Otherwise it retries the current phase. It never reruns validation or
regenerates committed artifacts merely because publication was interrupted. Prepared records are reused for their exact
attempt/source identity, and interrupted owned metadata writes are reconciled before ordinary dirty-checkout guards.
Identity checks do not grant ownership over unrelated Plan or Work Record edits.

Later target commits do not invalidate publication or cleanup. Recovery verifies ancestry against the recorded upstream
(or the local target in local-only mode), preserving the original publication commit as the receipt. Remote checks use
an independent temporary repository when needed, including after the publication clone has been removed; they never
fetch into the primary checkout. Missing or unreachable upstream history cannot fall back to a stale local branch as
proof. Exact target-head checks remain required for the pre-publication push lease, not post-publication cleanup.

Passive Plan and progress reads do not run those remote checks, fetch, or clone. They display applicable saved controller
and publication evidence, including a valid receipt after attempt cleanup, without claiming fresh remote verification.
Absent or invalidated proof leaves publication unconfirmed; neither a missing attempt nor a stale tracking ref proves
delivery. The receipt is subject to the same identity and reopening/new-execution invalidation rules above.

Fresh proof belongs to deliberate preparation, publication, and recovery actions. Those actions recheck authority and
obtain the required local or remote target evidence before recording newly confirmed success or authorizing cleanup.
This read/action boundary changes passive display, not the publication success or cleanup contract.

An interrupted cleanup can leave a directory whose `.git` file points to a removed registration in this repository, or
whose `.git` file Git already removed. After proving publication, recovery moves that unregistered directory intact to
`<execution-path>.saved/files`, reports the saved location, and completes the remaining cleanup. It does not infer clean
file contents from a published commit or delete the leftovers. Registered checkouts still require the normal
clean-worktree checks. A pre-existing saved copy is never overwritten, and an unrelated repository or the primary
checkout is not adopted by this recovery path.

`artifactCommit` is the immutable source-branch boundary, or `validatedCommit` for a copyless package. Publication does not commit or otherwise advance the source
branch after that phase. During cleanup, the normal proof is that the published target contains the source-branch tip.
Recovery may also delete a source branch that advanced past `artifactCommit` only when Git proves that the artifact is
published and every later source-branch commit is a single-parent empty commit. Any later commit that changes files or
merges history keeps the branch for the user.

For remote publication, recovery interprets `targetBaseCommit` exactly as the remote branch head used by the push lease,
not as the integration commit's first parent. A temporary reconciliation merge may sit between those commits.

Remote publication uses a stable temporary clone and never checks out, rebases, stashes, resets, or writes the user's
primary checkout. It pushes the assembled commit with a lease.

A repository without a remote has no second target authority that a primary checkout can later pull. In that explicit
local-only mode, RunWield checks the target checkout, preserves unrelated work, merges the candidate locally, and
commits its finalized lifecycle metadata for legacy Plans. Packages settle personal metadata after local Git proof.
Unrelated unsaved tracked changes block that operation; exact RunWield-owned
preparation and interrupted finalization writes are reconciled automatically. Non-overlapping untracked files are
preserved. This is the sole primary-checkout exception; users who need publication while the checkout contains parallel
tracked work must configure a remote.

## Removed authorities

This decision retires publication-specific transition journals, manual recovered-worktree merge actions,
`publication_failed`/`merge_conflict`/`merged` registry transitions, and Plan-owned repair-checkout pointers. They
described the same operation from multiple stores and made recovery depend on which write happened last.

Retired publication-specific journals do not become new authorities. Stored lifecycle labels and supported publication
records remain compatible through evidence-based reads and reconciliation; recovery does not discard an unfinished
attempt merely because its labels predate the current public lifecycle.

## Verification

Correctness requires two complementary tests:

1. A real-Git, multi-process restart matrix kills publication after every external-effect and registry-write boundary,
   starts a fresh process, and proves exact target ancestry, primary-checkout preservation, artifact uniqueness, and
   cleanup.
2. The authentic composed TUI journey drives Plan review, execution, `task_completed`, Workflow Validation, publication,
   ancestry verification, registry cleanup, and post-completion input readiness.

Presentation-only golden branches may check messages and menus, but they are not publication correctness tests.
