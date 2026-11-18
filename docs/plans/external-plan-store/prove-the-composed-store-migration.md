---
planId: "1dfdadeb-adfd-4323-b066-a32fd6ea5b4b"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store/"
    - "scripts/bun-test-files.json"
    - "src/shared/workflow/"
    - "src/shared/session/"
    - "src/shared/remote/"
    - "src/ui/workspace/"
    - "src/shared/project-runtime-layout.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
    - "docs/user-documentation/"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 13
dependencies:
    - "external-plan-store/preserve-session-and-connect-continuity"
    - "external-plan-store/expose-home-plans-across-user-surfaces"
    - "external-plan-store/activate-managed-remote-store-ownership"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "reviewed"
---

# Prove the Composed Store Migration

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Independent child tests cannot show that imported Epic siblings, surfaces, publication, runtime relocation and Session continuity work together. This child owns that missing cross-boundary evidence, not unimplemented features from other slices.

Owning requirements: Core [Plan authoring and external adoption](../../prd/runwield-core-prd.md#plan-authoring-and-external-adoption), [Work protection](../../prd/runwield-core-prd.md#work-protection), [Remote connection](../../prd/runwield-core-prd.md#remote-connection), [Session continuity](../../prd/runwield-core-prd.md#session-continuity), and [Execution and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). The transient proposal supplies the cross-capability [Plan store](../../prd/plan-store-prd.md#plan-store), [runtime](../../prd/plan-store-prd.md#project-runtime-outside-checkouts), [launch ownership](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode), and [explicit import](../../prd/plan-store-prd.md#plan-import) scenarios. Preserve these requirements; this child adds composed evidence and corrects stale maturity statements, without changing their semantics.

Planning baseline is delivered Plan 12 at `bd24597e6cda62f9695b91544a1015aa35608e75`. Its managed launch, owner transport, retained publication proof and adoption mechanisms exist. Its process fixtures do not establish a real Linux SSH qualification. Several transient PRD paragraphs still describe activation and managed transfer as target; reconcile them against the central capabilities and actual evidence rather than treating those paragraphs as missing implementation.

## Objective

After this child, composed tests prove the core home-store workflow across ordinary local, manual SSH and managed remote ownership, including recovery across the boundaries below. Platform qualification is recorded separately from local process evidence. Milestone history and full retention follow as explicit extensions; both remain required by the agreed full Epic scope. Do not start children 14 or 15.

## Approach

Drive real entry points through one integrated journey: relocate runtime -> explicitly import Epic -> edit sibling during
execution -> continue from another surface -> publish with Plan copies off -> remove execution checkout -> move/rename
Project directory -> retrieve record and resume Session. Keep Project, Plan, record and Session IDs stable. Split this
journey into bounded scenario files with fresh fixtures; do not put the whole ownership/crash matrix in one slow file.

`src/plan-store/index.ts` remains the only public Plan persistence owner. Reuse `importPlans`, `savePlanProse`,
`capturePlanReadContext`, execution reservation and named publication commands through real callers. Existing Git,
Session and runtime owners keep their responsibilities. A second facade, private consumer import or fake Plan writer
would weaken the very boundary this child must prove.

| Launch                          | Personal Plans, records and native store locks                       | Git effects and execution runtime |
| ------------------------------- | -------------------------------------------------------------------- | --------------------------------- |
| Ordinary local                  | Current account home                                                 | Current account home              |
| Manual SSH, then ordinary `wld` | Remote account home; laptop unavailable                              | Remote account home               |
| Laptop `wld remote <host>`      | Laptop home, including a home-only Project without a laptop checkout | Remote account home               |

Managed disconnect must retain this selection. Opening the same repository in manual SSH must not expose or take over
the laptop owner's Plan or attempt. Settings and user overrides remain in each checkout and retain their exact bytes.

Bounded regressions exposed by these scenarios are repaired in their existing owners. A missing public capability or
architectural expansion is reported immediately with the failing journey and recommended responsible child or focused
repair Plan; seek a scope decision before absorbing it. Do not rewrite delivered children or start another workflow.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/` — composed real-Git migration and recovery fixtures
- `src/plan-store/` — existing public owner operations only if a composed regression needs repair
- `scripts/bun-test-files.json` — register each new bounded TypeScript test in the isolated runner
- `src/shared/session/` — post-delivery rename/resume evidence
- `src/shared/remote/` — composed owner-mode evidence
- `src/ui/workspace/` — real Project surface continuation checks
- `src/shared/project-runtime-layout.ts` — audit remaining old runtime writers
- `docs/prd/runwield-core-prd.md` — cross-capability delivered journeys
- `docs/prd/runwield-workspace-prd.md` — surface journey consistency
- `docs/prd/runwield-connect-prd.md` — host continuation evidence
- `docs/prd/runwield-acp-protocol-prd.md` — client continuation evidence
- `docs/prd/plan-store-prd.md` — reconcile stale activation claims and link central capability evidence; retain unmet history and retention requirements
- `docs/adr/0020-home-project-state-and-launch-mode-ownership.md` — record verified owner mechanisms without unilateral acceptance
- `docs/user-documentation/` — explicit import, storage locations, copy defaults and backup guidance

## Reuse Opportunities

- Reuse authentic composed publication/remote fixtures and existing isolated runner.
- Reuse `managed-store-activation-fixture.ts`, `remote-runtime-workflows-fixture.ts`,
  `project-runtime-home-recovery.test.ts`, `epic-sibling-drafts.test.ts`, and
  `publication-session-restart.integration.test.ts`; extend their real owner paths instead of rebuilding lifecycle machinery.
- Reuse outcome IDs/capability links from the parent Epic instead of adding parallel definitions.
- [Git worktree documentation](https://git-scm.com/docs/git-worktree) distinguishes removal from repair after a move;
  use the existing Core cleanup/rebinding owners and assert valid registrations. [OpenSSH forwarding guidance](https://man.openbsd.org/ssh_config#ExitOnForwardFailure)
  does not guarantee destination connectivity; verify application recovery after disconnect.

## Implementation Steps

1. Proposed `src/shared/workflow/composed-store-local.test.ts` proves the complete ordinary-owner journey below through actual import, review/continuation, execution, publication and Session owners. Its sibling edit is read by a later child's planning entry without publishing the sibling. Proposed `src/shared/remote/composed-store-ownership.test.ts` repeats the ownership-sensitive journey with separate laptop/execution homes and production managed bootstrap, plus ordinary/manual-SSH entry while the laptop service is absent.
2. Proposed `src/shared/workflow/composed-store-recovery.test.ts` and `src/shared/remote/composed-store-recovery.test.ts` prove fresh-process continuation before destination publication, after publication before source retirement, and after real Git publication before owner acknowledgement. Reuse existing process drivers and natural process/transport boundaries; preserve each operation/attempt identity and prevent duplicate effects.
3. A runtime-writer audit plus exercised operations finds no new-format live `docs/plans`/delivery-copy fallback and no recreation of `.wld/internal/` or `.wld/plans`.
4. Existing configuration/override bytes, user source changes and retained repair data are preserved throughout the journey; legacy source documents remain untouched by explicit import.
5. User guidance states the actual home owner for both SSH modes, explicit import commands, copy defaults and store backup location; it never claims same-disk history is a backup.
6. Central PRDs and relevant ADR ownership clauses consistently describe verified current behavior and remaining history/retention targets. The proposed ADR is accepted only through the project's real decision process, not inferred from tests.
7. Every composed scenario has a recorded observed result, owner arrangement and evidence class: automated integration, actual platform smoke, or unavailable/unproved. Any missing capability has a concrete scope decision before implementation expands; a skipped platform run never becomes a passing result.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Proposed composed coverage and existing focused regressions:

```sh
bun run test src/shared/workflow/composed-store-local.test.ts src/shared/workflow/composed-store-recovery.test.ts
bun run test src/shared/remote/composed-store-ownership.test.ts src/shared/remote/composed-store-recovery.test.ts
bun run test src/shared/workflow/epic-sibling-drafts.test.ts src/shared/session/publication-session-restart.integration.test.ts src/shared/session/project-continuity.test.ts src/shared/attached/project-continuity.test.ts
bun run test src/shared/remote/managed-store-activation.test.ts src/shared/remote/managed-store-publication.test.ts src/shared/remote/remote-runtime-workflows-end-to-end.test.ts
bun run plan-store:check
bun run seams:check
```

The four `composed-store-*` files are proposed; the remaining files exist in the planning baseline. This is new evidence
for already implemented behavior, so a passing baseline is possible. Show each test's sensitivity with a bounded
counterfeit or an observed pre-repair failure; merely adding another passing regression command does not prove composition.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules. New source/tests use TypeScript and actual import
extensions. `bun run test` selects this checkout's isolated `scripts/run-tests.js`; do not invent a `.ts` runner path.
Keep each file within the existing isolated-runner deadline; split expensive cases instead of raising aggregate timeouts.

- **Local composition:** Seed a real legacy Epic with two child drafts, linked checkout runtime, unfinished repair
  bytes, and local settings/overrides. Passive discovery imports nothing. Deliberate entry relocates runtime; explicit
  folder import preserves source bytes, Plan IDs and relationships and is repeatable without duplicates. Execute one
  child while saving a sentinel sibling edit through the public owner. A later planning entry sees the sentinel before
  any sibling publication. A stale repository/delivery-copy decoy must not be read. Exercise current browser review
  routes and one Session/Attached continuation path: surface B discovers and resumes surface A's saved workflow through
  normal lookup, retaining its current revision, attempt and pending action. Calling two APIs independently with matching
  IDs is insufficient. Stale review input is refused.
- **Publication and cleanup:** Use real Git repositories and a bare target. Disable Plan copies and Work Record copies
  while keeping record generation enabled. Assert the sentinel code reaches the target, no artifacts-only copies commit
  appears, and no new delivery copies appear (unchanged legacy source files may remain). Remove the execution checkout
  through Core cleanup. Include interruption before canonical record persistence, then alter live Plan prose and resume
  Recorder after cleanup. Its first successfully persisted record uses sealed content, retained record identity and exact
  original delivery provenance; returning an already completed record is insufficient. Move the Project directory,
  reopen normally, and resume the same Session; historical segment cwd remains evidence while current cwd resolves to
  the new directory. Process A holds the actual Session writer lock. Process B resolves the old saved locator and renamed
  Project to the same Session/lock identity, observes lock contention specifically, then resumes after A releases it.
  Failure because the old directory is missing is insufficient. Search returns the canonical record after index rebuild.
- **Owner composition:** Use the real managed startup/admission path without a laptop checkout; replacing SSH/network
  or model execution is permitted at the external boundary only. Imported Epic documents, sibling edits, review and
  record retrieval live on the laptop. Git refs and execution runtime live in the remote account home. Use a same-ID
  remote-personal decoy to prove no takeover. With laptop services absent, ordinary/manual-SSH entry independently
  imports and delivers its own work. Reconnect a managed Session after a lost reply; the original operation result and
  one canonical mutation survive, and the manual owner's bytes stay unchanged.
- **Recovery composition:** Interrupt real child processes at the selected relocation and publication boundaries;
  wait for observed durable evidence before killing them. Resume in a fresh process with the same identities. Compare
  exact source/destination bytes and permissions, frozen input digest, target ref, operation receipt and record identity.
  Before verified destination commit, source is retained; after retirement, no competing writer remains. A real push
  followed by lost owner acknowledgement settles once without another push or record. Missing/contradictory proof stays
  recoverable and cannot mark the Plan verified. Retained repairs and unrelated user changes survive every case.
- **Writer audit:** Inspect primary and linked checkouts after each stage, including failure/restart: no `.wld/internal`,
  `.wld/plans`, runtime substitute or Plan-store symlink is recreated. Compare settings/override bytes, inspect home
  runtime locations and verify Git worktree registrations. Unavailable home access refuses writes without fallback.
  Source-boundary checks supplement these operations; a clean grep alone is insufficient.

- The new composed test must fail if any stage reads a stale primary Plan, loses a sibling edit, depends on an execution checkout for recording, or creates a second Session writer after rename.
- **Counterfeit check:** Temporarily disable managed owner selection, substitute a stale checkout document for the
  sibling read, and skip owner settlement after Git proof, one at a time. The corresponding scenario must fail on
  canonical bytes/revision, sentinel content or lifecycle/record provenance rather than an incidental exception.
  Restore each change before final validation. Existing correct implementations need no artificial pre-change failure.
- Run fresh-process crash points with real stores and Git, not injected lifecycle/Plan writes; check exact source/target evidence rather than only messages.
- Record Linux/macOS/Windows local coverage and supported Linux remote-host coverage honestly, with unavailable platform checks explicit.
- Manual: Perform the complete journey through normal TUI plus browser Plan review or Workspace; inspect no runtime
  files remain in the project and restore the Session after a directory rename. On an actually available supported
  Linux SSH host, run both ordinary `wld` after manual SSH and laptop `wld remote <host>` with the matching built runtime.
  Include managed disconnect/reconnect, copy-disabled real publication and owner-side record retrieval. Record host,
  runtime revision, commands/actions and observed result. This qualification has not yet been run for the composed
  journey. Establish available host access during execution. If it cannot run, report the missing prerequisite and
  obtain an explicit scope decision before claiming this acceptance criterion complete; do not silently waive it.
  Loopback tests do not prove Linux/SSH or Windows/macOS portability, and no credential or host is invented.
- Preserve: All Epic-preserved behavior, including code isolation, completion proof, automatic internal repair, host permissions and shared-Plan restrictions.
- Retire: Obsolete general fallback readers/writers only where their replacement already exists; bounded legacy import/settlement remains.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- History and retention are still explicit subsequent children, not implicitly shipped or removed at this milestone.
- Do not remove tests merely because old paths no longer compile; retain the protected behavior they represented.
- Qualification limitations are evidence gaps, not permission to weaken owner, publication or recovery semantics.
  Public behavior gaps require early scope review; ordinary bounded regressions remain part of this proof work.
