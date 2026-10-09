---
planId: "6fab52da-b258-4a81-a36b-6695ce226c60"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "HIGH"
affectedPaths:
    - "src/shared/plan-deviations.ts"
    - "src/plan-front-matter.js"
    - "src/plan-store.js"
    - "src/tools/plan-deviation.ts"
    - "src/shared/workflow/engineer-runner.ts"
    - "src/shared/workflow/engineer-plan-projection.ts"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/agent-definitions/shared-practice/plan-execution.md"
    - "src/agent-definitions/subagent-definitions/reviewer-prompt.md"
    - "src/agent-definitions/subagent-definitions/reviewer-verify-prompt.md"
    - "src/shared/work-records/generation.js"
    - "src/agent-definitions/recorder.md"
    - "src/ui/tui/runtime-interaction-adapter.js"
    - "docs/domain-language.md"
    - "docs/workflows.md"
    - "docs/validation-authority.md"
    - "docs/plan-workflow-map.md"
    - "src/skills/runwield/PLANS.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-07T23:52:50-04:00"
status: "validated"
origin: "internal"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
archivedAt: "2026-10-08T19:53:41.322Z"
archiveReason: "Delivered to the runtime-state Epic and landed on main; archived at owner request."
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/record-pair-plan-deviations.md"
---

# Record Pair Plan Deviations

## Context

Pair Execution lets the user inspect an increment and change direction before implementation continues. Today, revision
feedback returns only to the live Plan Engineer or Frontend Engineer turn. The Session Transcript can retain the tool
result, and optional metrics retain a content-free decision, but neither is Plan authority. A restart, Semantic Code
Review, or Work Record generation has no structured record that the user intentionally replaced a Plan requirement. The
Reviewer can then reject correct code for not matching obsolete Plan text.

The Plan execution prompt already says explicit user-directed Plan revisions win, but it gives the execution Agent no
guarded way to record that decision. The dormant Plan Amendment implementation has now been removed, including
`validation-plan-amendment.ts`, the supervisor resume hook, `runPlanAmendmentTransition`, and the Plan Amendment
projection exports. Their obsolete tests were removed too. This Plan must not restore them. Validation reloads the
authoritative execution Plan; that read is not user approval of an arbitrary edit.

The intended outcome is one durable chain of authority: an explicit user decision changes the effective Plan, Semantic
Code Review uses that change, and the Work Record states what differed from the initially approved Plan.

## Objective

Add a user-confirmed **Plan Deviation** flow to Pair Execution. A Plan Engineer or Frontend Engineer can propose the
exact requirement being replaced and its replacement. RunWield asks the user to confirm that text, then appends the
accepted decision to the authoritative execution Plan. Ordered Plan Deviations supersede conflicting original Plan
requirements for execution and Semantic Code Review. Work Record generation must reproduce every accepted deviation
under `## Deviations from Plan`.

Ordinary checkpoint feedback, implementation choices, Agent reports, Session text, and metrics must not acquire Plan
authority. No confirmed deviation means the approved Plan remains unchanged.

## Approach

Store an ordered `planDeviations` list in Plan Front Matter because it is human-approved Plan definition and history.
Before execution, the primary Plan owns definition. After execution starts, the execution-worktree Plan owns it. The
controller remains the owner of validation attempts and Review Issues; it does not duplicate Plan Deviations.

Use one shared type and formatter:

```ts
type PlanDeviation = {
    id: string;
    supersededRequirement: string;
    replacementRequirement: string;
    reason?: string;
    approvedAt: string;
};
```

Entries are append-only during active execution. Both requirement fields are required and must be concrete. Removing a
requirement is represented by a replacement such as “This requirement no longer applies,” not by an empty value. A later
confirmed entry can supersede an earlier replacement. When entries conflict, the latest accepted entry wins;
non-conflicting Plan requirements remain in force.

```text
Pair checkpoint or Pair repair
  -> user directs a change that conflicts with the effective Plan
  -> execution Agent calls record_plan_deviation
  -> RunWield shows superseded requirement -> replacement -> optional reason
     |-- Confirm -> revision-checked append to authoritative execution Plan
     |              -> execution continues under effective Plan
     `-- Cancel/unsupported/stale -> no append and no authority to diverge

