---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/cmd/remote/index.ts"
    - "src/shared/remote/entry.ts"
    - "src/shared/remote/supervisor.ts"
    - "src/shared/remote/runtime.js"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/018-remote-ssh-local-personal-authority.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 12
dependencies:
    - "external-plan-store/relocate-project-runtime-into-home-storage"
    - "external-plan-store/activate-the-local-home-store"
    - "external-plan-store/expose-home-plans-across-user-surfaces"
    - "external-plan-store/serve-laptop-owned-project-state"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "614d4a10-94c7-434a-b7c6-628aba5450b2"
---

# Activate Managed Remote Store Ownership

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The owner explicitly distinguishes manual SSH followed by ordinary `wld` from laptop-managed `wld remote host`. Public managed remote execution must compose that selection with all home-runtime relocation and supported workflow consumers.

Owning requirements: [Launch ownership](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode); [Project runtime](../../prd/plan-store-prd.md#project-runtime-outside-checkouts); [Remote connection](../../prd/runwield-core-prd.md#remote-connection). These are target changes; preserve the existing behavior named below.

## Objective

`wld remote host` completes planning, review, execution, publication and recording with laptop-owned Plans and remote-account home execution state, while manual SSH `wld` remains independent of the laptop.

## Approach

Resolve launch mode once during entry and pass its explicit owner context to every store consumer. Transfer personal
legacy runtime to the laptop through verified staged adoption; keep Git registries, staging/repair files and Git-effect
journals in remote home Project execution bindings. Shared Project IDs do not merge personal stores.

```text
manual SSH + wld -> remote personal store + remote execution runtime
laptop wld remote -> laptop personal service + remote execution runtime
```

Managed disconnection is unavailability/recovery, never a selector for the remote account's personal store.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/remote/index.ts` — public launch selection and entry/adoption
- `src/shared/remote/entry.ts` — bind laptop owner and remote execution context
- `src/shared/remote/supervisor.ts` — connection lifecycle and recovery
- `src/shared/remote/runtime.js` — compose workflow consumers with store service
- `src/shared/project-runtime-layout.ts` — cross-host adoption and owner-aware runtime paths
- `src/shared/worktree-registry.js` — personal-owner scoped attempts and repository-level Git coordination
- `src/shared/workflow/` — cross-host lifecycle/publication reconciliation
- `docs/prd/runwield-core-prd.md` — managed remote acceptance and project runtime scope
- `docs/adr/018-remote-ssh-local-personal-authority.md` — reconcile laptop Plan ownership and remote home execution state
- `docs/domain-language.md` — remote personal authority and Project Runtime State relationships

## Reuse Opportunities

- Reuse the prepared personal-store transport, existing remote host identity, connection-scoped mount verification and Session persistence.
- Reuse staged runtime relocation and proof-bearing publication; no new automatic external-effect retry policy.

## Implementation Steps

1. Managed remote entry selects the laptop Project store and remote account home execution tree; ordinary manual SSH entry selects only that remote account's personal store.
2. Automatic relocation transfers all personal and execution internal resources to their actual owners, preserving permissions, unfinished attempts, repair bytes and Git registrations; no remote checkout `.wld/internal/` remains.
3. Shared repository/Project IDs cannot adopt another personal owner's Plan or attempt. Remote execution bindings retain owner identity and repository-level coordination prevents unsafe Git overlap.
4. All remote planning, review, lifecycle, publication, record/index and collaboration consumers use their owner-specific contracts; no Plan lock or index database runs through SSHFS.
5. Disconnect and lost acknowledgement preserve durable operation evidence. Reconnect reconciles the same owner; mount replacement cannot select stale paths or another personal store.
6. Remote execution remains connected-only and requires no laptop checkout or source sync; ordinary SSH `wld` works with the laptop offline.
7. Core remote/runtime requirements, ADR-018 and glossary remote-owner relationships reflect the completed launch distinction while history/retention remain separate target work.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/shared/remote/remote-runtime-workflows-end-to-end.test.ts src/shared/remote/remote-runtime-workflows-reconnect.test.ts src/shared/remote/remote-runtime-workflows-records-faults.test.ts src/shared/remote/entry-isolation.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Exercise both launch modes against one remote repository using distinct personal stores; assert no copied Plans, no cross-owner attempt takeover and no checkout runtime writes.
- Interrupt cross-host relocation and publication before/after acknowledgement; a new connection retains exact Git proof and repairs without duplicate effects.
- Assert laptop-side native lock/index ownership and remote home staging ownership, then delete temporary mount paths and reconnect successfully.
- Manual: On an available supported Linux host, run manual SSH `wld` with laptop services absent, then laptop `wld remote`; plan and deliver in both, disconnect a managed operation and resume. If no host is available, record the unproved platform journey rather than claiming loopback tests establish it.
- Preserve: Host trust, connected-only execution, laptop Session authority, remote-only source access and current review/browser forwarding.
- Retire: Managed-remote checkout runtime, remote-account Plan fallback, implicit invocation-mode takeover and mounted native lock authority.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Different personal owners can share a physical repository without sharing private Plans; coordination is for Git effects, not data synchronization.
- The first real managed-remote activation must not strand pre-cutover runtime from old connections.
