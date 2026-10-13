# Plan workflow: planning through publication

This map covers routing, planning, execution, validation, publication, repair, resume, and Epic continuation. The
lifecycle and publication sections reflect the current implemented → reviewed → verified contract. Other paths retain
source-level detail from the original 2026-09-07 inspection rooted at commit `a201fc19737471b1d8f57ab384bb4412d65309a2`.

The [2026-09-07 transition audit](audits/2026-09-07-plan-workflow-transitions.md) preserves the original observations,
test limitations, and follow-up questions. Its audit labels below identify historical findings, not a claim that every
finding still reproduces or has been fixed. A Plan, Work Record, prompt, or documentation claim is not evidence that a
branch works; implementation and publication require their own checks and Git proof.

## What causes a transition

Five different inputs appear below:

| Marker | Input                     | Meaning                                                                                                                                                                          |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T**  | Accepted Custom Tool call | The implementation accepts the arguments and publishes an event, or performs the state change directly. A tool name appearing in prose or a returned transcript is insufficient. |
| **U**  | User interaction result   | A structured review, selection, or confirmation response. Feedback text supplies repair instructions; it is not parsed for words such as “approved.”                             |
| **C**  | Controller decision       | Code selects a branch using status, settings, identity, counters, or an explicit phase result.                                                                                   |
| **G**  | Git or process result     | Exit code, conflict state, commit identity, ancestry, target ref, or completed filesystem operation.                                                                             |
| **S**  | Saved state               | Plan document, controller checkpoint, tool-event receipt, worktree registry, or recovery journal read during resume.                                                             |

Thus, “everything advances through tool calls” is too broad. Agent completion uses tools; CI passes through an exit
code, human approval through an interaction, and publication through Git evidence. In the inspected production paths,
agent language is not parsed to decide that implementation, review, or a repair succeeded. Some consumers still wait for
the producer's turn to return before claiming its accepted event. That timing difference matters.

## The state owners

| State                                                                                                   | Owner in current code                                                           | What it establishes                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Plan definition and lifecycle status                                                                    | Primary Plan before execution; execution-worktree Plan during an active attempt | What the work is and how far validation has progressed.                                                                            |
| Validation checkpoint, review issues, repair receipt, counters, human review decision, execution report | Controller record under `.wld/internal/controller/plans/`                       | Which phase may resume and which repair/review generation it belongs to. `loadPlan` joins this state into its returned attributes. |
| Execution attempt and publication phase                                                                 | `.wld/internal/worktrees.json`, backed by Git facts                             | Which checkout/branch is owned and whether publication and cleanup completed.                                                      |
| Accepted root tool calls and acknowledgements                                                           | Structured custom entries in the Session's JSONL storage                        | Pending handoffs, not a replacement for Plan/controller truth. Isolated event delivery is in memory.                               |
| Interrupted non-publication mutation                                                                    | State-transition journal                                                        | Which owned effects can be proved, completed, or rolled back. Publication uses its registry record instead.                        |

Sources: [Plan location](../src/shared/workflow/plan-location.ts),
[controller storage](../src/shared/workflow/controller-registry.ts),
[event storage](../src/shared/workflow/workflow-tool-events.ts),
[task completion receipts](../src/shared/session/task-completion-session.ts),
[mutation boundary](../src/shared/workflow/state-transition.ts).

The public success path is `implemented → reviewed → verified`. Passing CI keeps the Plan implemented and saves
`validationPhase: semantic` in the controller. Reviewed work remains pending through artifact preparation and
publication; verified requires confirmed target delivery, or completed in-place validation for non-Git work. A permanent
controller `publicationReceipt` preserves confirmed delivery when the primary checkout trails the remote and after
attempt cleanup. Legacy validated statuses are compatibility inputs, not additional current milestones.

## Overall tree

The expanded trees below use these node names so a repair can point back to its exact destination.

```text
Request
├─ T triage_report → intent dispatcher
│  ├─ INQUIRY → Guide → answer; no Plan execution
│  ├─ IDEATION → Ideator → exploration; later implementation needs routing
│  ├─ OPERATION → Operator → T task_completed → finish; no validation
│  ├─ QUICK_FIX → Engineer → T task_completed → Q: no-plan CI loop
│  ├─ FEATURE / PLANNED_CHANGE → P: Planner
│  └─ PROJECT → P: Architect
└─ U load-plan / resume / direct review → R: saved-state entry

P: Plan creation and review
├─ saved / canceled / unfinished → stop with Plan available for later
├─ feedback → revise → P again
├─ approved Epic → X: Slicer → select child → P for that child
└─ approved executable Plan → E: execution preparation and implementation
   ├─ blocked / canceled / Pair stop / missing completion → pause → R
   └─ accepted completion + implementation checkpoint → V1: mechanical checks
      ├─ failed checks → CI repair → V1
      └─ passed → V2: semantic review
         ├─ protocol correction → same review round
         ├─ findings → semantic repair → V1
         ├─ round limit → user chooses another review, repair, human review, or stop
         └─ accepted review or explicit skip rule → H: human code review
            ├─ feedback → human-feedback repair → V1 → H
            ├─ no decision → retry H or pause
            └─ approval / allowed skip → D: artifact preparation and publication
               ├─ non-Git → record validation + advisory handoffs → finish
               └─ Git → seal candidate → prepare artifacts → integrate target
                  ├─ conflict → publication repair → retry D integration
                  ├─ transient error → bounded retry or pause → R
                  ├─ permission / policy failure → halt → R after correction
                  └─ publish target → verify ref → cleanup → finish
                     └─ Epic child → X: next eligible child in a fresh Session
```

