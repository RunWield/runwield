---
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
status: "draft"
planId: "61c0ed72-9d95-46de-94e2-d54a26abc0a9"
---

# Activate the Local Home Store

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The preceding slices supply the persistence, workflow and user-surface contracts, including browser review used by ordinary CLI workflows. Public startup must switch those consumers as one supported format, not expose half-built new storage or retain a permanent alternate live backend.

Owning requirements: [Plan import](../../prd/plan-store-prd.md#plan-import); [Plan store](../../prd/plan-store-prd.md#plan-store); [Launch mode](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode); [Plan authoring](../../prd/runwield-core-prd.md#plan-authoring-and-external-adoption). These are target changes; preserve the existing behavior named below.

## Objective

After this child, ordinary local and manual-SSH `wld` can import, plan, review, execute, publish and retrieve records end to end from home Project storage, including their normal browser review and supported user surfaces. Managed-remote activation and composed migration proof remain required before the broader supported-launch-mode milestone.

## Approach

Use explicit store-format admission at shared Core entry, with one format owner for an admitted Project. Publish the
CLI/tool contracts only when packages, lifecycle, import, default Work Record copies and package-aware review/surface
adapters are available. Remove general
repository fallback reads; keep legacy parsing only for import and settlement of recorded pre-cutover attempts.

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
- `src/shared/project-runtime-layout.ts` — composed admission and one-way adoption
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

1. Ordinary local startup and manual SSH followed by `wld` select their own account home store; all authoring, loading and workflow tools use it after version admission.
2. `wld plans import` exposes the prepared importer; loading an external Markdown path is the same explicit import. Empty normal lists omit unimported files and explain the command without automatic import.
3. Folder import offers Plan delivery copies once with the proposal's default selection, records the answer, and does not change the independent Work Record default.
4. Planner, Slicer, Engineer and Recorder prompts/tools expose package document paths and owner-controlled mutations; no Agent is instructed to edit protected metadata or create `.wld/plans`.
5. End-to-end local execution, publication and record retrieval use one package, preserve imported active attempts, and never recreate checkout `.wld/internal/`.
6. Public old-format discovery/adoption and new-format checkout document synchronization are removed; only explicit import and recorded legacy-attempt settlement retain legacy reads.
7. Core and affected surface requirements, glossary Plan/Plan Metadata/Epic Artifact/external adoption, Work Record/Delivery Copy, and Plan Board/Editor/reader definitions, and user docs describe the delivered local behavior. Managed remote remains explicitly target until its activation child lands; prepared surface wording becomes current only with this public cutover.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.ts src/cmd/plans/index.test.ts src/cmd/load-plan/index.integration.test.ts src/tools/plan-written.test.ts src/tools/plan-safe-file-tools.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Run the composed CLI/tool path in a disposable real Project: fresh empty store, explicit import, review, execution, delivery and record retrieval. No entry point can rediscover an unimported repository Plan.
- Repeat folder import and prove the delivery-copy question occurs once; direct path loading uses the same importer and preserves source bytes.
- Record all writes beneath project `.wld/` across success and failure; only pre-existing settings/overrides remain and their hashes are unchanged.
- Manual: Use ordinary `wld` on an upgraded Project without importing, then import and finish one task; repeat by manually opening SSH and running `wld` with the laptop offline.
- Preserve: Ordinary command semantics, review/readiness, private Sessions, target proof, recovery and local configuration overrides.
- Retire: Automatic external-document adoption, branch-selected live Plans, runtime checkout fallback, and Agent front-matter mutation instructions.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Do not leave a user-facing permanent legacy/new backend switch after the migration.
- No core workflow is implemented for the first time here: if a prerequisite contract is missing, reshape its not-started child rather than hide the missing capability in activation.
