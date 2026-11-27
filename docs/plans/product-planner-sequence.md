---
classification: "PROJECT"
type: "sequence"
complexity: "HIGH"
affectedPaths:
    - "packages/plans/"
    - "packages/agents/"
    - "packages/tools/definitions/"
    - "src/plan-store/"
    - "src/shared/workflow/"
    - "src/shared/session/"
    - "src/tools/plan-written.ts"
    - "src/cmd/load-plan/"
    - "src/ui/review/"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/routes/api/"
    - "src/agent-definitions/"
    - "src/skills/prototype/"
    - ".gitmodules"
    - "third_party/plannotator"
    - "third_party/plannotator-revision.txt"
    - "package.json"
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

Deliver three ordered child Plans, reviewed as one Sequence:

1. [**Plannotator integration pin**](plannotator-integration-pin.md) — combine upstream PRs #3907 and #4032 on the
   owner's fork, pin RunWield to that commit, and adapt RunWield to the much newer Plannotator source. Execution owner:
   `engineer`; collaboration: `autonomous`, with before/after review screenshots.
2. [**Retained prototypes and local review**](local-prototype-review.md) — Plan-associated prototype versions, local HTML
   interaction and annotations, named screen/state context, feedback through the existing review conversation, and
   lifecycle-compatible retention. Execution owner: `frontend-engineer`; collaboration: `pair` for interaction and visual
   review. Depends on `plannotator-integration-pin`. This child proves local review and retention before Product Planner
   is introduced.
3. [**Product Planner and technical handoff**](product-planner-workflow.md) — selectable Agent, read-only feasibility
   reviewer, optional Ideator handoff, separate revision-bound product acceptance, and guarded technical planning.
   Depends on `local-prototype-review`. Execution owner: `engineer`; collaboration: `autonomous` because the cross-surface
   workflow and acceptance rules are specified.

The third child consumes the second child's reference and feedback types.

### Epic Scope Changes

- Added `plannotator-integration-pin` as the first child. The owner chose to build on both open upstream PRs now through
  a fork integration branch. The pin update moved out of `local-prototype-review` because it is a large, separately
  verifiable upgrade (11,217 upstream commits since the current pin). No shared-review child is in scope. The
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

The home Plan Store is on `main` and is the default for local Projects. Plans live under
`~/.wld/projects/<projectId>/plans/<name>/`, outside every checkout. `src/plan-store/index.ts` is the only public
interface; `openProjectPlanStore(projectId)` reads by Plan ID and refuses stale writes. Worktrees read the same store,
and archive records facts without moving package directories.

The store's existing artifacts are a fixed, mutable, Markdown-only list (`manual-qa.md`, `integration-report.md`).
Package metadata accepts only known keys, and rename, prune, and delivery copies handle only the named Markdown
documents. Prototypes therefore need a package format change and deliberate support in those operations.
`docs/plans/runwield-package-architecture.md` already assigns "artifact content and references" to `packages/plans`.

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

`packages/agents/isolated.ts` already defines delegated roles (`DelegatedRoleId`) and read-only authority ceilings.
Product feasibility can use a distinct role beside `verification-adversary`, without a new Agent-host system or copied
adversary verdict. Product Planner owns the product conversation; the reviewer supplies evidence and constraints.

## Decisions and Child Contracts

### Prototype storage and portability

**Owner decision:** keep prototype files local and out of repository commits for this MVP. Associate them with the
existing `planId`; Plan references do not carry prototype bytes into Git. Do not force-add generated prototypes or build
a Git transfer/export mechanism. Private conversation and unsent review notes also remain local.

**Accepted known problem:** another machine does not have this machine's home store, so prototype references can be
unusable there. The owner accepts that limitation until a hosted Plan Store driver serves the same artifact operations.
Record it in the
internal PRD and implementing Plans only. Add no UI capability notices, missing-prototype warnings, or portability
banners for this limitation, and no public user-documentation work for it.

Local-only storage does not waive same-machine retention: restarting the Session, switching Agents, or moving between
registered planning/execution worktrees must keep access to the retained local prototype. Temporary preview cleanup
must not remove it.

**Owner decisions:** integrate with the home Plan Store now on `main`. Prototypes live in the Plan's own package folder
(`prototypes/`), linked by a new accepted `prototypes` metadata key with a package format version change. UI, tools, and
Workspace use `ProjectPlanStore` operations and never construct paths. Rename moves the folder with the package; archive
leaves it in place; prune deletes it with the Plan family. Delivery copies carry only Markdown documents, and Shared
Spaces carry only the body.

`docs/plans/external-plan-store.md` (still `draft`) and ADR-019 (still `proposed`) lag the delivered code. Updating
their status is outside this Sequence.

### Prototype revision and state context

**Selected approach:** retain sealed submitted prototype revisions, not every authoring keystroke. The local-review child
exports `PrototypeRevisionRef` with owning `planId`, `prototypeId`, and `revisionId`. The current review set is the
latest non-retired revision of each prototype for the Plan, so no Plan document field is needed. Children can reference
the original owning Plan without copying files.

Bind comments to the exact revision, current named screen/state, anchor, and original element/text context. The generated
HTML updates declared root screen/state attributes as interaction changes the display. The annotation bridge captures
and validates those values for the pending comment and current frame load. Earlier comments stay on their original
revision.

**Owner decision:** comments are not stored. As in Plan review today, comments sent during review go to the planning
Agent, and only annotations queued at approval or product acceptance are forwarded to the next Agent through the
existing approval-context path, carrying their typed prototype context. Named-state initialization can reopen the example; arbitrary browser replay and universal screenshots are not
required.

