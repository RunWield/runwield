---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/publication-machine.ts"
    - "src/shared/workflow/plan-executor.ts"
    - "src/shared/workflow/state-transition.ts"
    - "src/shared/workflow/validation-helpers.ts"
    - "src/shared/session/plan-association.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T19:28:54.739Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 3
dependencies:
    - "02-real-model-usage-across-backends-and-auxiliary-calls"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "f9517d6a-5f62-41be-9923-c0bf04b26a32"
---

# Workflow Outcome Observations

## Context

Workflow producers already call `recordWorkflowMetric` from many places — `plan-executor.ts`, `state-transition.ts`,
`validation-helpers.ts`, `execution-context.ts`, `implementation-checkpoint.ts`, `validation-context.ts`, and the
orchestrator. Those calls go through a writer that can silently fail, so the outcomes the owner most wants to count are
the least reliably recorded.

Confirmed publication is the sharpest case. `cleanupStoredPublication`
(`src/shared/workflow/publication-machine.ts:377`) removes the operational attempt record through `pruneEntry` on two
paths — the early `cleanup_complete` return at L385 and the final advance at L473. After either, the evidence that a
delivery was confirmed is gone.

The parent Epic requires measurements that report existing outcomes and never create a third conclusion alongside
confirmed publication and deliberate abandonment.

Owning PRD: [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery)
stays authoritative for what concludes delivery. The **Usage measurement and export** capability gains outcome-meaning
requirements that reference it.

## Objective

Validation attempts, repair rounds, and confirmed publication attempts are each observable as distinct counts, survive
restart, and are recorded before the evidence they describe is pruned. Plan attribution is present when a committed
association exists and absent otherwise.

## Approach

```text
validation attempt ----> observation (attempt identity, outcome)
repair round -----------> observation (round identity, distinct from attempt)
confirmed publication --> cleanupStoredPublication
                            retainPublicationCompletion
                            -> persist publication observation (bounded, awaited, non-fatal)
                            -> pruneEntry            (L385 and L473)
```

Both prune paths get the same guarded write:

```text
try persist(observation with stable attemptId)
  success -> prune
  failure -> prune anyway; leave incomplete/unverified coverage marker if possible
  repeated cleanup -> same attemptId deduplicates; publication is not counted twice
```

Publication is never gated on measurement success. Plan attribution reads existing committed associations; general
discussion stays unassigned rather than being spread across every associated Plan.

Set aside: deriving outcomes later from Plan status or transcripts. It would have avoided touching the publication
machine and produced inferred success the Epic forbids.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/shared/workflow/publication-machine.ts` — a bounded, awaited, non-fatal publication observation before
  `pruneEntry` on both the L385 and L473 paths, deduplicated by attempt identity.
- `src/shared/workflow/plan-executor.ts`, `state-transition.ts`, `validation-helpers.ts`, `execution-context.ts`,
  `implementation-checkpoint.ts`, `validation-context.ts` — existing producers route through the child 01 contract with
  stable operation identity.
- `src/shared/session/plan-association.ts` — read path for optional, time-scoped Plan attribution.
- Review and Guided Review producers that record workflow findings.
- `docs/prd/runwield-core-prd.md` — outcome-meaning requirements and scenarios under **Usage measurement and export**,
  linking execution/validation/recovery rather than restating it.

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

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/workflow` plus focused publication-machine tests; then
  `deno task ci`.
- A real Plan project runs a failed validation, a repair, and a confirmed publication; the journal holds one delivered
  attempt and separate attempt and round counts.
- Kill/restart before the L385 path and before the L473 path each yield exactly one durable publication observation, or
  an explicit incomplete/unverified coverage marker — never a blocked publication and never invented history.
- Re-running cleanup on an already-cleaned attempt adds nothing.
- An interrupted turn appears as ongoing; a non-Plan Session produces no undelivered-failure figure.
- A Session associated with two Plans attributes observations only within each association's time scope; unassociated
  discussion stays unassigned.
- Existing protected behavior: current `recordWorkflowMetric` event taxonomy, redaction, and worktree mapping still
  pass; publication still completes when measurement fails. Expected to stop existing: pruning attempt evidence with no
  persisted observation.
- No seam is added for Plan writes, publication state, or journal writes; `deno task seams:check` passes.

## Edge Cases & Considerations

- The metrics journal is not workflow authority. Publication front matter and Git evidence remain truth.
- Optional historical links such as commit references may become unavailable; a measurement stays readable without them.
- A finding is not a prevented defect. Counts stay as observed events with no inferred quality claim.
- Cleanup that keeps a worktree or branch returns `complete: false`; the observation must reflect what was actually
  confirmed, not the cleanup's tidiness.
- The historical **Complete Tool-Call Metrics** draft named overlapping goals; Planner reconciles them without
  importing its token-denominator scope.
