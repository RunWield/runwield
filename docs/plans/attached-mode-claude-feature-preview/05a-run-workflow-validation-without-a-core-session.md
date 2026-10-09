---
planId: "801100d6-b19e-44d7-aa38-1cc12956824b"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/validation-supervisor.ts"
    - "src/shared/workflow/validation-engine.ts"
    - "src/shared/workflow/validation-ports.ts"
    - "src/shared/workflow/validation-types.ts"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/shared/workflow/validation-mechanical.ts"
    - "src/shared/workflow/validation-recovery.ts"
    - "src/shared/workflow/validation-checkpoint.ts"
    - "src/shared/workflow/validation-session-adapter.ts"
    - "src/shared/workflow/validation-local-ci.ts"
    - "src/shared/workflow/validation.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/workflow/epic-integration.ts"
    - "src/shared/workflow/review-diff-tool.js"
    - "src/shared/workflow/review-inspection.ts"
    - "src/tools/review-complete.ts"
    - "docs/validation-authority.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-09T04:28:01.000Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 5
dependencies:
    - "04-implement-approved-plans-in-runwield-worktrees"
targetBranch: "epic/attached-mode-claude-feature-preview"
---

# Run Workflow Validation without a Core Session

## Context

Child 04 leaves an Attached Workflow at `implemented`: the Plan is `implemented`, the worktree checkpoint is saved, and
the registry entry is completed. The next step is Workflow Validation, which Claude must drive with its own workers.

The validation policy is already Session-independent. The parts around it are not. Four things still tie Workflow
Validation to a Core `HostedSession`:

```text
continueWorkflowValidation (validation-supervisor.ts)   # reads hostedSession; imports validation.ts (Session composition)
  └─ runValidationLoop (validation-engine.ts)           # policy: Session-independent
       ├─ localCI.run → runLocalCI                      # requires hostedSession (missing-command prompt, output events, cancel)
       ├─ reviewer round                                # passes Pi tools + a Pi SessionManager; nudges in-process
       ├─ CI repair / follow-up repair                  # awaits a Pi repair Agent until task_completed
       ├─ user decisions (round limit, CI exhaustion)   # awaits a Session interaction
       └─ retry waits                                   # sleeps in-process
```

Durable state is already strong. The Plan's Validation Checkpoint holds the attempt, generation, next phase, repair
generation, the consume-once repair receipt, and the review state (round, Review Issue Ledger, repair baseline, last
repair report). Semantic repair already has a hand-off form (`semantic_repair_handoff`) that resumes through the
supervisor on `task_completed`. What is still process-local: the reviewer's in-memory Pi session, in-process nudges,
pending-repair session maps, retry timers, and diff-inspection coverage.

Main changed the lifecycle before this Plan. During validation the Plan stays `implemented` with a `validationPhase`
marker (`mechanical` → `semantic`). A passed Semantic Review moves it to **`reviewed`**, which replaced
`validated_reviewer`. The engine also writes local delivery evidence receipts (`ci`, `ai`, `ai-skip`, `ci-repair`,
`ai-repair`) through `recordDeliveryEvidence`.

This child is a shared Core change with no change to Core Session behavior. It serves the target outcome in
[Connect: Shared Plan and verification outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes)
and keeps the requirements in
[Core: Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) and
[Core: Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair) unchanged. The Claude
journey that uses it is child 05.

Decisions from planning:

1. **Split.** The shared Session-independent validation work is this child. The Attached validation journey stays in
   child 05.
2. **Core observes the reviewer's diff inspection.** In child 05 the Claude reviewer worker calls a RunWield MCP
   `review_diff` operation directly. This child supplies the host-neutral diff reader and lets a caller pass recorded
   coverage back to the engine. The engine checks that coverage against the actual diff. A host's coverage claim never
   replaces observed reads.
3. **One completion signal.** Child 05 generalizes `task_completed` to every completion-gated pending action, the same
   way Core uses it. This child makes sure every repair kind resumes through the supervisor's consume-once
   `task_completed` path, not through an in-process wait.