## P — Planner or Architect through Plan Review

```text
P0. Planner/Architect writes docs/plans/<name>.md
├─ prose says “ready” but no accepted plan_written → no planning completion
└─ T plan_written(planName, execution policy)
   ├─ missing file / reserved artifact name / invalid policy / failed prerequisite
   │  → tool returns correction/error; no accepted advancement event
   │  → agent may repair the file/arguments and call plan_written again
   └─ load Plan, establish identity and request Plan Review
      ├─ review cannot produce a decision
      │  ├─ U retry → reopen review
      │  └─ U decline/cancel → canceled or intentional end; no execution
      ├─ remote review handoff → T event(saved) → stop for external review
      ├─ stale review evidence → canceled; reload and review the current Plan
      ├─ U feedback → review_feedback → status feedback
      │  → T event(feedback), nonterminal tool result
      │  → same planning conversation revises → P0 / plan_written
      └─ U approval → review_approved → status approved
         ├─ executable Plan → readiness_passed → ready_for_work
         │  ├─ U run now → T event(approved_execute) → E0
         │  └─ U later → T event(saved) → stop; load-plan can execute later
         └─ PROJECT Epic → epic_readiness_passed → ready_for_decomposition
            ├─ U decompose → T event(approved_decompose) → X0
            └─ U later → ready_for_decomposition and returned saved result
               → GAP: this branch does not publish the saved event [audit A1]
```

The review interaction commits its decision through `applySharedPlanReviewDecision`, including the current document,
revision, status, worktree identity, and execution-policy checks. This is human approval, not an agent's interpretation
of review prose. Temporary execution-control changes in a feedback submission are not an approval.

`runPlanningAgent` awaits `runActiveAgentTurn`, then claims a `plan_written` event and passes its payload to
`decidePostPlanning`. No event gives `no_call`. The interactive root handler can notice an event before the turn ends;
its feedback branch instead lets the current planning turn continue and then looks for the later accepted Plan event.
These are different consumer paths, despite sharing the same tool.

Sources: [plan_written](../src/tools/plan-written.ts),
[shared review decision](../src/shared/workflow/plan-review-actions.ts),
[planning runner](../src/shared/workflow/planning-agent.ts),
[decision interpreter](../src/shared/workflow/decisions.ts), [root handler](../src/shared/session/agent-handler.ts).

## E — Execution preparation, implementation, and Pair checkpoints

```text
E0. executePlan reloads the authoritative saved Plan
├─ missing/unreadable Plan → recovery review
│  ├─ U retry/recover → reload; Planner may revise after review feedback
│  ├─ accepted approved_execute after revision → executePlan again
│  └─ cancel / save / remote-review handoff → intentional stop
├─ PROJECT Epic → reject direct execution; use X
├─ invalid execution policy / status other than ready_for_work → refuse execution
└─ C resolve execution owner and current host capability
   ├─ engineer policy → runtime Plan Engineer
   ├─ frontend-engineer policy → Frontend Engineer
   └─ Pair recommendation + capable host → Pair; otherwise autonomous

E1. startActiveExecutionWorkflow
├─ G no Git
│  ├─ no prior consent → U proceed in current files or cancel
│  └─ consent → transactional execution_started → in_progress, non_git_in_place
└─ G Git available
   ├─ locate reusable attempt; verify target, identity, checkout and saved evidence
   ├─ otherwise resolve intended targetBranch (standalone: repository default when absent)
   │  ├─ standalone Planned Change, auto-merge off → create/reuse plan/<plan-name> landing
   │  └─ auto-merge on or Epic/Sequence child → retain existing target behavior
   ├─ standalone: record targetBranch and deliveryBranch
   ├─ create worktree + registry entry against resolved landing
   ├─ materialize authoritative Plan and needed Epic family; capture baseline
   ├─ preparation/indexing/checkpoint failure → rollback or recovery-required pause
   └─ execution_started + preparation checkpoint → in_progress
      → dispatch execution owner in that checkout
      → managed execution may first roll to a new Session segment

E2. Agent implements
├─ tool-assisted research, edits, tests and allowed delegate_agent assistance
│  → remain in E2; these calls do not complete the parent workflow
├─ T pair_checkpoint (when enabled)
│  ├─ U continue → next implementation increment
│  ├─ U revise + feedback → revise increment → another checkpoint
│  ├─ U autonomous / unavailable capability → continue autonomously
│  └─ U stop/cancel → in_progress pause; no completion
├─ T record_plan_deviation (all execution styles, including restored Sessions and validation repairs)
│  ├─ U confirm + unchanged Plan revision → append ordered `planDeviations` entry to execution Plan
│  │  → replacement becomes effective Plan authority; restart after write recovers by tool-call identity
│  ├─ U cancel → original Plan requirement remains authority
│  ├─ loss before write / stale Plan revision / changed execution identity → no write; ask again against current Plan
│  └─ unsupported confirmation host → pause; no inferred approval
├─ ordinary final text / error / interruption without accepted task_completed
│  → unfinished; remain in_progress, later owner follow-up or R
└─ T task_completed
   ├─ execution not started / wrong owner / paused Pair → rejected, no completion
   ├─ final Pair checkpoint required
   │  ├─ U continue → accept completion
   │  ├─ U revise → revise; do not accept completion yet
   │  ├─ U autonomous / unavailable capability → call task_completed again later
   │  └─ U stop/cancel → pause without accepting completion
   └─ accepted → event + root completion receipt → E3

E3. finalizePlanImplementation
├─ absent/wrong execution identity or invalid state → stop for recovery
├─ missing execution Plan + provable recorded baseline → restore then retry
├─ implementation already recorded → idempotent completion handling
└─ transaction records implementation_finished, checkpoints worktree changes,
   and marks registry attempt completed
   ├─ commit/transaction fails → no validation; repairRequired/recovery pause
   └─ succeeds → implemented → validation supervisor → V1
```

