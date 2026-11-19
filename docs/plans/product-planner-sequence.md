---
classification: "PROJECT"
type: "sequence"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.ts"
    - "src/plan-front-matter.ts"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/workflow/"
    - "src/shared/session/"
    - "src/tools/plan-written.ts"
    - "src/cmd/load-plan/"
    - "src/ui/review/"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/routes/api/"
    - "src/agent-definitions/"
    - "src/skills/prototype/"
    - "third_party/plannotator/packages/ui/components/html-viewer/"
    - "docs/domain-language.md"
    - "docs/prd/product-planner-prd.md"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-11-12"
status: "draft"
planId: "2ad27add-9bf4-476e-bd94-43e1ba32bab7"
---

# Product Planner and Local Prototype Review

## Context

The owner requested a Sequence with separate work for local prototype review and Product Planner. The
[Product Planner PRD](../prd/product-planner-prd.md) owns the agreed product direction. The two complete child Plans below
implement the local review capability first, then Product Planner and guarded technical handoff.

**Required:** retained prototypes, local Plannotator HTML annotations, owner/Agent iteration, product acceptance,
independent feasibility review, and handoff to Planner or Architect. Prototype visuals and UX express accepted intent;
prototype code is not production-ready.

**Excluded:** prototype files in repository commits, cross-machine prototype portability, prototype uploads to the Plan
share server, review by other people, Replica Hub, full Plannotator Artifact Server, and Router changes. Existing Plan
sharing and technical Plan execution remain supported. Do not add UI messaging about these missing capabilities.

Owning capabilities:

