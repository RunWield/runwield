---
planId: "a98f6b70-ecc2-43e5-bd0c-4ef4575fc7cf"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/remote/"
    - "src/shared/remote/control.ts"
    - "src/shared/remote/personal-resources.ts"
    - "src/plan-store/"
    - "src/shared/work-records/"
    - "src/shared/private-json-file.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/0020-home-project-state-and-launch-mode-ownership.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 11
dependencies:
    - "external-plan-store/add-canonical-plan-packages"
    - "external-plan-store/move-work-records-with-delivery-copies"
    - "external-plan-store/activate-the-local-home-store"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "reviewed"
---

# Serve Laptop Owned Project State

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Managed remote execution cannot safely obtain laptop-native lock or SQLite authority by pointing remote code at an SSHFS path. The personal store must execute authoritative mutations on its owner.

Owning requirements: [Launch ownership](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode); [Remote connection](../../prd/runwield-core-prd.md#remote-connection). These are target changes; preserve the existing behavior named below.

Plan 10 delivered the single owning [Plan-store interface](../../../src/plan-store/README.md) at
`src/plan-store/index.ts`. It already hides storage selection, identity, revisions, locks and durable writes.
`src/plan-store.js` and other implementation files are private. This child extends that owner for transport;
it must not recreate package persistence or lifecycle policy in a remote service.

`startRemoteControlService` already provides a loopback listener, per-connection credential, matching build/protocol
handshake, readiness and shutdown admission. Its settings receipts are connection-local memory, so they cannot provide
the durable recovery required here. Session control and save already have separate owners and remain unchanged.

The requirements added here are authenticated owner-side Plan/record access, stale-write refusal and reconcilable
interrupted operations. Preserve [Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle),
[Work Records](../../prd/runwield-core-prd.md#work-records), passive reads and ordinary local operation.
The owning [ADR](../../adr/0020-home-project-state-and-launch-mode-ownership.md) already selects this host partition.
This child prepares it; the next child activates it for `wld remote`, including remote-only Projects.

## Objective

A connection-scoped service and client can perform canonical Plan/record operations against the laptop store with expected revisions, durable operation identity and recoverable lost acknowledgements. This is a preparatory transport contract; managed remote startup is activated in the next child.

## Approach

Extend the existing authenticated remote personal-service boundary with coarse domain operations. Keep native locks,
atomic metadata/snapshot publication and record indexing on the laptop. Expose stable resource IDs, not lock handles
or permanent mount locators.

```text
connection-bound client
  -> authenticated control route + trusted Project/owner binding
  -> src/plan-store/index.ts named commands and queries
  -> owner-native locks, canonical documents, snapshots and operation evidence
  -> existing Work Record owner and index operations where applicable
```

The connection binds authority on the laptop before accepting requests. Request paths, matching Plan IDs and serialized
Plan access handles do not grant authority. Recheck the binding after asynchronous body reads and before admitting an
operation. A fresh connection can reconcile the same durable operation under the same owner with fresh credentials.
No production launcher selects this prepared service/client until Plan 12.

The transport translates a typed, bounded request to a named public operation. Start from `readPlanResource`,
`savePlanDocument`, `savePlanProse`, `savePlanDefinition`, `recordPlanEvent`, frozen-document/publication operations,
and existing Work Record persistence/search operations. Add a named public operation only when the required owner
behavior is missing. Transport never imports a private package writer, accepts arbitrary metadata patches, or duplicates
event rules from `shared/workflow/plan-lifecycle.js`. Remote Core can propose an event; the owner applies the existing
policy when committing it. Git effects and proof collection stay on the execution host.

Durable operation evidence belongs inside the owning store, alongside its existing mutation/recovery evidence.
Bind an operation ID to owner, Project, repository/attempt where relevant, command, expected revision and a deterministic
request digest. An identical retry returns the retained result even after the Plan advances; a changed payload under
the same ID is refused. Persist recoverable intent before effects and commit the outcome before acknowledging it.
An owner restart between effect and receipt must reconcile from retained evidence, not execute the effect again.

```text
reconcile(operation)
  retained completion -> return original outcome
  recoverable intent  -> finish/prove the same owner operation
  proven unstarted    -> allow the identical request under its original preconditions
  missing/contradictory/unavailable evidence -> report unresolved; do not infer permission to replay
```

Keep request/result sizes and in-memory caches bounded. Retain only the evidence needed to identify and recover an
operation, referring to immutable owner artifacts instead of duplicating whole snapshots. Never silently evict pending
evidence or let receipt compaction turn an old ID into a new mutation. Document the implemented retention boundary;
general Plan/history pruning remains its existing later child. Reads and failed authentication create no receipts.

Use the mount only for supported ordinary document access; do not transport a generic filesystem/database API or invent a second Session-save protocol.
Existing content-hash checks and current verified locators govern document access. Service reads remain usable without
an SSHFS mount. Copying a store to the client would create a second authority; executing through the existing owner avoids it.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/project-store-protocol.ts`, `project-store-service.ts`, `project-store-client.ts` (proposed) —
  typed wire contract, connection-bound handler and client; no parallel storage interface
- `src/shared/remote/control.ts` — trusted binding, authenticated route and connection lifetime admission
- `src/shared/remote/personal-resources.ts` — verified document locator reuse only where needed
- `src/plan-store/index.ts` and its private implementation — named owner operations, durable operation identity,
  reconciliation and native locking without exposing persistence choices to consumers
- `src/shared/work-records/` — reuse canonical record/index ownership, confidence rules and Plan backlinks
- `src/shared/private-json-file.ts` — reuse private durable replacement; change only if a demonstrated gap requires it
- `scripts/check-plan-store-boundary.ts`, qualification and test inventory — retain enforcement for the new consumers
- `docs/prd/runwield-core-prd.md`, `docs/adr/0020-home-project-state-and-launch-mode-ownership.md`,
  `docs/domain-language.md` and the store README — describe the prepared contract and preserve activation as target

Launcher, supervisor, runtime layout selection, saved Session continuation and live managed-remote cutover belong to
Plan 12. This child must not enable a new global backend switch or require a laptop source checkout for that future journey.

## Reuse Opportunities

- Reuse authenticated connection lifetime and existing personal-service transport patterns.
- Reuse package revision checks, native locks and record persistence; existing Session save/control remains its own proven owner.
- Reuse `src/plan-store/index.ts` admission and named commands; preserve `plan-store:check` and `seams:check`.
- Reuse `serveHttp` and the existing private atomic writer. [Bun server documentation](https://bun.sh/docs/runtime/http/server)
  distinguishes graceful shutdown from force-closing connections; application admission must still reject late work.
  [Node filesystem documentation](https://nodejs.org/api/fs.html#filehandlesync) documents explicit synchronization:
  an atomic rename alone is not a transaction spanning both effect and receipt. Qualify behavior on pinned Bun 1.4.3;
  current online documentation is not proof of the pinned runtime's behavior.

## Implementation Steps

1. **The wire contract admits only named domain operations.** The proposed protocol/service/client modules carry stable
   Project, owner, Plan/resource and operation identities plus existing revision preconditions. Validate bounded bodies,
   exact operation fields and typed replies. Reject unsupported operations, malformed identities, traversal and arbitrary
   filesystem, SQL, lock or metadata requests. Enumerate the supported operations and their public-owner mapping in the
   store README, including reads, Plan definition/prose/documents, lifecycle events, frozen snapshot publication,
   collaboration-secret-backed operations, and Work Record save/read/search/index reconciliation. Existing secret use
   stays owner-side; this is not a credential export endpoint.
2. **The service admits an explicitly bound owner.** `control.ts` accepts trusted registration of the prepared
   Project/owner service, reuses credential/build/protocol/readiness checks and refuses work after shutdown or loss of
   authority. The HTTP client cannot register a Project path, impersonate another personal owner, or select authority
   from a mount. Without registration the new routes cannot mutate a store. Production remote startup remains unchanged.
3. **Every effect reaches its current owner.** Service Plan operations import only `src/plan-store/index.ts`;
   expected document/controller revisions and lifecycle rules remain enforced there. Native Plan locks, snapshot
   persistence, collaboration secret use, Work Record Markdown, index subprocess/database access and backlink writes run
   on the laptop. Keep Work Record confidence, retained source and delivery-proof checks. Store publication commits
   snapshots/evidence; it neither executes Git publication nor accepts a client assertion as proof of publication.
4. **A durable operation has one effect.** The store binds each mutation ID to its immutable request and retains intent,
   outcome and reconciliation evidence durably. Simultaneous identical requests and later retries return the same
   outcome; a reused ID with different payload or preconditions conflicts without changes. Reconcile the effect/receipt
   crash window under native owner locks. Revision advance from a successful first request does not turn its retry into
   a new stale mutation. Bound transient memory and payloads; preserve unresolved evidence and safe old-ID handling.
5. **The client can recover uncertainty.** After timeout, interrupted reply, client death or owner restart, a caller can
   retain/resupply the original operation identity and query/reconcile its outcome through a freshly authenticated
   connection. Distinguish completed, proven unstarted, recovery pending and unavailable evidence; report contradictions
   without guessing. The client does not generate a replacement ID or replay external Git effects to recover a reply.
   Closing a connection prevents new admission and releases operation locks after settlement, without retaining an
   idle Session-wide lock or falsely claiming cancellation rolled back a committed effect.
6. **Document access and local behavior remain correct.** Return authorized resource identities, revisions/hashes and
   content, never persist a temporary mount locator as identity. Refuse a stale or swapped document locator; reconnect
   resolves fresh access. Passive reads create no authority or recovery receipts. Ordinary local commands continue through
   the same public owner without a running service, and the remote client's account never becomes a fallback owner.
7. **Documentation describes exactly this slice.** Add prepared owner-service scenarios to Core Remote connection and
   link existing Plan/Work Record rules; keep normal remote startup on its current behavior until Plan 12. Align ADR-0020,
   store README and any changed glossary definitions, explicitly separating prepared service capability from activated
   launch ownership. Preserve the existing Session save/writer protocol and remote trust model.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. The prepared checkout has `scripts/run-tests.js`;
use the authorized `bun run test` entrypoint rather than inventing a TypeScript runner or invoking `bun test`.
Add the proposed tests below to the isolated test inventory and run:

```sh
bun run test src/shared/remote/project-store-protocol.test.ts src/shared/remote/project-store.integration.test.ts src/plan-store/remote-operations.test.ts src/shared/remote/control.test.ts src/shared/remote/personal-resources.test.ts src/shared/remote/session-control.test.ts src/plan-store/operations.test.ts src/shared/work-records/package-store.test.ts src/shared/work-records/package-index.test.ts
bun run plan-store:check
bun run seams:check
```

The first three files are proposed, not existing passing evidence. Use real canonical stores, disposable homes and
`defineGitFixture` / `makeValidationProjectRoot`. Use `getHomeDir()` / `getCwd()` and
`withProcessGlobalTestLock` for HOME/cwd mutation. Real process/transport interruption and narrowly qualified
owner-internal interrupted-state fixtures may arrange failure evidence; behavior under assertion uses the public
interface. Add no owned persistence, lifecycle, registry or lock injection seams.

- **Protocol and admission:** `project-store-protocol.test.ts` and `control.test.ts` reject wrong credentials,
  mismatched builds/protocols, unregistered/wrong Project or owner, forged handles, unknown operations, protected-field
  patches, traversal and oversized/chunked bodies. Delay the final body chunk until shutdown and prove no mutation,
  receipt or index write. Validate response identity and payload bounds on the client as well.
- **Owner execution:** `project-store.integration.test.ts` launches separate owner and client processes with separate
  homes and real loopback control transport, with no personal mount. Author a Plan through the public store, then read,
  save prose/definition/document, apply an allowed event, refuse a forbidden transition and retain/read a frozen snapshot
  through the client. Assert actual owner bytes, revisions and protected metadata. Add a same-ID decoy Plan in the
  client home and prove it remains unchanged. Exercise an existing secret-backed operation with its genuine network
  boundary isolated; assert owner-only secret access and no secret in response or receipt.
- **Concurrency:** race a local public-store writer against two service requests with the same observed revision.
  Exactly one competing mutation wins; the loser receives the real stale-revision outcome. Concurrent duplicates of
  one operation ID yield one revision advance and the same returned outcome. An owner process holding the real native
  lock must block another process's mutation until release; an in-memory mutex cannot pass.
- **Durable recovery:** `remote-operations.test.ts` and the process integration fixture cover interruption before
  intent, after intent, after effect but before completion receipt, and after receipt before reply. A transport proxy
  drops replies; kill/restart owner or client and reconnect with fresh credentials. Reconcile/retry the same ID and
  assert one document change, one event and one snapshot/record effect. Retry after an unrelated later edit and return
  the original outcome without overwriting that edit. Changed payload/preconditions under the same ID fail. Missing or
  corrupt evidence stays unresolved; restoring valid evidence permits recovery. Disconnect is never treated as proof
  that an effect did not happen.
- **Records and host placement:** through the client, persist/read/search a canonical Work Record and repair an
  interrupted index update. Assert Markdown, index database and actual index subprocess arguments resolve inside the
  owner home, with no corresponding client-home files. Preserve confidence filtering, publication evidence and Plan
  backlinks. Concurrent/retried record persistence produces one canonical record and reconciled index entry.
- **Boundedness and shutdown:** send over-limit requests/results and enough sequential operations to exceed the
  in-memory cache bound. Assert predictable refusal or bounded paging, no partial writes, and bounded live cache state.
  Evicting cache entries, reconnecting or restarting must not forget durable operation identity. Test retention/
  compaction boundaries actually introduced, including unresolved evidence and an old-ID retry. During an admitted
  mutation request shutdown, allow safe settlement/recovery, then show a new local writer can acquire the native lock.
- **Access and unchanged activation:** authorized service reads work without a mount; changed content hashes and
  replaced locators refuse stale edits. Passive reads do not initialize identity or create receipts. Existing local
  public-store tests pass without a service; existing remote startup stays on its prior owner selection and all Session
  control/save regressions remain. A new service is instantiated only by explicit trusted registration in the fixture.
- **Failure sensitivity:** demonstrate that bypassing the revision comparison, replacing durable receipts with a
  connection Map, accepting client-selected paths, or writing into the client home fails the respective focused test.
  Revert these temporary mutations. A handler returning success without changing owner state cannot pass the tests.

Manual: supply a bounded fixture command beside the integration test using the real service/client. Record that command
and demonstrate save -> drop acknowledgement -> restart/reconnect -> reconcile same ID, then inspect owner revision,
receipt and record index. Do not require a live SSH startup cutover or change production launcher selection for this check.

Preserve authenticated remote trust, Session writer/save semantics, private owner identity, ordinary local operations,
passive reads, lifecycle rules, document hashes, Work Record confidence/provenance, and package recovery protection.
Retire mount availability as writer authority only for the newly prepared service operations.
Verify the owning PRD scenarios, affected references and glossary match the delivered contract; managed-remote activation,
full remote-only user journeys and general history retention/pruning remain assigned to their existing children.

## Edge Cases & Considerations

- Prototype verification is part of this child: an existing Session-save test is not evidence that these new store operations are safe.
- Long operations must reconcile on reconnect without retaining an idle session-wide mutation lock.
- A receipt written only after an effect leaves an ambiguous crash window. Recoverable intent plus existing owner
  evidence must close that gap; an operation-ID cache alone is insufficient.
- A fresh connection rotates credentials but must retain access to the same owner's durable outcomes. Another owner
  with an equal Project or Plan ID is not that owner.
- Service commands cannot depend on callbacks, laptop Git access to remote files or a fabricated local checkout.
  Keep execution-host effects outside the contract; report any required operation that cannot be expressed with the
  existing owner before expanding scope.
- Proposed filenames and response encodings are implementation choices, not product commitments. The owner partition,
  no-replay rule, existing local behavior and Plan 12 boundary come from the request and Epic.