`task_completed.message` is the execution report. It is not inspected for “pass”, “done”, blockers, or success language.
The tool's instructions tell the agent not to call while blocked; this is not a mechanical proof that all work was done.
Frontend preflight fields are reports/metrics, not independent browser-test evidence.

Execution runners and the managed semantic-repair continuation still await root-turn return before claiming completion.
Some also acknowledge before the next durable checkpoint. See audit A2 and A4; do not copy that order into new paths.

Sources: [Plan executor](../src/shared/workflow/plan-executor.ts),
[execution start](../src/shared/workflow/execution-start.ts),
[execution runner](../src/shared/workflow/engineer-runner.ts),
[implementation checkpoint](../src/shared/workflow/implementation-checkpoint.ts),
[task_completed](../src/tools/task-completed.ts), [Pair tool](../src/tools/pair-checkpoint.ts),
[Plan Deviation tool](../src/tools/plan-deviation.ts),
[runtime collaboration](../src/shared/workflow/execution-collaboration.ts).

## V0 — Validation owner and resume dispatch

```text
continueWorkflowValidation
├─ run Plans Doctor reconciliation
├─ S locate registered execution Plan and controller checkpoint
├─ same completion already settled / no runnable phase → no-op pause result
├─ live running owner → pause; do not start a second validation owner
└─ claim checkpoint with revision comparison; reload on bounded stale-write conflict
   ├─ implemented + mechanical phase → V1 mechanical
   ├─ implemented + validationPhase: semantic → V2 semantic
   ├─ legacy validated_ci → normalize to implemented + semantic phase
   ├─ reviewed → H, then D
   ├─ legacy validated with unfinished publication → reviewed → D
   └─ prior checkpoint awaiting_repair and no taskCompletionId
      → rebuild semantic-repair handoff
      ├─ saved Review Issues + repair generation → dispatch semantic repair
      └─ no semantic review state → validation_repair_evidence_missing
         → GAP: actual CI repair checkpoints also reach this branch [audit A3]
```

The engine reloads canonical state between phases. A checkpoint must not move a Plan backward past a phase already
recorded as passed. A phase returns an explicit continuation flag; a changed status, counter, or message alone does not
keep the loop running. `awaitingTaskCompletion`, `awaitingUserAction`, or no continuation means pause.

The engine bounds one call to 12 phase dispatches. The outer stable-boundary wrapper has a further bounded continuation
loop. Operational exceptions preserve state and, where requested, the pending completion claim. Stale Plan/controller
writes get bounded reload/retry; other exceptions produce a pause, not an inferred successful repair.

Sources: [supervisor](../src/shared/workflow/validation-supervisor.ts),
[engine](../src/shared/workflow/validation-engine.ts),
[checkpoint format](../src/shared/workflow/validation-checkpoint.ts),
[context resolution](../src/shared/workflow/validation-context.ts),
[execution identity validation](../src/shared/workflow/execution-context.ts).

## V1 — Mechanical validation and CI repair

```text
V1. Reload Plan/controller and resolve execution checkout
├─ invalid/missing execution evidence → validation_failed or operational pause
└─ G run execution checkout's verification_command from its exact project settings
   ├─ no configured command → U supply command → save and run
   │  └─ no answer → operational missing-information pause
   ├─ process operational error → typed retry/correction/pause/halt policy
   ├─ canceled → U Retry / Engineer follow-up / Stop
   │  ├─ Retry → V1
   │  ├─ follow-up → pause awaiting completion
   │  └─ Stop/cancel → pause
   ├─ exit code 0 → mechanical_validation_passed → implemented + validationPhase: semantic → V2
   └─ nonzero exit code
      ├─ fewer than 3 automatic repairs used
      │  → mechanical_validation_failed; persist count and implemented status
      │  → independent Reviewer-Feedback Engineer in execution checkout
      │  ├─ no accepted task_completed → pause, not success
      │  └─ T task_completed from this invocation → stop producer → V1
      └─ 3 repairs used and the final recheck still fails → U decision
         ├─ Retry after outside fix → V1; repair count is not reset by this choice
         ├─ Engineer follow-up + text → resume/rebuild last repair session
         │  ├─ T task_completed → V1
         │  └─ no tool / canceled input → pause
         └─ Stop → pause
```

