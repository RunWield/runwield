---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "packages/plans/"
    - "src/plan-store/index.ts"
    - "src/plan-store/packages.ts"
    - "src/plan-store/publication.ts"
    - "src/plan-store/prototypes.ts"
    - "src/plan-store/README.md"
    - "packages/tools/definitions/"
    - "src/tools/registry.ts"
    - "src/ui/review/plan-review.ts"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/routes/api/review-handlers.ts"
    - "src/skills/prototype/"
    - "docs/domain-language.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-core-prd.md"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review"
devServerHmr: true
parentPlan: "product-planner-sequence"
order: 2
createdAt: "2026-11-12"
status: "draft"
planId: "d1a99fe0-399d-4092-854c-8b65e5fef95c"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
---

# Retained Local Prototype Review

## Context

The owner needs to try a proposed experience, annotate it, and review an Agent's revision without losing the earlier
context. This child supplies that local review capability. The next child adds Product Planner and product acceptance.

The proposed requirements are owned by [interactive prototype review](../prd/product-planner-prd.md#interactive-prototype-review)
and [prototype retention](../prd/product-planner-prd.md#prototype-retention-with-the-plan). Add **Review the experience,
not prototype code quality**, **Keep feedback tied to what was reviewed**, **Preserve a simple, contained review
experience**, and the named retention requirements. Preserve existing Markdown review, queued feedback, direct edits,
Plan sharing, and technical approval.

Lasting owners are [Workspace browser review](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow) and
[Core Plan authoring](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption). This child updates those capabilities
for the behavior it delivers. It leaves product acceptance and shared prototype review explicitly unimplemented.

Current evidence: `HtmlViewer` supports raw HTML interaction and annotations. RunWield's review conversation already
carries text feedback. Neither temporary preview files nor Plan-text hashes retain prototype revisions. The existing
viewer removes document-authored Content Security Policy (CSP) tags, so a CSP inside generated HTML is not containment.

## Objective

An owner can open retained, self-contained HTML in local Plan review, interact with named states, submit text or pinpoint
comments to the current planning Agent, and inspect earlier prototype versions after restart or worktree handoff.
Comments behave like Plan review comments today: sent to the planning Agent, not stored, and forwarded only when
queued at approval.
Prototype bytes remain local and absent from workflow commits.

## Approach

### The Plan Store owns prototype revisions

The home Plan Store is now on `main` and is the default for every local Project with an identity. Plans live under
`~/.wld/projects/<projectId>/plans/<name>/`. `src/plan-store/index.ts` is the only public interface, and
`openProjectPlanStore(projectId)` returns a `ProjectPlanStore` that reads by Plan ID and refuses stale writes.
`docs/plans/runwield-package-architecture.md` assigns "artifact content and references" to `packages/plans`, with a later
hosted driver exposing the same operations.

**Decision (owner direction plus the package architecture):** prototypes are a Plan-owned artifact kind inside the Plan
Store boundary, stored with the Plan's package. Add the operations to the store's public surface (for example
`store.submitPrototype`, `store.listPrototypes`, `store.readPrototypeRevision`, `store.retirePrototype`), export their types from `packages/plans`, and keep the
local storage driver private in `src/plan-store/`. No UI, tool, or Workspace code builds a path.

**Owner decision:** prototypes live inside the Plan's own package directory, and the package metadata links to them.
One folder per Plan keeps archive, rename, and prune simple.

```text
~/.wld/projects/<projectId>/plans/<name>/
├── plan.wld.json                     # + new `prototypes` key (package format change)
├── context.md, validation.md, ...    # existing Markdown documents
└── prototypes/
    └── <prototypeId>/<revisionId>/   # sealed index.html + manifest.json
```

**Package format change.** Add `prototypes` as a new accepted key in `plan.wld.json`, with a package format version
change so `fields()` and every reader accept it explicitly. Each entry holds `prototypeId`, title, `retired`, and its
revisions (`revisionId`, HTML digest, submission time). The list changes as prototypes are added, revised, or retired;
only the sealed revision files are immutable. A RunWield build that predates the change refuses the newer package
rather than silently dropping the key.

The package's existing operations must now carry the `prototypes/` folder. Current code handles only the named Markdown
documents, so each needs a deliberate change in the Plan Store owner:

| Operation                                                          | Current behavior                                                   | Required change                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Rename (`renamePlanPackage` and its intent recovery)               | Moves each named document                                          | Also move `prototypes/`, including on recovery after an interrupted rename |
| Archive / restore                                                  | Records facts; the directory stays                                 | None beyond tests                                                          |
| Prune (`prunePackageFamily`)                                       | Deletes named documents and history, restores other files it finds | Delete `prototypes/` with the Plan                                         |
| Delivery copies (`sealPackagePublication`, `preparePackageCopies`) | Copies listed package documents                                    | Copy only the Markdown documents; never `prototypes/`                      |
| Shared Spaces share/push/pull                                      | Plan body only                                                     | None beyond tests                                                          |

Plan Epic artifacts (`manual-qa.md`, `integration-report.md`) are a different, mutable, Markdown-only kind; do not reuse
that path.

A `PrototypeRevisionRef` contains `planId`, `prototypeId`, and `revisionId`; it never contains a storage path. The
original owning `planId` lets Epic children refer to a parent's revision without copying it; parent and children are
pruned together as one family. The **current review set** is the latest revision of each non-retired entry in the
Plan's `prototypes` metadata. The manifest holds title, HTML digest, submission time, and the declared screen/state IDs
and labels.

Seal each submitted manifest and HTML payload atomically. Hash HTML plus meaningful manifest content, not timestamps.
Repeating an identical submission returns the existing revision. Replacing HTML under an existing revision is refused.
Write the sealed files and the metadata update under the same package lock and observed revision, so a crash never leaves
metadata pointing at a missing revision. An unreferenced sealed folder left by a crash is cleaned by the owner, not
exposed. Keep submitted revisions; do not save every authoring keystroke. Use the store's existing Project
admission, locking, and passive-read rules: a read creates no storage.

Expose a narrow `plan_prototype` tool, defined in `packages/tools/definitions/` and bound in `src/tools/registry.ts`. It
submits a self-contained HTML file as a new prototype or a new revision, retires a prototype, or reads retained
revisions, all through the store operations. The source file is read once on submission. Responses carry
stable references, not review credentials or paths. No upload or arbitrary-file serving API is added.

**Retention:** follows the table above. Registered planning and execution worktrees read through the same home store,
so no copy per checkout is needed.

**Out of Git and sharing:** delivery copies and Shared Space share/push/pull never include prototype payloads, even
with `plans.deliveryCopies` on.

> [!NOTE]
> **Prototype files stay on this machine**
>
> The local home store does not travel with a clone. The owner accepts unusable prototype references on another machine
> until a hosted Plan Store driver exposes the same artifact operations. Document this only in internal PRDs and Plans.
> Add no missing-capability notice, missing-prototype warning, portability banner, public documentation, or export
> mechanism.

### Extend the existing review conversation

```text
plan_prototype -> store.submitPrototype -> sealed revision (keyed by planId)
PlanReviewSurface (Workspace opens the Project's store, as review routes do today)
  document / prototype selection, revision selection
  HtmlViewer: interact / annotate
  existing annotation panel and sendPlannerMessage
    buildPlanReviewFeedback -> reviewDenyApi -> buildPlanConversationRequest
      current planning Agent, with typed prototype context
```

Reuse `docs/design-system.md`, `RunWieldPrimitives.tsx`, existing rectangular review controls, semantic tokens, and
`plannotator.css`. Keep the document, prototype choice, revision label, and feedback context clear. Do not redesign the
review shell. Show original comments with their original revision; do not project them onto revised elements.

Generated prototypes declare a small set of named screens/states and update root attributes such as
`data-runwield-screen` and `data-runwield-state` when interaction changes what is displayed. RunWield passes that mapping
to the upstream displayed-context option (see the dependency decision below). Plannotator captures the labels when a
target is selected, or when a global comment's composer opens, and keeps that snapshot through submission. RunWield
validates the captured labels against the sealed manifest. A label from an earlier load cannot become the context of a
later comment.

**Owner decision: comments follow today's Plan review rules.** RunWield does not store prototype annotations.

- **Sent during review:** the comment goes to the planning Agent through the existing conversation path and is not
  persisted by the Plan Store. It survives only where the conversation already does, in the Session transcript.
- **Queued at approval:** annotations still queued when the owner approves are forwarded to the next Agent through
  the existing approval-context path, exactly as Plan annotations reach the Engineer or Slicer today.
- **Unsent drafts:** keep the existing browser draft behavior; do not add a new store.

Each comment carries typed context all the way to Agent input: Plan identity, `PrototypeRevisionRef`, screen/state,
anchor, and relevant text/element context. Generated prose can summarize it, but the typed fields must reach the
conversation request and the approval context. Page-supplied labels describe the display; they never choose project,
Plan, author, storage path, or permissions.

A comment on an earlier revision stays valid input; name that revision instead of retargeting it. Named states and a
small initialization hook reopen the declared example; this is not arbitrary browser-session replay.

### Contain the HTML without replacing Plannotator

Render prototypes with `HtmlViewer resourcePolicy="self-contained"` from upstream PR #3907. That option installs a host
CSP before all author markup, fixes the sandbox to `allow-scripts`, permits inline scripts/styles and data images/fonts,
blocks external resources, and locks `window.__plannotatorLiveConfig` to null before author scripts. Conflicting live,
served-frame, external-bridge, popup, and wider-sandbox props throw. RunWield does not reimplement or patch this policy.

Prototype scripts and styles are inline; images are embedded. Do not load remote libraries, frames, fonts, or production
data. Keep credentials, private Session content, and privileged URLs out of the frame and its bridge messages.

This policy blocks resource loads, connections, and privileged frame actions; it is not a universal no-network claim.
Frame self-navigation is not reliably blocked by CSP. Intercept ordinary links/meta refresh in this prototype mode,
invalidate bridge state after navigation, and prove that a navigated frame cannot access credentials or invoke
privileged review operations. Do not claim that message-source checks make prototype JavaScript trusted. Mutation APIs
must retain their existing owner authorization and method/origin checks independently of the frame.

A separate Artifact Server or live-app proxy would introduce another serving and trust boundary. The selected approach
keeps the existing viewer and local review workflow.

### Dependency: the fork integration pin

**Owner decision:** the two viewer extensions go upstream as focused PRs from `gandazgul/plannotator`:
[#3907](https://github.com/backnotprop/plannotator/pull/3907) (resource restrictions) and
[#4032](https://github.com/backnotprop/plannotator/pull/4032) (displayed context). Both are open. The owner chose not to
wait: the [integration pin](plannotator-integration-pin.md) child combines them on the fork and pins RunWield to that
commit. This child starts after that pin lands.

This child consumes `resourcePolicy="self-contained"` and `displayedContextAttributes` and does not change Plannotator
source or the pin. If upstream review renames or changes an option, the integration branch picks up the new PR head
and RunWield follows the merged contract.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `packages/plans/` (`store.ts` interface and exported types) — prototype operations on `ProjectPlanStore`.
- `packages/plans` package format and `src/plan-store/packages.ts` — the new `prototypes` metadata key with a format
  version change; rename, prune, and recovery carry the `prototypes/` folder.
- `src/plan-store/prototypes.ts` (private), `src/plan-store/index.ts` — sealed revisions in the package.
- `src/plan-store/publication.ts` and delivery-copy code — copy only Markdown documents; never `prototypes/`.
- `src/plan-store/README.md` and `scripts/plan-store-boundary-qualification.ts` if needed — document the new artifact
  kind; keep `bun run plan-store:check` passing without new private-import exemptions.
- `packages/tools/definitions/plan-prototype.ts`, `src/tools/registry.ts` — submit/retire/read through the store; no
  filesystem server.
- `src/ui/review/plan-review.ts`, `src/ui/workspace/react/PlanReviewSurface.tsx`, feedback modules and review API handlers —
  display prototypes and send typed comment context through the existing conversation and approval-context paths.
- `src/skills/prototype/` and its synchronized bundled copy — distinguish retained Plan Prototypes from scratch
  experiments; document self-contained submission and the screen/state contract.
- Existing Plan-store, runtime-layout, review, archive, and browser tests — prove retention and behavior through real boundaries.
- `docs/domain-language.md`, Core/Workspace PRDs, and `docs/prd/product-planner-prd.md` — deliver Plan Prototype and
  Prototype Revision terminology and only this child's capability requirements.
- `docs/plans/runwield-package-architecture.md` (Plans row) and the accepted home-runtime ADR
  (`docs/adr/016-project-runtime-state-under-wld-internal.md`) — record prototypes as a Plan-owned artifact kind and its
  home location. Keep internal-only portability detail in PRDs/Plans, not public documentation.

Product acceptance, Router, shared-prototype publication, and Plannotator source do not change here.
The stale status of `docs/plans/external-plan-store.md` and ADR-019 is outside this child.

## Reuse Opportunities

- `HtmlViewer`, `useHtmlAnnotation`, `AnnotationPanel`, `buildPersistedHtmlAnchor`, `projectHostThreads` — retain existing
  interaction and anchor semantics, not a new annotation system.
- `sendPlannerMessage`, `buildPlanReviewFeedback`, `reviewDenyApi`, `buildPlanConversationRequest` — one owner conversation.
- `openProjectPlanStore`, `openRegisteredPlanDocuments`, Project admission, store locks and revision checks — one
  identity and storage owner, already used by Workspace review routes.
- `previewPlanRetention`, `confirmRetention`, `prunePackageFamily` — the existing retention path prototypes join.
- `defineGitFixture`, `makeValidationProjectRoot`, and the isolated runner — real storage/worktree tests without owned-system seams.

## Implementation Steps

1. **Submitted revisions survive process boundaries.** `ProjectPlanStore` exposes typed prototype submit, list, read,
   and retire operations, with `PrototypeRevisionRef` exported from `packages/plans`. Submitting via
   `plan_prototype` seals HTML and its named-state manifest in the Plan's package `prototypes/` folder, records it in the
   new `prototypes` metadata key, and returns the same revision for identical content. The package format version
   change is explicit, and older readers refuse rather than drop the key. Overwriting a revision, path escape, unsafe
   symlinks, and cross-Project or cross-Plan reads are refused. Passive reads create no storage.
2. **Retention follows Plan identity, not preview lifetime.** Renames, archive/restore, Session restart, and registered
   planning/execution worktrees resolve the identical retained bytes. Rename moves `prototypes/` with the package,
   including after an interrupted rename. Prune deletes it with the Plan family. Delivery copies (with `plans.deliveryCopies` on) and Shared
   Space share/push contain no prototype payload or feedback. `bun run plan-store:check` passes.
3. **Local Plan review renders the selected revision safely.** `PlanReviewSurface` renders prototypes with
   `resourcePolicy="self-contained"`, the `displayedContextAttributes` mapping, the real bridge, and current design
   primitives. Interaction and annotation modes, revision selection,
   keyboard access, and responsive controls work. No live `src` mode, credentials, private transcript, or production
   mutation authority enters the frame.
4. **Comments carry exact product context without being stored.** Plannotator's captured displayed context is validated
   against the manifest. Each comment sent to the planning Agent includes revision, screen/state, anchor, and original
   context through the review route and conversation builder. Annotations queued at approval reach the next Agent through
   the existing approval-context path with the same typed fields. The Plan Store holds no comment records. Named states
   can be reopened through the prototype's initialization contract. New revisions never inherit old anchors, and a stale
   frame response cannot overwrite new review input.
5. **Tests and Skill guidance exercise the real workflow.** Co-located TypeScript tests cover revision immutability,
   same-machine retention, archive/deletion, stale frame messages, typed feedback transport, and unchanged Markdown review.
   The prototype Skill produces self-contained, named-state submissions through the new tool while preserving disposable
   scratch use. No test-only injection seam, `any`, `unknown`, or standalone shared-type module is added.
6. **Documentation matches this delivery.** Update the owning Core retention and Workspace local-review requirements and
   acceptance scenarios, then link the transient PRD to those owners. Keep later product acceptance and shared review
   targeted/deferred. Update affected ADRs and `docs/domain-language.md` definitions, avoided aliases, and relationships
   for Plan Prototype and Prototype Revision. Do not add Product Planner as delivered until the next child.

## Approval Confirmation

No Work Records are proposed for supersession. The owner chose upstream Plannotator PRs plus a fork integration pin,
delivered by the preceding child. The owner chose to keep prototypes in the Plan package folder with a new `prototypes`
metadata key, and to copy only Markdown into delivery copies. The metadata entry shape, folder names, and root-attribute
names are reviewable implementation assumptions; they do not change the owner's local-only scope.

## Verification Plan

Use the Bun version in the checkout’s root `.bun-version`. Run `bun run install:locked` before checks. Use `bun scripts/run-tests.ts`, never direct `bun test`.

- Add `src/plan-store/prototypes.test.ts` (owner test) and public-command coverage beside
  `src/plan-store/operations.test.ts`, plus `src/tools/plan-prototype.test.ts`; run
  `bun scripts/run-tests.ts src/plan-store/prototypes.test.ts src/plan-store/operations.test.ts src/tools/plan-prototype.test.ts`
  and `bun run plan-store:check`. Use fresh process readers, a real Project identity, and real registered Git worktrees.
  Submit version A, submit B with the control removed, restart, and read both: the exact A bytes must survive, B must
  have a different reference, and duplicate A submission must not mutate it. Assert the package contains no comment
  records after review comments are sent. This fails for temporary or in-memory storage.
- Extend the existing archive/restore/rename/prune suites. Rename a Plan with prototypes, including a rename interrupted
  after its intent is written and then recovered: the revisions must be readable under the new name. Archive
  and restore, an Epic child referencing parent material, and family prune that removes `prototypes/` without touching
  unrelated files. Read a package written in the new format with the old reader path to confirm it refuses. With
  `plans.deliveryCopies` on, inspect the actual committed delivery copy and a Shared Space push payload for absence of
  prototype HTML.
- Add `src/ui/workspace/react/plan-prototype-review.test.tsx` and route/feedback integration coverage; run
  `bun scripts/run-tests.ts src/ui/workspace/react/plan-prototype-review.test.tsx src/ui/workspace/react/plan-review-feedback.test.ts src/ui/workspace/plan-review-cross-surface.integration.test.ts`.
  Exercise real comment serialization into the planning Agent's input, A/B context, stale frame replies, and invalid
  state IDs. Approve with prototype annotations still queued and assert the execution Agent's approval context carries
  their revision, screen/state, and anchor fields, as Plan annotations do today.
  A viewer that only renders HTML or turns annotations into unstructured prose must fail these checks. Shared review
  tokens must not read local prototype payloads. Existing Plan publication contains no HTML or owner credentials; ordinary Markdown sharing remains functional.
- Plannotator's own tests for the two options belong to the upstream PRs, and the pin child proves the upgrade. This
  child proves RunWield's use of the options through the checks above and below.
- **Headed browser:** run `bun run workspace:dev` and open `http://127.0.0.1:5173/dev/plan-review` in an assignment-specific
  `agent-browser --headed --session <name>` session. Extend the fixture with a realistic checkout prototype. Switch to
  empty cart, annotate a button and text, send feedback, revise it, and reopen A. Repeat on the actual owner review route
  with a saved Plan and running planning Session; stop/restart the owner process and reopen the same material. Capture
  desktop and narrow-screen screenshots, keyboard/focus behavior, console errors, and relevant network requests.
- **Browser security evidence:** run inline scripts and annotations successfully while probes for parent DOM/cookies,
  owner storage, external fetch/image/frame loads, form submission, popup/download/top navigation, and forged privileged
  bridge messages fail. Use a local request recorder for attempted resource loads. Exercise self-navigation separately:
  prove loss of the old bridge and no access to host credentials or mutation authority, without claiming all navigation
  requests are blocked. Happy DOM assertions are not sufficient for these checks.
- Preserve Markdown annotations, queued review input, direct edits, existing technical approval, and ordinary Plan sharing.
  Run `bun scripts/run-tests.ts src/ui/workspace/plan-review-browser.test.tsx src/ui/workspace/react/plan-review-behavior.test.tsx src/ui/workspace/react/plan-review-direct-edits.test.ts`.
  No existing behavior is retired. Verify glossary, PRD capabilities, ADRs, and affected links against the delivered flow.

## Edge Cases & Considerations

- **Revisions change without Markdown changes:** prototype content identity is separate from Plan-text identity; the next
  child includes exact references in product approval.
- **Concurrent tabs or writes:** compare expected document and prototype-metadata revisions through existing locks. Preserve unsent
  owner input on conflict; do not merge anchors across prototype versions.
- **Upstream review changes the options:** if names or behavior change in PR #3907 or #4032, the integration branch
  takes the new head and this child follows that contract. Return to the owner only if a change removes a capability this child needs.
- **Invalid or missing state labels:** do not fabricate the latest selected state. Preserve the owner's text and require
  valid capture before recording a state-bound annotation; provide ordinary action error/retry, not portability messaging.
- **Broken cross-machine references:** accepted scope limit. Do not publish bytes or introduce warnings to hide that limit.
- **Future hosted driver:** UI and tools use store operations, never paths, so a hosted Plan Store driver can serve the
  same prototypes later. That driver is not part of this child.
- **Remote sessions:** under `wld remote`, the managed owner transport caps requests at 1 MiB. Prototype submission
  through that transport must fail clearly above the cap rather than truncate; larger payload support is not in scope.
- **Prototype trust:** this is a simulated local experience, not a production application or hardened general browser.
  Frame content cannot authorize host actions. No universal browser-state replay or screenshot system is required.