### Epic Scope Changes

- `05-validate-with-claude-owned-review-and-repair-workers` — now depends on this child and owns only the Attached
  journey: record states, coordinator operations, MCP `review_diff`, plugin commands, and Connect documentation. It
  moved from order 5 to order 6. The shared supervisor, local CI, engine wait, and contract extraction work moved here.
- `06-publish-validated-work-and-record-the-outcome` — order 6 → 7. No scope change.
- `07-prove-and-document-the-supported-claude-preview` — order 7 → 8. No scope change.

## Objective

A caller without a `HostedSession` can run Workflow Validation for an `implemented` Plan through the same supervisor and
engine as Core Sessions. Every wait for an Agent or the user becomes a typed request returned to the caller. A fresh
process resumes from the Validation Checkpoint and the caller's accepted outcome, without repeating settled effects. The
run ends at `reviewed`, before the delivery phase. Core Session validation behaves exactly as it does today.

## Approach

The supervisor stops depending on the Session composition. Each entry point gives it a way to build engine arguments,
and both entries share the same claim, engine, and settlement code:

```diff
 validation-supervisor.ts
-  import { createEngineValidationArgs, runValidationLoop } from "./validation.ts"
-  continueWorkflowValidation(args with hostedSession)
+  runValidationAttempt({ projectRoot, planName, buildEngineArgs, trigger, taskCompletionId? })
+    claimValidation → runValidationLoop(buildEngineArgs(claim)) → settleValidation

 validation.ts (Session composition)
+  continueWorkflowValidation(args with hostedSession)
+    → runValidationAttempt({ ..., buildEngineArgs: port over HostedSession })   # behavior unchanged

 validation-host-turn.ts (new)
+  continueHostTurnValidation({ projectRoot, planName, resume? })
+    → runValidationAttempt({ ..., buildEngineArgs: host-turn port })
+    → HostTurnValidationResult
```

The host-turn port implements `ValidationSessionPort` without a Session. It changes only how each wait ends:

| Wait                                                           | Core Session (unchanged)                              | Host-turn mode                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI repair, Engineer follow-up repair, semantic repair          | In-process repair Agent until `task_completed`        | Repair request with repair prompt and the checkpoint's repair generation. Checkpoint stays `awaiting_repair`. Resume through the existing consume-once `task_completed` path. |
| Reviewer round                                                 | In-process Pi reviewer, nudged in the same Pi session | Reviewer request with prompt, review mode, and round identity. Resume supplies the accepted `review_complete` outcome and recorded diff coverage.                             |
| User decision (round limit, CI exhaustion, missing CI command) | Session interaction prompt                            | Decision request with the options. Resume supplies the chosen option, and the accepted choice is saved in the checkpoint.                                                     |
| Operational retry wait                                         | In-process sleep, cancellable                         | Pause with the recovery message. The caller retries later.                                                                                                                    |

```ts
type HostTurnValidationResult =
    | { kind: "host_request"; request: ValidationHostRequest } // reviewer | repair | decision
    | { kind: "awaiting_delivery"; planName: string } // Plan is `reviewed`; child 06 continues
    | { kind: "paused" | "failed"; reason: string; recovery?: ValidationRecoveryResult };
```

The exact type names are the Engineer's choice. The shape is not: one result union, one request union, and one resume
input keyed to the request identity.

### How a reviewer round resumes

Before the reviewer wait, the semantic phase reads canonical state: the Plan, checkpoint review state, Git diff, and
Epic context. It writes in only one place, the round-limit decision, and host-turn mode saves that decision in the
checkpoint before the reviewer request. So a fresh process can re-enter the phase and reach the same wait. The round
identity binds the outcome to that wait:

```text
round identity = attemptId + generation + semanticRound + reviewMode + correctionCount
                 + hash(full diff, repair diff)

resume(reviewer outcome, identity, recorded coverage spans)
  if identity ≠ the identity the engine computes now → reject; record nothing
  rebuild ReviewInspection from the recorded spans, checked against the actual diff files and scope
  apply the existing gates: incomplete inspection, diff not read, unaccounted findings, missing review_complete
  rejected → new reviewer request with the correction text; correctionCount + 1 is in its identity
  accepted → applyRoundFindings, lifecycle event, delivery evidence, next wait
```

The correction count is part of the identity, so a caller cannot reset the correction limit. A resume that sends a lower
count does not match. The engine's `decideValidationRecovery` sees the true number of corrections across processes.

### Where tools are built

Engine requests stop carrying Pi objects. The engine passes the diff text and inspection requirements. Each adapter
builds its own executable tools:

```diff
 IsolatedAgentSessionRequest (reviewer, integration reviewer, manual QA)
-  customTools: OpaqueToolDefinition[]
-  sessionManager: SessionManagerHandle
+  review: { fullDiff: string; repairDiff: string; requiredScope: "full" | "repair"; inspection: ReviewInspection }
 ValidationSessionPort
-  createInMemorySessionManager(cwd)
```

The Session adapter creates the per-round Pi `SessionManager` and the Pi `review_diff` / `review_complete` /
`qa_checklist_generated` tools, as it does today. It keeps one session across a round's nudges and creates a new one for
each round. The diff paging and the `review_complete` payload rules become pure shared modules. Child 05 uses them for
its MCP operations.

> [!TIP]
> **Why not a second validation loop**
>
> Repairs already hand off through the checkpoint, and the semantic phase can re-enter up to the reviewer wait. A typed
> request plus resume input reuses every existing gate. A separate loop for the host would copy review-round,
> repair-limit, and convergence policy, and the Epic forbids that. The parity test in the Verification Plan fails if the
> two entries drift.