The third repair receives a fresh CI run. There is no automatic fourth repair if that run fails. Passing CI resets the
CI repair counter. Repairing `.wld/settings.json` can change the command the next CI invocation runs: settings are
reloaded.

In live isolated repairs, `runValidationAgentUntilEvent` registers before dispatch, excludes earlier events, scopes by
invocation/session, then aborts and waits for the producer after the accepted completion. That is stronger than merely
returning a message with a tool name. Normal no-tool returns settle paused. Abrupt loss while the adapter has written
`awaiting_repair` has the separate recovery defect in V0.

Sources: [mechanical phase](../src/shared/workflow/validation-mechanical.ts),
[CI process adapter](../src/shared/workflow/validation-local-ci.ts),
[validation composition](../src/shared/workflow/validation.ts),
[isolated event runner](../src/shared/session/agent-workflow-step.ts),
[repair adapter](../src/shared/workflow/validation-session-adapter.ts).

## V2 — Semantic review, corrections, repair, and round limit

```text
V2. Resolve current Plan and diff
├─ non-Git execution → C skip semantic diff review → reviewed → H
├─ humanReviewDecision == changes_requested
│  → C return review authority to human after fresh CI → reviewed → H
├─ implementation diff required but absent / only Plan changes
│  → validation_failed → implemented; result failed, no automatic repair
├─ empty implementation diff allowed for this classification → C skip → H
└─ reviewable diff
   ├─ 3 rounds reached AND a last repair report exists → U decision
   │  ├─ “look again” → another review round
   │  ├─ “talk to repair engineer” → collect feedback; validation_failed
   │  │  ├─ T task_completed → V1 → round-limit decision again
   │  │  └─ no completion / cancel → pause
   │  ├─ “let me read changes” → force humanReviewMode always → H
   │  └─ Stop/cancel → pause with findings saved
   └─ run review round
      ├─ open ledger items exist → verification mode: findings and repair delta
      └─ no open items → discovery mode: broad review
         → independent Reviewer with one private manager reused for corrections
         ├─ provider operational error → bounded typed retry or pause/halt
         ├─ no accepted review_complete → protocol correction in same round
         ├─ no accepted review_diff evidence, except Claude trust path
         │  → protocol correction in same round
         ├─ prior open finding omitted → protocol correction in same round
         ├─ correction budget spent → pause; do not consume semantic round
         └─ T review_complete accepted and consumer checks pass
            ├─ approved == true → semantic_review_passed → reviewed → H
            └─ approved == false → apply findings to ledger; capture repair baseline
               → semantic_review_feedback → implemented
               → persist semantic round + awaiting_repair + repair generation
               ├─ managed handoff supported → new semantic-repair segment
               │  → Reviewer-Feedback Engineer → T task_completed
               │  → matching generation receipt → validation resume → V1
               └─ inline fallback → independent feedback-repair invocation
                  ├─ T task_completed → generation receipt → V1
                  └─ no completion → pause with saved findings
```

The review tool rejects `approved: true` with unresolved findings in the submitted array. The round consumer
additionally requires every previously open finding to be accounted for. Repair reports are claims shown to the next
Reviewer; they do not themselves close ledger entries. Advisories do not block approval.

Current broad-versus-focused selection depends on **open ledger items**, not a fixed “two full reviews” rule. The
automatic semantic limit is 3; explicit user “look again” can go beyond it. Protocol correction allows three corrective
retries after an initially incomplete response. Transient retries use a separate policy and do not spend semantic
rounds.

The diff gate currently proves that a `review_diff` event occurred, not that the reviewer read all relevant code. `list`
alone emits that event, and the Claude trust path can bypass it. See audit A5.

Sources: [semantic phase and round runner](../src/shared/workflow/validation-semantic.ts),
[review_complete](../src/tools/review-complete.ts), [diff tool](../src/shared/workflow/review-diff-tool.js),
[Review Issue ledger](../src/shared/workflow/review-ledger.ts),
[managed repair continuation](../src/shared/session/runtime/workflows.ts),
[repair receipt](../src/shared/workflow/validation-supervisor.ts).

## H — Human code review and human-feedback repair

```text
H0. Read saved decision and review mode
├─ already approved / skipped / not_required → D
├─ mode none → persist not_required → D
├─ mode ask, no prior changes_requested → U open / skip
│  ├─ skip → persist skipped → D
│  ├─ cancel / unsupported / unrecognized answer → pause; not a waiver
│  └─ open → H1
└─ mode always, or returning from human feedback → H1

H1. Request Code Review with current diff and Plan
├─ U approved → persist approved + timestamp → D
├─ U feedback / annotations / images
│  → persist changes_requested; validation_failed → implemented BEFORE repair
│  → independent Reviewer-Feedback Engineer receives human feedback
│  ├─ T task_completed → V1 → semantic skip-for-human rule → H1
│  └─ no completion / failure → pause; do not reopen over unfinished repair
└─ closed/no answer → U Retry / Stop
   ├─ Retry → H1 again
   └─ Stop/cancel → pause at human review
```

