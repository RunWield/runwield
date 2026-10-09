---
planId: "d5f5e7cb-fcef-4407-b4a4-8b715924f5a9"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/agent-definitions/planner.md"
    - "src/agent-definitions/document-formats/"
    - "src/tools/plan-written.ts"
    - "src/plan-store.js"
    - "src/plan-front-matter.js"
    - "src/shared/workflow/"
    - "src/shared/session/"
    - "src/ui/review/"
    - "src/ui/tui/runtime-interaction-adapter.js"
    - "src/ui/workspace/"
    - "docs/design-system.md"
    - "docs/domain-language.md"
    - "docs/plan-lifecycle.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev"
devServerHmr: true
createdAt: "2026-08-08T00:51:28-04:00"
origin: "internal"
status: "user_verified"
userVerifiedAt: "2026-09-24T15:54:26.488Z"
userVerificationNote: "The user confirms Sequences are complete and has been using them. Implementation was merged in PR #76 (Add Planner-authored PROJECT sequences) on 2026-09-08; current Sequence review tests pass. The tracked Plan remained draft despite implementation."
archivedAt: "2026-09-24T15:54:31.185Z"
archiveReason: "Completed Sequences confirmed in use by the user; archived as user_verified at their request."
archivedFromStatus: "user_verified"
archivedFromPath: "docs/plans/planner-owned-plan-chains.md"
---

# Planner-Prepared PROJECT Sequences and Multi-Plan Review

## Context

Planner can discover that a bounded request needs two or more Plans, but submitting the first through `plan_written` can
end planning before the others exist. If the user remembers to create them later, prose dependency notes do not provide
the connection and automatic continuation they expected.

The agreed solution is a PROJECT Sequence with a short context document and complete child PLANNED_CHANGE Plans, all
prepared by Planner in the current conversation and submitted together. The user does not need another Slicer
conversation when Planner already understands the decomposition. An Epic can be small; it does not require a new
classification, a separate chain manifest, or the full architecture document that Architect normally authors.

The subsequent agreed refinement is a persisted PROJECT `type` that selects the planning/review action. Existing Epics
get **Approve & Slice**; the new type gets **Approve & Execute** for its already-prepared children. `sequence` is the
name for the new type. Both reuse ordinary PROJECT storage, child relationships and common lifecycle machinery.

The user confirmed that upcoming Epic-level validation and publication do not apply to Sequences. A Sequence validates
and delivers each child through the normal per-Plan workflow; it does not validate or publish the assembled container.
Keep these capabilities specific to `type: epic` as the separate Epic work lands. Sequences reuse the common PROJECT
machinery without automatically acquiring every future Epic feature. The filename and Plan ID are retained for
continuity; the title and scope replace the earlier separate-chain proposal.

## Objective

Planner can prepare a brief Sequence and every complete child Plan before one `plan_written` submission. Plan Review
shows a Sequence overview tab and one tab per child in execution order. One approval or save decision applies to the
displayed set. Approve & Execute starts the first eligible approved child and normal Epic continuation runs subsequent
children in fresh Sessions. The Sequence remains non-executable and reuses common storage, lifecycle, relationships, and
Work Record machinery; its completion does not claim aggregate validation or publication.

Single-Plan review and the ordinary Architect -> Slicer -> Planner workflow remain supported.

## Approach

### PROJECT type selects the action

```yaml
# Architect/Slicer workflow; also the default for existing PROJECT Plans with no type.
classification: PROJECT
type: epic

# Planner has prepared the container and all children.
classification: PROJECT
type: sequence
```

| PROJECT type     | Initial review                     | Primary action    | After approval                                                    |
| ---------------- | ---------------------------------- | ----------------- | ----------------------------------------------------------------- |
| `epic` or absent | Epic design                        | Approve & Slice   | Existing Slicer workflow                                          |
| `sequence`       | Container and all children in tabs | Approve & Execute | Finalize the prepared decomposition and execute children in order |