Workflow Validation
  -> reload execution Plan
  -> original body + ordered confirmed Plan Deviations
  -> Reviewer checks code against the effective requirements
  -> publication carries the Plan Deviations to the target
  -> Recorder input and deterministic Work Record rendering include them
```

`record_plan_deviation` is a workflow-only Custom Tool supplied beside `pair_checkpoint` to initial, resumed, and Pair
validation-repair turns. The tool uses a dedicated confirmation interaction, binds the write to the active Plan name,
execution checkout, worktree identity, and expected Plan revision, and uses the tool call identity for idempotency. A
stale revision requires a fresh proposal and confirmation. Content-free metrics can remain content-free; the Plan is the
durable record.

Persist the accepted entry with
`savePlan(executionCwd, planName, current.markdown, { planDeviations: nextEntries },
{ expectedRevision: confirmedRevision })`
in `src/plan-store.js`. Preserve the current body and all unrelated metadata. `savePlan` already holds catalog and Plan
locks, checks the expected revision, honors Shared Plan write restrictions, and uses an atomic document write without
overwriting existing controller state. Recheck the active execution identity before saving; do not hold a Plan lock
while waiting for the user. This is one Plan-document change, not a lifecycle transition. No new amendment operation,
approval journal, baseline comparison, or supervisor recovery hook is needed. The accepted entry and its tool-call
identity are committed together in the same document.

The Engineer projection and Semantic Reviewer request must render a clear `Approved Plan Deviations` section after the
original Plan body. Semantic Review must receive the actual reloaded Plan content; the current placeholder text (“Plan
content is supplied by the validation request”) is not sufficient. Discovery and verification rounds treat confirmed
Plan Deviations as higher priority than conflicting original text. An existing Review Issue can be resolved without a
code change when its requirement was later superseded and the code satisfies the replacement; unrelated correctness,
security, and regression findings remain reviewable.

Work Record generation receives normalized Plan Deviations separately from the general execution report. The
deterministic Work Record builder inserts every accepted entry under `## Deviations from Plan`, then includes any other
meaningful deviation text from Recorder without duplicating the confirmed entries. This makes automatic generation and
later `wld wr backfill` produce the same durable history even if Recorder omits its optional deviation field.

