---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/shared/workflow/publication-attempt.ts"
    - "src/shared/isolated-publication.ts"
    - "src/shared/work-records/"
    - "src/shared/worktree.js"
    - "src/shared/worktree-registry.js"
    - "src/ui/review/review-launcher.ts"
    - "src/ui/workspace/"
    - "src/shared/attached/"
    - "src/attached/claude/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-connect-prd.md"
executionAgent: "engineer"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/code-review"
devServerHmr: true
createdAt: "2026-10-07T03:22:48.414Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 7
dependencies:
    - "05-validate-with-claude-owned-review-and-repair-workers"
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "bcbc44f4-cbec-4b05-990c-a2631b0f3b5a"
---

# Publish validated work and record the outcome

## Context

Child 5 reaches the shared pre-publication checkpoint. Core's `publishOnce` prepares recording artifacts before artifact
sealing and Git publication. Recording cannot be deferred to a later child or supplied by a no-op handoff without
leaving a hidden Core-owned Recorder turn in the Attached path.

Core owns [execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) and
[Work records](../../prd/runwield-core-prd.md#work-records). Connect owns
[artifact privacy](../../prd/runwield-connect-prd.md#artifact-privacy-and-records), host reasoning, and ordinary-use
restoration. [ADR-016](../../adr/016-proof-bearing-publication-state-machine.md) and the validation authority matrix
govern publication evidence.

## Objective

After this child, the runtime FEATURE journey works end to end: an installed Claude user can activate, plan, review,
implement, validate, complete configured code review, publish, produce a Work Record and eligible memory outcome,
recover supported interruptions, and return to ordinary Claude use. Child 7 still must establish integrated release
evidence and final Preview distribution/support claims.

## Approach

Use the shared engine's optional code-review and publication sequencing. Extend durable review identity to bind actual
candidate evidence. Claude owns any recording or publication-repair reasoning; Core validates and persists resulting
artifacts through existing authorities.

```text
validated candidate → configured code review → recording preparation
→ artifact seal → safeguarded publication → proven delivery → cleanup and closure
```

The staged lifecycle and artifact state are not externally claimed as successful delivery until publication evidence
proves it. Do not move recording outside the existing publication protocol or copy its state machine into Attached.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- Shared code-review/publication phase modules and publication authorities — existing gate order, evidence
  reconciliation, and cleanup.
- `src/shared/work-records/` and memory candidate flows — host-owned synthesis, canonical persistence, provenance, and
  eligible knowledge outcomes.
- `src/ui/review/review-launcher.ts` and Workspace review handlers — durable candidate-bound code-review decisions.
- `src/shared/attached/` and Claude carriers — recording, interaction, publication repair actions, and terminal closure.
- Worktree/registry services and owning Core/Connect scenarios — publication and retained recovery evidence.

## Reuse Opportunities

- `runValidatedReviewerPhase`, `publishOnce`, publication-attempt authority, and isolated publication — canonical
  review-to-delivery sequencing.
- Work Record generation/persistence and memory eligibility flows — artifact-driven provenance without transcript
  ingestion.
- Child 3 durable review and child 5 durable engine host actions — code review, recording, and repair continuation.

## Implementation Steps

1. Configured code review uses Plannotator and durable candidate-bound decisions. Approval cannot apply to a changed
   candidate; feedback returns through shared repair/re-verification rules. Manual acceptance remains distinct from
   automated evidence.
2. Recording preparation requests a bounded Claude-owned Recorder action and accepts structured synthesis against
   canonical request/artifact/evidence references. Core owns Work Record and memory provenance, eligibility,
   persistence, and deduplication; no hidden HostedSession or raw transcript import remains in this Attached path.
3. Shared publication seals required artifacts and applies existing Git/worktree safeguards. Externally visible Verified
   and successful closure require proven publication; local validation, staging, host prose, or a successful subprocess
   alone cannot claim delivery.
4. Fresh-process recovery reconciles artifact preparation, sealing, publication attempts, uncertain Git effects, and
   cleanup. Accepted decisions/artifacts are not repeated. Internal repair is automatic; unresolved external uncertainty
   or consequential choices produce durable, actionable waits.
5. Cancellation, failed publication, retry limits, or quota exhaustion preserve continuation. Only confirmed successful
   publication or deliberate user abandonment concludes delivery. Safe closure removes active host restrictions without
   deleting canonical Plan, Work Record, worktree, or recovery evidence.
6. Owning Core and Connect scenarios and references describe implemented publication, recording, memory, privacy, and
   closure behavior. The complete Preview release remains unclaimed until child 7 verifies the combined journey.

## Verification Plan

- Automated: run
  `deno run -A scripts/run-tests.js src/shared/attached/ src/attached/claude/ src/shared/workflow/validation-publication.test.ts src/shared/workflow/publication-machine.e2e.test.ts src/shared/workflow/publication-machine.failure-matrix.test.ts src/shared/workflow/publication-revalidation.test.ts src/shared/workflow/validation-work-record-handoff.test.ts src/ui/review/code-review.test.ts`.
- Automated: kill Core before/after recording acceptance, artifact sealing, publication effects, and cleanup. Resume
  fresh and compare canonical publication evidence, Plan lifecycle, record identity, and memory outcomes. Forge
  merge/recording claims and alter candidates after review; guards must reject them.
- Headed browser: exercise configured code review at the real `/review/code` endpoint, submit Feedback, resume
  repair/re-verification, approve the current candidate, and restore a pending review after host shutdown. Confirm
  endpoints stop with Claude. `deno task workspace:dev` provides the HMR fixture at
  `http://127.0.0.1:5173/dev/code-review`, not integrated recovery proof.
- Black-box: complete a real FEATURE through proven publication and inspect its canonical Work Record and eligible
  memory result. Send ordinary prompts afterward. Instrument all model-call origins and seed private host-conversation
  sentinels; no sentinel may appear in persistent state, records, indexes, or telemetry.
- Expected: Verified retains the same meaning as Core, Work Records derive from structured evidence, and recovery
  preserves work without blind replay. Existing Core publication, code-review, record provenance, and memory eligibility
  behavior remain protected.
- Verify PRD and authority references match delivered behavior. Use the current design system for any visible review
  changes; substantial UI scope must be assigned to Frontend Engineer by Planner.

## Edge Cases & Considerations

- Recording may change publication artifacts after validation; preserve the existing sealing and revalidation rules
  rather than silently treating every artifact change as implementation.
- Memory eligibility does not mean every workflow must create a new memory; the outcome must truthfully record what was
  eligible and persisted.
- Merge conflicts, target movement, or uncertain publication require evidence reconciliation and supported continuation,
  not destructive reset.
- Cleanup failure must preserve recoverable files and truthful delivery evidence. Closing Claude never implies
  abandonment.
