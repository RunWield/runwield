---
planId: "f9517d6a-5f62-41be-9923-c0bf04b26a32"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/metrics.js"
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/workflow/plan-executor.ts"
    - "src/shared/workflow/state-transition.ts"
    - "src/shared/workflow/validation-helpers.ts"
    - "src/shared/session/plan-association.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T19:28:54.739Z"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 3
dependencies:
    - "02-real-model-usage-across-backends-and-auxiliary-calls"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
userVerifiedAt: null
status: "validated"
validatedCommit: "de5c375392ee3a750256319ad3575ed6354ea3f0"
---

# Workflow Outcome Observations

## Context

Children 01 and 02 are delivered. `recordWorkflowMetric` now writes through the durable journal
(`src/shared/workflow/metrics-journal.ts`): cross-process locking, collection epochs, truthful persistence results, and
torn-write repair. The v2 record contract (`V2_EVENTS` in `src/shared/workflow/metrics.js`) carries stable identity —
`eventId`, `recorderId`, `seq` — for execution, tool, model, context, and command events.

Workflow outcomes are not in that contract. The producers that observe them — `plan-executor.ts`, `state-transition.ts`,
`validation-helpers.ts`, `execution-context.ts`, `implementation-checkpoint.ts`, `validation-context.ts`, and the
orchestrator — still emit v1 records with sanitized free-form details. V1 records have no stable event identity and no
Plan link, so validation attempts and repair rounds cannot be counted as distinct, deduplicated outcomes.

Confirmed publication is the sharpest case. `cleanupStoredPublication`
(`src/shared/workflow/publication-machine.ts:381`) removes the operational attempt record through `pruneEntry` on two
paths — the early `cleanup_complete` return at L390 and the final advance at L482. After either, the evidence that a
delivery was confirmed is gone, and no observation precedes the prune.

The parent Epic requires measurements that report existing outcomes and never create a third conclusion alongside
confirmed publication and deliberate abandonment.

Owning PRD: [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery)
stays authoritative for what concludes delivery. Following child 01's precedent, outcome-meaning requirements extend the
existing **Local workflow metrics** capability (`docs/prd/runwield-core-prd.md#usage-measurement-and-export`) and
reference execution/validation/recovery rather than restating it.

## Objective

Validation attempts, repair rounds, and confirmed publication attempts are each observable as distinct counts, survive
restart, and are recorded before the evidence they describe is pruned. Plan attribution is present when a committed
association exists and absent otherwise.

## Approach

```text
validation attempt ----> v2 workflow-outcome observation (attempt identity, outcome)
repair round -----------> v2 workflow-outcome observation (round identity, distinct from attempt)
confirmed publication --> cleanupStoredPublication
                            retainPublicationCompletion (L368)
                            -> persist publication observation (bounded, awaited, non-fatal)
                            -> pruneEntry            (L390 and L482)
```

New v2 events in `V2_EVENTS`/`V2_EVENT_CATEGORIES` (categories `validation` and `recovery`) record the three outcome
kinds with stable identity: `validation_attempt` (attempt number, outcome), `repair_round` (round identity distinct from
the attempt), and `publication_confirmed` (deterministic `eventId` derived from `attemptId`). `planId` joins `V2_LINKS`
so workflow-outcome observations can carry Plan attribution read from committed associations (`plan-association.ts`) at
observation time. Workflow observations retain the committed transition or confirmed delivery identity, never free-form
error messages.

Both prune paths get the same guarded write:

```text
try persist(publication_confirmed with deterministic eventId from attemptId)
  success -> prune
  failure -> prune anyway; leave incomplete/unverified coverage marker if possible
  repeated cleanup -> same eventId deduplicates; publication is not counted twice
```

Publication is never gated on measurement success. Plan attribution is present when a committed association exists and
absent otherwise; general discussion stays unassigned rather than being spread across every associated Plan.