The set-aside option was automatic recording from free-form checkpoint feedback. It removes one confirmation but lets an
Agent misclassify ordinary revision feedback as a user-approved specification change. A full Plan Review for each change
is safer but defeats rapid Pair steering. The selected focused confirmation preserves user authority with less ceremony.
The separate `offer-semantic-review-intervention.md` draft remains about one-delivery review waivers; it is not a source
of durable Plan Deviations and is not part of this change.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/plan-deviations.ts` — own the named `PlanDeviation` type, strict normalization, ordered effective-plan
  projection, prompt/record formatting, and append/idempotency rules used across execution, review, and recording.
- `src/plan-front-matter.js`, `src/plan-store.js`, and `src/plan-store.test.js` — recognize, preserve, serialize, and
  reload `planDeviations` as Plan-owned definition data without moving it into controller state or stripping it during
  lifecycle writes.
- `src/tools/plan-deviation.ts` and focused tool tests — own Pair-only proposal validation, explicit confirmation,
  revision/worktree-bound durable append, cancellation, stale-write, unsupported-host, and duplicate-call behavior.
- `src/shared/session/session-runtime-interactions.js` and `src/ui/tui/runtime-interaction-adapter.js` — carry and
  render the dedicated Plan Deviation confirmation with exact accepted/canceled outcomes. Do not infer acceptance from
  prose.
- `src/shared/workflow/engineer-runner.ts`, `src/shared/workflow/validation-helpers.ts`, and execution/repair
  integration tests — supply `record_plan_deviation` wherever a real Pair execution owner receives `pair_checkpoint`,
  including resumed execution and Pair validation repair.
- `src/shared/workflow/engineer-plan-projection.ts`, `src/shared/workflow/workflow-prompts.ts`, and prompt tests — give
  execution Agents the Plan body plus confirmed deviations while continuing to hide unrelated lifecycle Front Matter.
- `src/agent-definitions/shared-practice/plan-execution.md` and Agent contract tests — require the execution Agent to
  use the guarded tool when an explicit user instruction conflicts with an effective Plan requirement, and forbid silent
  edits or inferred deviations.
- `src/shared/workflow/validation-semantic.ts`, validation integration tests, and both Reviewer prompt definitions —
  supply the effective Plan to every discovery/verification round and apply confirmed-deviation precedence to new and
  existing Review Issues.
- `src/shared/work-records/generation.js`, `src/agent-definitions/recorder.md`, Work Record tests, and the validation
  Work Record handoff test — pass normalized deviations to Recorder and guarantee their deterministic Markdown
  inclusion.
- `src/tools/registry.js` and tool-policy tests — keep the new mutation tool workflow-scoped and unavailable to
  unrelated Agents or delegated turns.
- `docs/domain-language.md` — define **Plan Deviation** and update Semantic Code Review, Review Issue, Pair Execution,
  Work Record, and stable relationships. Keep **Plan Amendment** retired; do not redefine it as the new flow.
- `docs/workflows.md`, `docs/validation-authority.md`, `docs/plan-workflow-map.md`, and `src/skills/runwield/PLANS.md` —
  document confirmation, ownership, review precedence, recovery, and Work Record behavior. Preserve their corrected
  statement that Workflow Validation has no automatic Plan Amendment approval gate.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `src/plan-store.js` — reuse `loadPlan`, `savePlan`, `StalePlanWriteError`, and the existing locked atomic document
  write. Persist only `planDeviations`; do not add a multi-resource transition or copy controller fields into YAML.
- `src/shared/session/session-runtime-interactions.js` — reuse typed interaction request/outcome handling and managed
  operation authority for the confirmation boundary.
- `src/shared/workflow/engineer-plan-projection.ts` — extend the existing protected Front Matter projection rather than
  send all runtime metadata to execution Agents.
- `src/shared/workflow/validation-engine.ts` and `validation-supervisor.ts` — keep their canonical reload before each
  phase so a resumed Reviewer receives the execution Plan, not stale caller input.
- `src/shared/work-records/generation.js` — reuse the existing `deviationsFromPlan` section and Recorder handoff, but
  add deterministic confirmed-deviation content so optional Agent output cannot erase it.
- `src/shared/git-test-fixture.ts` and Work Record/validation fixtures — exercise real Git, Plan, transition, and
  publication boundaries without adding an injection seam for RunWield-owned persistence.

## Implementation Steps

- `planDeviations` is a recognized Plan definition field with a named strict item type. Plan load/save, lifecycle
  updates, worktree materialization, archive/restore, review edits, publication, and Work Record backlink writes
  preserve valid entries in order. Plans without the field retain current behavior, and malformed entries stop deviation
  use and validation with a clear recovery message instead of being silently discarded.
- `record_plan_deviation` is available only during active Pair execution for Plan Engineer or Frontend Engineer,
  including resumed Pair work and Pair validation repair. Its required proposal names the effective requirement being
  superseded and the replacement; an optional reason supplies useful context. It cannot change Plan status, execution
  policy, worktree identity, controller state, or unrelated Plan fields.
- The tool presents the exact proposal through a typed user interaction. Only an accepted interaction appends the
  deviation. Cancellation, stop, unsupported interaction capability, wrong owner, inactive Pair mode, missing execution
  context, or a Plan revision change writes nothing and does not authorize contrary implementation. A retry of an
  already committed tool call returns the existing entry without a duplicate.
- An accepted append uses the existing `savePlan` boundary against the authoritative execution Plan, with the confirmed
  revision and rechecked active worktree identity. The body, lifecycle status, existing controller state, and registry
  remain unchanged. Process loss before the atomic write requires confirmation again; process loss after it recovers the
  same single entry from the Plan without consulting Session Transcript or metrics. No Plan Amendment helper, operation,
  projection export, or legacy supervisor resume hook is restored.
- Plan Engineer and Frontend Engineer prompts state that explicit user direction wins only after the guarded record is
  accepted. They call the tool when a user instruction replaces an effective requirement, reread the effective Plan, and
  continue under it. They do not record ordinary implementation feedback that remains compatible with the Plan, and they
  do not use raw `edit`/`write` to manufacture a deviation.
- Execution requests and compaction/resume re-anchors contain the original Plan body followed by normalized confirmed
  Plan Deviations, without exposing controller/lifecycle Front Matter. Ordered replacements are unambiguous: the latest
  confirmed conflicting entry wins and all other original requirements remain active.
- Every Semantic Reviewer discovery and verification request contains the actual canonical execution Plan projection,
  including confirmed deviations. Reviewer prompts require each conflict to be judged against the replacement, forbid a
  blocking finding based only on superseded text, and allow an existing ledger item to resolve when its requirement is
  superseded and the implementation satisfies the replacement. Real defects outside the deviation remain blocking.
- Work Record generation always emits `## Deviations from Plan` when the source Plan has confirmed deviations and lists
  each superseded requirement, replacement, and recorded reason when present. Recorder can add other retrospective
  deviations, but cannot omit, contradict, or duplicate confirmed entries. Automatic generation and explicit backfill
  produce equivalent deviation content.