Both offer **Approve for Later** with their respective normal resume path. Type is a persisted PROJECT capability
choice, not lifecycle status or proof that children are ready. It does not change when work starts or finishes. The
container never executes itself. Existing readiness and approval checks still apply to every child.

Current implementation recognizes Epics only by `classification: PROJECT`; `type: epic` is legacy metadata that tests
explicitly ignore/strip. Add canonical type parsing, persistence and trusted action selection, defaulting missing
PROJECT type to `epic` without requiring a bulk rewrite. Separate shared PROJECT-container checks from type-specific
Epic capability checks: both types need child storage, ordering, archive and recovery, while Epic-only validation and
publication require `type: epic`. Audit `isEpicPlan` callers rather than treating a function rename as sufficient. Do
not treat PLANNED_CHANGE `type: epic` metadata as a PROJECT. Unsupported PROJECT type values return a clear correction
request and never authorize execution. Route and validate actions using canonical stored type, never a browser-supplied
type or the presence of multiple tool arguments alone. Type changes while review is open invalidate that review; an
active attempt is not silently reclassified or restarted.

Sequences retain ordinary per-child validation, human review, delivery and Work Records. Do not create a Sequence-level
validation contract, release/publication action, or mandatory final integration gate. Container completion is derived
from settled child outcomes using common completion machinery and must not be described as independent aggregate proof.
Use normal per-Plan target selection (including explicitly chosen targets); do not automatically create an Epic release
branch for a Sequence that has no aggregate publication step. No new branching or publication engine is introduced.

### Authoring and submission

Keep the Planner prompt change to two sentences, with the tool schema supplying parameter details:

> When a request needs several already-understood Plans executed in order, write a brief PROJECT container with
> `type: sequence` and all complete child Plans using normal Epic storage and relationships. Submit the container and
> children together through `plan_written` for review; use the normal Architect/Slicer path when architecture or
> decomposition still needs work.

Do not turn this capability into another interview, size rubric, mandatory ceremony, or long prompt section. The
following authoring and validation details specify implementation behavior and documentation; they are not instructions
to paste wholesale into Planner's prompt. Prefer a short example in existing format/tool documentation over another
mandatory planning template.

Planner may prepare a Sequence when the outcome and child boundaries are understood well enough to write all children as
execution-ready Plans. Do not impose a numeric child limit or automatically route a known two-Plan decomposition away
from Planner. Unresolved architecture or decomposition still follows the existing collaborative escalation workflow.

The brief Sequence body contains a title, Context, Objective, and an ordered child overview explaining why the split
exists and which outcomes depend on earlier children. The children carry the full canonical Planner format,
implementation steps, and verification. The Sequence uses standard PROJECT front matter and no execution-agent policy.
Its brevity is an authoring option associated with `type: sequence`, not an exemption from normal PROJECT requirements.
Link child references to canonical Plans; prose is not authoritative order or dependency data. Do not add an ADR or
require Architect's full format just to group already-understood work. Full validation artifacts remain required for
each child under the canonical Plan contract; upcoming Epic-only aggregate artifacts are not required for the Sequence
container.

Proposed compatible tool shape:

```javascript
// Existing single-Plan calls keep working.
plan_written({ planName: "add-search", executionAgent: "engineer" });

// Planner writes every document before this call. Children are in execution order.
plan_written({
    planName: "search-improvements", // saved PROJECT with type: sequence
    plans: [
        { planName: "search-improvements/01-index", executionAgent: "engineer" },
        { planName: "search-improvements/02-search", executionAgent: "frontend-engineer" },
    ],
});
```

`plans` is an optional nonempty child descriptor list with per-child execution policy using existing policy fields and
defaults. For `type: sequence`, it declares the complete child set for tabbed review; a resumed submission using only
the container reference resolves that same complete set from normal PROJECT membership. `type: epic` keeps its ordinary
design review and Approve & Slice; a grouped execution submission for it returns a correction request rather than
silently changing type. Do not infer permission to skip Slicer merely because children exist. The submitted parent must
be a PROJECT sequence and each submitted child must be a PLANNED_CHANGE member of it. Resolve references through the
Plan store, ensure stable identities, and carry Plan IDs through review and decisions.