Guided-review explanations and review conversation text support the user's decision. They do not approve publication.
Conversation feedback takes the same invalidation/repair/recheck path as submitted feedback. The code does not impose an
automatic count limit on human-requested repairs.

Sources: [human review](../src/shared/workflow/validation-human-review.ts),
[final decision predicate](../src/shared/workflow/validation-context.ts),
[feedback repair](../src/shared/workflow/validation-semantic.ts).

## D — Delivery artifacts, target integration, publication, and cleanup

Publication is a separate loop. Its successful Git-backed phases are:

```text
candidate_sealed → artifacts_committed → target_integrated
  → target_published → publication_verified → cleanup_complete
```

Every arrow below identifies its trigger. Failure remains attached to the last recorded publication phase; it does not
automatically erase passing validation or go back to semantic review.

```text
D0. Enter publication under Plan lock, after H has a final decision
├─ non-Git / supported in-place path
│  → child QA preparation if relevant
│  → validation_passed with in-place evidence → verified
│  → advisory QA / Recorder handoffs → result verified; no merge
└─ worktree path
   ├─ target/attempt identity missing → pause/fail; no target movement
   ├─ S existing publication → reconcile recorded phase against Git
   │  ├─ cleanup_complete → prune remaining registry entry → finish
   │  ├─ publication_verified → cleanup
   │  └─ earlier phase → resume at that phase
   └─ no publication → G checkpoint execution checkout and read target head
      → S start publication record → candidate_sealed

D1. candidate_sealed → artifacts_committed
├─ Epic child with existing QA section → reuse section
├─ Epic child without section → Manual QA invocation
│  ├─ T qa_checklist_generated → validate/write section → ready
│  ├─ no accepted tool / rejected checklist → warn and continue without it
│  └─ operational failure → typed retry or blocked publication [audit A8]
└─ stage validation_passed in execution Plan → reviewed with candidate evidence
   → standalone QA + Recorder generation run concurrently
   ├─ T manual_qa_completed → present checklist
   ├─ T work_record_completed → accepted sections → save/reuse pending Work Record
   ├─ failure / missing completion → best-effort warning
   └─ retain supersession proposals for completion; preparation does not approve or index the record
   → G checkpoint artifacts with publication-attempt metadata
   → S artifacts_committed

D2. artifacts_committed → integrate target
├─ G execution checkout changed before integration → preserve old attempt; reset to implemented for fresh validation
├─ no resolvable upstream → local-target path
│  ├─ interrupted owned finalization → reconcile exact owned changes before dirty checks
│  ├─ unsaved tracked changes outside allowed Plan paths/owned .gitignore → block
│  ├─ unrelated staged Plan/owned-ignore changes → block
│  ├─ safely set aside allowed unstaged authoritative metadata
│  ├─ target checkout/ref safety checks → merge locally
│  ├─ failure → abort primary merge; restore owned set-aside files if target unmoved
│  │  → local conflict repair gap [audit A7]
│  └─ successful merge → finalize verified Plan and approved record metadata; commit
│     → callbacks record target_integrated then target_published
└─ resolvable upstream → isolated publication clone; primary checkout untouched
   ├─ fresh clone → fetch local target/execution and remote target
   │  → integrate remote target if missing → merge execution/artifact candidate
   └─ saved publication/repair clone
      ├─ unfinished merge → typed conflict → D-repair
      ├─ fetch newest remote target; if not already ancestor, merge it
      └─ fetch execution branch; include sealed artifact commit if absent
   → finalize verified Plan and approved record metadata; commit → S target_integrated

D3. target_integrated → target_published → publication_verified
├─ remote → G push with lease for the observed remote head
│  ├─ lease race / remote unavailable → typed bounded retry; re-read/integrate target
│  ├─ permissions / branch policy → halt until corrected
│  └─ push succeeds → S target_published
│     → G remote target contains finalized publication commit → S publication_verified
└─ local → G target contains finalized publication commit and candidate → S publication_verified

D4. cleanup
├─ G target no longer contains recorded publication commit → retain cleanup state
├─ retain permanent controller publicationReceipt and recording input
├─ synchronize approved Work Records to index; retain durable retry state on failure
├─ remove execution worktree without forced deletion
├─ delete execution branch only with publication/merge proof
├─ remove publication clone
├─ any cleanup failure → warn, retain registry, return successful verified result
└─ all cleanup effects complete → S cleanup_complete → prune registry → finish

D-repair. Failure in D
├─ transient → retry policy, then pause if spent; cancellation pauses immediately
├─ correctable content conflict + fewer than 2 repairs this invocation
│  → independent Reviewer-Feedback Engineer in typed repair checkout
│  ├─ no accepted task_completed → cannot claim repair success; recovery decision
│  └─ T task_completed → G no unmerged paths; finalize pending merge/repair commit
│     → retry D (NO normal CI/reviewer loop here) [audit A6]
├─ known user-fixable block → U Retry / Stop
│  ├─ Retry → normalize staged/unstaged/committed repair → retry D
│  └─ Stop/cancel → retain reviewed Plan, branch, clone and registry → R
├─ fatal permission/policy condition → failed result; preserve candidate
└─ other stage/bookkeeping failure → reconcile/retry where supported, otherwise pause
```