- `docs/domain-language.md` defines **Plan Deviation** as an explicit, user-confirmed replacement to effective Plan
  definition during execution; distinguishes it from ordinary Pair feedback, the retired Plan Amendment gate, the
  separately proposed Review Override, and a Review Issue; and states that Plan, Reviewer, code, and Work Record must
  agree on the replacement.
- Workflow docs and the shipped RunWield Plan skill describe the confirmation flow, durable owner, restart behavior,
  Reviewer precedence, and Work Record result. They retain the completed cleanup's rule: validation does not infer user
  approval from Plan edits or run an automatic Plan Amendment gate.
- Focused behavioral tests and `deno task ci` pass without adding or re-baselining an injection seam.

## Approval Confirmation

No Work Records are proposed for supersession. This change extends Pair Execution and Work Record behavior but does not
materially replace the outcomes of the existing Pair Execution or Work Records records.

## Verification Plan

- Automated Plan storage/tool behavior:
  `deno run -A scripts/run-tests.js src/plan-store.test.js src/shared/plan-deviations.test.ts src/tools/__tests__/plan-deviation.test.ts src/tools/__tests__/pair-checkpoint.test.js src/ui/tui/runtime-interaction-adapter.test.js`.
- Automated execution and prompt behavior:
  `deno run -A scripts/run-tests.js src/shared/workflow/pair-execution.test.js src/shared/workflow/plan-execution-runtime-boundaries.integration.test.ts src/shared/workflow/workflow-prompts.test.js src/shared/session/agent-contracts.test.ts src/shared/session/agents-shared-practice.test.ts src/shared/session/__tests__/session-tools-policy.test.js`.
- Automated review and Work Record behavior:
  `deno run -A scripts/run-tests.js src/shared/workflow/validation-prompts.test.js src/shared/workflow/validation-loop-review.test.js src/shared/workflow/validation-work-record-handoff.test.ts src/shared/work-records/work-records.test.js`.
- Add one objective-level `plan-deviation-lifecycle.integration.test.ts` using a real Git fixture and real Plan writes.
  It confirms a proposed deviation, reads the execution Plan Markdown directly to prove the accepted entry was written,
  disposes the original Hosted Session, creates a fresh validation context from the saved Plan, and captures the
  Semantic Reviewer request. It then discovers the source again through the normal Work Record backfill path and
  generates a Work Record with a Recorder response that omits optional deviation text. The test must prove that the
  fresh Reviewer request names the replacement as authoritative and that the final Work Record still contains the exact
  deviation. It fails if the implementation is only a prompt change, transcript note, metric, module-level cache,
  unpersisted custom tool, pass-through projector, or optional Recorder instruction.
- Persistence regression: accepted confirmation adds exactly one entry to the execution Plan while leaving its body,
  status, existing controller record, registry, and stale primary Plan unchanged. A stale confirmation changes none of
  those files. Reload from disk before retrying a committed tool call and assert no duplicate or second confirmation.