- [Proposal: interactive prototype review](../prd/product-planner-prd.md#interactive-prototype-review) and
  [retention](../prd/product-planner-prd.md#prototype-retention-with-the-plan).
- [Proposal: product-first planning](../prd/product-planner-prd.md#product-first-planning),
  [feasibility](../prd/product-planner-prd.md#feasibility-and-product-trade-offs), and
  [acceptance and handoff](../prd/product-planner-prd.md#product-acceptance-and-technical-handoff).
- [Core Plan authoring](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption),
  [review](../prd/runwield-core-prd.md#plan-review), and [lifecycle](../prd/runwield-core-prd.md#plan-lifecycle).
- [Workspace browser review](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow).

## Objective

Deliver two ordered child Plans, reviewed as one Sequence:

1. [**Retained prototypes and local review**](local-prototype-review.md) — Plan-associated prototype versions, local HTML
   interaction and annotations, named screen/state context, feedback through the existing review conversation, and
   lifecycle-compatible retention. Execution owner: `frontend-engineer`; collaboration: `pair` for interaction and visual
   review. This child proves local review and retention before Product Planner is introduced.
2. [**Product Planner and technical handoff**](product-planner-workflow.md) — selectable Agent, read-only feasibility
   reviewer, optional Ideator handoff, separate revision-bound product acceptance, and guarded technical planning.
   Depends on `local-prototype-review`. Execution owner: `engineer`; collaboration: `autonomous` because the cross-surface
   workflow and acceptance rules are specified.

The second child consumes the first child's reference and feedback types. No shared-review child is in scope. The
Sequence is reviewed as one change. Neither adopting Replica Hub nor adding the full Plannotator Artifact Server is
needed; either would introduce another storage and serving platform.

## Vertical Slice Findings

### Existing interfaces can carry the local review experience

The checked-out Plannotator source contains `HtmlViewer`, with controlled annotations, interaction/annotation modes,
pinpoint comments, text selection, and unanchored-target reporting. RunWield's Plan review currently renders Markdown,
not this HTML component.

```text
PlanReviewSurface
  HtmlViewer                         proposed prototype view
  sendPlannerMessage                 existing owner conversation
    buildPlanReviewFeedback
      reviewDenyApi
        buildPlanConversationRequest
          current planning Agent
```

Typed prototype context must travel through that path. Element selectors and geometry are not sufficient to identify a
simulated state such as an empty cart. Raw HTML mode does not automatically capture application state.

### Retention is not supplied by the current preview or revision machinery

`src/plan-store.ts` and `resolveWorkflowPlanLocation()` own document identity and location. Registered planning and
execution worktrees can own the current Plan. Existing transfers materialize Markdown and do not generally transfer
associated HTML bundles. `epic-artifacts.ts` is a narrow precedent for named companion documents, not a general store.

Archive and restore move Markdown and selected Epic companions. `deleteArchivedPlanUnit()` refuses unexpected
non-Markdown files or subdirectories. The selected local-only approach must not place prototype folders in those
repository archive units. Associate local prototype retention with the Plan's lifecycle instead.

`getPlanRevisionForText()` hashes Markdown; it does not retain content. Current review versions are partly in memory,
and browser draft annotations use a Plan-text fingerprint. Code Review widgets use temporary files deleted on cleanup.
None is the required durable prototype owner.

### Product drafts need runtime protection

`src/cmd/load-plan/index.integration.test.ts` explicitly proves that an ordinary draft can approve for later or approve
and start execution without another planning turn. This remains valid for existing technical Plans.

The proposed Product Draft must be distinguishable in canonical saved Plan data. Product acceptance must not flow into
`run`, `later` readiness, or Epic decomposition. Review, manual board transitions, readiness, Sequence admission, and
execution/resume must observe the same restriction. A hidden button or Agent instruction alone is insufficient.

### Independent feasibility review fits an existing pattern

`src/shared/session/subagent-definitions.ts` already defines delegated roles and read-only authority ceilings.
Product feasibility can use a distinct role beside `verification-adversary`, without a new Agent-host system or copied
adversary verdict. Product Planner owns the product conversation; the reviewer supplies evidence and constraints.

## Decisions and Child Contracts

### Prototype storage and portability

**Owner decision:** keep prototype files local and out of repository commits for this MVP. Associate them with the
existing `planId`; Plan references do not carry prototype bytes into Git. Do not force-add generated prototypes or build
a Git transfer/export mechanism. Private conversation and unsent review notes also remain local.

**Accepted known problem:** copying or cloning the Plan to another machine can leave its prototype references unusable.
The owner accepts that limitation until the separate centralized Plan Store work resolves portability. Record it in the
internal PRD and implementing Plans only. Add no UI capability notices, missing-prototype warnings, or portability
banners for this limitation, and no public user-documentation work for it.

Local-only storage does not waive same-machine retention: restarting the Session, switching Agents, or moving between
registered planning/execution worktrees must keep access to the retained local prototype. Temporary preview cleanup
must not remove it. Route storage access through the existing project-runtime owner and stable Plan identity, rather
than copying assets into each checkout or placing them in disposable preview directories. The first child owns a named runtime-layout path and `plan-prototypes.ts` interface; UI callers never construct physical
paths. Its reviewable retention assumption preserves local material through archive/restore and removes it on explicit
deletion/prune only when no surviving active or archived Plan refers to it.

The owner reports that centralized Plan Store work is in progress. Its [Epic](external-plan-store.md) and
[ADR-019](../adr/019-home-project-state-and-launch-mode-ownership.md) still describe a proposed target in this checkout;
do not mistake that target for current implementation. This Sequence neither waits for nor implements that migration.
Keep physical storage decisions localized so the later store work can relocate assets without a new prototype-review
workflow.

### Prototype revision and state context

**Selected approach:** retain sealed submitted prototype revisions, not every authoring keystroke. The first child
exports `PrototypeRevisionRef` with owning `planId`, `prototypeId`, and `revisionId`. A Plan's optional `prototypes` list
selects review material; children can reference the original owning Plan without copying files.

Bind comments to the exact revision, current named screen/state, anchor, and original element/text context. The generated
HTML updates declared root screen/state attributes as interaction changes the display. The annotation bridge captures
and validates those values for the pending comment and current frame load. Earlier comments stay on their original
revision. Named-state initialization can reopen the example; arbitrary browser replay and universal screenshots are not
required.

A prototype-only revision must be a real reviewed-product change even when Plan prose stays identical. The design must
include prototype references in review/acceptance identity and avoid silently mutating an accepted prototype version.

### Contained HTML execution

**Constraint from the PRD:** use self-contained, simulated experiences, not live production applications or proxy mode.
Keep prototype execution separate from review credentials and unrelated Project data.

The actual `HtmlViewer` removes document-authored Content Security Policy meta tags before inserting its annotation
bridge. Therefore, putting a restrictive policy inside generated HTML is not sufficient. The first child adds an opt-in host policy before author content on the existing sandboxed `rawHtml` path and forces
non-live bridge behavior. It permits self-contained scripts/styles and embedded images while denying resource loads,
connections, and privileged frame actions. Frame self-navigation needs separate checks and is not covered by a universal
no-network promise. Verify credential isolation and unauthorized-action rejection in a real browser; Happy DOM is not
proof of containment.

### Product acceptance and technical handoff

**Selected approach:** keep lifecycle `draft` and add a durable distinction for product-stage work. Preserve existing
technical drafts and statuses. Product acceptance records the reviewed product intent and authorizes technical planning,
not execution. Technical completion must be an explicit authoritative operation, not inferred from opening a Plan or
changing the active Agent. Ordinary edits must not silently remove the product-only restriction.

Continue enriching the same Plan identity where possible. If Architect develops an Epic, preserve the product
agreement and prototype references through that conversion and child planning. Reopened product review returns to
Product Planner; completed technical handoff must not be undone by an old review reference.

The second child specifies a persistent `planningMode: product` document marker and a single Product Agreement section.
Controller-owned `productReview` records the phase, immutable accepted text/prototype snapshots, and chosen technical
Agent. Product identity excludes unrelated technical prose. The field names and section boundary are reviewable
implementation assumptions, not new lifecycle statuses.

Four authoritative operations begin product drafting, accept a revision, submit technical work, and reopen product
review. One shared eligibility rule blocks technical approval/readiness/execution until explicit technical submission
matches accepted intent. Do not reuse `Approve for Later`, which currently prepares a Plan for execution.

**Owner decision:** offer both acceptance-and-continuation into technical planning and acceptance saved for later. Both
preserve the accepted product revision; neither approves implementation. A saved acceptance resumes at technical
planning, not execution.

**Owner decision:** record revision-bound product approval separately from Plan lifecycle; it is not a boolean.
The Plan stays `draft` while technical planning is incomplete. The review can show “Product approved — technical
planning pending.” Keep the approved product baseline and prototype revisions identifiable; a bare boolean is not
sufficient. Technical additions must not erase product acceptance solely because the overall Plan text changed.
Changes to accepted product intent require renewed product agreement, as specified in the PRD.

Do not add a `product_approved` lifecycle state. Product approval must remain inspectable after technical planning
changes the Plan's lifecycle. Core readiness and execution guards still enforce technical-planning completion.

## Expected Change Surface

The boundaries this Epic is expected to touch. This list is guidance, not an allowlist: each child Plan verifies the
real footprint during implementation and changes whatever its Implementation Steps need. Discovery that changes approved
intent — another subsystem joins the Epic, public behavior or architecture shifts, migration risk grows — comes back to
the user, not to the file list.

- `src/plan-store.ts`, Plan metadata, project-runtime layout, and workflow Plan-location modules — associate retained
  local prototypes with stable Plan identity across same-machine worktrees and lifecycle operations; keep prototype
  bytes out of Plan commits and protect product-only drafts.
- `src/ui/review/plan-review.ts`, `PlanReviewSurface.tsx`, feedback types and review handlers — expose retained HTML and
  carry typed revision/state annotations through the existing owner conversation.
- `third_party/plannotator/packages/ui/components/html-viewer/` — reuse the current HTML viewer and bridge; determine
  the focused host-facing containment change without adopting its server or live-app mode. The dependency publication
  choice is recorded for owner decision in the first child.
- `src/shared/workflow/`, `src/cmd/load-plan/`, and `src/tools/plan-written.ts` — keep product acceptance separate from
  technical approval across direct review, Sequence actions, execution, and resume.
- `src/shared/session/`, `src/constants.ts`, and Agent Definitions — selectable Product Planner, feasibility role,
  appropriate review continuation, and Ideator/Planner/Architect handoff guidance. Router is unchanged.
- `src/skills/prototype/` and document formats — distinguish retained Plan Prototypes from disposable scratch experiments
  and product drafts from execution-ready technical Plans.
- `docs/domain-language.md`, owning Core/Workspace capabilities, and affected ADRs — document delivered changes with
  their child, without promoting the proposed external-store architecture or shared prototype review.

## Reuse Opportunities

- `HtmlViewer`, `useHtmlAnnotation`, persisted HTML anchor utilities, and `AnnotationPanel` — existing annotation UI.
- `sendPlannerMessage`, `buildPlanReviewFeedback`, `reviewDenyApi`, and `buildPlanConversationRequest` — review iteration.
- `resolveWorkflowPlanLocation`, existing `planId`, project-runtime layout, and Plan-store archive/restore operations —
  authoritative Plan association and same-machine local retention, without Git asset transfer.
- Existing delegated-role loader and authority ceiling — independent read-only feasibility review.
- Existing selectable Agent discovery and `planningAgentName` review references — selection and conversation continuity.

## Verification Plan

Each linked child includes focused commands and concrete behavior checks. Use Bun 1.4.3, `bun run install:locked`, and
the isolated test runner; no direct `bun test` and no test-only seams. The Sequence itself is not executable.

Child 1 updates Core retention and Workspace local-review capabilities. Child 2 completes product planning/acceptance,
proves the cross-child journey, consolidates lasting requirements into their central PRDs, preserves shared-prototype
intent as deferred, and removes the completed transient proposal. Glossary and affected ADR updates land with each
child's implemented behavior.

### Outcome Evidence

- **Local review:** an owner opens a retained multi-state prototype, switches between interaction and annotation, sends
  text and pinpoint feedback, receives a relevant Agent reply, and reviews a revision without a Plan share server.
- **Revision truth:** an annotation on an empty state remains tied to the exact reviewed version after the Agent changes
  the control and after Session restart. A prototype-only change cannot retain stale product acceptance.
- **Retention:** retained local prototypes remain accessible across same-machine planning/execution worktrees and
  Session restart; active material survives preview cleanup; rename, archive, restore, and prune preserve the selected
  local retention policy without losing unrelated files.
- **Local-only scope:** inspect actual workflow commits and delivered files to confirm prototype bytes are absent.
  Internal docs record unusable references on another machine as an accepted limitation. No new missing-capability,
  missing-prototype, or portability UI messaging is added; no cross-machine success is claimed.
- **Containment:** rendered prototype interactions and annotations work while real-browser probes confirm denied access
  to review credentials, unrelated files, and forbidden external effects.
- **Product-only guard:** review, manual transitions, Sequence actions, direct execution, and resume cannot execute a
  Product Draft. Ordinary technical drafts retain their existing direct-approval behavior.
- **Product workflow:** direct Product Planner selection and optional Ideator handoff preserve decisions; a real
  feasibility finding produces a product trade-off; acceptance reaches Planner or Architect without starting delivery.
- **Documentation:** delivered terminology, owning PRD scenarios, and applicable ADRs agree; shared prototype review
  stays deferred. Preserve the proposal's unmet intent when consolidating it.
- **Compatibility:** Markdown annotations, queued feedback, direct edits, ordinary technical-draft approval/run/save,
  Epic slicing, Sequence execution, existing Plan sharing, and replan worktree preservation retain their behavior. No
  existing technical behavior is retired. Only product-origin drafts receive the additional technical-submission gate.

## Edge Cases & Considerations

- **Local-only MVP:** prototypes do not travel with repository commits. Broken references on another machine are an
  accepted known problem for later centralized Plan Store work; document this internally, without UI notices.
- **Prototype code is not production code:** retaining it for review does not approve source reuse or production safety.
- **Existing Plan compatibility:** no mandatory prototype, new status, or technical-planning turn for ordinary Plans.
- **Unknown/deleted annotation targets:** keep original context visible; do not silently reassign feedback.
- **External-host compatibility:** enforce product-stage guards in shared Core actions without claiming a new Product
  Planner Connect command. The separate Connect Ideator/Guide Plan is not a prerequisite for local Agent selection.
- **No shared prototype implementation:** do not add upload, remote review, or participant Agent-control work.
- **Architectural maintenance:** reconcile affected accepted Plan ownership/archival ADRs in the implementing change.
  Do not accept or implement ADR-019 as a side effect of this Sequence.
