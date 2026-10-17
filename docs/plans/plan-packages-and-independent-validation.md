---
planId: "c3de7406-8856-4908-b131-4e387be39aac"
classification: "PROJECT"
complexity: "HIGH"
affectedPaths:
    - "docs/plans/"
    - "src/plan-store.js"
    - "src/plan-front-matter.js"
    - "src/shared/workflow/"
    - "src/shared/epic-artifacts.ts"
    - "src/shared/session/"
    - "src/shared/collaboration/"
    - "src/agent-definitions/"
    - "src/tools/"
    - "src/cmd/load-plan/"
    - "src/cmd/plans/"
    - "src/ui/review/"
    - "src/ui/tui/"
    - "src/ui/workspace/"
    - "docs/plan-lifecycle.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
createdAt: "2026-08-14T00:11:43-04:00"
origin: "internal"
userVerifiedAt: null
status: "draft"
---

# Plan Packages and Independent Validation

## Context

RunWield stores each executable Plan as one Markdown file. Planner combines the requested outcome, implementation steps,
verification procedures, and manual QA expectations in that file. Plan Engineer or Frontend Engineer implements it and
is instructed to run the full Verification Plan and CI command. Workflow Validation then runs Mechanical Validation and
AI code review. This repeats work without giving the full approved acceptance contract an independent owner.

The same gap exists for Epics. Children publish to their recorded target branch. Without an Epic target, partial work
can reach the main branch before the capability is complete. Current automatic parent completion and `epic_done_enough`
do not run an integrated check of the assembled result. The Epic Manual QA aggregate is advisory, not executed proof.
Remote child publication already uses an isolated clone; the problem is the release destination, not necessarily a write
to the primary checkout.

This Epic separates specification, implementation, independent proof, user acceptance, and delivery. It also makes the
Epic branch the default destination for child work and validates the assembled Epic before declaring independent
success. Users retain the right to accept any result without waiting for successful checks.

The original prerequisites are present: the session-independent validation engine, controller-owned recovery, simpler
workflow messages, and Pair Execution for both Plan execution owners. They are foundations to reuse, not pending
prerequisite Plans. The validation-authority Work Record records user-attested verification rather than a successful
RunWield Workflow Validation run. Source and tests support the current ownership map below; this design session did not
run the test suite.

Two saved dependent Epics remain separate:

- `plan-package-frontend-experience-planning` adds user journeys, representative states, and reviewed prototypes.
- `epic-branch-publication-workflow` adds owner-triggered delivery of an Epic branch to the primary branch.

One prerequisite ships first as a standalone Plan:

- `epic-branches-and-integration-gate` gives every Epic an automatic Epic branch, settles Epic completion from delivered
  children, and adds an integration gate (CI, integration review, Code Review per setting) before an Epic is
  `validated`. This Epic runs on that flow. Its Validator child upgrades the gate's checks to the integrated
  `validation.md` contract; Epic assembly is no longer a child of this Epic.

This Epic does not implement either dependent experience. Its interfaces must support them. No-plan QUICK_FIX behavior
remains unchanged.

Generic automated project QA remains deferred. Validator is a single independent Agent that takes over the approved
Plan's normal validation work from Engineer, performs the checks it can, and explains the remaining human work in
`manual-qa.md`. It does not discover and operate a general project QA campaign or require the deferred Automated QA
proposal.

### Product requirements and scope changes

The following are proposed changes, not delivered capabilities. Core owns shared workflow behavior; Workspace owns its
browser and collaboration experience. Eventual implementation must update the owning requirements and acceptance
scenarios in the same changes that deliver each outcome. Slicer determines the child boundaries.