The option set aside: rewrite each phase as an explicit step machine. That makes every wait a resumable step, but it
changes Core Session control flow in many places for no user-visible gain.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/validation-supervisor.ts` — one attempt runner parameterized by an engine-arguments builder;
  claim and settlement no longer read `hostedSession`; no import of `validation.ts`.
- `src/shared/workflow/validation.ts` — the Session entry point (`continueWorkflowValidation`) composes the Session port
  and calls the attempt runner.
- `src/shared/workflow/validation-host-turn.ts` (new) — the host-turn entry point and host-turn port.
- `src/shared/workflow/validation-ports.ts`, `validation-types.ts` — remove the opaque Pi handles and
  `createInMemorySessionManager`; add the host request, resume input, and host-turn result types.
- `src/shared/workflow/validation-semantic.ts`, `validation-checkpoint.ts` — reviewer rounds consume a supplied outcome
  by identity; the round-limit decision is saved in the checkpoint.
- `src/shared/workflow/validation-mechanical.ts` — CI repair and Engineer follow-up hand off in host-turn mode instead
  of awaiting a repair Agent.
- `src/shared/workflow/validation-recovery.ts` — retry waits do not sleep in host-turn mode.
- `src/shared/workflow/validation-session-adapter.ts`, `epic-integration.ts`, `validation-publication.ts` — build Pi
  tools and per-round session managers from the new request shape. These are the callers that use the removed handles
  today. Session, Epic integration review, and Manual QA behavior are unchanged.
- `src/shared/workflow/validation-local-ci.ts` — a Session-free command runner; `runLocalCI` keeps its Session prompt,
  events, and cancellation on top of it.
- `src/shared/workflow/review-diff.ts` (new), `review-diff-tool.js` — pure diff parsing, listing, paging, and coverage
  spans move to the new module; the Pi tool wraps it.
- `src/shared/workflow/review-outcome.ts` (new), `src/tools/review-complete.ts` — pure `review_complete` normalization
  and Review Issue Ledger checks; the Pi tool wraps them.
- `src/shared/workflow/review-inspection.ts` — rebuilt from recorded spans, rejecting spans outside the actual diff.
- Tests that construct reviewer requests with the old handles (`review-contract.test.ts`,
  `src/shared/session/agy-cli-execution.test.ts`) — rewrite them against the new request shape; do not delete them.
- `docs/validation-authority.md`, `docs/domain-language.md` — host-turn continuation as a typed input and the updated
  Session-Independent Validation Engine definition.

Deliberately unchanged: `src/shared/attached/` and `src/attached/claude/` (child 05), the delivery phase and publication
behavior (child 06), and Plan Lifecycle events and their meaning.

## Reuse Opportunities

- `claimValidation` / `settleValidation` and the owner PID claim — the only concurrency guard for a validation attempt.
- `recordValidationRepairCompletion` and `rebuildSemanticRepairHandoff` — the existing consume-once repair resume.
- The `semantic_repair_handoff` result and `supportsSemanticRepairHandoff` — the pattern the CI repair hand-off follows.
- `makeValidationCheckpoint`, `readValidationReviewState`, `normalizeLedger`, `applyRoundFindings`,
  `unaccountedOpenItems` — durable round state and ledger rules.
- `decideValidationRecovery` and `readValidationRetryPolicy` — the correction and retry limits.
- `recordDeliveryEvidence` — Core-written receipts that tests use as proof that Core ran each check.
- `src/shared/attached/execution-boundary.test.ts` — the source check and the fake `claude`/`pi` executables that prove
  no model process starts.
- `defineGitFixture` and `makeValidationProjectRoot` — real environments for the new tests.

## Implementation Steps

1. `validation-supervisor.ts` exports one attempt runner. It takes the project root, Plan name, trigger, optional task
   completion ID, and a function that builds engine arguments from the claim. It contains the claim, repair-handoff
   rebuild, engine call, settlement, and stale-write retry that `continueValidationAttempt` contains today. It does not
   import `validation.ts`, `validation-session-adapter.ts`, or `hosted-session.js`. `continueWorkflowValidation` in
   `validation.ts` calls it with the Session port. The existing supervisor, resume, and self-healing suites pass without
   assertion changes.
2. `src/shared/workflow/validation-local-ci.ts` exports a Session-free validation command runner. It reads
   `verification_command` with the given settings policy, runs it, and returns the existing `LocalCIResult` kinds plus a
   `command_missing` result. `runLocalCI` uses it and keeps its Session prompt, output events, and cancellation. The
   existing local CI tests pass unchanged.
3. `ValidationSessionPort` has no `createInMemorySessionManager`. No request type contains `OpaqueToolDefinition` or
   `SessionManagerHandle`, and both types are removed. Reviewer, integration reviewer, and Manual QA requests carry
   their data, not tool objects. `validation-session-adapter.ts` builds the Pi tools. It also builds one Pi
   `SessionManager` per reviewer round, reused across that round's nudges and new for the next round.
   `epic-integration.ts` and `validation-publication.ts` use the new request shape.
4. `src/shared/workflow/review-diff.ts` exports diff parsing, file listing, byte-bounded page reads, and coverage spans.
   Its module graph contains no `@earendil-works/*`, `review-diff-tool.js`, or `hosted-session.js`.
   `review-diff-tool.js` contains only the Pi tool definition and event publishing, and calls `review-diff.ts`.
5. `src/shared/workflow/review-outcome.ts` exports the `review_complete` payload normalization and the ledger identity
   checks (`fix_confirmed`, `fix_rejected` with reason, unknown or renumbered IDs, approval with open findings). Its
   module graph contains no `@earendil-works/*`, `src/tools/review-complete.ts`, or `hosted-session.js`.
   `src/tools/review-complete.ts` calls it and contains no copy of those rules. The tool keeps its incomplete-inspection
   rejection.
6. `ReviewInspection` can be rebuilt from recorded `{ scope, path, start, end }` spans. A span whose path is not in the
   diff, whose scope differs from the required scope, or whose range exceeds the file's diff length makes the rebuild
   fail. A valid rebuild gives the same `unread()` and `feedback()` as an inspection that recorded the same reads live.
7. `src/shared/workflow/validation-host-turn.ts` exports `continueHostTurnValidation` (or an equivalent name). It calls
   the step 1 attempt runner with the host-turn port. The module and its port contain no calls to `runValidationLoop`
   (except through the attempt runner), `applyRoundFindings`, `unaccountedOpenItems`, `decideValidationRecovery`,
   `recordLifecycleEvent`, `recordDeliveryEvidence`, or the CI command runner. They also contain no `new HostedSession`,
   `new AgentSession`, `createAgentSession`, or `createValidationSessionPort`. It returns one host request,
   `awaiting_delivery`, or a paused or failed result. When the next phase is delivery, it returns `awaiting_delivery`
   without running that phase.
8. In host-turn mode, a CI failure under the repair budget records `mechanical_validation_failed` and the CI delivery
   evidence. It then returns a repair request. The request carries the repair prompt, the execution directory, the role
   (`reviewer-feedback-engineer`), and a repair generation equal to the saved `awaiting_repair` checkpoint's
   `repairGeneration`. A semantic feedback round returns the same kind of repair request, built from the existing
   semantic repair hand-off. Engineer follow-up after CI exhaustion returns a repair request with the user's text and
   the durable repair context, the way the fresh-process branch of `continueLastRepairTurn` builds it today.
9. Resuming with `task_completed` for the saved repair generation goes through `recordValidationRepairCompletion` or the
   mechanical equivalent. It claims ledger fixes for semantic repairs and reruns the configured CI command. A second
   resume with the same completion runs no CI and writes no new evidence. A completion with another repair generation is
   rejected, and the checkpoint does not change.
10. In host-turn mode, a reviewer wait returns a reviewer request with the prompt, review mode, and round identity
    (Approach). A resume input with a matching identity, an outcome accepted by `review-outcome.ts`, and coverage spans
    goes through the existing gates: incomplete inspection (from the rebuilt `ReviewInspection`), diff not read,
    unaccounted findings, and missing outcome. A rejection returns a new reviewer request with the correction text and
    the incremented count in its identity. Acceptance records the same lifecycle events, ledger changes, delivery
    evidence, and metrics as a Session round. A resume input with any other identity is rejected. It changes no Plan
    events, checkpoint review state, repair generation, delivery evidence, or metrics. Settlement may only restore the
    checkpoint's claim fields.
11. In host-turn mode, the round-limit prompt, the CI exhaustion prompt, and a missing validation command each return a
    decision request with the same options and text the Session prompt shows. A resume input with one of those options
    takes the same branch as the Session answer. The accepted round-limit choice is saved in the Validation Checkpoint,
    so re-entering the phase for that round does not ask again. An answer for a missing command is saved through the
    existing settings writer.
12. In host-turn mode, operational retry waits do not sleep. The run pauses with the `decideValidationRecovery` message,
    and a later call resumes from the checkpoint. Correction and retry limits give the same decisions as in a Session.
13. `docs/validation-authority.md` lists the host-turn resume input as a typed input to the supervisor. The input
    carries the request identity, outcome, coverage spans, decision, and repair completion. Like a Session report, it
    can only move validation through the existing gates. `docs/domain-language.md` updates **Session-Independent
    Validation Engine** to say that the supervisor and local CI are Session-independent too, and that a runtime without
    a Session gets typed requests instead of in-process waits. Neither document claims that the Attached validation
    journey has shipped.

## Verification Plan

- Automated, focused:
  `deno run -A scripts/run-tests.js src/shared/workflow/validation-host-turn.integration.test.ts src/shared/workflow/validation-host-turn-parity.test.ts src/shared/workflow/review-diff.test.ts src/shared/workflow/review-outcome.test.ts src/shared/workflow/architecture-boundary.test.ts`.
- Automated, protected Session behavior:
  `deno run -A scripts/run-tests.js src/shared/workflow/validation-loop-core.test.js src/shared/workflow/validation-loop-review.test.js src/shared/workflow/validation-loop-repair.test.js src/shared/workflow/validation-loop-human-review.test.js src/shared/workflow/validation-loop-delivery.test.js src/shared/workflow/validation-ci-recovery.test.js src/shared/workflow/validation-repair-resume.integration.test.ts src/shared/workflow/validation-self-healing.integration.test.ts src/shared/workflow/validation-tool-continuation.integration.test.ts src/shared/workflow/validation-lifecycle-resume.test.js src/shared/workflow/validation-local-ci.test.ts src/shared/workflow/validation-manual-qa.test.ts src/shared/workflow/validation-publication.test.ts src/shared/workflow/epic-integration.test.ts src/shared/workflow/review-contract.test.ts src/shared/workflow/review-diff-tool.test.js src/shared/session/agy-cli-execution.test.ts src/tools/ src/shared/attached/`.
- **Red-to-green host-turn test** (`validation-host-turn.integration.test.ts`). It uses a real Git worktree fixture, a
  real `implemented` Plan, and a real `verification_command` script that fails until a marker file exists. Each step
  runs in its own `deno` subprocess with `--deny-net`, with fake `claude` and `pi` executables first on `PATH` that
  write a marker if started (as in `execution-boundary.test.ts`). After each step the test checks that no file changed
  outside the Plan, worktree, delivery evidence, metrics, and settings. This catches state kept in a hidden sidecar
  file.
  1. Start: Mechanical Validation runs the real command, records `ci` evidence, and returns a CI repair request. Its
     repair generation equals the checkpoint's `repairGeneration`, and the checkpoint is `awaiting_repair`.
  2. Resume with `task_completed` for a different generation: rejected, and the checkpoint bytes do not change.
  3. The test creates the marker in the worktree and resumes with `task_completed` for the right generation. CI reruns
     and passes, and the run returns a discovery reviewer request. Repeating this completion runs no CI, writes no `ci`
     evidence, and returns the same reviewer identity.
  4. Resume with an outcome but no coverage spans: the result is a reviewer request with the "diff not read" correction
     and an identity whose correction count is 1. No lifecycle event is recorded.
  5. Resume with spans that cover half of one file: the result is a correction naming the unread bytes. Resume with
     spans for a path that is not in the diff: rejected.
  6. Resume with an identity that has a lower correction count: rejected.
  7. Change one worktree file and resume with otherwise valid identity fields and full coverage: rejected because the
     diff hash changed. No Plan event, checkpoint review state, delivery evidence, or metrics change. Restore the file.
  8. Resume with full coverage and one new finding: the run returns a semantic repair request. The ledger has the
     finding as `new`, and the `ai` evidence says "Changes requested".
  9. Complete the repair. Resume with a verify-round outcome that uses full-scope instead of repair-scope spans:
     rejected as incomplete. Then resume with repair-scope coverage that confirms the fix: the Plan is `reviewed`, the
     result is `awaiting_delivery`, and no human review or publication event exists.
  10. Repeat step 9's completion: nothing changes. No fake model executable ran.

  The test fails before this change because no Session-free entry point exists. A stub that keeps outcomes in memory
  cannot survive the per-step subprocesses. A wrapper that checks identity without the engine's diff cannot pass step 7.
- **Parity test** (`validation-host-turn-parity.test.ts`). It runs the same scripted outcomes through both entry points
  on identical fixtures: `continueWorkflowValidation` with a scripted external `SemanticReviewPort` and repair Agent,
  and `continueHostTurnValidation` with resume inputs. Both runs must produce equal ordered lifecycle events, final
  checkpoint review state, delivery evidence kinds and outcomes, and validation metric events. Cases:
  - CI failure, repair, and pass;
  - feedback, repair, and verify-round approval;
  - an unaccounted finding corrected on retry;
  - approval with open findings rejected;
  - a Plan-only diff (`validation_failed`);
  - `humanReviewDecision: changes_requested`;
  - non-Git skip;
  - an Epic child with integration notes.

  A second validation loop that copies policy drifts in at least one case.
- Automated, decisions: a fixture past `SEMANTIC_REVIEW_CYCLES` returns the round-limit decision request with the
  Session's four options. Resuming with `continue` and then a reviewer outcome uses that outcome without asking again.
  Resuming with `stop` pauses with tests and findings preserved, the same as `validation-loop-review.test.js` "stop at
  limit". A fixture with no `verification_command` returns a missing-command decision; the answer is saved to settings
  and CI runs.
- Automated, correction limit: in host-turn mode, rejected reviewer outcomes across fresh processes reach the same
  `decideValidationRecovery` decision at the same count as in-process nudges.
- Automated, contracts: `review-diff.test.ts` and `review-outcome.test.ts` pin page boundaries, coverage spans, and
  ledger identity rules against literal expected values. Capture those values from the current tool before the
  extraction, not by calling the tool. `architecture-boundary.test.ts` gains:
  - module-graph checks for `review-diff.ts` and `review-outcome.ts` (step 4 and step 5);
  - the supervisor import rule (step 1);
  - the host-turn source rule (step 7).
- Session behavior: a new assertion in `validation-loop-review.test.js` checks that two reviewer rounds get different Pi
  session managers and that nudges in one round share one. Every listed Session suite passes. Tests may change only how
  they construct requests, now that the opaque handles are gone. No test that asserts a Session behavior may be deleted.
  Pinned behavior includes:
  - nudges reuse the round's Pi reviewer session;
  - CI repair pauses without `task_completed`;
  - process loss during repair resumes without repeating the repair turn;
  - human review gates publication;
  - Epic integration review and Manual QA keep their tools.
- Behavior expected to stop: none. Only the `createInMemorySessionManager` port member and the opaque handle types go
  away. Their current users (`validation-semantic.ts`, `epic-integration.ts`, `validation-publication.ts`, and two
  tests) move to the new request shape.
- `deno task seams:check` passes. The host-turn port is production code, not a test seam. Tests provide only
  external-Agent outcomes as resume input.
- Docs: the authority matrix and glossary describe host-turn continuation. The Core and Connect PRDs are unchanged
  because no user-visible behavior changes; child 05 updates Connect when the Attached journey ships.

## Edge Cases & Considerations

- **Shared modules load Pi.** The engine's import graph already reaches `hosted-session.js` and `validation.ts` through
  Epic integration and Work Record generation. A "graph must not contain" check is therefore not possible for the entry
  point. The Epic allows imports that load Pi, so the proof is behavioral: source rules (step 7) and the runtime checks
  in the red-to-green test (`--deny-net`, fake model executables).
- **Concurrent callers.** `claimValidation` owner checks still allow only one engine run per attempt. A second caller
  gets the existing `active` result. Callers keep their own request records; child 05 uses record CAS.
- **CI reruns on re-entry.** A CI exhaustion decision is resumed by re-entering Mechanical Validation, which runs the
  configured command again before the prompt. Assumption: this is acceptable because Retry already means "run CI again",
  and a check run by Core is never fabricated evidence. If the command now passes, the decision is not needed.
- **Engineer follow-up writes before its wait.** It records `validation_failed` and then returns a repair request. Its
  resume goes through the repair completion path, not by re-entering the prompt, so the write is not repeated.
- **Lost Session nudge context.** A fresh host worker does not share the earlier reviewer's memory. The correction text
  and durable ledger carry what matters, as they already do after a Session process restart.
- **Delivery is out of scope.** Human review, Manual QA, publication, and post-verification hand-offs are not reachable
  in host-turn mode in this child. Child 06 extends the entry point past `reviewed`.
- **Non-Git in-place execution** keeps the existing semantic skip (`ai-skip` evidence) and reaches `awaiting_delivery`
  after Mechanical Validation.
