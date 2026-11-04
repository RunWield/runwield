---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/remote/"
    - "src/shared/remote/control.ts"
    - "src/shared/remote/personal-resources.ts"
    - "src/plan-store.js"
    - "src/shared/work-records/"
    - "src/shared/private-json-file.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 11
dependencies:
    - "external-plan-store/add-canonical-plan-packages"
    - "external-plan-store/move-work-records-with-delivery-copies"
targetBranch: "epic/external-plan-store"
status: "draft"
planId: "a98f6b70-ecc2-43e5-bd0c-4ef4575fc7cf"
---

# Serve Laptop Owned Project State

## Context

This draft implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Managed remote execution cannot safely obtain laptop-native lock or SQLite authority by pointing remote code at an SSHFS path. The personal store must execute authoritative mutations on its owner.

Owning requirements: [Launch ownership](../../prd/plan-store-prd.md#storage-ownership-by-launch-mode); [Remote connection](../../prd/runwield-core-prd.md#remote-connection). These are target changes; preserve the existing behavior named below.

## Objective

A connection-scoped service and client can perform canonical Plan/record operations against the laptop store with expected revisions, durable operation identity and recoverable lost acknowledgements. This is a preparatory transport contract; managed remote startup is activated in the next child.

## Approach

Extend the existing authenticated remote personal-service boundary with coarse domain operations. Keep native locks,
atomic metadata/snapshot publication and record indexing on the laptop. Expose stable resource IDs, not lock handles
or permanent mount locators. Store operation receipts before acknowledgement so a retry identifies the previous effect.

Use the mount only for supported ordinary document access; do not transport a generic filesystem/database API or invent a second Session-save protocol.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/` — personal-store service/client contract and connection authentication
- `src/shared/remote/control.ts` — connection-scoped operation admission
- `src/shared/remote/personal-resources.ts` — distinguish mount access from mutation authority
- `src/plan-store.js` — coarse owner-executed Plan operations
- `src/shared/work-records/` — owner-executed record and index operations
- `src/shared/private-json-file.ts` — durable receipt and metadata replacement
- `docs/prd/runwield-core-prd.md` — remote store service behavior kept target until activation

## Reuse Opportunities

- Reuse authenticated connection lifetime and existing personal-service transport patterns.
- Reuse package revision checks, native locks and record persistence; existing Session save/control remains its own proven owner.

## Implementation Steps

1. Authenticated requests bind Project, personal owner and stable operation ID; a request cannot select another owner by supplying a path or matching Plan ID.
2. Plan metadata/document operations, snapshot publication, collaboration-secret use and Work Record persistence/indexing execute on the laptop with its native locks.
3. Expected revisions reject stale requests, while retrying an accepted operation ID returns its retained outcome rather than reapplying the mutation.
4. A lost acknowledgement, client death or reconnect can distinguish committed, uncommitted and unavailable evidence without automatically replaying Git effects.
5. Document access uses verified current mount/service paths and content hashes; persisted references never depend on a temporary mount location.
6. Local ordinary operations continue through the same Core ownership contract without needing a network service; no always-on daemon or hosted Workspace dependency is introduced.
7. Core Remote connection requirements document the prepared contract and remaining activation scope; existing Session writer/save rules are unchanged.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/shared/remote/control.test.ts src/shared/remote/personal-resources.test.ts src/shared/remote/session-control.test.ts
```

New coverage below is proposed, not an existing passing test inventory. Planner must select concrete test files and
commands that fail before this slice and pass afterwards; the regression command alone does not prove the new outcome.
Use real stores/repositories and disposable homes, with `withProcessGlobalTestLock` for process-global changes. Do not
add injection seams for Core-owned persistence or lifecycle rules.

- Use two real processes and a loopback authenticated transport with disposable stores; concurrently mutate one Plan and prove native-owner serialization and stale revision rejection.
- Drop replies before/after durable receipt publication, reconnect and retry the same operation: each accepted mutation appears once.
- Verify index subprocess/database paths and lock acquisition occur on the owner side, not a simulated mounted path; denied owner/Project requests cause no writes.
- Manual: Exercise a service fixture with an interrupted acknowledgement and inspect the laptop store and receipt before retrying the same request.
- Preserve: Existing authenticated remote trust, Session save semantics, private data ownership and ordinary local operation.
- Retire: Using mount availability as evidence of native writer authority for the new store contract.
- Check that the owning PRD capabilities, affected references, and any assigned glossary definitions match only the
  behavior delivered by this child; remaining Epic outcomes stay target.

## Edge Cases & Considerations

- Prototype verification is part of this child: an existing Session-save test is not evidence that these new store operations are safe.
- Long operations must reconcile on reconnect without retaining an idle session-wide mutation lock.
