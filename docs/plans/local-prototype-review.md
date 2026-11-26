---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store.ts"
    - "src/plan-front-matter.ts"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/plan-prototypes.ts"
    - "packages/tools/registry.ts"
    - "src/ui/review/plan-review.ts"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/routes/api/review-handlers.ts"
    - "third_party/plannotator/packages/ui/components/html-viewer/"
    - "src/skills/prototype/"
    - "docs/domain-language.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-core-prd.md"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review"
devServerHmr: true
parentPlan: "product-planner-sequence"
order: 1
createdAt: "2026-11-12"
status: "draft"
planId: "d1a99fe0-399d-4092-854c-8b65e5fef95c"
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
comments to the current planning Agent, and inspect earlier versions and comments after restart or worktree handoff.
Prototype bytes remain local and absent from workflow commits.

## Approach

### One local owner for submitted revisions

Add `src/shared/plan-prototypes.ts` as the authority for immutable prototype revisions and durable annotation records.
Export its named reference and feedback types from that module. Use `resolveWorkflowPlanLocation()` to find the Plan and
`resolveProjectRuntimeLayout()` to locate primary-checkout storage. Respect passive read inspection and action-owned
runtime entry; path resolution alone does not authorize a write.

**Reviewable implementation assumptions:** use `.wld/internal/prototypes/<planId>/` through a named layout field. A
`PrototypeRevisionRef` contains `planId`, `prototypeId`, and `revisionId`; it never contains a user-supplied storage path.
`planId` identifies the original owning Plan, so later Epic children can refer to the same revision without copying it.
The Plan document's optional `prototypes` list selects current review material. The retained manifest holds its title,
HTML content digest, submission time, and declared screen/state IDs and labels.

Seal each submitted manifest and HTML payload before attaching its reference through the canonical Plan writer. Hash
HTML plus meaningful manifest content, not timestamps. Repeating an identical submission reuses its revision. Replacing
HTML under an existing reference is not allowed. A failed Plan attachment must not delete an earlier revision. Keep
submitted revisions and their feedback until the Plan's retention boundary; do not save every authoring keystroke.

Expose a narrow `plan_prototype` tool through the existing registry: submit a self-contained HTML file as a new or
revised prototype for a saved Plan, or read its retained versions and feedback. Core assigns and validates identities.
The source file is read on submission, not mounted as a live directory. Responses provide stable references and local
read context, not review credentials. No upload or arbitrary-file serving API is added.

**Archive assumption:** keep local material through archive and restore, then remove it on explicit deletion/prune only
when no surviving active or archived Plan references it. This follows reversible Plan archival without putting HTML
inside Markdown archive units. Preserve child references to a parent prototype. Do not alter the archive validator to
accept arbitrary non-Markdown payloads.

> [!NOTE]
> **Prototype files stay local**
>
> Another machine can have unusable references. The owner accepts this MVP limit. Document it only in internal PRDs and
> Plans. Add no missing-capability notice, missing-prototype warning, portability banner, public documentation work,
> export mechanism, or dependency on the proposed centralized Plan Store.

### Extend the existing review conversation

```text
plan_prototype submission -> retained revision -> Plan.prototypes
PlanReviewSurface
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

Persist comment/thread identity, review Plan identity, prototype reference, screen/state identity, anchor, relevant
text/element context, and comment content. Use Plannotator's persisted anchor utilities where suitable. Page-supplied
labels describe the display; they never choose project, Plan, author, storage path, or permissions. Preserve submitted
and explicitly saved feedback across restart. Existing draft-input behavior must not regress.

Use typed feedback all the way to Agent input. Generated prose can summarize it but cannot be the only retained record.
A comment on an earlier revision remains valid input; make that revision explicit rather than silently retargeting it.
Named states and a small initialization hook reopen the declared example; this is not arbitrary browser-session replay.

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
keeps the existing viewer and local review workflow. Today the gitlink is `7d06fcd8…` while the marker file names the
older `762700fa…`; the pin update below fixes both.

### Dependency decision: upstream PRs from the owner's fork

**Owner decision:** the two viewer extensions go upstream as focused PRs from `gandazgul/plannotator`, not as a
RunWield-owned adapter or an uncommitted submodule patch.

| Extension                        | Branch in `~/web/plannotator`  | Status when recorded (2026-11-12)                                      |
| -------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| Host resource restrictions       | `feat/host-html-restrictions`  | [PR #3907](https://github.com/backnotprop/plannotator/pull/3907), open |
| Displayed context on annotations | `feat/html-annotation-context` | In progress, independent of #3907                                      |

This child consumes both public options and does not change Plannotator source. Before execution, pin
`third_party/plannotator` to a fetchable upstream commit that contains both merged PRs. If upstream has not merged them
when this child is ready to run, the fork is the fallback: point the submodule at the fork commit that contains both
branches. The owner chooses when to use that fallback; it requires no new planning.

In either case, update the gitlink, `.gitmodules` only when the source repository changes, and
`third_party/plannotator-revision.txt` together, so all three name the same commit. Upstream has moved thousands of
commits past the current pin. Treat the pin update as an integration step: rerun the existing Plannotator-backed review
tests and browser checks rather than assuming compatibility.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/plan-prototypes.ts`, `src/shared/project-runtime-layout.ts` — own revision, feedback, and local storage rules.
- `src/plan-store.ts`, `src/plan-front-matter.ts`, archive/prune callers — retain typed references through saves, rename,
  worktrees, archive/restore, and reference-aware cleanup.
