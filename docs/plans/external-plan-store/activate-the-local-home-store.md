---
planId: "61c0ed72-9d95-46de-94e2-d54a26abc0a9"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/cli.ts"
    - "src/cmd/plans/"
    - "src/cmd/load-plan/"
    - "src/tools/plan-written.ts"
    - "src/tools/plan-safe-file-tools.ts"
    - "src/agent-definitions/"
    - "src/shared/project-runtime-layout.ts"
    - "src/plan-store.js"
    - "src/shared/workflow/package-workflow.ts"
    - "src/shared/work-records/owner.ts"
    - "src/cmd/wr/"
    - "src/shared/attached/"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/user-documentation/"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 10
dependencies:
    - "external-plan-store/preserve-session-and-connect-continuity"
    - "external-plan-store/import-plans-with-workflow-evidence"
    - "external-plan-store/run-lifecycle-from-canonical-plans"
    - "external-plan-store/move-work-records-with-delivery-copies"
    - "external-plan-store/expose-home-plans-across-user-surfaces"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "reviewed"
---

# Activate the Local Home Store

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The preceding slices supply the persistence, workflow and user-surface contracts, including browser review used by ordinary CLI workflows. Public startup must switch those consumers as one supported format, not expose half-built new storage or retain a permanent alternate live backend.