Set aside: deriving outcomes later from Plan status or transcripts. It would have avoided touching the publication
machine and produced inferred success the Epic forbids. Also set aside: migrating every remaining v1 producer event to
v2 — only outcome-bearing observations move; other v1 records stay readable and unchanged.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/shared/workflow/metrics.js` — new v2 workflow-outcome events (`validation_attempt`, `repair_round`,
  `publication_confirmed`), `planId` in `V2_LINKS`, and the enum values they need.
- `src/shared/workflow/publication-machine.ts` — a bounded, awaited, non-fatal `publication_confirmed` observation
  before `pruneEntry` on both the L390 and L482 paths, with deterministic identity from `attemptId`.
- `src/shared/workflow/plan-executor.ts`, `state-transition.ts`, `validation-helpers.ts`, `execution-context.ts`,
  `implementation-checkpoint.ts`, `validation-context.ts`, `orchestrator.ts` — outcome-bearing observations become v2
  records with stable operation identity and Plan attribution; unrelated v1 events remain unchanged.
- `src/shared/session/plan-association.ts` — read path for optional, time-scoped Plan attribution (no writer changes).
- Review and Guided Review producers that record workflow findings.
- `docs/prd/runwield-core-prd.md` — outcome-meaning requirements and scenarios under **Local workflow metrics**, linking
  execution/validation/recovery rather than restating it.

## Reuse Opportunities

- `retainPublicationCompletion` and `advanceStoredPublication` — the existing pre-prune retention point where the
  observation naturally belongs.
- `plan-association.ts` stable Plan/segment relationships — attribution without new Session ownership.
- `projectAggregateTranscript` (`src/shared/session/session-transcript-manifest.ts`) — its verification rules stay
  authoritative for context and references; it must not become a metrics backfill source.
- The child 01 collection contract, epoch eligibility, and truthful persistence result.
- `src/testing/workflow-metrics-fixture.ts` and `makeValidationProjectRoot` for real Plan projects.

## Implementation Steps

- A failed validation, a repair round, and a confirmed publication for one Plan produce one delivered-attempt
  observation plus separate validation-attempt and repair-round counts.
- Both `pruneEntry` paths in `cleanupStoredPublication` are preceded by an awaited, bounded, non-fatal attempt to
  persist the same stable publication observation.
- Repeated cleanup for one attempt identity does not add a second publication observation.
- A recording failure or process death at publication leaves an incomplete or unverified-coverage indication when
  evidence survives, and never blocks or reverses confirmed publication.
- An interrupted Agent turn is recorded as ongoing work; it is never labeled an abandoned workflow.
- Abandoned figures describe observed delivery workflows only, not every open Session.
- Plan attribution is present only where a committed association covers the observation's time scope; unassigned
  discussion stays unassigned.
- One Session touching multiple Plans attributes each observation to at most the Plans actually associated at that time.
- Tool fan-out is not recorded as model-request fan-out.
- Workflow observations retain the committed transition or confirmed delivery identity, never free-form error messages.
- `docs/prd/runwield-core-prd.md` names the outcome-meaning requirements and scenarios, keeping confirmed publication
  and deliberate abandonment as the only two delivery conclusions.
- The new test files named in the Verification Plan exist, drive real fixtures, and pass; the journal-count and
  attribution assertions are automated, not manual inspection.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/workflow` plus the new test files below; then `deno task ci`.
- `src/shared/workflow/publication-outcome-observations.test.ts`, built on the `publication-machine.test.ts` fixture
  pattern (`defineGitFixture`, `addEntry`, `src/testing/workflow-metrics-fixture.ts`), asserts: after full cleanup the
  journal holds exactly one v2 `publication_confirmed` record whose `eventId` is derived from `attemptId`; the early
  `cleanup_complete` path (an attempt stored at that phase) produces the same single record; a second cleanup invocation
  with the same attempt identity leaves the journal unchanged; and with metrics disabled or an unwritable journal,
  cleanup still completes and prunes while an incomplete/unverified coverage indication survives where evidence allows.
  A fresh-process step (the `publication-revalidation.test.ts` subprocess pattern) proves the observation precedes
  `pruneEntry`: a kill between the observation and the prune leaves the durable observation, and a kill before the
  observation leaves no invented one.
- `src/shared/workflow/workflow-outcome-observations.test.ts` drives a real failed validation and a repair round through
  the existing plan-action-evidence fixture pattern and asserts the journal holds `validation_attempt` and
  `repair_round` as distinct v2 records with distinct identity fields, plus one delivered-attempt observation for the
  confirmed publication. This test fails if the event names are added to `V2_EVENTS` without a producer emitting them.
- An attribution test using a session transcript fixture with committed `runwield.plan_association` entries covering
  disjoint time scopes asserts observations carry `planId` only when the association covers the observation's time, stay
  unassigned otherwise, and attribute a two-Plan Session to at most the Plans actually associated at that time.
- An interrupted turn appears as ongoing; a non-Plan Session produces no undelivered-failure figure.
- Existing protected behavior: current `recordWorkflowMetric` event taxonomy, redaction, and worktree mapping still
  pass; publication still completes when measurement fails. Expected to stop existing: pruning attempt evidence with no
  persisted observation — pinned by the new publication-outcome test above, not by any current test.
- No seam is added for Plan writes, publication state, or journal writes; `deno task seams:check` passes.

## Edge Cases & Considerations

- The metrics journal is not workflow authority. Publication front matter and Git evidence remain truth.
- Optional historical links such as commit references may become unavailable; a measurement stays readable without them.
- A finding is not a prevented defect. Counts stay as observed events with no inferred quality claim.
- Cleanup that keeps a worktree or branch returns `complete: false`; the observation must reflect what was actually
  confirmed, not the cleanup's tidiness.
- `docs/plans/complete-tool-call-metrics.md` remains a separate untouched draft; Planner reconciles overlap and does not
  import its token-denominator scope.