- `src/tools/plan-prototype.ts`, `packages/tools/registry.ts` — submit/read retained material without exposing a filesystem server.
- `src/ui/review/plan-review.ts`, `src/ui/workspace/react/PlanReviewSurface.tsx`, feedback modules and review API handlers —
  display prototypes, persist comments, and send typed context through the existing conversation.
- `third_party/plannotator` gitlink, `.gitmodules` (fork fallback only), and `third_party/plannotator-revision.txt` —
  pin one fetchable commit with both upstream extensions. No Plannotator source changes in this child.
- Existing Plannotator-backed review code (`astro.config.ts` aliases, `PlanReviewSurface.tsx`, `CodeReviewSurface.tsx`) —
  adapt only where the newer pinned revision changes public interfaces.
- `src/skills/prototype/` and its synchronized bundled copy — distinguish retained Plan Prototypes from scratch
  experiments; document self-contained submission and the screen/state contract.
- Existing Plan-store, runtime-layout, review, archive, and browser tests — prove retention and behavior through real boundaries.
- `docs/domain-language.md`, Core/Workspace PRDs, and `docs/prd/product-planner-prd.md` — deliver Plan Prototype and
  Prototype Revision terminology and only this child's capability requirements.
- `docs/adr/006-local-first-workspace-plan-board.md`, `007-plan-archival-and-retrieval.md`, and
  `016-project-runtime-state-under-wld-internal.md` — maintain the Plannotator dependency decision and associated local
  retention/ownership. Keep internal-only portability detail in PRDs/Plans, not public documentation.

Product acceptance, Router, shared-prototype publication, and the external Plan Store migration do not change here.

## Reuse Opportunities

- `HtmlViewer`, `useHtmlAnnotation`, `AnnotationPanel`, `buildPersistedHtmlAnchor`, `projectHostThreads` — retain existing
  interaction and anchor semantics, not a new annotation system.
- `sendPlannerMessage`, `buildPlanReviewFeedback`, `reviewDenyApi`, `buildPlanConversationRequest` — one owner conversation.
- `planId`, `resolveWorkflowPlanLocation()`, runtime admission/inspection, and Plan-store locks — one identity and storage owner.
- `defineGitFixture`, `makeValidationProjectRoot`, and the isolated runner — real storage/worktree tests without owned-system seams.

## Implementation Steps

1. **Submitted revisions survive process boundaries.** `plan-prototypes.ts` exports typed submit/read/feedback operations
   and `PrototypeRevisionRef`. Submitting via `plan_prototype` seals HTML and its named-state manifest under the primary
   runtime owner, attaches `prototypes` through the canonical Plan writer, and returns the same revision for identical
   content. Attempts to overwrite a revision, escape paths, follow an unsafe storage symlink, or read another Plan's
   material without owner authorization are refused. Passive reads create no storage.
2. **Retention follows Plan identity, not preview lifetime.** Saves, renames, Session restart, and registered
   planning/execution worktrees preserve references and resolve identical retained bytes. Archive/restore preserves
   material locally; deletion/prune removes only unreferenced owned material. Existing Markdown archive safety remains.
   Actual planning/execution/publication staging excludes the payload, feedback, and temporary authoring files.
3. **Local Plan review renders the selected revision safely.** `third_party/plannotator`, `.gitmodules`, and
   `plannotator-revision.txt` name one fetchable commit containing both upstream extensions. Existing Markdown Plan
   Review and Code Review still work on that pin. `PlanReviewSurface` renders prototypes with
   `resourcePolicy="self-contained"`, the displayed-context mapping, the real bridge, and current design primitives. Interaction and annotation modes, revision selection,
   keyboard access, and responsive controls work. No live `src` mode, credentials, private transcript, or production
   mutation authority enters the frame.