- Preserve the cleanup's behavioral coverage with
  `deno run -A scripts/run-tests.js src/plan-store.test.js src/shared/workflow/validation-self-healing.integration.test.ts src/shared/workflow/state-transition.test.js`.
  Validation must still reach Mechanical Validation without an automatic amendment prompt. An ordinary body edit must
  not synthesize a `planDeviations` entry or a user-approval claim. Do not recreate the eight obsolete detect/apply,
  projection/partition, or legacy-baseline tests; test the explicit confirmation flow instead.
- Full automated gate: `deno task ci`, including `deno task seams:check`.
- Manual Pair flow: run a small Plan in Pair mode, inspect an increment, and give revision feedback that conflicts with
  one Plan requirement. Confirm the displayed old requirement, replacement, and reason. Resume the Session and inspect
  the execution Plan; the single confirmed entry remains. Finish execution and verify Semantic Code Review does not
  reopen the superseded requirement.
- Manual negative flow: cancel one proposed deviation and cause one stale revision before confirmation. Confirm neither
  proposal is stored, the Agent says the original Plan still applies, and it does not report conflicting work complete.
- Manual record flow: finish and publish the fixture Plan. Read its Work Record and confirm `## Deviations from Plan`
  names the old requirement and the accepted replacement even when the execution report does not repeat them.
- Existing behavior to protect: normal Pair continue/revise/stop/autonomous choices; Pair capability fallback;
  content-free metrics; execution-worktree Plan authority; controller-owned validation checkpoints and Review Issues;
  semantic repair convergence; Plan publication; optional Recorder prose; Plans and Work Records with no deviations.
- Behavior expected to stop: a confirmed Pair direction can exist only in live feedback or Session Transcript; Semantic
  Review can block solely on the superseded Plan text; Recorder can omit a known confirmed Plan deviation.
- Glossary check: implementation, prompts, workflow docs, and `docs/domain-language.md` use **Plan Deviation** with the
  same confirmation, ownership, precedence, and recording rules.

## Edge Cases & Considerations

- **Decision boundary:** “Make the spacing tighter” can be ordinary feedback when the Plan leaves spacing open. “Keep
  the old navigation although the Plan requires replacing it” is a Plan Deviation. The Agent proposes; the
  user-confirmation interaction decides. No text classifier writes authority by itself.
- **Repeated changes:** a later confirmed deviation can replace an earlier replacement. Preserve both entries in order
  for history, tell Reviewer that the latest conflict wins, and list both in the Work Record.
- **Cancellation and capability loss:** no acceptance means no Plan change. Do not silently switch to autonomous and
  implement the conflicting direction. Pause with a concrete explanation if the active host cannot confirm it.
- **Stale writes:** bind confirmation to the Plan revision shown to the user. If the Plan changes before commit, discard
  the acceptance result and request a fresh confirmation against the new effective Plan.
- **Crash boundary:** the Plan write is the durable commit. Transcript interaction events and metrics are evidence for
  display and diagnostics only. A committed deviation is idempotent by operation/tool-call identity; an uncommitted
  answer is not replayed as approval after restart.
- **Validation repair:** when a confirmed deviation supersedes an open Review Issue requirement, the next verification
  round can resolve that item from the new effective Plan plus code evidence. It must not falsely claim that code
  changed.
- **Removed Plan Amendment code:** do not restore the deleted module, transition helper, projection exports, supervisor
  resume hook, or obsolete tests. Confirmation belongs to `record_plan_deviation`, before the Plan save, not to
  validation startup. An arbitrary Plan body edit is not a confirmed deviation. This Plan does not add a general audit
  or approval mechanism for all Plan-file edits.
- **Review Override:** the draft `docs/plans/offer-semantic-review-intervention.md` describes accepting one Reviewer
  result for one delivery without durable policy. Keep that waiver separate. A Plan Deviation changes effective
  requirements and must be recorded in the Work Record.
- **Compatibility:** no historical decision can be reconstructed safely from old transcripts or execution reports.
  Existing Plans without `planDeviations` need no migration. Only decisions confirmed after this behavior ships become
  authoritative deviations.
- **Sensitive content:** confirmed text becomes repository content in the Plan and Work Record. The confirmation prompt
  must make that visible. Metrics must retain only content-free outcome/count fields if metrics are added.