`resolveUpstream` uses configured target-branch upstream information, with `origin`/same-branch fallbacks. Therefore “no
explicit upstream configured” does not necessarily mean local publication. The local path is stricter about tracked
dirty files than an overlap-only rule: it rejects all tracked changes outside its allowlist.

The first implementation candidate is sealed **before** child QA. QA and Plan/Work Record changes are sealed in the
later artifact commit. Once `artifacts_committed` is recorded or recovered from commit metadata, retries skip completed
artifact handoffs. Before that boundary, prepared records are reused only when their saved source identity matches the
publication attempt. Interrupted finalization reconciles the owned Plan and Work Record changes; it does not adopt
unrelated edits or rerun Recorder for an already prepared record.

The saved remote repair path integrates the latest target before leased push. A lease protects ref replacement; ancestry
proves which history the integration contains. Neither proves that conflict resolution preserved behavior. Cleanup uses
ancestry: a legitimate later target commit does not invalidate confirmed publication.

Sources: [publication loop](../src/shared/workflow/validation-publication.ts),
[phase model](../src/shared/workflow/publication-attempt.ts),
[stored publication and reconciliation](../src/shared/workflow/publication-machine.ts),
[remote/local Git publication](../src/shared/isolated-publication.ts),
[repair dispatch/finalization](../src/shared/workflow/validation-merge-repair.ts),
[Git worktree operations](../src/shared/worktree.js),
[QA/Work Record handoffs](../src/shared/workflow/validation-helpers.ts),
[Recorder event consumer](../src/shared/work-records/generation.js).

## X — Epic decomposition and next-child continuation

```text
X0. Approved Epic → Slicer conversation
├─ agent/user discuss and revise child boundaries → remain in Slicer
└─ T slicer_finalize_decomposition(children?, confirmation)
   ├─ blank confirmation / wrong Epic status / invalid children → reject
   ├─ child writes or transaction fail → restore owned writes or recovery pause
   └─ children exist + writes succeed → decomposition_finalized → ready_for_work
      → remain available for child selection (not automatic first-child execution)
      → U load-plan Epic → choose child → P/E/R according to child state

X1. Child workflow returns verified after D
├─ not an executable child with parentPlan → no Epic continuation
├─ parent missing/held/terminal/done-enough → no continuation
└─ C inspect children in canonical order; skip terminal-status children
   ├─ none left → no next child; parent completion handled by lifecycle logic
   └─ earliest remaining child
      ├─ on_hold → blocked
      ├─ in_progress / failed / implemented → recovery required; blocked
      ├─ dependency missing/not satisfied → blocked
      ├─ other unsupported state → blocked; do not skip ahead
      └─ eligible → finish old Session handoffs and create fresh Session
         ├─ draft / feedback → P with Planner
         ├─ approved → readiness_passed → E
         └─ ready_for_work → E
            → child's own V/H/D; save-for-later stops the automatic chain
```

Slicer finalization performs its transaction directly inside the tool; it does not need a terminal-event consumer. Its
`confirmation` is a nonempty agent-supplied string, not an independently collected user approval receipt. This is
another place where “called a tool” and “proved user authorization” have different meanings.

Child QA is stored in the Epic's `manual-qa.md`. A child does not receive its own auto-generated Work Record; terminal
parent resolution can produce the Epic record. Explicit `epic_done_enough` sets the completion mode and
`closed_without_verification`; it does not prove merge or review. A branchless parent may complete after every included
child is delivered. An Epic with a branch stays reviewed after its integration gate until its checked commit reaches the
recorded final target; `epic_publication_confirmed` then records verified.

Sources: [Slicer tool and runner](../src/shared/workflow/workflow-slicer.ts),
[child selection](../src/cmd/load-plan/plan-epic-flow.ts),
[continuation resolver/runner](../src/shared/workflow/epic-continuation.ts),
[Session continuation](../src/shared/session/runtime/workflows.ts),
[parent lifecycle handling](../src/shared/workflow/plan-lifecycle.js),
[auto-generation selection](../src/shared/work-records/auto-generation.ts).

## O — Shared operational failure and retry branches

V1, V2, child QA preparation, and D use this typed policy where their adapters report an operational error. CI test
failures and Reviewer findings use their own repair loops above. The no-plan Q loop stops on operational failure.