| Epic outcome                                                                | Owning capability and acceptance coverage                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package identity, authoring, migration, and preservation of user edits      | [Core Plan authoring and external adoption](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption). Extend the external-adoption and concurrent-edit scenarios to packages. Preserve user prose and explicit adoption.                                                                       |
| Whole-package approval and stale-review rejection                           | [Core Plan review](../prd/runwield-core-prd.md#plan-review). Extend feedback, approve-for-later, and approve-and-run scenarios to the complete reviewed package, including Sequence members.                                                                                                            |
| Independent Validator, advisory human QA, shared loop, repair, and recovery | [Core Execution, validation, and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery). Change who performs Plan validation; add three-loop pause/resume and inability-to-check scenarios. Preserve recoverable work and separate delivery evidence.                                 |
| Stable findings and independent confirmation                                | [Core Semantic review and repair](../prd/runwield-core-prd.md#semantic-review-and-repair). Extend claim/rejection and blocked-repair scenarios to Validator findings. Replace independent review retry budgets with the shared budget; preserve review coverage and nonblocking advisories.             |
| Validation, user acceptance, delivery, and Plan-defect return               | [Core Plan lifecycle](../prd/runwield-core-prd.md#plan-lifecycle). Add failed/unrun acceptance, advisory QA with `validated`, and user-approved replanning scenarios. Preserve publication distinction and historical evidence.                                                                         |
| Epic branch assembly, accepted gaps, and integrated checks                  | [Core Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold). Change default child delivery to the Epic branch; add pending-delivery containment and integrated-failure scenarios. Preserve explicit overrides, hold, and done-enough choices.                           |
| Package browsing, editing, archive, and retained QA                         | [Workspace Local Plan management](../prd/runwield-workspace-prd.md#local-plan-management) and [Browser Plan review and workflow](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow). Extend edit, stale-tab, artifact, and recovery journeys; link Core rules rather than copying them. |
| Package-wide encrypted sharing and compatibility                            | [Workspace Shared Plan collaboration](../prd/runwield-workspace-prd.md#shared-plan-collaboration). Extend publish/pull and revision-conflict scenarios to all authored package documents without changing access ownership.                                                                             |

Removal targets are single-document approval/synchronization, Engineer-owned independent proof, separate retry budgets,
and Epic success inferred from child statuses alone. Manual QA remains advisory; no new human QA gate is added. Generic
automated project QA and later Epic publication remain deferred.

## Objective

Replace single-file executable Plans with **Plan Packages** and give the approved validation contract an independent
Validator. A new execution-ready package has `plan.md` and `validation.md`. Generated `manual-qa.md` contains only the
remaining human work. Lightweight child drafts and historical migrated Plans can lack an approved validation contract;
they cannot start new execution until Planner supplies one and the user approves it.

The architecture must produce these outcomes:

- One approval covers the authored package, not whichever document a caller happened to read.
- Plan Engineer and Frontend Engineer implement the approved work, add required tests and fixtures, and use targeted
  checks during development. They do not own or claim the independent validation result.
- Validator performs the approved Plan checks it can and records evidence, findings, and remaining human work. A
  separate Semantic Reviewer checks the current candidate against the approved package where semantic diff review
  applies. Review may find further issues before repaired code receives its final validation.
- Orchestration owns bounded repair, completion events, process recovery, and the return to full proof after code
  changes.
- The user can always accept an individual Plan or Epic through code review or directly as `user_validated`.
- `validated` means the independent workflow passed its performed checks and applicable AI review with no unresolved
  observed failure. Checks Validator could not perform remain explicit advisory human work, not passing evidence.
  `user_validated` means the user accepted the result. Neither status is delivery evidence.
- An Epic has its own target branch by default. Children publish there. The assembled Epic receives integrated
  validation without becoming an executable Plan or owning a durable execution worktree.
- The binary migrates the current checkout and RunWield-managed worktrees, including unfinished attempts. Migration is
  repeatable, permits partial progress, and handles old-format Plans introduced by later merges.

The main option set aside is adding more instructions to the existing Plan and Engineer prompt. That retains duplicated
verification work and does not establish an independent owner of the approved proof. No new datastore, framework, or
service is needed: extend the current file store, controller, Git machinery, Agent tools, and review surfaces.

### Package shape and ownership

```text
docs/plans/<plan>/
  plan.md          identity, authored definition, lifecycle and human history
  validation.md    approved validation contract
  manual-qa.md     generated human QA guide, when needed

docs/plans/<epic>/
  plan.md
  validation.md    integrated Epic contract
  manual-qa.md     advisory aggregate
  <child>/
    plan.md
    validation.md
```

Only a directory containing canonical `plan.md` is a Plan Package. Companion Markdown is not cataloged as a separate
Plan. `planId` remains durable identity; names remain human-facing locations. A parent package owns its documents and
child relationships, not every file below its directory.

| Fact                                                               | Owner                           | Caller rule                                                                                            |
| ------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Plan definition and human lifecycle history                        | Authoritative package documents | Primary before execution; managed execution or retained document worktree afterward                    |
| Package membership, content revision, atomic saves and migration   | Plan store                      | Callers do not assemble package identity or independently write companions                             |
| Approval receipt and exact reviewed snapshot                       | Controller, keyed by `planId`   | Bind approval to the reviewed specification revision; never rebuild the review base from current files |
| Validation results, generations, repair receipts and review issues | Controller                      | Agent reports are inputs; only the current workflow owner advances state                               |
| Worktree identity and publication state                            | Worktree registry plus Git      | Preserve real commit, target, ancestry and publication evidence                                        |
| Session conversation and handoff history                           | File-backed Session machinery   | Keep one user-facing Session across role changes; transcript prose is not completion authority         |
| UI and Workspace metadata                                          | Projections of these owners     | No browser, database projection or Agent message can manufacture approval or proof                     |

Dependencies point from commands, tools, workflow, collaboration and UI to the Plan store's package interface.
Controller operations coordinate lifecycle writes through that interface. Validation depends on an approved package
snapshot and a candidate identity, not on a browser, a Session transcript, or a mutable primary Plan copy. Existing
external process, model and browser capabilities remain external; package transactions and lifecycle rules remain
RunWield-owned.

### Approval and document changes

The approved specification revision covers a versioned, ordered manifest of authored package paths and content:

- the body of `plan.md` and authored metadata, including classification, Work Kind, dependencies, relationships, and
  target policy;
- all of `validation.md`;
- any explicitly declared authored companion artifacts. This permits the dependent frontend Epic to add its artifacts
  without teaching every caller a different approval rule.

Exclude mutable lifecycle fields, timestamps, archive history, controller records, collaboration synchronization fields,
generated QA and reports, and child-package content. Preserve custom authored metadata rather than dropping unfamiliar
keys. Authored YAML values can be canonicalized so formatting-only YAML changes do not withdraw approval. File
additions, removals, renames, or authored-content changes change the specification revision. Status changes and
regenerated QA do not.

Keep the content revision separate from byte revisions used to prevent overwriting concurrent edits. A review decision
must carry the actual reviewed snapshot, its identity and revision, and expected workflow ownership. A validation-only
edit after review opens must reject the old approval, including in Workspace. Never use freshly loaded content as if it
were the content the user reviewed.

The Plan store stages and commits a complete package update under existing locks, with a durable journal that lets
readers resolve one committed file set. Sequential file replacement alone is not atomic package approval. Recovery may
finish or restore only writes it can prove it owns. External edits remain intact. Direct Markdown edits stay supported;
the next read detects changed authored content and requires review before further work under that revision.

Share, pull, push and conflict detection transfer the same authored file manifest as approval. A peer that supports only
one Plan body must receive a clear compatibility error, not a success that silently drops `validation.md`. Preserve
existing collaboration ownership and encryption rules. Migration of remote-canonical content cannot bypass those rules.

Archive, restore and prune act on explicitly selected package-owned artifacts. Archiving a parent does not implicitly
archive all child packages. Existing bulk archive actions can select the related children and report each result. An
unselected child's folder can remain below a container without an active parent `plan.md`. Never recursively delete a
parent directory as a substitute for determining which packages are owned by the action.

### Planning and validation contract

Planner authors `validation.md` for a Planned Change. Architect owns the Epic's integrated acceptance intent and its
validation contract; Slicer connects child scope to the Epic outcomes without claiming implementation or proof. Child
drafts remain lightweight until Planner prepares the selected child. The current Epic template and tool behavior must
change with this architecture so future Epics can carry an executed contract while remaining non-executable containers.

Each contract states stable outcome and check identifiers, required inputs, setup and cleanup, actions, observable
success, and whether the check is machine-executable, agent-executable, or genuinely human-only. An agent-executable
check is a procedure another Agent can perform and report; it is not a permission to replace evidence with a claim.
Commands resolved through project settings are identified with the relevant configuration so repair cannot silently
weaken the approved proof by changing what the command means.

The Verification Adversary challenges whether the draft contract can distinguish the requested result from a cheap
counterfeit before approval. Preserve this role; do not restore the removed Objective-Failing Checks mechanism. The
contract must cover promised outcomes as well as protected existing behavior, not simply require a green test suite.

Validator reports identify the package revision, candidate revision, attempt and generation, and each check's result,
with evidence references. Failed, blocked, unrun and genuinely human-only checks are distinct from passing checks.
Operational failure, such as an unavailable tool or crashed test service, is distinct from an implementation finding and
from a proposed Plan defect. No required check disappears because execution failed early.

Validator generates `manual-qa.md` from the approved checks it could not complete and their current disposition. This
includes human-only judgments and checks blocked by missing access, tools, or environment setup. A blocked or failed
check does not become a passing check when it appears in this document.

The document is a human QA guide, not just a checklist. Each remaining procedure identifies its approved check, the
behavior and purpose, required environment and setup, concrete actions, expected results, relevant evidence and prior
attempts, why Validator could not finish it, and cleanup when needed. Record known setup separately from unverified
instructions. Include the checked candidate and a short summary of completed validation so the human knows what remains.

All remaining human QA is advisory. Anything Validator could not do goes into this Plan artifact and does not block
completion, even if the approved contract expected the check to run. The user can inspect the guide during Code Review
or later; no checklist acknowledgement or human QA gate is required. This applies to Planned Changes and Epics.

The guide must not add requirements or claim unperformed checks passed. Validator must attempt feasible approved checks
and explain concrete limits for the rest. A check that exposes an implementation defect is a failure, not an inability
to perform the check: moving it into the guide cannot remove its open finding. Report missing access or unavailable
services as unperformed checks, not invented implementation defects. A blocked repair for a known defect remains open.
Reports and checkboxes do not rewrite the approved requirements. `validated` certifies the performed validation and
applicable review, not completion of every manual procedure.

### Implementation, proof and repair

```mermaid
graph TD
    A[Plan implementation] --> B[Validator]
    B --> C[Validation repair if needed]
    C --> D[AI review]
    D --> E[Review repair if needed]
    E --> F{Code repaired}
    F -->|Yes| G[Shared loop budget]
    G -->|Remaining| B
    G -->|Exhausted| H[Pause with findings]
    F -->|No| I[Resolve checks and owner gates]
```

The diagram is the independent path for a Planned Change. Validator and AI review share one bounded loop; neither stage
runs its own repeated repair loop before the other stage gets control. AI review examines the current code after any
validation repair, even though that repair has not yet received fresh Validator proof. Only checks against the final
unchanged candidate can support `validated`. A blocked repair for a known defect can pause the flow. An unavailable
validation environment leaves the affected checks in advisory `manual-qa.md`; it does not itself block completion.
Continuing around the loop is not a way to label missing evidence as a passing check.

Allow three automatic full loops. Each loop runs Validator, one validation repair turn if needed, AI review, and one
review repair turn if needed. Do not repeat either stage's repair within that loop. Exit early when the current
candidate has passed its performed checks and applicable review, with all unperformed checks recorded as advisory human
work.

After the third loop, if findings remain or the last repair still needs validation, pause and offer the user a choice:
continue with another explicitly authorized budget, return to planning, leave the work paused, or accept the result. Do
not hide another automatic repair loop behind final verification. Unchecked repairs remain visibly unvalidated. The user
can pause or accept earlier; three loops is not a prerequisite for either action. This bounds automatic repetition, not
the exact token cost of each turn.

Non-Git semantic diff review retains its explicit not-applicable behavior. An Epic runs its integrated Validator path
without an Epic-level Engineer or Semantic Reviewer; integrated failures still return through a reviewed repair child.

Implementation completion, validation completion, semantic review completion and repair completion have role-specific
contracts. Each accepted event carries its owner, attempt, generation and tool-call identity and is consumed once.
Implementation completion produces `implemented`; it cannot produce a validation report. Repair completion returns
control to orchestration; it cannot declare a Plan independently validated. Keep existing Workflow Tool Event ownership
and consume-once protections rather than replacing them with transcript parsing.

Validation Repair Engineer receives the approved package reference, candidate checkout, failing checks and evidence.
Review Repair Engineer receives the package, candidate and current review issues. Plan-Revision Repair Engineer receives
the approved revision difference and preserved candidate. These are bounded contexts, not a replay of the implementation
conversation. No repair role edits lifecycle metadata, approval receipts, counters or publication records.

Validation findings reuse the Review Issue Ledger mechanism in `src/shared/workflow/review-ledger.ts`, not a separate
Ticket system. Each finding has a stable ID, its originating stage, approved requirement or check, evidence, and current
repair state. IDs survive repair, rejection, pause, and continuation of the same attempt. Keep validation and AI review
findings distinguishable and prevent identity collisions.

Repair Engineer reports each supplied ID as fixed, already satisfied with evidence, or blocked with a reason and what
would unblock it. A repair claim is not resolution. Validator confirms or rejects validation fixes; Reviewer confirms or
rejects review fixes. Rejected fixes retain their IDs. Omitted and blocked findings stay open; a blocked report must not
be accepted as successful repair completion. Reuse the existing claim/confirm/reject behavior and extend its durable
reporting where needed rather than treating all supplied items as fixed from a generic completion signal.

Orchestration owns the shared loop budget and durable counters across both stages. Validation repair and AI review
repair must not each receive an independent retry allowance. Exhaustion pauses with evidence and user choices; it does
not invent success or automatically buy another loop. Resume preserves consumed budget. On restart, reconcile current
files, controller state and Git facts before choosing the next action. Do not replay a completed or interrupted Agent
turn as recovery.

Any code repair invalidates proof for the earlier candidate. This includes validation repair, review repair, Code Review
chat repair and publication conflict repair. Independent success requires a fresh complete Validator run and applicable
AI review. A changed package also needs renewed approval. The user can instead accept the repaired result directly.

### Validation environment and Agent authority

Validator runs in the existing implementation worktree for a Planned Change. Do not create a separate validation or
repair copy and merge it back. Reuse the environment already prepared for implementation. For an Epic with no execution
worktree, the controller still needs a checkout of the assembled Epic revision; that is an assembly requirement, not a
sandbox against the model editing code.

Validator receives read and inspection tools, shell access for approved checks, and Guide's existing `write_docs` and
`edit_docs` tools for generated Markdown reports and `manual-qa.md`. Do not give it general `write`, `edit`, or
`multi_file_edit` tools. Its Agent definition prohibits source repair, test weakening, settings changes, or amendment of
`plan.md` and `validation.md`, including through shell commands or delegation. Its job is to report findings and explain
remaining human work. Package writes still use the Plan store's ownership rules.

This is a tool-policy and Agent-responsibility boundary, not an operating-system security sandbox. Test commands can
produce their normal outputs and have side effects. Preserve existing consent and secret-handling rules. No new sandbox,
disposable-copy system, or rollback subsystem is required to prevent an assumed model impulse to repair.

Reports identify the actual checked candidate and approved package. Changed code or requirements cannot retain proof for
the old inputs. For Git candidates, retain commit and relevant working-file evidence, including required untracked
inputs. For non-Git work, retain consent-based in-place operation and record the checked source scope and digest without
inventing Git evidence. Record unavailable evidence as a limit; direct user acceptance remains available.

The rejected alternative was a disposable validation copy for every Plan. It adds dependency and service setup, local
configuration transfer, disk use, and cleanup without being needed for independent Agent responsibility. The owner chose
the simpler same-worktree model.

### Lifecycle, owner acceptance and Plan defects

| State                   | Meaning                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `implemented`           | Implementation finished, or Epic children and accepted gaps are settled; independent proof remains                                   |
| `validating`            | Validator owns the current independent attempt                                                                                       |
| `reviewing`             | Semantic Reviewer owns the current Planned Change review                                                                             |
| `awaiting_owner_review` | Configured Code Review remains; advisory manual QA never creates this gate                                                           |
| `validated`             | Performed checks and applicable AI review passed for the recorded candidate; configured owner gates resolved; advisory QA may remain |
| `user_validated`        | The user accepted the result without requiring a successful independent path                                                         |
| `defective`             | The user approved a structured Plan-defect return to planning                                                                        |

Detailed phases, repair kind, counters and paused state belong in the controller, not additional board statuses.
Delivery remains separately recorded. A Plan can be validated with publication pending. An Epic can be validated without
being delivered to the primary branch. Legacy `verified` and `user_verified` records retain historical meaning;
migration must not relabel an old attestation or automatic Epic completion as a new independent run.

The user can always accept a Planned Change or Epic through Code Review or directly as `user_validated`. Neither route
requires a successful Validator run, AI review, integrated Epic validation, or exhausted repairs. Code review is
optional. Failed, interrupted and unrun workflows must expose the action. Where all applicable independent gates already
passed, ordinary owner review can retain `validated` even with advisory QA remaining. Direct acceptance remains
explicit. A Validator that finishes with documented unperformed checks differs from a Validator turn that never ran or
was interrupted: the latter cannot manufacture a completed validation report.

Record the acceptance route, time, available package and candidate identity, and existing check results. Missing
candidate evidence is recorded as unavailable, not used to prohibit acceptance or fabricate proof. Acceptance ends
automatic work at a safe checkpoint. Delayed Agent completions cannot overwrite it or restart repairs. It does not
discard worktrees, claim failed checks passed, create delivery evidence, or automatically publish an Epic.

An implementation Agent, Validator or Reviewer can propose a Plan defect with evidence: contradictory requirements,
missing authority or information, or a contract that can pass while the objective fails. Only user approval creates
`defective` and returns the package to Planner. Preserve the candidate and attempt history. Planner produces a new
revision for review, followed by bounded revision repair when safe. Rejection of the proposal leaves the package
unchanged; the user chooses repair, pause or acceptance. Do not confuse a test failure with permission to rewrite scope.

### Epic assembly and integrated validation

```mermaid
graph TD
    A[Child delivery receipts] --> B[Epic branch commit]
    B --> C[Settled children and accepted gaps]
    C --> D[Epic implemented]
    D --> E[Integrated Validator]
    E --> F[Epic validated]
    E --> G[Report to Planner]
    G --> H[Approved repair child]
    H --> A
```

Architect names a default Epic target branch in future Epic definitions. Children execute from and publish to that
branch. The user can change this through ordinary Plan feedback, including choosing per-child delivery to the primary
branch. A primary branch destination does not imply modifying the primary checkout. RunWield does not publish the Epic
branch to primary in this Epic.

Recommended branch rule: record both the Epic destination and its intended creation base. Resolve the base commit before
branch creation; do not silently create from hard-coded local `main`. Use the repository's intended target/upstream as
the proposal and ask when it is ambiguous. Existing targets must be inspected rather than reset. Explicit child
overrides remain explicit. Changed inherited targets can update drafts; approved children require review, and active
attempts retain their recorded target unless the user chooses recovery. Do not retrofit new target defaults onto
unfinished migrated attempts.

The controller owns each integrated validation attempt, including the temporary checkout, cleanup and durable report.
Its identity binds the Epic `planId`, approved package revision, declared assembly repository and ref, exact commit,
child-set revision, delivered child receipts, outcome claims, accepted gaps, and attempt generation. It is not an Epic
execution worktree record. An interrupted run can resume or rerun from those inputs without inventing an Engineer phase.

Automatic `implemented` requires each included child to be settled and its delivered candidate to be contained in the
assembled revision. `validated` or `user_validated` child status alone is insufficient; pending publication is not
delivery. Proven publication can settle before cleanup finishes. A closed or excluded child needs an explicit outcome
disposition and must not count as built merely because it left the board. Active, failed or repair-pending included
children prevent automatic completion. Reconcile after actual delivery and on reload, not only on child validation
events.

The user can mark the Epic done enough and record accepted gaps, or directly accept the current result as
`user_validated`. Done-enough is the independent path to `implemented`, not a synthetic passing result. An omitted
outcome is an accepted gap; an outcome claimed by a delivered child that fails is a validation failure. The Slicer and
child contracts must distinguish complete outcomes from partial contributions using stable Epic outcome identifiers.
Changing scope or adding children changes the assembly inputs and requires reconciliation.

Before accepting an integrated result, compare the current package revision, assembly head, child set and generation
with the attempt inputs. Changed inputs make the report stale; retain it as history, not proof of the current Epic.
Repeat these checks on resume and before later delivery. A branch watcher alone is insufficient. Reports and status
bookkeeping must not move the source commit being certified; any subsequent branch movement requires fresh integrated
proof before it is described as currently validated.

A failing integrated run returns its complete report and failed outcome identifiers to Planner. The repair is a child
Plan, not an unplanned Epic-level Engineer turn. That child's contract names the failures; after its delivery, rerun the
whole integrated contract. The user can choose acceptance instead at any point.

For explicit per-child delivery, pin integrated validation to the declared common assembly branch, normally primary. A
child delivered to another target counts only when its candidate is actually contained in that assembly; validation must
not silently merge mixed targets. Non-Git Epics use the defined source snapshot rather than a branch or fictitious
commit. This preserves non-Git execution without claiming branch isolation exists there.

### Repeatable migration and compatibility

Migration lives in the binary on project entry, not the installer. It converts legacy Plans in the current checkout and
RunWield-managed worktrees, including unfinished attempts and retained worktrees that own reopened Plans. A global
installation cannot enumerate every repository. Notices state that unmanaged branches and worktrees are not upgraded
automatically. The binary does not check out arbitrary branches. A checkout later opened with `wld` gets the same scan.

```mermaid
graph TD
    A[Project entry] --> B[Scan checkout and managed worktrees]
    B --> C[Legacy Plan found]
    C --> D[Recoverable package conversion]
    D --> E[Package available]
    D --> F[Local conflict retained]
    E --> G[Next entry scans again]
    F --> G
```

Keep conversion support for one whole version, with deprecation considered in a later release and announced explicitly.
A global migration marker must not suppress discovery: if a later merge introduces old-format Plans, the next `wld` run
converts them. Repeating a completed conversion makes no further changes. Mixed layouts can exist on disk during partial
progress; ordinary operations resolve the relevant package through the store, not through a second legacy execution
path. Unadopted external Markdown remains readable and unchanged by listing or browsing. Deliberate adoption creates its
package and required identity while preserving its prose and age; storage migration does not imply user approval.

Progress is per package and authoritative checkout. One conflict does not undo unrelated conversions. The journal
records input identity/content, intended paths and committed output so an interrupted package can finish or restore
without losing user edits. Readers must not see half a package. Coordinate conversion with current Plan, catalog,
controller and worktree owners. An unfinished attempt is supported; an old process actively writing those files must
stop or release ownership before they change. Do not treat a status alone as proof that a checkout is idle.

Each checkout converts its own content. A stale primary copy must never replace the authoritative execution-worktree
Plan. Preserve identity, names, relationships, archive membership, collaboration references, lifecycle history,
controller generations, repair receipts and worktree identity. Do not reset an attempt merely because its files moved.

When a legacy copy and package represent the same identity, reconcile only when content equivalence is proven. Different
content, another identity at the destination, or unresolved Git conflicts retain both inputs and produce a local report.
Never choose a winner from file shape, modification time or a directory-wide overwrite. Remote-canonical packages retain
the existing collaboration write restrictions; local migration cannot publish an unauthorized remote revision.

Migration extracts the existing Verification Plan into `validation.md` without rewriting requirements. Retain approval
only through explicit evidence connecting the old approved content to the new package. Old byte hashes remain historical
receipts, not the new content hash. Migration must not invent a Validator pass or silently strengthen acceptance
criteria.

If an unfinished Plan has no usable verification section, or extraction is ambiguous, convert its storage and return it
to Planner. Startup does not use an Agent to invent new criteria. Planner supplies the contract, and the user approves
it before implementation or validation resumes. Preserve code and attempt history. Record this migration return so
restart and delayed completions cannot bypass it. It is not an implementation failure or an Agent-declared `defective`
state. Direct `user_validated` remains available. Lightweight drafts follow their ordinary Planner path.

Completed and archived Plans keep their historical outcomes. Missing new contracts must not reopen them automatically or
fabricate integrated Epic proof. If later reopened for new execution, they need an approved validation contract. The
glossary changes ship with the implementation that makes each new concept true, not during this design session.

Publication migration requires explicit recovery handling. Existing receipts bind commits, artifact paths and target
ancestry. Do not change a historical seal, broaden an allowed-path list, or add a migration commit and assume old proof
still authorizes publication. Reconcile any existing remote/local effect first. Preserve historical publication evidence
and create new candidate/proof state where conversion changes what remains to be delivered. Restart must distinguish an
already delivered old candidate from an undelivered converted one and must never publish or clean up twice.

The options rejected are installer-time global migration and requiring every Plan to finish before upgrade. Neither
handles legacy files arriving through a later merge. The chosen approach costs temporary format and recovery support,
but permits unfinished work and delayed branch integration. Removing migration support is later work, not a hidden
timer.

## Vertical Slice Findings

The relevant current call paths and evidence are:

- `getStoredPlanPath` and `collectPlans` in `src/plan-store.js` resolve and discover Markdown files. Revisions currently
  include body, whole-document bytes and front matter. `plan-store.test.js` covers stale writes, archive selection and
  identity. A folder rename alone would catalog companion Markdown as Plans.
- `submitPlanForReview` -> `applySharedPlanReviewDecision` -> `runPlanReviewDecisionTransition` saves and approves one
  document. `validateApprovedPlanSnapshotForHandoff` rejects changed identity, revision, status and worktree evidence.
  The Workspace `answerInteraction` path supplies freshly loaded content alongside an earlier expected revision; package
  approval must retain the original reviewed snapshot rather than reconstructing that base.
- `snapshotSequenceReview` and `validateSequenceReviewDecision` in `sequence-review.ts` already retain opening snapshots
  and validate membership/order for grouped review. Workspace uses those snapshots for Sequences. Preserve grouped
  approval while extending each member to a package; approving the container alone must not approve changed child
  contracts. `sequence-review.test.ts` and `owner-workspace.test.js` cover the existing grouped path.
- Guide exposes `write_docs` and `edit_docs`; `docs-file-tools.test.js` checks Markdown-only file access. These tools
  restrict file type, not all possible shell behavior. `review-ledger.ts` preserves issue IDs and independent fix
  confirmation; `reviewer-feedback-engineer.md` requires per-ID repair reports and stops on blocked items. Validator
  extends these existing patterns.
- `resolveWorkflowPlanLocation` chooses the execution or retained document worktree and refuses to substitute a primary
  copy when that document is missing. `plan-document-authority.integration.test.ts` and
  `authority-continuation.integration.test.ts` protect that rule across edits, archive and recovery.
- `finalizePlanImplementation` -> `continueWorkflowValidation` -> `runValidationLoop` owns implementation checkpoints,
  Mechanical Validation, semantic review, repair and delivery. Controller generations and consume-once events already
  exist. `validation-repair-resume.integration.test.ts` covers rerunning checks after interruption rather than replaying
  repair turns. These mechanisms must serve the new Validator, not be replaced by prompt instructions. Today,
  `runMechanicalValidationPhase` sends `executionCwd` to `runLocalCI`, which reloads the exact checkout's configured
  command. Retain that environment while replacing separate per-stage retry budgets with the shared loop.
- `materializeChildFeaturePlans` inherits `targetBranch`. `prepareTargetBranchRef` currently creates missing targets
  from local `main`; that is not an adequate implicit rule for named Epic branches. `recordPlanEvent` and
  `advanceParentEpicWhenAllChildrenVerified` can advance the parent before publication. Both need assembly evidence, not
  just terminal child statuses. Tests in `workflow-slicer.integration.test.ts`, `worktree-creation.test.ts`, and
  `plan-lifecycle.test.js` expose these paths.
- `publishExecutionWorktreeIsolated` and the publication machine already protect target movement, isolated remote
  publication and retry. `artifactEvidence` expects a specific commit shape and recorded Plan paths. Migration must
  preserve actual proof rather than adapting only the filename. `isolated-publication.test.ts` and
  `publication-machine.e2e.test.ts` cover ancestry and crash recovery.
- `pushPlanRevision` currently transfers one encrypted body. `archivePlan` moves one Plan and registered Epic artifacts;
  bulk archive explicitly selects children. Package-wide sharing and explicit archive ownership must extend these
  behaviors. `collaboration-commands.integration.test.ts` and `epic-artifacts.test.ts` provide baseline coverage.

`docs/validation-authority.md` is the current ownership reference. `docs/domain-language.md` is the applicable glossary;
there is no domain-language map in this checkout. Some glossary and lifecycle prose still use legacy status names. The
approved target is `validated` and `user_validated`, separate from delivery. `FEATURE` is a legacy classification; new
executable Plans use `PLANNED_CHANGE`. Plan Engineer and Frontend Engineer are the current execution roles.

## Expected Change Surface

This is guidance, not an allowlist or child task list. Later planning must verify the real footprint. Changes to
approved intent, another subsystem, or greater migration risk return to the user.

- `src/plan-store.js`, `src/plan-front-matter.js` — package identity, authored membership, revisions, atomic saves,
  discovery, archive scope and conversion.
- `src/shared/workflow/` — approval snapshots, Validator attempts, role completion, bounded repair, lifecycle,
  Plan-defect and migration return, Epic assembly evidence, publication compatibility and recovery.
- `src/shared/worktree.js`, `src/shared/worktree-registry.js`, `src/shared/isolated-publication.ts` — declared branch
  bases, managed-worktree migration, exact candidate and target evidence. Existing publication safety stays owned here.
- `src/shared/session/` — continuous Session and isolated role histories; safe handoff and stale-event rejection.
- `src/shared/collaboration/` and `src/cmd/plans/` — package transfer, revision conflicts, locks, archive/restore and
  prune.
- `src/agent-definitions/`, their document formats, and `src/tools/` — package authoring, integrated Epic contracts,
  independent Validator, bounded role inputs and completion contracts. The future Architect default names an Epic
  target; this current PROJECT does not set an execution policy or target branch for itself.
- Binary project-entry paths and `src/cmd/load-plan/` — repeatable conversion, local conflict reports, retained-attempt
  planning return, and format support notices. `src/cmd/update/index.ts` and the installer do not own repository
  conversion.
- `src/shared/epic-artifacts.ts` — explicit authored versus generated artifact ownership, contextual advisory QA, and
  retained artifact access after delivery.
- `src/shared/workflow/sequence-review.ts` — preserve grouped review of a Sequence and its children, extending each
  reviewed member to its authored package snapshot without changing Sequence execution semantics.
- `src/ui/review/`, `src/ui/tui/`, `src/ui/workspace/` — package review and browsing, complete reviewed snapshots,
  lifecycle and delivery display, failed/unrun check evidence, and owner acceptance for both Plans and Epics. Browser
  work reuses shared Plan Review, Code Review and Plan Board bodies, Session-scoped interaction routes, and `--rw-*`
  design tokens. The user can inspect `plan.md` and `validation.md` within one review, and can distinguish authored
  requirements from generated reports. `manual-qa.md` is an accessible Plan artifact during Code Review and after
  delivery, not a required checklist dialog. A stale package cannot be approved from an old tab. Closing a review is not
  acceptance.
- `docs/plan-lifecycle.md`, `docs/domain-language.md`, the owning Core and Workspace PRD capabilities linked above, and
  release documentation — package, role, proof, acceptance, delivery and migration contracts. The implementation
  introducing each term updates the glossary in that same change. The dependent frontend and publication Epics need
  review against these settled contracts before their later planning; this Epic does not implement their scope.

## Reuse Opportunities

- `plan-store.js` atomic writes, identity and revision checks; `state-transition.ts` owned rollback and journaling.
- `controller-registry.ts`, `validation-supervisor.ts`, `validation-engine.ts` and existing checkpoint/repair
  generations.
- `plan-location.ts` authoritative document lookup; publication and worktree registries with real Git recovery checks.
- Existing Planner, Architect, Slicer, Verification Adversary, Semantic Reviewer, Pair checkpoints and bounded repairs.
- Existing Manual QA generation and Epic aggregate, expanded into contextual human procedures without becoming gates or
  approval authority.
- Guide's `write_docs` and `edit_docs` tools; `review-ledger.ts` stable identities and claim/confirm/reject rules.
  Validator reuses these boundaries rather than adding general code-editing tools or a second finding system.
- Existing collaboration encryption and write ownership, extended to the package manifest rather than replaced.
- Shared Workspace and standalone review surfaces; `docs/design-system.md` and `src/ui/design-system/` remain the
  browser baseline. Workspace stays a projection; no new database becomes necessary for Core operation.
- The session-independent engine remains available to other runtimes, including Connect. This Epic does not introduce a
  second validation authority or change model-host ownership.

## Verification Plan

This is an architectural acceptance contract, not an executable child Plan. Later Plans turn these outcomes into checks
that fail against the old architecture and pass against the new one. Automated integration uses real temporary Plan
projects, controller files and Git repositories, not injected substitutes for RunWield-owned transactions or locks.

Required project checks are `deno task seams:check` and `deno task ci`. Focused test files run through
`deno run -A scripts/run-tests.js <deno test args>`, never direct `deno test`. Browser changes require real-browser
checks through the project's approved acceptance tools and shared `/dev` surfaces.

Manual acceptance must cover one standalone Planned Change and a multi-child Epic: inspect both authored documents in
review, reject stale approval after a validation-only edit, follow implementation through failed validation and bounded
repair, accept a failing result with and without code review, distinguish acceptance from delivery, and reopen after
process loss. Migration acceptance includes unfinished managed-worktree work and a later Git merge of a legacy Plan.

Cross-boundary acceptance must also show a Plan completing and delivering with advisory human QA. Open that same
artifact during Code Review and again after delivery. A second run must show a real observed defect remaining open
instead of being hidden in that guide. Exercise the shared three-loop limit with findings from both stages and a
restart, retaining IDs, partial repairs, and the user's choice. These journeys join the Core and Workspace capability
scenarios above; passing isolated child checks alone does not prove them.

### Outcome Evidence

- **Package identity is real** — ordinary Plan reads, writes, review, collaboration, archive and publication reach the
  package interface. `validation.md`, generated QA and report files never appear as separate Plans. Names and `planId`
  survive conversion; execution-ready Plans have approved contracts.
- **Approval covers the package** — a validation-only edit, authored companion addition/removal or changed target policy
  invalidates the old approval. Status/QA updates and child content changes do not. A stale Workspace review uses the
  original snapshot and cannot approve current unseen content. Interrupted saves expose one committed file set.
- **Collaboration and archive preserve scope** — validation-only changes transfer and conflict correctly; incompatible
  peers cannot silently drop them. Single-parent archive and prune do not move or delete unselected children.
- **Implementation cannot claim proof** — Plan Engineer/Frontend Engineer completion ends at `implemented`. Only a
  matching Validator report advances the independent path. `task_completed` is not a universal validation/repair event.
- **Every contract check is accounted for** — results bind to a package, candidate and generation and distinguish
  passed, failed, blocked, unrun and human-only work. A green generic CI command cannot stand in for omitted contract
  checks. A concrete inability to perform a check produces advisory human QA, not a pass and not a completion gate.
- **Validator reports rather than repairs** — its effective tools expose `write_docs` and `edit_docs`, not general
  file-writing tools. Its definition prohibits repairs and contract edits through any tool. A representative failed
  check produces a finding and leaves repair to Engineer in the same worktree; normal test outputs and generated QA
  remain allowed. Do not claim that this tool policy sandboxes shell commands.
- **Human QA has usable context** — an infeasible approved procedure appears in `manual-qa.md` with its check ID,
  purpose, setup, actions, expected result, prior evidence, and reason it needs a human. With performed checks and AI
  review passing, this remaining QA does not prevent `validated` or delivery and needs no user acknowledgement. The user
  can open the retained Plan artifact during Code Review or after delivery. An actual failure remains an open finding,
  not advisory-only work. The guide adds no unapproved requirement.
- **Findings survive repair** — each validation and review finding keeps its ID across claims, rejection and resume.
  Per-ID blocked reports preserve open findings and partial work. Only the responsible validation or review result
  confirms a fix; omitted IDs cannot disappear on a successful-looking completion.
- **One shared loop limits token spend** — validation and AI review do not have independent automatic repair budgets. An
  integration run with findings in both stages and a process restart cannot exceed three automatic full loops.
  Exhaustion pauses with all findings and unchecked repairs preserved. Further automatic work requires new user
  authorization; pause and acceptance also work before the third loop.
- **Repairs invalidate old proof** — validation, review, Code Review chat and publication conflict repairs all need
  fresh full validation and applicable semantic review for independent success. Old completion events cannot settle a
  new run.
- **User acceptance always works** — both Plans and Epics can become `user_validated` through code review or direct
  action after failed, unrun or interrupted checks. No Agent approval is required. Reports stay unchanged, late events
  cannot restart work, and unavailable candidate evidence is not fabricated.
- **Plan-defect return has one owner** — an Agent proposal cannot set `defective`. User approval preserves the candidate
  and returns to Planner; a revised package needs review before bounded revision repair. Migration return has its own
  reason and cannot be mistaken for an approved Plan defect.
- **Lifecycle and delivery are distinct** — new independent success uses `validated`; owner acceptance uses
  `user_validated`. Pending publication remains visible independently. Legacy success is not rewritten as a new pass.
- **The Epic is the default release unit** — new children inherit the reviewed Epic destination, publish there rather
  than primary by default, and preserve explicit overrides. Branch creation uses a recorded intended base, not implicit
  `main`.
- **Child status does not prove assembly** — pending delivery prevents automatic Epic completion even if child status is
  `validated` or `user_validated`. Current delivered candidate containment and the current child set decide settlement.
- **Epic proof is exact and non-executable** — the controller runs the integrated contract against pinned inputs with no
  Epic Engineer or durable execution worktree. Advancing the branch, editing the contract or changing the child set
  makes an old report stale. Owner acceptance never creates integrated proof.
- **Done enough does not hide broken work** — unbuilt outcomes are recorded as gaps. Claimed outcomes that fail remain
  failures. A repair child names failed Epic outcome IDs, and its delivery leads to a full integrated rerun.
- **Migration is repeatable and partial** — the binary converts the current checkout and managed worktrees including
  unfinished attempts. A second run makes no changes. A later actual merge of old-format Plans triggers conversion
  again. One local conflict preserves both inputs without reversing other completed conversions. Unmanaged refs remain
  untouched.
- **Migration preserves authority and recovery** — differing primary/worktree content retains execution authority. Crash
  cases at each package write and publication transition preserve identity, attempt generations, real sealed evidence
  and user edits. Concurrent old writers cannot race a conversion. A receipt for old paths is not proof of a new
  candidate.
- **Missing contracts return to Planner** — format-only extraction can preserve approval with equivalence evidence.
  Missing or ambiguous verification in unfinished work preserves code but prevents automatic resumption until a new
  contract is approved. Direct acceptance remains possible; completed and archived work is not reopened automatically.
- **Existing behavior stays protected** — Plan sharing, review, Plan Board, dependency selection, worktree authority,
  non-Git consent, Pair Execution, Session continuity, bounded repair, recovery, archive/restore, publication ancestry
  checks and no-plan QUICK_FIX all retain their intended behavior through the new owners.
- **Old behavior stops** — no sole-filename Plan authority, single-body-only approval or synchronization, Engineer-owned
  independent proof, automatic Epic success from child statuses alone, implicit per-child primary delivery, or universal
  completion event. Manual QA is not an independent Validator substitute and AI review does not rewrite omitted intent.

## Edge Cases & Considerations

- **Three shared loops.** Validator, validation repair, AI review, and review repair share one counter. After three
  automatic loops, unresolved findings or unchecked repairs require a user choice before more automatic work. Preserve
  the counter across pause and restart. Do not restore separate per-stage retry budgets. The user can pause or accept
  earlier. A bounded loop count controls runaway repetition but does not promise an exact token ceiling.
- **Cost and retention.** Rechecking repaired code costs time and tokens. Preserve cancellation and the shared budget.
  Retain reports and receipts needed for recovery, clean only owned temporary resources, and do not treat
  report-generation failure as passing a missing gate.
- **Direct edits and external processes.** File locks coordinate RunWield, not arbitrary editors or old binaries. Check
  expected content and preserve unexpected writes. Unsafe concurrent ownership pauses the affected operation without
  requiring every unfinished Plan in the project to finish first.
- **Publication during migration.** This is a high-risk compatibility boundary, not a filename refactor. Never
  manufacture replacement evidence for a candidate already published or overwrite current primary/target content from an
  old branch. Use existing journals, registry phases and real Git effects to distinguish recovery cases.
- **Advisory manual QA.** All checks Validator cannot perform remain visible in `manual-qa.md` without blocking
  completion. `validated` can coexist with this guide; never claim its unperformed checks passed. Known defects still
  need confirmed repair or explicit user acceptance as `user_validated`. User acceptance is not constrained by the
  availability of a browser or a candidate checkout.
- **Stale reports and status display.** Historical validation remains evidence for its recorded inputs, not for whatever
  the branch contains today. Loaded views reconcile staleness with the controller; they do not erase reports or silently
  claim the new head passed. Status bookkeeping must not create an endless validate-and-change-the-same-commit loop.
- **Scope changes.** Parent approval excludes child file contents, but assembly proof includes the child set and outcome
  coverage. A new child must not retroactively disappear from integrated acceptance because an older worktree lacks it.
- **Epic delivery is later.** Validation proves the Epic assembly, not compatibility with future primary-branch content.
  The dependent publication Epic must recheck its merge candidate and support explicit owner acceptance without false
  proof. Its saved `verified` terminology must be aligned with `validated` before later planning.
- **Historical packages.** Completed Plans can retain legacy evidence and lack a newly approved contract. Reopening for
  execution requires review; browsing and archive must not invent validation requirements retroactively.
- **Technology horizon.** File packages increase transaction and collaboration complexity but retain Git-readable,
  portable artifacts and existing local operation. Keep conversion for the agreed version window, measure startup scans
  in large Plan catalogs, and remove the legacy converter only through an announced later release. No new service or
  permanent dual storage engine is justified by this change.