Owning requirements: [Plan import](../../prd/plan-store-prd.md#plan-import); [Plan store](../../prd/plan-store-prd.md#plan-store); [Launch mode](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode); [Plan authoring](../../prd/runwield-core-prd.md#plan-authoring-and-external-adoption). These are target changes; preserve the existing behavior named below.

### Prepared-branch findings

The prepared branch is `ea8fc7079119a620189ce3ad3bc8100368fe7d39`, including child 9. These are implemented
prerequisites, not work to rebuild:

- `enterProjectRuntime` already admits ordinary execution-account identity and calls `enterHomeProjectRuntime`.
  Runtime relocation and explicit document import are separate operations.
- `plan-package-store.ts` owns package creation, revisioned document writes, import, retained inputs and publication
  receipts. `withPackageWorkflow` checks Project, repository, owner, Plan ID and revision before admitting workflow work.
- `plan-store.js` still selects package behavior through `currentPackageSelection()` and otherwise discovers checkout
  Plans. Catalog and new-Plan authoring cannot require an existing selected Plan merely to choose their store.
- `src/cmd/plans/index.ts` does not expose import. `load-plan` still calls `onboardExternalPlan`; the prepared importer
  must replace that in-place adoption path. Work Record import exists but canonical access requires its owner scope.
- Child 9 delivered package document/review adapters, revision and role checks, Core `read_plan`, `work_record_read`
  and `work_record_search`, restricted-host access proof, and nested-link/Sequence review repairs. Activate these
  boundaries through normal entry; do not fork them or weaken their authorization.
- `withPackageWorkflow` raises `LegacyPackageContinuation` for a retained unfinished imported attempt. Its existing
  evidence checks are not a complete public continuation-and-settlement journey; this child must connect that journey.

Also update the owning [Core recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery),
[Work records](../../prd/runwield-core-prd.md#work-records),
[Project initialization](../../prd/runwield-core-prd.md#project-context-and-initialization),
[Workspace Plans](../../prd/runwield-workspace-prd.md#local-plan-management),
[browser review](../../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow),
[Connect outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes), and
[ACP access](../../prd/runwield-acp-protocol-prd.md#chat-workflow-access) capabilities.
Add public canonical authoring/import and store-only discovery; preserve lifecycle, private Session ownership, restricted
host permissions, Shared Plan restrictions and confirmed-publication completion. Remove ordinary checkout authority.

No sibling scope moves are proposed. Only this child is authorized; managed-remote activation and the Epic-wide final
migration qualification stay with later children.

## Objective

After this child, ordinary local and manual-SSH `wld` can import, plan, review, execute, publish and retrieve records end to end from home Project storage, including their normal browser review and supported user surfaces. Managed-remote activation and composed migration proof remain required before the broader supported-launch-mode milestone.

## Approach

Use explicit store-format admission at shared Core entry, with one format owner for an admitted Project. Publish the
CLI/tool contracts only when packages, lifecycle, import, default Work Record copies and package-aware review/surface
adapters are available. Remove general
repository fallback reads; keep legacy parsing only for import and settlement of recorded pre-cutover attempts.

Resolve Project-level storage independently of selected-Plan workflow admission. Reuse the existing identity and
package owners; do not make every caller construct a selector, invent a placeholder Plan, or use an environment flag
as a permanent backend switch. Reconstruct authorized owner/Plan/revision context at each browser, Connect and ACP
request boundary, rather than depending on another request's async scope.

```text
normal local/manual-SSH entry -> Project identity + supported format -> home runtime and personal store
  passive catalog/read        -> inspect existing authority, no adoption or recovery writes
  explicit import/path load   -> existing importer -> canonical package -> review/continuation
  new planning               -> package document + owner-controlled definition -> plan_written
  selected workflow          -> checked Plan ID/revision -> existing lifecycle/publication/Recorder
  retained legacy attempt    -> exact recorded owner -> proven settlement -> canonical continuation
```

The empty store may explain `wld plans import`, but it must neither scan/adopt documents automatically nor ask an unsolicited migration question.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cli.ts` — ordinary entry and supported store-format admission
- `src/cmd/plans/` — import/list/read/archive/doctor command behavior
- `src/cmd/load-plan/` — path loading as explicit import and live package continuation
- `src/tools/plan-written.ts` — package-aware authoring handoff
- `src/tools/plan-safe-file-tools.ts` — protect metadata while exposing authorized document edits
- `src/agent-definitions/` — canonical paths, split metadata and removal of front-matter write assumptions
- `src/shared/project-runtime-layout.ts`, `src/shared/project-identity.ts`, `src/plan-store.js` and
  `src/shared/workflow/package-workflow.ts` — one Project format owner, passive catalog access, selected lifecycle
  admission and narrowly authorized legacy continuation
- `src/shared/plan-package-store.ts` and `src/shared/plan-package-import.ts` — reuse canonical creation/import; extend
  only where public authoring or settled continuation needs owner-controlled mutations
- `src/shared/work-records/owner.ts` and `src/cmd/wr/index.ts` — select canonical records without requiring a Plan;
  expose existing explicit import/list/read/search/rebuild through ordinary entry
- `src/shared/attached/`, `src/acp/`, `src/ui/workspace/` and `src/ui/review/` — connect normal public entry to child 9's
  resource/revision contracts, preserving independent request authorization
- settings and command-help owners — persist the one-time folder-import answer and separate delivery-copy settings
- `docs/adr/0020-home-project-state-and-launch-mode-ownership.md` and affected ADR-004/015/016/017/018 clauses — reconcile
  accepted local ownership while leaving managed-remote proposals explicitly separate
- `docs/domain-language.md` — Plan, Plan Metadata, Epic Artifact and external adoption definitions
- `docs/prd/runwield-core-prd.md` — same-change authoring/lifecycle/initialization requirements
- `docs/user-documentation/` — ordinary usage and explicit import guidance
- `docs/prd/runwield-workspace-prd.md` — activate the prepared package surface requirements
- `docs/prd/runwield-connect-prd.md` — activate supported package access requirements
- `docs/prd/runwield-acp-protocol-prd.md` — activate supported client package workflow requirements

## Reuse Opportunities

- Reuse command registry, plan_written lifecycle ownership, Agent definition loading and existing runtime entry guards.
- Reuse the complete package/import/lifecycle/publication contracts rather than fork CLI-specific store logic.

## Implementation Steps

1. **Normal entry selects home authority.** Ordinary CLI/TUI, local Workspace, Connect and ACP use the same admitted
   local Project format for Plans and Work Records. Manual SSH followed by `wld` selects that account's home without
   a laptop. Shared Core admission handles format/version compatibility and runtime adoption before mutations;
   passive list/read/help inspection does not migrate, repair, register or import anything. A missing or denied store
   never re-enables checkout discovery. Managed-remote entry retains its separate owner contract and existing supported behavior; this child must not
   silently route it into ordinary home admission or make it unsupported. Its new laptop-owned canonical activation
   remains deferred to its own child, without a public local legacy-backend switch.
2. **Explicit import is public and source-preserving.** `wld plans import <file-or-folder>` dispatches to
   `importPlanPackages`; `load-plan` with an external Markdown path imports through the same owner and continues the
   returned package. Canonical package references load directly. Name selection never searches repository documents.
   The importer retains identity, status, Epic relationships and continuation evidence, handles repeats/restarts without
   duplicates, and leaves source bytes unchanged. Plain Markdown and metadata-free delivery copies become drafts.
   `wld wr import <path>` uses canonical Work Record ownership even when no Plan exists; ordinary read/search/index
   cannot ingest repository copies implicitly.
3. **Delivery settings are explicit and independent.** Successful repository-folder Plan import offers keeping
   delivered Plans in `docs/plans/` once per Project, with yes preselected. Persist an actual answer so retries and
   subsequent sessions do not ask again; cancellation, EOF or missing interactive input is not an affirmative answer.
   Use established command input conventions and retain a pending choice without blocking already committed import.
   Do not prompt for file import, unrelated external folders, startup or passive browsing. Plan copies remain off by
   default before this choice; Work Record copies retain their separate on-by-default policy. Copy destinations are
   publication output, never live discovery input.
4. **New authoring uses package documents and typed definition changes.** Planner/Slicer creation, child/Sequence
   relationships, `plan_written`, Engineer/Recorder access and safe file tools use exposed package Markdown paths or
   authorized document operations. Core owns definition/lifecycle metadata in `plan.wld.json`; ordinary agents neither
   author protected metadata nor put YAML front matter in live Markdown. Update bundled templates, prompts and Connect
   planning handoffs together so a new Plan can be created in an empty store. Planning-only worktrees and branch Plan
   seeding/synchronization disappear for new package work; code execution isolation remains. Editing a sibling draft
   becomes visible on its next load without a Git publication step.
5. **Recorded attempts settle safely.** Route `LegacyPackageContinuation` only through the retained matching Project,
   Plan ID, repository and attempt evidence. Resume the original worktree, validation/checkpoint and publication owner;
   preserve uncommitted repairs and never start a replacement attempt merely because admission selected home storage.
   Reconcile changed live evidence through the existing recovery owner, then record proven delivery or deliberate
   abandonment in the package and release its unfinished-attempt binding. Restart/retry is idempotent. Positive
   settlement must remove dependence on the old checkout document for future package work. Missing, changed or
   contradictory evidence stays recoverable, preserves work and cannot fall through to generic legacy reads.
6. **Public journeys remain composed.** Review, execution, validation, publication, default record copying and later
   retrieval use one package across restart and surfaces. Store-only catalog/read/archive/doctor and scoped record
   search share the same identity. General checkout fallback and new-format document synchronization are removed;
   parsing repository documents remains only for explicit import or recorded pre-cutover settlement. Runtime writes
   remain in the home Project tree, with no `.wld/internal/`, `.wld/plans` or alias in primary/linked checkouts.
7. **Guidance matches the delivered local behavior.** Update the owning central PRD capabilities/scenarios, affected
   references, glossary definitions and user docs in the same change. Explain the breaking upgrade, explicit Plan and
   Work Record import, editable home documents, independent copy settings, home backup responsibility and local/manual
   SSH ownership. Reconcile the affected ADR ownership clauses. Keep managed remote and remaining history/retention
   targets distinct; do not retire the transient proposal while later Epic requirements remain undelivered.

## Verification Plan

Use Bun 1.4.3 and `bun run install:locked` before checks. The prepared branch has `scripts/run-tests.js`, while newer
checkout guidance names `.ts`; use the stable supported `bun run test` entrypoint rather than copying a nonexistent
runner path. RunWield runs full CI after implementation. For this child, run:

```sh
bun run test src/shared/local-home-store.integration.test.ts src/cmd/plans/import.test.ts src/cmd/load-plan/local-home-store.integration.test.ts src/shared/workflow/local-home-cutover.integration.test.ts
bun run test src/plan-package-import.test.ts src/plan-package-import-evidence.test.ts src/plan-package-import-recovery.test.ts src/shared/workflow/package-lifecycle.integration.test.ts src/shared/workflow/package-publication.integration.test.ts src/shared/workflow/package-work-record-delivery.integration.test.ts
bun run test src/cmd/plans/index.test.ts src/cmd/load-plan/index.integration.test.ts src/tools/plan-written.test.ts src/tools/plan-safe-file-tools.test.ts src/shared/project-runtime-entry.integration.test.ts src/shared/work-records/package-import.test.ts
```

The first four files are **new behavioral suites to implement**, not claims of existing passing coverage. Adapt nearby
existing tests to normal admission and run affected Connect/ACP/Workspace tests discovered during implementation too.
When browser adapters, JSX/TSX or UI types change, run `bun run workspace:check` explicitly; `bun run check` alone
does not cover that surface. Preserve existing managed-remote entry/admission regression tests to prove this local
cutover does not silently disable or change that launch mode.

Use `defineGitFixture`, real package/runtime owners and disposable homes; protect HOME/cwd mutations with
`withProcessGlobalTestLock`. Only external agent, browser, CI or process boundaries may be controlled. No injected
package, registry, lock or lifecycle substitutes.

- **Fresh/upgrade entry:** through public command or server dispatch, seed unimported Plans and Work Records plus
  conflicting delivery copies in a real repository. Normal startup/list/search across CLI and Workspace shows none;
  no import question occurs and passive snapshots show no writes. Explicit import makes only selected artifacts
  visible, with expected IDs/status/relationships and unchanged source hashes. Repeat after process restart and prove
  one package per ID. Empty-store new planning produces a canonical draft without first importing a repository Plan.
- **Import choice:** verify default yes, both persisted answers, a repeated folder import, interrupted/EOF prompting,
  a single-file import and a folder outside the Project. Neither answer changes Work Record copy policy. Load an
  external Markdown path and assert its package ID is the importer's ID, rather than an in-place adopted file.
- **Authoring and review:** create a Plan and a Sequence child through normal tools; edit package prose and a sibling,
  submit and review, then restart. Identity, lifecycle and relationships stay in metadata; stale revisions and protected
  metadata edits are rejected without losing prose. Exercise child 9's allowed resource operations under restricted
  host permissions; an arbitrary home path remains denied. Normal request entry must work without test-only package
  admission or a preselected Plan scope.
- **Composed delivery:** start from a public imported/created Plan, use real Git publication to a fixture target and
  the existing lifecycle/Recorder owners, restart between review and execution, and retrieve the record after removing
  the execution checkout. Check target ancestry/proof, canonical completion and exact retained input. Cover Plan
  copies off/Work Record copies on and both off; no copies setting may block delivery or change live authority.
- **Pre-cutover continuation:** seed a real recorded legacy attempt with uncommitted repair work, import explicitly,
  then resume through normal entry. Include validation-in-progress and publication-acknowledgement-loss cases. Prove
  the same attempt/worktree survives, publication happens once, canonical settlement is recorded, the old checkout
  may subsequently disappear, and a new package operation needs no repository document. Tampered/missing evidence
  must not start another attempt or fabricate completion. Exercise this Plan's own pre-cutover delivery shape.
- **No checkout runtime:** snapshot settings/overrides and recursively inspect primary and linked checkout `.wld/`
  after success, refusal and fresh-process recovery. Neither runtime directories nor Plan aliases are created; existing
  local configuration bytes remain unchanged except the specifically chosen delivery-copy setting. Preserve foreign
  files rather than deleting `.wld/` wholesale. Repeat from a second isolated home to prove owner separation.
- **Manual public flow:** launch ordinary `wld` in a disposable upgraded Project, see the empty list, explicitly import,
  edit/review in the real browser, execute and retrieve a record. Check nested evidence links and Sequence child review
  from normal entry. Repeat ordinary `wld` after manual SSH with the laptop unavailable when an SSH fixture exists;
  otherwise report that manual coverage honestly and use a fresh subprocess with an independent HOME for automated
  ownership proof. Do not claim managed-remote verification.
- **Preserve/retire:** retain approval/readiness, dependency ordering, private Sessions, authorization, stale-write
  rejection, code isolation, target proof and recovery tests. Replace tests asserting repository discovery, in-place
  external adoption, branch-selected Plan authority and agent front-matter mutation with explicit-import/store-only
  assertions; do not simply delete their lifecycle or recovery coverage.
- **Documentation:** confirm local capabilities and glossary match executed journeys, upgrade instructions include both
  explicit imports, and ADRs no longer compete on local authority. Remaining Epic outcomes stay target.

A counterfeit that only wraps existing commands in `withPackageWorkflow` cannot pass: empty-store authoring and
catalogs have no selected Plan, fresh requests must reauthorize, unimported repository files must stay invisible, and
settled legacy attempts must work after their old checkout is removed.

## Edge Cases & Considerations

- Do not leave a user-facing permanent legacy/new backend switch after the migration.
- All prerequisite children are delivered. Repair a bounded integration gap here; if a missing capability changes the
  approved objective, report that concrete gap instead of editing a delivered sibling or starting a later child.
- Home denial or an unsupported stored format is not permission to select checkout authority. Preserve evidence and
  expose the actual access/version prerequisite; automatic Core recovery remains responsible for owned machinery.
- Research: [Git worktree documentation](https://git-scm.com/docs/git-worktree) confirms moved worktrees need valid Git
  registration and describes `repair`. Reuse the shipped relocation owner; copying files alone does not prove preserved
  attempts. This source does not establish cross-host or Bun durability, which remain behavioral verification concerns.
