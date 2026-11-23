---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/constants.ts"
    - "src/agent-definitions/"
    - "src/shared/session/agents.ts"
    - "src/shared/session/subagent-definitions.ts"
    - "src/shared/workflow/product-review.ts"
    - "src/shared/workflow/controller-state.ts"
    - "src/shared/workflow/plan-lifecycle.ts"
    - "src/shared/workflow/plan-review-actions.ts"
    - "src/shared/workflow/sequence-review.ts"
    - "src/plan-store.ts"
    - "src/tools/plan-written.ts"
    - "src/tools/delegate-agent.ts"
    - "src/cmd/load-plan/"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review"
devServerHmr: true
parentPlan: "product-planner-sequence"
order: 2
dependencies:
    - "local-prototype-review"
createdAt: "2026-11-12"
status: "draft"
planId: "5e239ac4-9f0f-4e72-8212-65b1abe4e737"
---

# Product Planner and Technical Handoff

## Context

The owner wants a product-focused partner before technical planning: roughly 90% product judgment and 10% technical
skill. Product Planner makes users, journeys, behavior, scope, visual choices, and trade-offs concrete. Planner or
Architect then decides how to deliver the accepted experience.

This child implements [product-first planning](../prd/product-planner-prd.md#product-first-planning),
[feasibility and product trade-offs](../prd/product-planner-prd.md#feasibility-and-product-trade-offs), and
[product acceptance and technical handoff](../prd/product-planner-prd.md#product-acceptance-and-technical-handoff).
Add their named requirements: direct selection and optional Ideator handoff; product-grounded drafts; independent
feasibility challenge; product-level choices; one agreement between text and experience; separate product acceptance;
continue-or-save; and preservation through Planner or Architect.

The dependency supplies retained prototype revisions and local annotations. This child consumes that contract rather
than introducing another store or review surface. It preserves ordinary technical drafts, approval, execution, Plan
sharing, and Router. No shared prototype review or new Product Planner Connect command is included.

Lasting owners are Core [Agent customization](../prd/runwield-core-prd.md#agent-and-skill-customization),
[Plan authoring](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption),
[Plan review](../prd/runwield-core-prd.md#plan-review), [lifecycle](../prd/runwield-core-prd.md#plan-lifecycle), and
[Epic decomposition](../prd/runwield-core-prd.md#epic-decomposition-and-hold), with browser behavior owned by
[Workspace review](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow).

## Objective

The owner can shape and accept a feasible product proposal, then continue to technical planning or save it for later.
The accepted text and prototype revisions remain identifiable. No product-stage action authorizes implementation, and
no alternate execution entry point can bypass technical submission and normal approval.

## Approach

### Separate the agreement from execution readiness

**Owner decision:** product approval is a separate revision-bound record, not a boolean or a new Plan Status. The Plan
remains `draft` while technical planning is incomplete. Approval preserves agreed journeys, behavior, explicitly approved
visual choices, and aligned requirements. Placeholder data and incidental details remain illustrative.

**Reviewable implementation assumption:** keep product text in one explicit `## Product Agreement` section in the Plan
body, not a second editable copy in YAML or the runtime store. Its subsections hold scope, journeys, states, acceptance
scenarios, approved visual choices, decisions, and uncertainties. Technical sections can grow outside that section.
Use a Markdown-aware section extractor so headings in code fences cannot change its boundary.

Add optional document metadata `planningMode: "product"` and use the preceding child's `prototypes` references. The
marker persists through technical planning; it is not approval. A product draft is marked from its first saved version.
Core cannot treat a marked document with absent or malformed runtime evidence as an ordinary technical draft.

Add `productReview` to the controller-owned fields in `WorkflowControllerState`. It contains a versioned phase
(`product`, `technical`, or `submitted`), immutable acceptance records, and the selected technical Agent when accepted.
Each acceptance record holds an ID, acceptance time, product revision, the accepted Product Agreement text, and exact
prototype references. Historical snapshots are evidence, not an editable second definition.

A single `src/shared/workflow/product-review.ts` owner computes product identity from the agreement text and ordered
prototype references, with stable encoding and line-ending normalization. It does not hash unrelated technical prose,
Plan Status, or timestamps. The selected prototype references cover the whole submitted prototype; changing one requires
renewed acceptance even if the Plan prose is unchanged. Feasibility evidence used for acceptance is linked to that same
product revision. It is evidence for the conversation, not an automatic pass/fail gate.

```text
Product Draft [Plan Status: draft]
  accept + continue -> accepted revision -> Planner or Architect
  accept + save     -> accepted revision -> later continuation to the chosen Agent
Technical planning [Plan Status: draft]
  product change    -> product review, previous acceptance retained as history
  technical submit  -> normal technical Plan/Epic review
Normal approval and readiness -> existing execution or decomposition workflow
```

### Four authoritative operations, one execution rule

Implement these operations in `product-review.ts`, using canonical Plan location, existing document/controller locks,
revision comparisons, and document/controller write support. Do not build another transaction framework.

- `beginProductDraft`: confirms stable identity and the product marker, creates product-review state, and preserves
  lifecycle `draft`. Repeated registration cannot erase accepted evidence or revert a later phase.
- `acceptProductRevision`: compares the exact displayed product revision with the saved definition and selected prototype
  references. It records the immutable acceptance and `planningAgent: "planner" | "architect"`, then enters technical
  phase. Both continue and save leave lifecycle `draft`; only continue dispatches a technical planning turn.
- `submitTechnicalPlan`: requires accepted matching product intent, technical phase, valid technical Plan/Epic structure,
  and the selected technical planning context. Resolve the caller from the trusted hosted-turn/tool context captured by
  `createPlanWrittenTool`, not a tool argument, stored destination, or UI Agent label. It records submitted phase before
  ordinary technical review. Opening
  review, changing Agent, or filling in an execution policy is not submission or implementation approval.
- `reopenProductReview`: uses existing reopen handling, returns to product/draft, and retains earlier acceptances. It
  does not discard an execution worktree or silently reset an active delivery attempt.

Expose a `product_plan` review tool beside `plan_written` rather than treating product acceptance as `run`, `later`, or
`decompose`. It registers marked Product Drafts and opens product review; a named reopen action returns accepted work to
product review through the owner above. It cannot accept on the user's behalf. Add an explicit technical-submission
input to `plan_written` for accepted Product Drafts. Existing calls for ordinary technical Plans remain unchanged.

The shared eligibility rule is: **a product-origin Plan can enter technical approval, readiness, decomposition, or
execution only after explicit technical submission with a matching accepted product revision.** Both document marker
and controller evidence participate in detection: surviving evidence with a removed marker must not unlock execution.
Normal Plans with neither remain compatible. A new prototype alone does not make an ordinary technical Plan product-origin.

Check this rule at shared review actions, manual lifecycle transitions, Sequence review/admission, readiness and
execution preparation, direct executor/start paths, and resume. Callers use one owner for the decision, not copied
phase comparisons. Product acceptance must never emit an existing execution-approved event. Sequence approval must
reject an unfinished Product Draft child before approving or preparing any member.

Ordinary document saves preserve omitted product metadata; null/removal cannot silently erase the restriction. Product
Agreement or prototype changes invalidate eligibility immediately by revision mismatch, even before a planning Agent
processes them. Route deliberate product revision through product review and preserve the old baseline. Technical-only
body edits preserve product acceptance while normal whole-Plan technical approval rules still apply. Protect canonical
writers and review-editor saves, not only toolbar handlers. This is workflow protection, not tamperproof protection from
a user deleting both raw document and controller evidence outside RunWield.

### Product conversation and technical continuation

Add canonical Agent ID `product-planner`, its selectable definition, and a read-only delegated role
`product-feasibility-reviewer`. The role checks facts, dependencies, uncertainty, genuine blockers, and viable
alternatives. It distinguishes absent current support from infeasibility. A requested write delegation is reduced to
read authority by Core. Product Planner reconciles findings and asks product-level questions; the reviewer does not
make owner decisions or design the whole architecture.

Product Planner gathers enough evidence before investing heavily in a prototype and checks feasibility before handoff.
It commonly uses prototypes for visual or interaction questions, but does not invent UI for non-UI requests. It writes
product acceptance scenarios, not fake implementation steps. New product promises require fresh consideration of the
affected feasibility findings. Keep the definition concise and reuse shared user-authority and planning practices.

Ideator offers an optional handoff and carries settled goals and decisions. Direct selection requires no Ideator visit.
Router is unchanged. Planner and Architect receive the accepted agreement, exact prototype references, review context,
feasibility findings, and remaining uncertainty. They must return material product changes for owner agreement rather
than silently substituting a simpler experience. Prototype code is not a production implementation.

In the existing review shell, offer **Accept and continue** and **Accept and save for later** plus the technical destination
**Planner** or **Architect**. Recommend Planner for bounded work and Architect for cross-cutting design; the owner chooses.
This does not reclassify through Router. Show the accepted product revision and technical-planning stage independently
of Plan Status. Reuse existing review controls and design tokens; do not add a new planning dashboard.

Persist the chosen destination and route `load-plan`, review reopening, and Session restart from current saved evidence.
Preserve `planningAgentName`, but do not let an old review reference restore Product Planner after technical handoff.
Old accept/continue responses cannot overwrite a newer revision or start a second conflicting turn. Cancellation or a
failed dispatch leaves accepted intent available for later continuation; it does not advance readiness.

Keep the same `planId` when Architect converts the document into a `PROJECT`. Decomposition children carry a typed
reference to the parent acceptance ID/revision and original prototype owner. Child planning resolves that baseline,
includes the relevant scenarios, and preserves the parent's product restriction until the parent has completed technical
submission. Do not manufacture separate product approvals for unchanged child scope. A parent's material change cannot
silently leave unstarted children executable against a different agreement. Preserve running work and use existing
replanning/Plan Deviation paths for changes found during delivery; do not reset delivery state through document edits.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/constants.ts`, `src/shared/session/agents.ts`, `src/agent-definitions/product-planner.md` — canonical selectable Agent.
- `src/shared/session/subagent-definitions.ts`, `src/tools/delegate-agent.ts`, role definition and registry tests — bounded
  feasibility review with an enforced read-only authority ceiling.
- `src/plan-front-matter.ts`, `src/plan-store.ts`, `src/shared/workflow/controller-state.ts` and controller persistence —
  typed product marker, inherited references, revision-bound acceptance, and safe writes.
- New `src/shared/workflow/product-review.ts`, `src/tools/product-plan.ts`, registry and `plan-written.ts` — authoritative
  product operations, separate review outcomes, and explicit technical submission.
- `plan-review-actions.ts`, `plan-lifecycle.ts`, `plan-actions.ts`, `sequence-review.ts`, `plan-executor.ts`, execution-start,
  `src/cmd/load-plan/`, and `src/shared/attached/coordinator.ts` — shared eligibility across supported entry points.
- Session workflow event/dispatch and saved review-reference modules — continue/save, destination persistence, stale-event handling.
- `src/ui/review/plan-review.ts`, `PlanReviewSurface.tsx`, review decision API/types — product-specific acceptance and stage display.
- Ideator, Planner, Architect, Slicer and Engineer guidance as needed, document formats, and handoff prompts — accepted
  intent stays available through technical planning, decomposition, implementation, and AI review.
- Core/Workspace PRDs, the root PRD's Plan description, transient proposal, `docs/domain-language.md`, `docs/plan-lifecycle.md`, and
  `docs/adr/003-plan-lifecycle-event-module.md` — requirements, terminology, and ownership agree with delivered behavior.

No Router prompt, routing benchmark retuning, shared-prototype server, or external Plan Store migration is in scope.

## Reuse Opportunities

- Canonical Plan IDs, `resolveWorkflowPlanLocation()`, document/controller writes and locks — preserve existing authority.
- `planningAgentName`, existing review feedback and Session workflow dispatch — continue the correct conversation.
- Existing delegated roles and `verification-adversary` authority-ceiling pattern — a distinct feasibility role, not its verdict format.
- Child 1's `PrototypeRevisionRef` and durable feedback — immutable experience evidence, no second asset store.
- Existing Plan/Epic formats and external-draft compatibility — extend product-origin documents only.

## Implementation Steps

1. **Product Drafts have an enforced saved contract.** The product draft format includes `planningMode: "product"`,
   Product Agreement, and optional retained prototype references from first save. `product-review.ts` computes its
   revision and owns all four operations. Controller records retain exact acceptance snapshots and destination. Canonical
   save/update/review-edit paths preserve omitted metadata and cannot remove the gate or forge product acceptance.
   Product edits immediately fail revision matching; technical-only edits do not erase the product baseline.
2. **Core cannot execute an unfinished Product Draft.** The single eligibility owner is used by shared review, low-level
   lifecycle transitions, manual board actions, Sequence admission/approval, readiness, direct load/execution/start,
   attached execution, and resume. Incomplete product children stop Sequence approval before member mutation. Missing or
   malformed product evidence blocks advancement. Ordinary technical drafts still support direct approval/execution.
3. **Product review produces only product outcomes.** `product_plan` opens the existing local review surface with typed
   product outcomes and displayed revision. Both acceptance actions preserve lifecycle `draft` and record the owner's
   selected technical Agent. Continue dispatches planning only; save does not dispatch. Restart and load resume technical
   planning. Stale/duplicate responses cannot overwrite accepted intent or dispatch conflicting turns. `plan_written`
   enters normal technical review only through explicit `submitTechnicalPlan` for product-origin work.
4. **Product Planner and feasibility review work through actual Agent selection and delegation.** The new definition is
   selectable, composes required shared practices, supports direct discovery and useful prototypes, and submits product
   drafts without fabricated technical steps. Ideator offers the optional handoff. The feasibility role is discoverable,
   read-only even when write is requested, and returns supported facts, uncertainties, blockers, and alternatives tied
   to the proposal. Product Planner explains consequential choices and reconsidered findings in product terms.
5. **Accepted intent survives both technical paths.** Planner/Architect receive the accepted text, prototype revisions,
   feasibility evidence, decisions, and unresolved issues. Agent switching alone cannot submit technically. Architect
   conversion preserves `planId`; children retain and resolve the parent acceptance reference and relevant scenarios.
   Technical planning preserves accepted behavior or returns the change to product review. Current saved phase outranks
   stale `planningAgentName`. Replanning retains existing execution work rather than resetting it.
6. **Behavioral tests distinguish product approval from execution approval.** Real saved Plans/controller records exercise
   every bypass named in Verification, both acceptance actions, stale review, product-only versus technical-only edits,
   missing fields, and parent-child inheritance. Agent registry and delegation tests establish selection and authority;
   representative conversations establish prompt behavior rather than only asserting keywords exist.
7. **Product and architectural guidance lands with the workflow.** Update Core's named requirements and scenarios and
   Workspace's browser acceptance flow; keep ordinary technical Plan behavior explicit. Update lifecycle guidance and
   ADR-003 for the separate product gate, without adding a lifecycle status. Update `docs/domain-language.md` definitions,
   avoided aliases, and relationships for Product Planner, Product Draft, Product Acceptance, and Feasibility Review;
   reconcile the proposal's terms rather than creating competing aliases. Consolidate delivered lasting requirements
   from `product-planner-prd.md` into their central owners, preserve deferred shared-prototype intent there, update current
   references, and remove the completed transient PRD. Update `docs/prd/runwield.md#plan` to link to the owning capabilities
   without duplicating requirements. Keep historical Plan/Work Record links historical. No public
   portability documentation or UI limitation messages are added.

## Approval Confirmation

No Work Records are proposed for supersession. The owner confirmed separate revision-bound product approval and both
acceptance actions. The Product Agreement section, permanent document marker, controller field names, and parent-reference
shape are reviewable implementation assumptions. They preserve those decisions without adding a Plan Status.

## Verification Plan

Use the Bun version in the checkout’s root `.bun-version` and run `bun run install:locked` before checks. All RunWield tests use its isolated runner.

- Add `src/shared/workflow/product-review.test.ts` and `src/tools/product-plan.test.ts`; run
  `bun scripts/run-tests.ts src/shared/workflow/product-review.test.ts src/tools/product-plan.test.ts src/plan-store.test.ts`.
  Use real Plan files and controller records, not a fake product-state owner. Accept revision A, append technical sections,
  and verify A remains approved. Change only the prototype reference or Product Agreement and verify execution is blocked
  while A's original text/references remain inspectable. Include omission/null/removal attempts, code-fence headings,
  stale tabs, and restart. A boolean or a whole-Plan hash cannot pass these tests.
- Add a parameterized integration suite `src/shared/workflow/product-execution-guards.integration.test.ts`; run
  `bun scripts/run-tests.ts src/shared/workflow/product-execution-guards.integration.test.ts src/cmd/load-plan/index.integration.test.ts`.
  Exercise real boundaries: `applySharedPlanReviewDecision`, manual Plan actions and `recordPlanEvent`,
  `prepareApprovedPlanForWork`, `plan-executor`, `startActiveExecutionWorkflow`, resume, Sequence review, and attached
  coordinator execution requests. Test product phase, accepted technical phase, missing/malformed evidence, mismatched
  revision, and inherited unfinished parent acceptance. Assert no readiness/decomposition/execution transition, worktree
  execution preparation, or implementation dispatch. For Sequence refusal, assert no earlier child was approved first.
  A hidden-button-only implementation must fail. Keep existing direct ordinary-draft approval tests passing.
- Through the real tool/review/dispatch boundaries, prove accept-and-continue starts Planner and separately Architect,
  never Engineer/Slicer; accept-and-save starts neither and keeps `draft`; a later load selects the saved technical Agent.
  Prove explicit technical submission plus normal technical approval permits the normal next action. Mere Agent change,
  direct review, guessed technical-submit input from Product Planner, or ordinary save cannot do so. A stale review
  reference cannot return a technically handed-off Plan to Product Planner. Duplicate continuation is not a second turn.
- Verify Architect conversion and real decomposition: same parent ID and approval, child reference resolution, relevant
  scenario/prototype context in child planning, no copy into Git, and blocking of unstarted child execution after a
  material parent product change. Preserve active work through the existing replan/deviation path.
- Extend actual Agent registry, shared-practice, delegate-role, and tool registry tests. Verify Product Planner selection,
  optional Ideator handoff, read-only ceiling, and supported tool access. Run representative prompt evaluations for a
  vague request, settled Ideator context, a non-UI request, an unavailable dependency, and an achievable new capability.
  Evidence must show useful product choices and no invented production readiness. Do not alter Router tests or prompts
  to make the new Agent pass routing benchmarks.
- **Headed browser:** use `bun run workspace:dev` at `http://127.0.0.1:5173/dev/plan-review`, then the actual owner review
  route with a saved Product Draft. In an assignment-specific `agent-browser --headed --session <name>` session, inspect
  requirements and a retained prototype, send annotation feedback, revise and accept it. Test both acceptance actions and
  both technical destinations, restart after save, and finish technical submission followed by ordinary review. Verify
  product approval and technical stage are distinct, actions work by keyboard, and narrow-screen controls remain usable.
  Capture screenshots, console errors, and the dispatched Agent/state evidence; a screenshot alone does not prove guards.
- Run `bun scripts/run-tests.ts src/ui/workspace/react/plan-review-behavior.test.tsx src/ui/workspace/plan-workflow-gates.integration.test.ts src/ui/workspace/plan-workflow-resume.integration.test.ts`.
  Preserve review chat without forced revisions, technical approve-for-later/run, ordinary Epic slicing, Sequence review,
  existing Plan sharing, cancellation, and replan worktree preservation. No existing behavior is retired for ordinary
  technical Plans. Verify PRD scenarios, glossary, lifecycle/ADR guidance, and live references agree; shared prototype
  review stays deferred and no Product Planner Connect command is claimed.

## Edge Cases & Considerations

- **Semantic contradiction outside Product Agreement:** hashes cannot detect that technical prose quietly changes the
  experience. Planner/Architect and AI review must compare the plan and implementation to the retained agreement.
- **Existing external Markdown Plans:** no product marker or controller evidence means existing adoption and review
  behavior. A missing technical Agent or corrupt marked state never means execution permission.
- **After acceptance:** product questions can reopen review without losing earlier approval evidence. Unchanged technical
  detail does not require a second product interview; changed accepted intent does.
- **Local-only evidence:** prototype references may fail on another machine. This accepted limitation stays in internal
  PRDs/Plans. No uploads, export, UI warnings, or centralized-store prerequisite are added.
- **Dispatch interruption:** durable accepted intent survives; reuse existing workflow resume behavior. Acceptance is not
  reverted merely because a turn did not start, and failure is not reported as execution completion.
- **Already running work:** retain execution ownership and worktree contents. A product edit is not permission to reset
  delivery metadata or bypass the established Plan Deviation and replanning operations.