For this bounded first version the group contains the complete current child set of one unstarted Sequence. Reject
duplicate IDs, missing documents, mixed parents, nested Epics, omitted children, invalid order, and forward/cyclic
dependencies before review. Require declared order to agree with the submitted sequence rather than silently renumbering
Plans. Invalid input returns actionable tool feedback and keeps Planner active. Repeated feedback submissions preserve
IDs and user edits. Child membership uses normal `parentPlan`; order uses normal `order`. To retain the user's earlier
request for ID-based dependency connections, permit stable sibling Plan IDs in the existing `dependencies` list,
retaining legacy name/segment reads. This is a bounded resolver extension, not a new relationship store or wholesale
migration.

### Shared tabbed review

Use `PlanReviewSurface` for standalone and embedded Workspace review. Show the Sequence overview first, followed by
numbered child tabs. The selected tab owns document content, revision history, annotations, attachments, direct edits,
and its execution-policy controls. The Sequence has no execution policy. Tabs preserve state by Plan ID, including local
draft recovery and scroll position. Use shared RunWield tab primitives, semantic tokens, and existing header geometry;
long titles and many tabs must remain keyboard-accessible without overflowing the page.

A single decision bar clearly states that approval covers the Sequence and all listed children. Use **Approve &
Execute** and **Approve for Later** labels, with visible scope such as “Sequence and 2 Plans.” Changing tabs does not
change the scope. Sending annotations or using review chat returns Plan-ID-tagged feedback across the group to the same
Planner conversation. Direct edits remain attached to their document. Planner may revise affected siblings, and the next
review shows every current document and its own previous revision. Never drop feedback from an inactive tab or flatten
several Plans into one Markdown document. Closing review retains the existing unanswered-review behavior and starts no
work.

### Approval and handoff

The runtime call path is:

```text
Planner writes Sequence + complete children
  -> plan_written resolves and snapshots the complete group
  -> one PLAN_REVIEW interaction, shared tabbed browser body
  -> shared group decision validates all documents and commits approval
  -> normal Epic decomposition finalization + child readiness
  -> save for later OR execute first child
  -> existing Epic continuation, validation, delivery, and Work Records
```

Extend the existing shared review-decision and state-transition authorities to handle the group under the catalog and
member resource locks. Capture parent/child IDs, order, reviewed content, policies, and action evidence. At decision
time reload the complete membership and every member's status, document and worktree evidence. Preserve today's semantic
comparison that tolerates formatting-only normalization while using current byte revisions for writes. A changed
requirement, membership, dependency, execution policy, or active attempt invalidates the affected review set before any
approval is committed; retain feedback and show why review must refresh. Direct edits explicitly submitted by the user
are part of the reviewed decision, not an unrelated stale external change.

Use the existing durable transition journal for all affected Plans. Either commit the whole decision or restore the
previous state when safe. If process loss or concurrent user edits prevent rollback, leave recoverable evidence covering
every member; ordinary Plan actions must also respect that unresolved transition. No valid prefix may start execution.
Recovery and repeated answers must not duplicate lifecycle transitions or execution. Keep pending/settled workflow event
evidence in the existing Session authority, not in a new Epic manifest or UI cache. Publish a consume-once accepted
workflow outcome only for a committed group decision; distinguish run from save explicitly and recover a committed run
decision if interruption occurs before dispatch.

Approval records the normal review events for the Sequence and children, finalizes the prepared decomposition, and
applies normal readiness checks. Extract reusable machinery from Slicer finalization if necessary, without invoking
Slicer or hand-writing lifecycle status. Do not nest incompatible lock-taking transitions or call a fake lifecycle
implementation. A committed approval is preserved if subsequent readiness/preparation fails, but no child starts until
the group is settled and the first child's normal execution prerequisites pass. Execution worktrees are prepared only
when the corresponding child is reached so later children start from the target after predecessors have delivered.

