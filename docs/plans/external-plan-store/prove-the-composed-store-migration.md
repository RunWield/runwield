---
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/"
    - "src/shared/session/"
    - "src/shared/remote/"
    - "src/ui/workspace/"
    - "src/shared/project-runtime-layout.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/adr/019-home-project-state-and-launch-mode-ownership.md"
    - "docs/user-documentation/"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 13
dependencies:
    - "external-plan-store/preserve-session-and-connect-continuity"
    - "external-plan-store/expose-home-plans-across-user-surfaces"
    - "external-plan-store/activate-managed-remote-store-ownership"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "1dfdadeb-adfd-4323-b066-a32fd6ea5b4b"
---

# Prove the Composed Store Migration

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Independent child tests cannot show that imported Epic siblings, surfaces, publication, runtime relocation and Session continuity work together. This child owns that missing cross-boundary evidence, not unimplemented features from other slices.

Owning requirements: [Project runtime](../../prd/plan-store-prd.md#project-runtime-outside-checkouts); [Plan store](../../prd/plan-store-prd.md#plan-store); [Launch ownership](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode); [Execution and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). These are target changes; preserve the existing behavior named below.

## Objective

After this child, the core home-store workflow is usable end to end across ordinary local, manual SSH and managed remote execution with composed recovery evidence. Milestone history and full retention follow as explicit extensions; both remain required by the agreed full Epic scope.

## Approach

Drive real entry points through one integrated fixture/journey: relocate runtime -> import Epic -> edit sibling during
execution -> continue from another surface -> publish with Plan copies off -> remove execution checkout -> rename
Project -> retrieve record and resume Session. Repeat the owner-sensitive boundaries in managed remote mode.

Any missing public behavior belongs back in its responsible not-started child or a focused repair Plan; do not turn this into a catch-all implementation of omitted features.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/` — composed real-Git migration and recovery fixtures
- `src/shared/session/` — post-delivery rename/resume evidence
- `src/shared/remote/` — composed owner-mode evidence
- `src/ui/workspace/` — real Project surface continuation checks
- `src/shared/project-runtime-layout.ts` — audit remaining old runtime writers
- `docs/prd/runwield-core-prd.md` — cross-capability delivered journeys
- `docs/prd/runwield-workspace-prd.md` — surface journey consistency
- `docs/prd/runwield-connect-prd.md` — host continuation evidence
- `docs/prd/runwield-acp-protocol-prd.md` — client continuation evidence
- `docs/adr/019-home-project-state-and-launch-mode-ownership.md` — record verified owner mechanisms without unilateral acceptance
- `docs/user-documentation/` — explicit import, storage locations, copy defaults and backup guidance

## Reuse Opportunities

- Reuse authentic composed publication/remote fixtures and existing isolated runner.
- Reuse outcome IDs/capability links from the parent Epic instead of adding parallel definitions.

## Implementation Steps

1. One composed fixture proves every stage of the Epic's cross-boundary journey, including sibling visibility and Session continuity after execution checkout removal and Project rename.
2. A fresh-process kill matrix covers relocation commit boundaries and final publication/store acknowledgement boundaries across supported owner arrangements.
3. A runtime-writer audit plus exercised operations finds no new-format live `docs/plans`/delivery-copy fallback and no recreation of `.wld/internal/` or `.wld/plans`.
4. Existing configuration/override bytes, user source changes and retained repair data are preserved throughout the journey; legacy source documents remain untouched by explicit import.
5. User guidance states the actual home owner for both SSH modes, explicit import commands, copy defaults and store backup location; it never claims same-disk history is a backup.
6. Central PRDs and relevant ADR ownership clauses consistently describe verified current behavior and remaining history/retention targets. The proposed ADR is accepted only through the project's real decision process, not inferred from tests.
7. Any gap discovered has an identified responsible child or focused repair Plan with discriminating evidence; this Plan does not absorb new product scope.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.ts src/shared/workflow/publication-machine.e2e.test.ts src/shared/session/publication-session-restart.integration.test.ts src/shared/remote/remote-runtime-workflows-end-to-end.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- The new composed test must fail if any stage reads a stale primary Plan, loses a sibling edit, depends on an execution checkout for recording, or creates a second Session writer after rename.
- Run fresh-process crash points with real stores and Git, not injected lifecycle/Plan writes; check exact source/target evidence rather than only messages.
- Record Linux/macOS/Windows local coverage and supported Linux remote-host coverage honestly, with unavailable platform checks explicit.
- Manual: Perform the complete journey through normal TUI plus one other supported surface; inspect no runtime files remain in the project and restore the Session after rename. Include managed remote disconnect/reconnect.
- Preserve: All Epic-preserved behavior, including code isolation, completion proof, automatic internal repair, host permissions and shared-Plan restrictions.
- Retire: Obsolete general fallback readers/writers only where their replacement already exists; bounded legacy import/settlement remains.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- History and retention are still explicit subsequent children, not implicitly shipped or removed at this milestone.
- Do not remove tests merely because old paths no longer compile; retain the protected behavior they represented.