| Classified input                                                                                                                                                                 | Controller choice and next transition                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider rate limit, timeout, network failure, unavailable service; Git target-ref race or unavailable remote                                                                    | `transient` → retry the same operation after a cancellable delay; disabled/spent retry budget → pause at that phase.                                       |
| Missing `review_complete`, unread diff, unaccounted findings, invalid reviewer arguments                                                                                         | `correctable` → nudge the same Reviewer; after the protocol correction limit → pause. Does not approve or repair implementation.                           |
| Git content conflict                                                                                                                                                             | `correctable` → D-repair, with its separate maximum of two Agent repairs per publication invocation.                                                       |
| Missing command, process start/supervision failure; missing Plan/registry/checkout; dirty primary checkout; provider authentication                                              | `missing_information` → pause with required user action; after correction, explicit resume retries that phase.                                             |
| Missing optional review entity with supplied correction instructions                                                                                                             | `missing_information` with correction → return `correct`; caller chooses the correction behavior. This policy branch itself has no correction-count check. |
| Post-publication bookkeeping failure                                                                                                                                             | `missing_information` → reconcile saved publication and Git evidence on retry; do not invent a new implementation success.                                 |
| Provider permission denial or unclassified legacy provider error; unknown Plan status; Git permission/policy denial; prohibited action/lifecycle invariant/access policy failure | `fatal` → halt this invocation with a failed result; preserve owned work for later recovery after the cause is corrected.                                  |
| User cancels a retry delay                                                                                                                                                       | Stop waiting and return paused; do not dispatch the next operation.                                                                                        |
| User-choice surface unavailable, canceled, or returns an unrecognized value                                                                                                      | Standard Retry/Stop interaction resolves to Stop; it does not retry unattended.                                                                            |

`retry.maxRetries` defaults to 3, but the implementation compares the **current attempt** against it. In these
attempts-start-at-one loops that means at most three attempts total, not three retries after the first attempt. The
delay uses bounded jitter with a 2-second default base and 60-second default cap, or a valid bounded Retry-After.
Protocol correction has a separate limit of three corrections. User-requested retries and repair loops have the
different limits stated in V1/V2/H/D; do not treat these counters as interchangeable.

Sources: [error classification](../src/shared/workflow/validation-operational-errors.ts),
[recovery decisions and delay](../src/shared/workflow/validation-recovery.ts),
[user choice](../src/shared/workflow/validation-interactions.ts).

## R — Loading, recovery, hold, and explicit exits

These are command/user paths. None needs to invent a missing agent completion from a transcript.

| Entry or choice                                          | Transition and destination                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load draft/feedback                                      | Continue Planner/Architect, or direct review if eligible; then P. Direct review uses the structured review result directly and does not require `plan_written`.            |
| Load approved/ready Plan                                 | User can execute, review, defer/hold, inspect, or cancel. Approved execution first records readiness. Affected-path drift can require confirmation.                        |
| Load in_progress/failed                                  | Recovery menu resolves worktree and journals; continue records `recovery_continue` to ready_for_work and returns through E; reset uses `recovery_reset`.                   |
| Load implemented/reviewed (including legacy equivalents) | Resume validation through V0 at its saved phase; no repeat initial implementation completion required.                                                                     |
| Load reviewed with publication record                    | Publication recovery/cleanup takes precedence over completion menus; resume D from saved evidence.                                                                         |
| Follow-up after implementation                           | Create the bounded follow-up planning/execution flow through the load-plan recovery action; this is an explicit choice, not automatic repair success.                      |
| Inspect / restore record / settle records                | Read-only inspection or deterministic registry/journal recovery from current evidence; return to recovery menu or reloaded state.                                          |
| Missing execution worktree                               | Restore only a provable attempt; otherwise stop-lost/abandon/review choices preserve or explicitly dispose of the attempt. No guessed checkout.                            |
| Hold                                                     | `plan_held` stores heldFromStatus/reason/baseline; status on_hold.                                                                                                         |
| Resume hold                                              | Run current evidence/staleness checks; failure stays held, warning needs a user choice, success `hold_resumed` restores the permitted saved status and re-enters its flow. |
| Reset held Plan                                          | Explicit reset decision, with optional attempt abandonment, records `hold_reset_to_draft`; return to planning.                                                             |
| Reopen review                                            | `review_reopened` moves to feedback and detaches/abandons the old execution association where required; P again.                                                           |
| Abandon / reset                                          | Explicit recovery action uses owned Git/registry/lifecycle operations; outcome can be committed, rolled back, blocked, or needs recovery. It is not validation success.    |
| User Verified                                            | Required user note + `manual_user_verified` → user_verified. No automatic CI, semantic approval, or publication proof is asserted.                                         |
| Close without verification                               | Explicit canonical action + reason → closed_without_verification. Does not claim CI/review/publication.                                                                    |
| Epic done enough                                         | User choice + lifecycle event → closed_without_verification with done-enough mode; may generate Epic Work Record.                                                          |
| Archive/restore                                          | Explicit storage/history action with eligibility/recovery checks; no new validation or merge.                                                                              |
| Cancellation / agent switch                              | Pause/release runtime ownership while retaining durable evidence; `/load-plan` reconstructs the next action.                                                               |

Source: [load-plan dispatcher](../src/cmd/load-plan/index.ts),
[direct review](../src/cmd/load-plan/plan-review-flow.ts),
[readiness/execution actions](../src/cmd/load-plan/plan-execution.ts),
[recovery menu](../src/cmd/load-plan/plan-recovery-flow.ts),
[recovery actions](../src/cmd/load-plan/plan-recovery-actions.ts), [reset](../src/cmd/load-plan/plan-recovery-reset.ts),
[hold](../src/cmd/load-plan/plan-hold.ts), [canonical actions](../src/shared/workflow/plan-actions.ts).