Approve for Later leaves a finalized Sequence with approved/prepared children, starts no Agent execution, and creates no
execution Session. Loading it later offers its normal child execution path rather than re-running Slicer or planning
already-approved children. Approve & Execute dispatches the first child, never the container. Preserve per-child
execution owners and Pair/autonomous choices through all handoffs. Subsequent children use ordinary Epic stop, hold,
dependency, recovery and fresh-Session behavior, with validation/publication remaining per child. This Plan does not add
an unattended code-review bypass or alter what counts as completed work. Revisions after execution begins use existing
per-Plan recovery/review workflows; arbitrary batch reapproval of an active Sequence is outside this first version.

The option set aside is a separate Plan Chain store/lifecycle. It duplicates Epic grouping and lifecycle for a problem
that can be solved by allowing one planning conversation and review decision to prepare several ordinary Plans.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/agent-definitions/planner.md`, `document-formats/`, and relevant definition tests — permit brief Sequence
  authoring and multiple complete child files before submission; retain complete child requirements.
- `src/tools/plan-written.ts` and its tests — compatible group parameters, full membership preflight, per-document
  review history/feedback, identities, and accepted run/save outcome.
- `src/plan-front-matter.js`, `src/plan-store.js`, and their tests — persisted PROJECT type with backward-compatible
  defaulting, ordinary identity/membership loading, and sibling-ID dependency resolution preserving existing references.
- `src/shared/workflow/plan-review-actions.ts`, `plan-approval.ts`, `state-transition.ts`, and lifecycle helpers — one
  recoverable group decision using existing ownership and transition rules; distinguish common PROJECT behavior from
  Epic-only capabilities so Sequences never enter aggregate validation/publication.
- `workflow-slicer.ts`, `decisions.ts`, `planning-agent.ts`, `workflow-tool-events.ts`, and Session workflow dispatch —
  reuse prepared-decomposition finalization and route approved groups to execution without a Slicer turn.
- `src/ui/review/plan-review.ts`, `review-launcher.ts`, the TUI interaction adapter, and Workspace live-review routes in
  `src/ui/workspace/server/session-continuation.js` — preserve the complete group through both review transports.
- `src/ui/workspace/react/PlanReviewSurface.tsx`, review draft/feedback/version/policy helpers, and existing shared tabs
  — tab-local state with one group-wide decision, shared between presentations.
- Surface Lab fixtures and review/workflow integration tests — expose and verify multi-Plan review and execution.
- `docs/design-system.md`, `docs/domain-language.md`, `docs/plan-lifecycle.md`, and the living Core PRD — document the
  PROJECT types, the shorter Sequence authoring path, group approval, and shared lifecycle/storage semantics. Add the
  Sequence term and revise the current glossary's assumption that every PROJECT is Architect/Slicer-authored.

## Reuse Opportunities

- Plan store identity and child catalog helpers: `ensurePlanIdentity`, `findPlansByParent`, `compareChildPlansByOrder`,
  and the existing child dependency resolver.
- `applySharedPlanReviewDecision` and state-transition journaling: retain semantic staleness checks, protected fields,
  conservative rollback, and recovery blocking while extending the transaction scope.
- `materializeSlicerDraft`, `runEpicDecompositionFinalizeTransition`, and `recordPlanEvent`: reuse the underlying
  materialization/finalization authorities, independent of which Agent authored the documents.
- `resolveEpicContinuation` and `runEpicChildContinuation`: preserve ordering, dependency satisfaction, holds and
  recovery stops; `SessionRuntime` already supplies fresh Sessions for Epic continuation.
- `PlanReviewSurface`, `RunWieldTabs`, and per-document draft/version/feedback helpers: extend the existing review body.

## Implementation Steps

- PROJECT type round-trips through canonical storage and review: absent/`epic` selects Slice, `sequence` selects
  Execute. Trusted backend validation rejects incompatible actions, unsupported types and stale type changes. Both
  remain non-executable PROJECT containers throughout lifecycle, board, archive, collaboration and recovery operations.
- Common PROJECT grouping and continuation work for both types. Epic-only aggregate validation, publication and default
  release-branch preparation exclude Sequences. Finishing the last child settles the Sequence without scheduling an
  aggregate gate or exposing a container Publish action; existing child evidence retains its actual meaning.
- Planner's effective instructions add only concise guidance for a brief PROJECT sequence plus fully specified child
  Plans in one conversation, require all files before submission, and do not route an already-understood decomposition
  to Slicer solely due to size.
- `plan_written` accepts both existing calls and grouped Sequence calls; invalid/incomplete groups cannot open review,
  terminate planning as approved, or start a valid prefix. Accepted groups preserve stable IDs and per-child policies.
- Existing sibling dependency resolution accepts Plan IDs and still resolves legacy names/segments. Renaming a child
  leaves its ID-based dependency satisfied by the same canonical Plan; missing/duplicate IDs do not resolve arbitrarily.
- One shared tabbed surface round-trips every document's feedback, edits, versions and settings independently in both
  launch modes. Refresh and tab switching preserve recoverable drafts; group decisions include inactive tabs.
- A shared, journaled group decision either commits every required review transition or blocks execution pending safe
  recovery. Stale membership/content and process interruption cannot leave an executable approved prefix or a lost run
  decision. Repeated answers and resumed committed outcomes cannot start the same child twice.
- Committed run decisions finalize the prepared Sequence and reach the first child's normal execution path without
  Slicer or repeated child planning. Save decisions finalize the same ordinary documents without execution; subsequent
  loading uses normal Epic child selection and continuation. Normal readiness failure remains recoverable.
- Existing standalone/Architect reviews, per-child validation and delivery, fresh Sessions, execution policy, holds,
  Work Records and true Epic behavior remain protected; neither PROJECT container becomes executable.
- Domain language, lifecycle guidance, Planner format guidance and design-system documentation describe the implemented
  multi-document submission using ordinary Epic terminology. Surface Lab includes standalone and Workspace variants.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

Use real temporary Plan projects, Git fixtures, normal lifecycle transitions, and the existing test runner. Do not add
seams for Plan writes, lifecycle state, locks, or workflow ownership. Fake only genuine external boundaries such as
model turns, browser launch and subprocess/network operations where already supported.

Automated behavior to prove:

- Missing PROJECT type and explicit `epic` preserve Approve & Slice; `sequence` exposes Approve & Execute and grouped
  save in both transports and after reload. Canonical type survives save/archive/restore and collaboration
  serialization. Forging type/action in a browser answer, submitting a group for an `epic`, or changing type during
  review cannot skip decomposition or execute unapproved children. Existing PLANNED_CHANGE legacy metadata never becomes
  a PROJECT.
- Complete the final child of a Sequence and confirm no container Validator, aggregate publication or implicit Epic
  release-branch preparation occurs, while every child's ordinary validation/delivery still runs. Assert that Sequence
  action APIs and UI exclude aggregate Validate/Publish even when the container is terminal. When the separate Epic
  capabilities are present, paired `type: epic` fixtures must still expose and execute them under their normal policy.
- A real Sequence and two children reach tabbed review through `plan_written`; one run answer approves the whole set,
  finalizes decomposition and dispatches only child 1. No Slicer or extra Planner turn occurs. After normal child 1
  completion, child 2 starts exactly once in a fresh Session with its own approved content/policy and the expected
  target content. This test must fail if the implementation merely displays tabs but submits or runs the first Plan
  alone.
- Save-for-later produces the same complete ordinary PROJECT/child documents and approval state, with zero execution
  turns; a later normal load reaches child execution without reopening decomposition.
- Missing child, duplicate identity, wrong parent, omitted child, inconsistent ordering and cyclic/forward dependency
  input keep planning open and cause no approval or execution. Test ID dependencies after a child rename, alongside
  legacy name/segment dependencies and missing/ambiguous identities.
- Edit/comment on both children, switch tabs, refresh, send feedback, revise and reopen: each annotation, attachment,
  direct edit, version history and policy stays on its original Plan. Approval on the Sequence tab includes both
  children.
- Changing a child or adding a child while review is open prevents acceptance of a stale set without losing drafts.
  Existing harmless YAML normalization behavior remains accepted, and protected lifecycle fields cannot be edited into a
  fabricated approved result.
- A real interrupted transaction fixture leaves every member blocked until the existing recovery machinery settles it.
  Test interruption during a member write and after approval commit but before dispatch, plus duplicate review answers.
  Verify that independent load of a partially written child cannot bypass the group recovery block. Use subprocess
  interruption or real malformed/unwritable fixture state, not injected replacements for RunWield-owned writes.
- Preserve existing single-Plan review, ordinary Epic Approve & Slice, per-child feedback/review, mixed execution
  agents, Pair settings, failed/held child stops, user acceptance, validation/publication and Work Record behavior. No
  existing delivery or verification test becomes obsolete solely because grouped submission was added.

Commands for the implemented change:

- `deno run -A scripts/run-tests.js src/tools/__tests__/plan-written.test.js src/tools/plan-written.test.ts src/shared/workflow/plan-review-actions.test.ts src/shared/workflow/state-transition.test.js src/shared/workflow/decisions.test.js src/shared/workflow/workflow-slicer.integration.test.ts src/shared/workflow/epic-continuation.test.js src/plan-store.test.js`
- Run added group-submission/recovery integration files through `deno run -A scripts/run-tests.js <files>` and the
  applicable existing review UX/transport and Golden workflow tests through their repository runners.
- `deno task ci` after focused checks pass; this includes the zero-seam check. Never run `deno test` directly.

Headed-browser verification is required for the review changes. Run `deno task workspace:dev` and open the new
multi-Plan variants linked from `/dev`, in both standalone and embedded Workspace presentations. Exercise three tabs,
keyboard navigation, narrow layout/long labels, unsent edits and annotations across tabs, draft recovery on refresh,
feedback/revision, mixed child policies, group approval and save. Also exercise a real local review and a live Workspace
Session review so fixture-only tabs cannot satisfy acceptance. Confirm one shared header, visible group decision scope,
no whole-page overflow, and no comment/settings leakage across documents. Check the single-Plan variants still work.

## Edge Cases & Considerations

- This Plan adds a Sequence type using common PROJECT machinery, not a separate chain lifecycle, branch system,
  scheduler, Work Record aggregate, or new Plan classification. Do not add another manifest or persist progress in UI
  state.
- The proposed `plans` tool field and brief container headings are reviewable choices. The confirmed product contract is
  complete Planner-authored children, a concise PROJECT Sequence, one tabbed review, and ordinary execution.
- Grouped review initially covers one unstarted Sequence and all its children. Existing active/terminal work remains on
  its ordinary per-Plan workflow; rejection must preserve existing Plans and explain the next usable action.
- No automatic parent/dependency migration is required. New ID-based sibling dependencies coexist with existing
  references. Parent identity/storage remains the ordinary Epic representation, including its current rename behavior.
- `docs/plans/plan-packages-and-independent-validation.md` is concurrent work. Implement against the canonical Plan
  storage/review authority present when this Plan runs. If packages land first, review each Plan through that package's
  normal approved-content boundary and include each child's required artifacts. Exclude Epic-only aggregate validation
  artifacts and publication from the Sequence container. Do not add a legacy-only parallel workflow. If the Epic work
  lands later, the shared PROJECT versus Epic-only capability boundary and tests must make this exclusion explicit.
- Current code uses `validated` and `user_verified` in places where draft specifications propose different names. Reuse
  implemented lifecycle constants and dependency satisfaction semantics; status renaming is outside this Plan.
- Approval does not waive per-child code review, validation or delivery checks. A Sequence groups independently
  deliverable Plans; an Epic owns the assembled outcome and its upcoming integrated validation/publication. This
  distinction replaces the earlier assumption that Sequences would inherit every future Epic capability.