A prototype-only revision must be a real reviewed-product change even when Plan prose stays identical. The design must
include prototype references in review/acceptance identity and avoid silently mutating an accepted prototype version.

### Contained HTML execution

**Constraint from the PRD:** use self-contained, simulated experiences, not live production applications or proxy mode.
Keep prototype execution separate from review credentials and unrelated Project data.

The actual `HtmlViewer` removes document-authored Content Security Policy meta tags before inserting its annotation
bridge. Therefore, putting a restrictive policy inside generated HTML is not sufficient. Upstream PR #3907 adds
`resourcePolicy="self-contained"`, which installs a host policy before author content on the sandboxed `rawHtml` path
and forces non-live bridge behavior. The local-review child uses it. It permits self-contained scripts/styles and embedded images while denying resource loads,
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

The Product Planner child adds a Plan Store-owned **product record** to the package (a new accepted metadata key) and a single Product Agreement section in the body. The record holds the phase, the
chosen technical Agent, and acceptance records that point at a frozen Plan Store milestone copy and exact prototype
revisions;
its existence marks a Plan as product-origin. The eligibility rule lives in `@runwield/plans` lifecycle policy, which
the store's review, event, Sequence, and execution-reservation commands already apply. Product identity excludes
unrelated technical prose. Field names and section boundary are reviewable assumptions; no Plan Status is added.

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

- `packages/plans/` and `src/plan-store/` — prototype artifact operations and the product record behind the public store
  interface; one lifecycle-policy eligibility rule; prototypes excluded from delivery copies and Shared Spaces.
- `src/ui/review/plan-review.ts`, `PlanReviewSurface.tsx`, feedback types and review handlers — expose retained HTML and
  carry typed revision/state annotations through the existing owner conversation.
- `.gitmodules`, `third_party/plannotator` pin, `package.json`/`bun.lock`, and Plannotator-backed review code — pin and
  adapt to a fork commit with two upstream options (resource restrictions,
  [PR #3907](https://github.com/backnotprop/plannotator/pull/3907); displayed annotation context,
  [PR #4032](https://github.com/backnotprop/plannotator/pull/4032)). Reuse the HTML viewer and bridge without adopting
  its server or live-app mode. No Plannotator source is edited inside RunWield. **Owner decision:** contribute them upstream from `gandazgul/plannotator` and build now on a fork
  integration branch that carries both. The first child owns the pin; return to upstream after both merge.
- `src/cmd/load-plan/`, `src/shared/workflow/execution-start.ts`, `packages/tools/definitions/`, and
  `src/tools/plan-written.ts` — route by product phase; separate product outcomes; explicit technical submission.
- `packages/agents/` (role IDs, registry, definitions, delegated roles) — selectable Product Planner, feasibility role,
  and Ideator/Planner/Architect handoff guidance. Router is unchanged.
- `src/skills/prototype/` and document formats — distinguish retained Plan Prototypes from disposable scratch experiments
  and product drafts from execution-ready technical Plans.
- `docs/domain-language.md`, owning Core/Workspace capabilities, and affected ADRs — document delivered changes with
  their child, without promoting shared prototype review or a hosted store driver.

## Reuse Opportunities

- `HtmlViewer`, `useHtmlAnnotation`, persisted HTML anchor utilities, and `AnnotationPanel` — existing annotation UI.
- `sendPlannerMessage`, `buildPlanReviewFeedback`, `reviewDenyApi`, and `buildPlanConversationRequest` — review iteration.
- `openProjectPlanStore`, Plan IDs, store locks/revision checks, lifecycle policy, and retention/prune commands —
  authoritative Plan association and same-machine local retention, without Git asset transfer.
- Existing delegated-role loader and authority ceiling — independent read-only feasibility review.
- Existing selectable Agent discovery and `planningAgentName` review references — selection and conversation continuity.

## Verification Plan

Each linked child includes focused commands and concrete behavior checks. Use the Bun version in the checkout’s root `.bun-version`, `bun run install:locked`, and
the isolated test runner; no direct `bun test` and no test-only seams. The Sequence itself is not executable.

The pin child changes no product requirements. The local-review child updates Core retention and Workspace local-review
capabilities. The Product Planner child completes product planning/acceptance,
proves the cross-child journey, consolidates lasting requirements into their central PRDs, preserves shared-prototype
intent as deferred, and removes the completed transient proposal. Glossary and affected ADR updates land with each
child's implemented behavior.

### Outcome Evidence

- **Local review:** an owner opens a retained multi-state prototype, switches between interaction and annotation, sends
  text and pinpoint feedback, receives a relevant Agent reply, and reviews a revision without a Plan share server.
- **Revision truth:** an annotation on an empty state reaches the Agent tied to the exact reviewed version, and stays
  so after the Agent changes the control. Annotations queued at approval reach the next Agent with the same context;
  the Plan Store holds no comment records. A prototype-only change cannot retain stale product acceptance.
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
  accepted known problem until a hosted Plan Store driver exists; document this internally, without UI notices.
- **Prototype code is not production code:** retaining it for review does not approve source reuse or production safety.
- **Existing Plan compatibility:** no mandatory prototype, new status, or technical-planning turn for ordinary Plans.
- **Unknown/deleted annotation targets:** keep original context visible; do not silently reassign feedback.
- **External-host compatibility:** enforce product-stage guards in shared Core actions without claiming a new Product
  Planner Connect command. The separate Connect Ideator/Guide Plan is not a prerequisite for local Agent selection.
- **No shared prototype implementation:** do not add upload, remote review, or participant Agent-control work.
- **Architectural maintenance:** update `src/plan-store/README.md`, the package architecture Plans row, and the accepted
  home-runtime ADR in the child that adds each store capability. Reconciling ADR-019's status is separate work.