Direct review is available for draft, feedback, approved, and ready-for-work Plans with a valid execution policy,
including Plans without custom shell checks. The old automatic Plan Amendment approval gate has been removed from the
active validation code.

## Q — No-plan Quick Fix side branch

Accepted Engineer `task_completed` starts `runMechanicalValidation`. It runs local CI, accepts success only from exit
code zero, and allows up to three independent Engineer repairs. Each repair requires its own accepted `task_completed`
before CI is rerun. Cancellation, operational failure, missing completion, or spent budget stops the run. Success
attempts advisory `manual_qa_completed` checklist generation. There are no Plan status writes, semantic review, human
code-review gate, worktree publication, or automatic merge. Its counters are invocation-local; it is not the durable
saved-Plan recovery model.

Sources: [routing and initial completion](../src/shared/workflow/orchestrator.ts),
[Quick Fix loop](../src/shared/workflow/validation-helpers.ts),
[later root completion](../src/shared/session/agent-handler.ts).

## Tool and backend coverage

| Boundary                 | Accepted input and actual effect                                           | Consumer / caveat                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing                  | `triage_report` validates intent and publishes event                       | Root handler → intent dispatcher.                                                                                                           |
| Planning                 | `plan_written` publishes review outcome after prerequisite writes          | Planning runner, interactive handler; Epic-later event omission is A1.                                                                      |
| Implementation/repair    | `task_completed` publishes event; root also has completion receipts        | Initial execution, later root turns, managed repair segment, isolated repair adapter; timing and acknowledgement differ.                    |
| Reviewer evidence        | `review_diff` accepted list/show publishes evidence event                  | Semantic consumer checks presence; it does not prove complete reading.                                                                      |
| Reviewer decision        | `review_complete` publishes accepted approval/findings                     | Isolated event runner → protocol/ledger checks → semantic phase.                                                                            |
| Child QA                 | `qa_checklist_generated` writes artifact, then publishes                   | Isolated owner stops producer on event; missing call has advisory fallback.                                                                 |
| Standalone/Quick Fix QA  | `manual_qa_completed` validates/presents checklist and publishes           | Event-gated best-effort handoff. This is checklist generation, not proof a human performed QA.                                              |
| Work Record              | `work_record_completed` validates structured sections and publishes        | Recorder consumer saves artifact; generation failure does not revoke validation.                                                            |
| Slicer                   | `slicer_finalize_decomposition` owns transaction directly                  | No transcript/event extraction needed; confirmation is an agent claim.                                                                      |
| Pair                     | `pair_checkpoint` owns explicit interaction and runtime state directly     | Increment approval is not task completion. Final task completion has a separate Pair gate.                                                  |
| Interview                | `user_interview` owns structured question/answer interaction               | Continues current agent; does not approve a Plan or finish implementation.                                                                  |
| Init                     | `init_save_verification_command` writes settings and exposes saved command | Direct operation state; no Plan lifecycle transition. “Verification not implemented” can deliberately save a zero-exit placeholder command. |
| Delegation               | `delegate_agent` returns bounded child assistance                          | Child tool permissions exclude parent workflow controls; its prose return cannot finish the parent's Plan.                                  |
| Pi                       | Actual tool implementations publish events                                 | Root consumers sometimes rely on turn return/`terminate`; mixed tool batches expose A2.                                                     |
| Claude CLI               | MCP aliases execute the same actual tools                                  | Bridge terminal flag blocks later lifecycle calls, but permits capability calls; root paths are not uniformly stopped at acceptance.        |
| TUI / Workspace / ACP    | UI decisions and SessionRuntime/shared workflow calls                      | Presentation is not validation authority; Pair requires host support. No separate transcript-based success decoder was found here.          |
| Attached / AGY proposals | Not an implemented planner-to-merge path in this inspected code            | Design Plans and backend spikes do not establish operational coverage. Re-audit when wired into production.                                 |

Sources: [tool events](../src/shared/workflow/workflow-tool-events.ts),
[Claude MCP bridge](../src/shared/session/backends/claude-cli/mcp-bridge.ts),
[Claude execution](../src/shared/session/backends/claude-cli/execution-session.ts),
[delegation](../src/tools/delegate-agent.ts), [interview](../src/tools/user-interview.ts),
[Init command](../src/tools/init-verification-command.ts).

## Maintaining this map

For a workflow addition, trace the producer, acceptance checks, direct effect/event, owning consumer, next durable
write, acknowledgement, producer shutdown, and restart destination. Add both successful and paused branches here.
Specify whether the branch reruns CI/review or intentionally reuses earlier validation.

Test a real tool call through each affected entry path, including a producer that remains active after acceptance,
another tool in the same batch, no completion tool, wrong invocation, rejected arguments, and interruption at the
**actual state written by the adapter**. For publication, test changed remote heads and conflicts in the real repair
checkout. Checking that a returned message contains a tool name cannot establish any of these properties.

Keep current mechanics here and date-specific failures in the audit. Update the audit date/commit after source changes;
do not mark the linked task resolved from this document alone.