4. **Comments preserve exact product context.** Plannotator's captured displayed context is validated against the manifest;
   durable feedback includes revision, screen/state, anchor, and original context. Named states can be reopened through
   the prototype's initialization contract. Existing text/pinpoint UI sends this typed data through the review route and
   conversation builder to the current Agent. New revisions never inherit old anchors automatically; old feedback remains
   inspectable after restart, and a stale response cannot overwrite new review input.
5. **Tests and Skill guidance exercise the real workflow.** Co-located TypeScript tests cover revision immutability,
   same-machine retention, archive/deletion, stale frame messages, typed feedback transport, and unchanged Markdown review.
   The prototype Skill produces self-contained, named-state submissions through the new tool while preserving disposable
   scratch use. No test-only injection seam, `any`, `unknown`, or standalone shared-type module is added.
6. **Documentation matches this delivery.** Update the owning Core retention and Workspace local-review requirements and
   acceptance scenarios, then link the transient PRD to those owners. Keep later product acceptance and shared review
   targeted/deferred. Update affected ADRs and `docs/domain-language.md` definitions, avoided aliases, and relationships
   for Plan Prototype and Prototype Revision. Do not add Product Planner as delivered until the next child.

## Approval Confirmation

No Work Records are proposed for supersession. The owner chose upstream Plannotator PRs from the owner's fork, with a
fork pin as fallback. Storage naming, archive retention through prune, and the root-attribute names are reviewable
implementation assumptions; they do not change the owner's local-only scope.

## Verification Plan

Use the Bun version in the checkout’s root `.bun-version`. Run `bun run install:locked` before checks. Use `bun scripts/run-tests.ts`, never direct `bun test`.

- Add `src/shared/plan-prototypes.test.ts` and `src/tools/plan-prototype.test.ts`; run
  `bun scripts/run-tests.ts src/shared/plan-prototypes.test.ts src/tools/plan-prototype.test.ts src/plan-store.test.ts`.
  Use fresh process readers and real registered Git worktrees. Submit version A, save an empty-cart annotation, submit B
  with the control removed, restart, and read both: the exact A bytes and original comment context must survive, B must
  have a different reference, and duplicate A submission must not mutate it. This fails for temporary or in-memory storage.
- Extend archive/restore/prune and runtime-layout tests using their existing isolated suites. Confirm rename, restoration,
  an Epic child referencing parent material, deletion with a surviving reference, and cleanup without touching unrelated
  files. Inspect actual staged/published Git trees, not only `.gitignore`, for absence of prototype HTML and feedback.
- Add `src/ui/workspace/react/plan-prototype-review.test.tsx` and route/feedback integration coverage; run
  `bun scripts/run-tests.ts src/ui/workspace/react/plan-prototype-review.test.tsx src/ui/workspace/react/plan-review-feedback.test.ts src/ui/workspace/plan-review-cross-surface.integration.test.ts`.
  Exercise real feedback serialization into Agent input, A/B context, stale frame replies, invalid state IDs, and restart.
  A viewer that only renders HTML or turns annotations into unstructured prose must fail these checks. Shared review
  tokens must not read local prototype payloads or mutate their feedback. Existing Plan publication contains no HTML,
  private prototype feedback, or owner credentials; ordinary Markdown sharing remains functional.
- **Pin check:** `git submodule status third_party/plannotator`, `cat third_party/plannotator-revision.txt`, and
  `git -C third_party/plannotator log --oneline` must agree on one commit that contains both extension merges (or both
  fork branches). `git ls-remote` against the configured submodule URL must show that commit is fetchable. Plannotator's
  own tests for the two options belong to the upstream PRs; this child proves RunWield's use of them.
- After the pin update, run `bun run workspace:build` and
  `bun scripts/run-tests.ts src/ui/workspace/workspace-plan-review-ux.test.tsx src/ui/workspace/workspace-plan-review.integration.test.ts`
  to show existing Plannotator-backed review still works.
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
- **Concurrent tabs or writes:** compare expected document/feedback revisions through existing locks. Preserve unsent
  owner input on conflict; do not merge anchors across prototype versions.
- **Upstream review changes the options:** if merged names or behavior differ from PR #3907 or the context PR as
  proposed, follow the merged public contract. Return to the owner only if a change removes a capability this child needs.
- **Invalid or missing state labels:** do not fabricate the latest selected state. Preserve the owner's text and require
  valid capture before recording a state-bound annotation; provide ordinary action error/retry, not portability messaging.
- **Broken cross-machine references:** accepted scope limit. Do not publish bytes or introduce warnings to hide that limit.
- **Future storage relocation:** UI and tools use the prototype owner, never physical paths. Follow current accepted
  runtime ownership; do not implement or accept proposed ADR-019 as a side effect.
- **Prototype trust:** this is a simulated local experience, not a production application or hardened general browser.
  Frame content cannot authorize host actions. No universal browser-state replay or screenshot system is required.
