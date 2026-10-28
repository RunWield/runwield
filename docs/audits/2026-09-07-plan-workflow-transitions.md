# Plan transition audit — 2026-09-07

Companion to the [complete workflow tree](../plan-workflow-map.md). Scope comes from
[Make terminal workflow tools authoritative in every path](https://app.todoist.com/app/task/make-terminal-workflow-tools-authoritative-in-every-path-6hFm55r9wQpjmFCC).
This is an investigation, not a completion record or a claim that the task is resolved.

## Verdict

**The broad claim is false.** The inspected production success paths consume accepted tool events or direct structured
tool effects, rather than parsing an agent's language to infer success. However, some root consumers still wait for an
Agent turn to finish, one accepted Plan outcome omits its event, and an actual CI repair checkpoint takes the wrong
restart branch. Publication repairs also have weaker validation than the implementation they modify.

These are separate questions:

1. **Does prose advance the workflow?** No active success decoder was found in the paths traced here. Dead compatibility
   parsers remain. Text is still used for reports, feedback, and error presentation.
2. **Does every accepted terminal call immediately hand control to the owner and stop its producer?** No; A1–A2.
3. **Does the next step have durable evidence, including after interruption?** Not consistently; A3–A4.
4. **Does a tool call prove the underlying work or approval was adequate?** Only to the extent its checks enforce; A5–A8
   describe important limits.
5. **Is every transition a tool call?** No, and that is not itself a defect: CI exit codes, explicit user decisions,
   lifecycle rules, saved checkpoints, and Git evidence legitimately drive controller transitions.

## Evidence and limits

The audit traced source from dispatchers through tools, event consumers, lifecycle writes, validation phases,
publication, and recovery. Existing docs, prompts, and Work Records were not accepted as implementation evidence.
Prompts were inspected only to compare their requested behavior with what the code actually enforces.

Inspection started at `a201fc19737471b1d8f57ab384bb4412d65309a2`; this was not a pristine checkout. Unrelated work was
present and preserved. Concurrent dependency-only commits moved HEAD during inspection; those commits changed
`deno.json` and `deno.lock`, not the workflow source. The [source manifest](plan-workflow-source-manifest.json) records
the final snapshot HEAD and file hashes for the source/test files referenced by these documents, plus the installed Pi
loop used for the root observation. The installed dependency matters: a future dependency version may change termination
behavior without changing RunWield's source. Source links and function names identify the inspected boundaries; line
anchors are audit-time hints.

**Reproduced** means an executable probe reached the bad behavior. **Source-confirmed** means the branch/ordering was
read directly; an end-to-end operational failure was not reproduced. **Contract concern** identifies an insufficient
check or ambiguous guarantee, rather than claiming a demonstrated corrupt publication. No live model-provider run, real
remote push, full test suite, or OS process-kill experiment was performed for this audit.

## Findings

### A1 — Epic approval saved for later omits its authoritative event

**Reproduced.** `plan_written` accepts PROJECT approval, records `epic_readiness_passed`, and returns a terminal
`outcome: "saved"` result when the user chooses later. This branch omits `publishAcceptedPlanOutcome`. The neighboring
decompose and executable-Plan save branches do publish. Consumers now depend on the event, so a correct-looking return
value is insufficient: they can report `no_call`, or retain an earlier feedback event, while the Plan is already ready
for decomposition.

- Producer: [PROJECT later branch](../../src/tools/plan-written.ts#L759), in `createPlanWrittenTool`.
- Consumer: [runPlanningAgent](../../src/shared/workflow/planning-agent.ts#L64) awaits the turn, claims the event, and
  maps an absent event to `no_call`.
- Probe: [epic-save.probe.js](probes/epic-save.probe.js).
- Observed: `outcome="saved"`, `status="ready_for_decomposition"`, `events=[]`; required saved-event assertion fails.
- Coverage gap: the existing [Plan tool test](../../src/tools/__tests__/plan-written.test.js) named “plan_written
  project approval can save for later with session-complete guidance” checks the returned result, termination flag, and
  status messages, rather than this consumer-visible event.

Acceptance target: every accepted Plan outcome publishes exactly its intended event, including later, cancellation,
remote review, and feedback-to-later sequences. Exercise both direct root and `runPlanningAgent` consumers.

### A2 — Root completion does not uniformly stop the producer or advance immediately

**Reproduced for Pi root Operator; additional consumer differences are source-confirmed.** A root assistant batch with
`task_completed` followed by another tool runs the second tool. The completion is accepted, but the root handler's event
race only watches `triage_report` and `plan_written`. It waits for turn return before handling task completion.

- [Root event race](../../src/shared/session/agent-handler.ts#L104): excludes `task_completed`. Its non-feedback
  Plan/triage event branch returns without aborting or joining the running producer.
- [Engineer runners](../../src/shared/workflow/engineer-runner.ts#L33): both initial and segment-handoff paths await
  `runActiveAgentTurn` before claiming accepted completion.
- [Managed semantic repair](../../src/shared/session/runtime/workflows.ts#L591): also awaits the active turn before
  consuming repair completion.
- [Orchestrator](../../src/shared/workflow/orchestrator.ts): `runRootTurnUntilTaskCompletion` does race the event and
  aborts the turn, but does not wait for producer shutdown before returning.
- Installed Pi `agent-loop.js`, `executeToolCallsSequential` and `shouldTerminateToolBatch`: sequential execution checks
  abort between tools; the batch terminates only if **every** finalized result requests termination. A mixed batch can
  continue despite a terminal tool result.
- [Claude MCP test](../../src/shared/session/backends/claude-cli/mcp-bridge.test.ts#L400) explicitly permits capability
  tools after a terminal lifecycle result. The bridge gate blocks further lifecycle calls, not all work. Root callers
  waiting for Claude process completion are therefore not equivalent to isolated event interception.
- Probe: [root-completion.probe.ts](probes/root-completion.probe.ts). Observed `ranAfterCompletion=true`; required
  `false` assertion fails using a real root Session and real `task_completed`, with only model output substituted.

The isolated [runValidationAgentUntilEvent](../../src/shared/session/agent-workflow-step.ts) is stronger: it registers
before invocation, scopes the event, aborts the producer, and waits for its shutdown. This does not establish the same
guarantee for root consumers. Potential overlapping work in the early-return Plan/triage branch is a source-based
consequence, not a separately reproduced race in this audit.

Acceptance target: every entry path has an explicit event-to-owner handoff and a producer shutdown boundary. Include a
producer that never returns voluntarily and a second mutating capability in the same batch. A test that just returns a
canned terminal message cannot demonstrate this property.

### A3 — The actual interrupted CI-repair checkpoint is treated as semantic repair

**Reproduced with controlled interruption and a fresh Session.** The repair adapter writes
`state="awaiting_repair", repairKind="ci", nextPhase="mechanical"` before invoking a CI repair Agent. On resume without
a task-completion ID, the supervisor treats every `awaiting_repair` checkpoint as semantic repair. Without semantic
Review Issues, it returns `validation_repair_evidence_missing` and runs CI zero times.

- Writer: [prepareRepairInvocation](../../src/shared/workflow/validation-session-adapter.ts#L374).
- Branch: [continueValidationAttempt](../../src/shared/workflow/validation-supervisor.ts#L416).
- Rejection: [rebuildSemanticRepairHandoff](../../src/shared/workflow/validation-supervisor.ts#L246).
- Probe: [ci-repair-resume.probe.ts](probes/ci-repair-resume.probe.ts). The real adapter writes the checkpoint; the
  external repair turn is held open while a fresh Session attempts resume. The probe does not fabricate controller state
  or fake Plan writes, lifecycle operations, or locks. It releases the suspended turn during cleanup.
- Existing [repair-resume tests](../../src/shared/workflow/validation-repair-resume.integration.test.ts#L250) pass,
  including tests named “process loss during CI repair” and “process loss after repair changes the worktree”. Their
  helper `saveRunningMechanicalCheckpoint` seeds `state="running"`, bypassing the adapter's actual awaiting state.

This proves wrong dispatch from the persisted state. It does not prove all OS crash, PID ownership, or filesystem
durability behavior. Acceptance target: dispatch resume by repair kind and evidence; test before dispatch, while the
real adapter is awaiting repair, after file edits, after accepted completion, and after its durable receipt.

### A4 — Some events are acknowledged before the next durable transition

**Source-confirmed ordering; crash loss not reproduced.**

- [engineer-runner](../../src/shared/workflow/engineer-runner.ts#L64) claims and acknowledges completion before its
  caller reaches [finalizePlanImplementation](../../src/shared/workflow/implementation-checkpoint.ts).
- [Managed semantic repair](../../src/shared/session/runtime/workflows.ts#L620) acknowledges before
  `recordValidationRepairCompletion` persists the generation receipt.
- [Planning runner](../../src/shared/workflow/planning-agent.ts#L79) and
  [root Plan dispatch](../../src/shared/session/agent-handler.ts#L363) settle the accepted Plan event before downstream
  workflow dispatch completes.
- [Event publication](../../src/shared/workflow/workflow-tool-events.ts#L365) inserts into the in-memory event list
  before appending the durable root custom entry. A persistence exception needs its own tested outcome.

An interruption between acknowledgement and the next owned checkpoint can leave no pending receipt for replay. Some
lifecycle effects are independently recoverable, so this is not a claim that every such window loses the Plan. It is a
limit on “consume once” or crash-safe handoff claims.

Acceptance target: make the destination durable before settlement, or provide a recoverable transaction tying them
together. Inject failures at actual external persistence/process boundaries and check what a new Session can prove.

### A5 — The semantic diff gate proves a tool event, not sufficient inspection

**Source-confirmed; contract concern.** [review_diff](../../src/shared/workflow/review-diff-tool.ts#L349) emits an event
for `list`, including the empty-diff result with `hasDiff:false`. The
[adapter](../../src/shared/workflow/validation-session-adapter.ts#L279) records only `Boolean(diffEvent)`, and the
[review consumer](../../src/shared/workflow/validation-semantic.ts#L522) accepts that or `trustedClaudeMcpReview`. The
gate does not require `show`, track inspected paths/ranges, or consume `hasDiff`. Claude's owning-session kind can
satisfy the trust exception without that event.

This is not transcript parsing, and the Reviewer may in fact read the code correctly. The evidence simply does not
establish that it did. Acceptance target: specify what inspection evidence is required and make provider paths enforce
the same intended standard. Test list-only, empty list, incomplete paths, and the Claude exception explicitly.

### A6 — Publication repair can change code without fresh CI or review

**Source-confirmed.** [Publication correction](../../src/shared/workflow/validation-publication.ts#L370) calls
`dispatchMergeRepair` and returns directly to the publication loop on success.
[finalizeMergeRepair](../../src/shared/workflow/validation-merge-repair.ts#L68) checks unresolved paths, finishes a
pending merge, requires merge ancestry, stages with `git add -A`, and may commit further repair changes. It does not run
the ordinary mechanical, semantic, or human-review phases on the resulting integration.

The repair prompt restricts changes to conflicted files, but the finalizer does not enforce that changed-path boundary.
Fresh target integration also relies on Git merge/ref evidence, not a new behavior check of the combined tree. A valid
merge and safe leased push establish history and ref ownership; they do not establish correctness of conflict edits.

Acceptance target: explicitly decide which repairs invalidate validation, enforce repair scope, and bind required checks
to the actual publication candidate. Test a clean Git resolution that breaks CI and an unrelated repair edit.

### A7 — Local publication conflict loses the repair checkout and recovery classification

**Source-confirmed; full local conflict repair not reproduced.** The
[local publisher](../../src/shared/isolated-publication.ts#L687) aborts the primary merge, rewrites
`current_checkout_merge_conflict` to `local_publication_conflict`, and clears `repairCwd`/`mergeWorktreePath`. The
[publication classifier](../../src/shared/workflow/validation-publication.ts#L87) treats that as correctable content
conflict, but [dispatchMergeRepair](../../src/shared/workflow/validation-merge-repair.ts#L217) falls back to the
execution checkout. That is not the aborted target integration. `publicationFailureNeedsUserAction` and
`describeMergePause` also omit the rewritten failure kind from their conflict branches.

The resulting instructions can direct repair to a checkout with no corresponding unresolved merge, followed by a generic
recovery message. Acceptance target: retain/create the real repair checkout and carry the local conflict kind
consistently through automatic correction, explanation, user retry, and restart.

### A8 — “Advisory QA” has different failure behavior for Epic child artifacts

**Source-confirmed; contract concern.**
[prepareEpicChildManualQaArtifact](../../src/shared/workflow/validation-publication.ts#L130) warns and continues for
missing/rejected checklist completion. A classified provider operational failure instead gets bounded retries, then can
block publication. Standalone QA and Recorder generation in
[post-verification handoffs](../../src/shared/workflow/validation-publication.ts#L677) are best effort.

These handoffs run during artifact preparation, before Git target publication, despite the function name. The first
candidate is already sealed; their artifacts are committed at the next publication boundary. A crash before
`artifacts_committed` can repeat partially completed handoffs. Tool events alone do not make these effects exactly once.

Acceptance target: state whether each artifact is required for delivery, make missing-tool and operational-failure
policy consistent with that choice, and test partial artifact writes before checkpoint recovery.

### A9 — The automatic Plan Amendment gate is not in the active validation path

**Resolved by removal.** The dormant detection, apply, legacy journal resume, and transition helper code for the old
automatic Plan Amendment gate has been removed. The active validation path still does not present an automatic Plan
Amendment approval loop and does not silently adopt Plan body or definition edits from the execution worktree.

Before adding a new broad amendment gate, define its owner, staleness rules, affected evidence, and resume behavior
instead of assuming legacy helpers provide the gate.

### A10 — Direct Plan Review no longer requires retired check metadata

**Resolved by removal (2026-09-24).** [getDirectPlanReviewEligibility](../../src/cmd/load-plan/plan-review-flow.ts) now
checks supported status and execution policy only. Direct review opens Plans without custom shell checks, including
ready-for-work Plans, through the existing review flow. Integration coverage exercises review, feedback, approval for
later, and execution without the retired metadata.

### A11 — `validated` is used as terminal status before publication completes

**Source-confirmed; consumer contract concern.** Publication stages
[validation_passed](../../src/shared/workflow/validation-publication.ts#L542) before target integration. Meanwhile,
[terminal/verified helpers](../../src/shared/workflow/plan-lifecycle.js#L185) include `validated`, as does
[Epic child selection](../../src/shared/workflow/epic-continuation.ts#L29). The ordinary successful continuation is
attached to the post-publication result, but status-only readers do not independently consult publication evidence.

Do not equate `attrs.status === "validated"` with “merged to target and cleanup complete.” Whether a particular consumer
must wait for publication needs an explicit contract. This audit did not reproduce an actual premature dependent run.

## What remains of transcript parsing

| Location                                                                                             | Current use                                                                                   | Authority conclusion                                                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `workflow-results.js` `readLatestPlanOutcome`, `readLatestReviewOutcome`, `readLatestTaskCompleted*` | Definitions, compatibility re-exports, tests; no active production transition call site found | Dead parser presence is not evidence that a current transition uses it. Keep new consumers off it. |
| `orchestrator.ts` `readLatestTriageOutcome`                                                          | Definition and tests; live handlers claim triage events                                       | Same distinction.                                                                                  |
| `extractAssistantOutput`                                                                             | Delegated assistance and Quick Fix QA context                                                 | Transports text; accepted completion is gated separately.                                          |
| `parseRecorderSections`                                                                              | Definition and tests                                                                          | Actual generation consumes `work_record_completed`.                                                |
| Reviewer adapter reads assistant `stopReason === "error"`                                            | Classifies provider operational failure                                                       | Structured error metadata, not language-based success.                                             |
| Root Session custom-entry restore                                                                    | Loads accepted/settled event receipts                                                         | Structured owned records, not scanning conversational tool results.                                |
| Feedback and repair reports                                                                          | Human/Agent content supplied to another Agent                                                 | Not independently verified just because carried by a tool.                                         |
| Git error output and publication commit metadata                                                     | Typed failure classification and deterministic recovery evidence                              | Text parsing exists here; it is process/Git evidence, not an Agent success narrative.              |

Reproduce the call-site search from the repository root:

```sh
rg -n 'readLatest(PlanOutcome|ReviewOutcome|TaskCompleted|TriageOutcome)|extractAssistantOutput|parseRecorderSections' src
rg -n 'Plan Amendment|validation_plan_amendment' src docs
rg -n 'claimWorkflowToolEvent|waitForWorkflowToolEvent|settleWorkflowToolEvent|claimPendingTaskCompletion|acknowledgeTaskCompletion' src
```

These searches seed inspection; they are not proof by themselves. Follow aliases and indirect Session adapters into
their actual producers and consumers, as the [workflow map](../plan-workflow-map.md) does.

## Executable evidence

The following existing regression selection passed: **41 tests, 11 steps, 0 failures**. This establishes the behaviors
covered by those tests, not universal workflow correctness.

```sh
deno run -A scripts/run-tests.js \
  src/shared/workflow/workflow-tool-events.test.ts \
  src/shared/workflow/validation-tool-continuation.integration.test.ts \
  src/shared/workflow/validation-repair-resume.integration.test.ts \
  src/shared/workflow/validation-completion-gating.test.ts \
  src/shared/workflow/publication-machine.failure-matrix.test.ts \
  src/shared/workflow/validation-publication.test.ts \
  src/shared/session/agent-handler.test.ts
```

The three audit probes assert the intended invariant and **fail on the audited implementation**. They are deliberately
named `.probe.js`/`.probe.ts`, outside automatic test discovery. Run them explicitly, one safe sandbox per command:

```sh
deno run -A scripts/run-tests.js docs/audits/probes/epic-save.probe.js
deno run -A scripts/run-tests.js docs/audits/probes/root-completion.probe.ts
deno run -A scripts/run-tests.js docs/audits/probes/ci-repair-resume.probe.ts
```

| Probe | Required invariant                                    | Observed failure                                   |
| ----- | ----------------------------------------------------- | -------------------------------------------------- |
| A1    | Accepted PROJECT saved result has a saved Plan event  | Empty pending event list                           |
| A2    | No later tool executes after accepted root completion | Later tool executed                                |
| A3    | Fresh Session resumes actual CI-repair state with CI  | `validation_repair_evidence_missing`; zero CI runs |

The probes use the real tools/controllers. Their substitutes are external boundaries: model output, user interaction, CI
process results, and an Agent turn suspended for interruption. They add no production dependency-injection seams. After
fixing a finding, promote the appropriate scenario into normal regression coverage and update this dated audit with the
fix and tested evidence; do not silently rewrite the original observation.

## Coverage required before claiming the Todoist task resolved

Use the map's node names to build a producer/consumer matrix. For each terminal tool, cover accepted, rejected, absent,
duplicate, stale invocation, persistence failure, and accepted-then-producer-keeps-running cases. Include root Pi, root
Claude CLI, isolated validation, planning runners, initial execution, segment handoff, semantic repair continuation,
direct review, and load/resume. Delegation must be unable to finish its parent through child prose or child controls.

For every repair kind, resume from the actual checkpoint written before dispatch, after changes, after acceptance, after
the durable repair receipt, and after settlement. For publication, include local and remote conflicts, target movement,
dirty primary checkout, permission/policy failure, exhausted retries, interrupted artifacts, and cleanup after a later
target commit. Confirm whether each code-changing repair returns to CI/review or explicitly reuses old evidence.

Completing a surgical fix or passing a broad-sounding test name is not sufficient evidence for the other branches.
