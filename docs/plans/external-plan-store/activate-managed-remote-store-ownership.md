---
planId: "614d4a10-94c7-434a-b7c6-628aba5450b2"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/cmd/remote/index.ts"
    - "src/shared/remote/entry.ts"
    - "src/shared/remote/supervisor.ts"
    - "src/shared/remote/control.ts"
    - "src/shared/remote/project-store-client.ts"
    - "src/plan-store/"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/018-remote-ssh-local-personal-authority.md"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
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
userVerifiedAt: null
status: "in_progress"
---

# Activate Managed Remote Store Ownership

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
The owner explicitly distinguishes manual SSH followed by ordinary `wld` from laptop-managed `wld remote host`. Public managed remote execution must compose that selection with all home-runtime relocation and supported workflow consumers.

Owning central capabilities are Core [Remote connection](../../prd/runwield-core-prd.md#remote-connection),
[Project context](../../prd/runwield-core-prd.md#project-context-and-initialization),
[Work protection](../../prd/runwield-core-prd.md#work-protection),
[Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery), and
[Work Records](../../prd/runwield-core-prd.md#work-records). This child changes launch ownership and managed runtime
placement, preserving lifecycle, evidence, connected-only work and ordinary local/manual-SSH behavior.
The transient [Plan Store proposal](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode) supplies the accepted
target intent; promote delivered requirements into those central capabilities without claiming later history/retention work.

Plan 11 delivered `PreparedProjectStore`, `ProjectStoreClient`, authenticated registration and trusted
`registerHomeProjectOwner` admission without a checkout. Production `src/cmd/remote/index.ts` does not register that
service, and `entry.ts` does not select it for ordinary consumers. Its wire operations cover editing, limited review
events, frozen publications and records; they do not yet perform the complete authoring/execution/publication journey.
`project-runtime-layout.ts` still sends managed owners through checkout-runtime migration.

The Plan 11 integration note is required work here: freeze execution-repository delivery-copy settings before
publication, then carry execution-host Git proof to the matching laptop-owned attempt before completing lifecycle or
approving a Work Record. Sealing a snapshot alone establishes neither Git delivery nor that journey.

## Objective

`wld remote host` completes planning, review, execution, publication and recording with laptop-owned Plans and remote-account home execution state, while manual SSH `wld` remains independent of the laptop.

## Approach

Resolve launch mode at the trusted launcher/bootstrap boundary. Bind the remote Project/repository identity to the
laptop's home-only owner through `registerHomeProjectOwner` and `registerProjectStore`; pass the verified binding to
the supervisor/view before importing workflow consumers. Identity discovery stays passive until deliberate admission.
Non-Git folders and the remote-home entry retain their existing optional-Git behavior.

`src/plan-store/index.ts` remains the single public Plan owner. It selects local execution or the connection-bound
client internally; callers continue expressing named operations. Add the missing coarse operations needed by actual
consumers, keeping lifecycle policy centralized. Do not expose raw metadata, locks, filesystem access or a parallel
remote Plan API to callers. Work Record operations use their existing owner behind the service. Runtime layout and Git
publication keep their existing separate owners.

Transfer eligible personal legacy runtime to the laptop through verified staged adoption; keep Git registries,
staging/repair files and Git-effect journals in remote home Project execution bindings. Match original owner and attempt
before adopting. A matching Project ID is insufficient. Runtime adoption does not silently import repository Plan/record
copies or take a manual-SSH owner's packages. Preserve existing explicit import and retained-attempt rules.

```text
manual SSH + wld -> remote personal store + remote execution runtime
laptop wld remote -> laptop personal service + remote execution runtime
```

Managed disconnection is unavailability/recovery, never a selector for the remote account's personal store.

```text
remote repository settings -> frozen attempt input on laptop
laptop frozen documents -> remote execution and publication state machine
remote durable Git proof -> matching laptop attempt settlement -> lifecycle / Work Record confidence
```

The existing publication state machine proves Git effects on the execution host. A named owner operation validates and
retains that evidence against the exact Project, personal owner, repository, attempt, sealed input, candidate and target.
A request saying success, a Session message, or a matching commit string alone cannot approve delivery. Keep the existing
receipt/proof semantics; do not add a second publication phase machine. Lost replies reconcile the same operation ID
and retained proof without replaying Git. Execution settings are frozen before publication and reused after reconnect;
the home-only owner's current false/false defaults cannot replace the remote repository policy.

Copying packages to the execution host or routing all workflow code directly through a transport client would create
another authority or spread ownership decisions across consumers. The public owner hides transport and persistence.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/remote/index.ts` — public launch selection and entry/adoption
- `src/shared/remote/entry.ts` — bind laptop owner and remote execution context
- `src/shared/remote/supervisor.ts` — connection lifecycle and recovery
- `src/shared/remote/control.ts`, `project-store-protocol.ts`, `project-store-service.ts`, `project-store-client.ts` —
  bind trusted admission and extend named operations for the live journey
- `src/plan-store/`, especially access, workflow and publication operations — hide remote selection and accept matched
  execution evidence; keep existing lifecycle policy and boundary enforcement
- `src/shared/work-records/` and remote Session continuation — owner-side record/index work and stable resume identities
- `scripts/check-plan-store-boundary.ts` and isolated test inventory — enforce the owner interface and include new tests
- `src/shared/project-runtime-layout.ts` — cross-host adoption and owner-aware runtime paths
- `src/shared/worktree-registry.js` — personal-owner scoped attempts and repository-level Git coordination
- `src/shared/workflow/` — cross-host lifecycle/publication reconciliation
- `docs/prd/runwield-core-prd.md` — managed remote acceptance and project runtime scope
- `docs/adr/018-remote-ssh-local-personal-authority.md`, `0020-home-project-state-and-launch-mode-ownership.md` and
  affected ADR-017/ADR-016 clauses — reconcile host placement, adoption and proof without competing current guidance
- `src/plan-store/README.md` and the transient Plan Store PRD references — document activated operations and remaining scope
- `docs/domain-language.md` — remote personal authority and Project Runtime State relationships

## Reuse Opportunities

- Reuse the prepared personal-store transport, existing remote host identity, connection-scoped mount verification and Session persistence.
- Reuse staged runtime relocation, native locks, durable operation receipts and proof-bearing publication; no new
  automatic external-effect retry policy.
- [OpenSSH forwarding documentation](https://man.openbsd.org/ssh_config#ExitOnForwardFailure) says forwarding setup
  success does not guarantee later destination connectivity; retain application health/admission checks.
- [SQLite filesystem guidance](https://www.sqlite.org/howtocorrupt.html) depends on correct native locking; keep owner
  indexing local rather than opening databases through SSHFS. Qualify pinned Bun 1.4.3, not only current online docs.

## Implementation Steps

1. **Production launch selects the intended owner.** The public remote command registers the laptop home-only owner
   from trusted remote identity, and supervisor/view bootstrap configures the store before consumer imports. All supported
   planning, browser review, execution, validation, lifecycle, collaboration and recording paths reach the public owner.
   Ordinary/manual-SSH entry needs no laptop service. Remote-only Projects require neither a laptop checkout nor source sync.
2. **One public module owns Plan storage.** `src/plan-store/index.ts` hides launch selection, connection context, native
   locks, revisions and durable operations. Extend the prepared protocol only with named domain operations required by
   the real journey, including authoring/catalog, review, execution reservation, checkpoints and settlement where absent.
   Callers do not import the client or private persistence, reconstruct owner paths, or duplicate lifecycle policy.
3. **Adoption preserves exact work and retires checkout runtime.** Under the existing migration/admission discipline,
   transfer personal controllers, locks' protected data, secrets and index/record recovery data to the laptop; relocate
   repository registries, staging, repair bytes and Git-effect journals into the remote account's home execution binding.
   Stage and verify destination bytes/permissions and retained identities before publishing ownership and retiring sources.
   Restart reconciles the same adoption, including failure after destination commit but before source retirement. Never
   copy a live lock as a new lock authority. Reconcile stale internal state automatically; an active writer retains its
   authority until settlement. No permanent `.wld/internal/`, fallback runtime or Plan-store symlink remains after adoption.
4. **Owner and repository coordination remain distinct.** Bind execution attempts and recovery to personal owner,
   Project, repository and checkout identities. Shared repository coordination serializes conflicting Git operations
   across owners without exposing their Plans or allowing attempt takeover. Imported unfinished attempts keep their
   recorded execution owner until proven settlement/cleanup or deliberate abandonment; migration cannot start a replacement.
5. **Publication freezes policy and proves delivery across hosts.** Read delivery-copy and record-generation settings
   from the execution repository before sealing the attempt's publication/recording input. Preserve independent Plan and
   Work Record choices and retained bytes across reconnect or settings changes. Git operations remain remote. Retain and
   reconcile their proof with the matching laptop attempt through a named owner operation before lifecycle completion,
   binding release or Work Record confidence approval. Wrong-owner, wrong-attempt, stale candidate, wrong target, missing
   or contradictory proof cannot settle. An execution-host crash after push must reconcile existing proof, not push again.
6. **Reconnect preserves authority and operation identity.** Persist outstanding operation identities in the existing
   continuation owner before sending mutations. Saved Session resume and a fresh authenticated connection reconcile the
   same owner/attempt and receipts, including owner restart and acknowledgement loss. Re-resolve current authorized
   document locators after mount replacement; native Plan locks, record index and secrets stay owner-side. Unavailability
   blocks new work without checkout or remote-personal fallback. Connected-only cancellation remains effective.
7. **Documentation matches the activated slice.** Update the central Core capabilities and acceptance scenarios,
   ADR-018/ADR-0020 and affected ADR-017/ADR-016 guidance, Plan-store README and glossary relationships together.
   Replace prepared-only launch claims where implemented; preserve separate Session ownership, existing platform limits,
   explicit imports, and later history/retention targets. Reconcile transient PRD references without deleting its unmet
   requirements or presenting the whole Epic as delivered.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Add the proposed files below to the isolated inventory.
The checkout has `scripts/run-tests.js`; use the supported entrypoint, never direct `bun test`:

```sh
bun run test src/shared/remote/managed-store-activation.test.ts src/shared/remote/managed-store-adoption.test.ts src/shared/remote/managed-store-publication.test.ts src/shared/remote/remote-runtime-workflows-end-to-end.test.ts src/shared/remote/remote-runtime-workflows-reconnect.test.ts src/shared/remote/remote-runtime-workflows-records-faults.test.ts src/shared/remote/entry-isolation.test.ts src/shared/remote/project-store.integration.test.ts
bun run plan-store:check
bun run seams:check
```

The three `managed-store-*` files are proposed. Use real stores, repositories, separate owner/execution processes and
disposable homes. Use `getHomeDir()` / `getCwd()` and `withProcessGlobalTestLock` for process-global mutation. Reuse
remote runtime/process fixtures and real public operations; no injection seams for owned persistence or lifecycle.
Keep bounded scenarios split into focused files; do not solve slow Golden fixtures with blanket deadline increases.

- **Public activation:** `managed-store-activation.test.ts` enters the production launcher/bootstrap composition with
  remote identity and no laptop checkout. Author a Plan through the normal tool path, list/read it, approve through the
  browser review route, reserve and execute it, run real fixture CI/review, publish a sentinel change and retrieve its
  Work Record. The fixture may replace actual SSH/network or model boundaries, but must not manually register/select
  the store in place of production startup. Assert owner package bytes/revisions, remote Git refs, owner record/index,
  and absent remote-personal copies/checkout runtime. A same-ID decoy in the remote account must remain unchanged.
- **Launch distinction:** against the same remote repository, start ordinary/manual-SSH composition with laptop
  services unavailable; author and deliver under the remote account's home. Then use managed composition and verify
  independent personal Plans and attempts. Cover non-Git folder/remote-home entry and subsequent Git adoption without
  manufacturing a laptop source tree. Passive discovery creates no registration or runtime; deliberate work does.
- **Consumer reachability:** extend existing runtime workflow/reconnect/record tests to assert laptop authority for
  authoring edits, review revisions, lifecycle/checkpoints, saved continuation, collaboration-secret use and record search.
  Preserve TUI/browser forwarding and Session save/writer behavior. Audit consumers against the explicit public export
  list; source-boundary checks supplement these behavioral assertions.
- **Adoption:** `managed-store-adoption.test.ts` arranges real pre-cutover checkout state, unfinished attempts, repair
  bytes, secrets and Git registrations. Interrupt before destination publication, after it but before retirement, and
  during resumed cleanup. Restart in a new process and verify exact bytes, permissions, stable attempt identity and
  valid worktree registrations. Source retirement follows verified destination; no duplicate active authority remains.
  Reject another owner's same-ID attempt. Exercise live-lock exclusion and concurrent ordinary/managed Git coordination.
  Missing/corrupt evidence preserves recoverable work and never permits a replacement attempt.
- **Proof and settings:** `managed-store-publication.test.ts` uses a real remote execution repository and bare target.
  Test opposite laptop/remote settings with independent Plan-copy and Work Record-copy choices; freeze the remote
  choices, change settings, reconnect and inspect the actual published tree against the original choice. Drop the proof
  acknowledgement and restart both sides after the real push. Reconcile one operation to one publication and one owner
  completion/record, with exact candidate/target/input provenance. Delay proof and assert lifecycle/record confidence
  remain pending; wrong owner/attempt/candidate/target or a bare success assertion must fail without mutation.
- **Native ownership and recovery:** hold the actual laptop Plan lock in another process while a remote mutation waits;
  verify the index subprocess/database are laptop-native. Drop a reply, rotate credentials, replace/remove mount paths
  and resume the same operation after an unrelated later edit. Observe one mutation and the retained original result;
  no fallback writes, duplicate event/record or lost edit. Service/connection loss cancels remote owned work and admits no
  new mutation; admitted work settles or remains recoverable under existing rules.
- **Failure sensitivity:** show the activation test fails when production registration/selection is disabled, the
  publication test fails when proof settlement is skipped or home-only default settings replace execution settings, and
  adoption tests fail when destination acknowledgement is treated as permission to retire unverified source state.
  Revert temporary counterfeits. A service-only fixture or successful no-op response cannot satisfy these assertions.

Manual: use an actually available supported Linux SSH host and the matching built runtime to complete both launch
journeys, including Plan review in the laptop browser, execution, real publication and owner-side record retrieval.
Disconnect managed execution, reconnect and resume its saved workflow; inspect host placement and unchanged manual-SSH
Plans. If no suitable host is available, record the unproved platform journey explicitly. Loopback process tests are
integration evidence, not Linux/SSH platform qualification.

Preserve host trust, connected-only execution, laptop Session authority, remote-only source access, native locks,
revision-safe review, explicit import, original unfinished-attempt ownership and proof-bearing publication. Retire
managed checkout runtime, remote-account fallback for managed Plans, mount-native lock/index authority and invocation
mode as permission to take another owner's attempt. Verify central PRDs, ADRs and glossary describe only delivered
behavior; unrelated remote clients and later Epic retention work remain outside this child.

## Edge Cases & Considerations

- Shared Project/repository IDs do not merge personal stores. Git coordination protects shared refs without sharing Plans.
- Legacy sources with conflicting ownership remain preserved while Core reconciles them; never guess ownership or
  overwrite a divergent destination. Report an unrecoverable factual ambiguity early with the evidence.
- Connection credentials and mount paths change; stable owner/Project/repository/attempt identities and durable receipts do not.
- No laptop Git access exists for a remote-only Project. Split named store commands from execution-host effects;
  do not serialize callbacks or fabricate local paths to make an existing helper appear compatible.
- History/pruning is a later child. Preserve all unresolved operation/adoption evidence under the existing retention rule.
