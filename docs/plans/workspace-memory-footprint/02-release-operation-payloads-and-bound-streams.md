---
planId: "d9669631-9da1-4698-b78a-c01fee3b946a"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "HIGH"
affectedPaths:
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/routes/owner-session-api.js"
    - "src/ui/workspace/islands/SessionSurface.jsx"
    - "src/ui/workspace/server/owner-connections.ts"
    - "src/ui/workspace/session-continuation.integration.test.ts"
    - "scripts/workspace-memory-check.ts"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
origin: "internal"
parentPlan: "workspace-memory-footprint"
order: 2
dependencies:
    - "01-reuse-workspace-renderer"
userVerifiedAt: null
createdAt: "2026-09-30T13:17:28.080Z"
targetBranch: "main"
status: "validated"
validatedCommit: "18de97e526ec751c7cd2ff08fbb3bc39a5cd3dfd"
---

# Release Finished Operation Payloads and Bound Observation Streams

## Context

**Finished operations retain transcript-sized payloads, and slow connections queue repeated copies of them.** This is
slice 2 of [Workspace Memory Footprint](../workspace-memory-footprint.md), after renderer reuse removes the main
navigation leak.

The real service/route fixture retained 2,000 events after 20 operations completed. A stream with 500 events containing
512,000 text bytes queued 133,696,601 encoded bytes. Canceling released those external buffers. The source event count
cap of 1,000 does not bound the downstream queue.

Owning requirements:

- [Browser Sessions](../../prd/runwield-workspace-prd.md#browser-sessions): extend the proposed **Keep repeated browser
  use memory-stable** requirement from slice 1 to operation completion and slow/disconnected observation. Preserve
  **Preserve conversation, drafts, and controls in the browser**.
- [TUI and phone continuity](../../prd/runwield-workspace-prd.md#tui-and-phone-continuity): reconnect to the same saved
  conversation and current work.
- [Browser Plan review and workflow](../../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow): preserve
  pending reviews, current content, and explicit decisions.
- [Core Session continuity](../../prd/runwield-core-prd.md#session-continuity) and
  [ADR-015](../../adr/015-file-authoritative-session-bundles.md): saved history stays in files; background work and
  pending interactions belong to their live owner, not the browser connection.

No product requirement is removed. Operation completion is not a new conclusion for a delivery workflow.

## Objective

Finished operations no longer retain large live payloads. A slow observer cannot accumulate a full encoded snapshot for
every event. Reconnection, duplicate submissions, notifications, and live interactions remain correct without stopping
work or losing saved conversation.

## Approach

### Separate payload lifetime from retry metadata

`WorkspaceSessionContinuationService` remains the owner. At actual operation settlement, replace the live record with an
explicitly constructed compact result. Retain operation/Project/Session identity, status, generation, error result, and
the small notification data needed for current browser semantics. Do not spread the old record into the result.

Remove live transcript/tool/image payloads, `runtimeSessionId`, resolved interaction callbacks, queued-message bodies,
configuration payloads, and large `sessionInfo` references from settled records. Current state is read from the live
runtime while running; saved conversation is loaded through the existing timeline after settlement.

Preserve the existing receipt lookup and create-request deduplication contract. **Do not add eviction or expiry to
`createRequests` in this slice.** Compact identity/result metadata may continue to grow by request count; this scope
removes payload-size growth, not every byte associated with lifetime requests. Do not describe that residual metadata as
an absolute memory bound. A new receipt migration or retry-expiry policy is outside this Sequence.

All settlement paths use one compaction rule: local create, continuation, reopened review/workflow, background-result
operation, failure, and observed remote completion. Events racing after settlement cannot repopulate transcript
payloads. Preserve the last applicable Agent-stop notification as a compact event with stable identity, so a fast
completed operation still alerts once. Do not replay old notifications on reload.

### Make stream production follow reader demand

Keep the current Server-Sent Events (SSE) snapshot protocol. Each snapshot replaces the browser's transient view, so
intermediate obsolete snapshots need not queue.

```text
operation update -> mark observer dirty
reader has demand -> read current snapshot -> sanitize -> encode -> enqueue once
more updates while blocked -> remain dirty; do not encode or store each update
operation settles -> latest compact result -> final snapshot -> close stream
abort / cancel / device revocation -> unsubscribe observer; leave operation running
```

Use `ReadableStream.pull` and demand checks. Retain at most **one enqueued encoded snapshot and one dirty/latest-version
marker per observer**, not one encoded snapshot per producer event. Serialization must not occur for discarded
intermediate updates. Keep synchronous internal `subscribeOperation` users, including `waitForPlanReview`, working.

This is a bound relative to the size of the current snapshot, **not an absolute byte cap on an active turn**. Preserve
the existing 1,000-event live buffer and coalesced text semantics; do not silently truncate active output or add a new
delta/cursor protocol. Absolute live-payload limits and whole-history projection are deferred.

At settlement, disconnect operation subscriptions immediately after capturing the compact final result. A pending
final-result variable may retain only that compact result, never a full terminal snapshot. A slow reader may still hold
its single previously queued encoded snapshot until drain/cancel, but must not keep an active producer subscription,
unencoded terminal transcript, or large completed record. A fast reader receives the final result before EOF. Cancel,
request abort, device revocation, and server shutdown close the observer idempotently.

### Keep the browser observation lifecycle separate

In `SessionSurface`, a terminal snapshot remains a normal completion: close observation, clear transient items, and
refresh saved history. An SSE close must not turn a received completion into an interruption or start an endless
reconnect/poll loop.

Fallback operation polling has at most one request in flight per observed operation and aborts that request on operation
change or unmount. Retain existing stale-response guards. Do not abort the server-owned operation, pending review, or
background task when the browser leaves.

No process split, durable event queue, datastore migration, or new application-owned injection seam is needed. This
preserves ADR-015; no new domain term or changed architectural authority needs a glossary or ADR update.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/server/session-continuation.js` — one settled-payload compaction rule, late-event handling, remote
  subscription release, and shutdown cleanup.
- `src/ui/workspace/routes/owner-session-api.js` — demand-driven operation SSE, final result, abort/cancel, and device
  connection cleanup.
- `src/ui/workspace/server/owner-connections.ts` — reuse existing device revocation registration; change only if this
  stream integration requires it.
- `src/ui/workspace/islands/SessionSurface.jsx` — terminal-stream behavior and non-overlapping, abortable operation
  polling.
- `src/ui/workspace/workspace-operation-memory.test.ts` (new), continuation integration tests, background lifecycle
  tests, and Session UX tests — real resource lifetime and preserved behavior.
- `scripts/workspace-memory-check.ts` from slice 1 — add operation and combined-workload scenarios.
- `docs/prd/runwield-workspace-prd.md` — long-use and reconnect scenarios, linking unchanged Core ownership guarantees.

Keep transcript projection, browser history virtualization, shared Core live-buffer eviction, token-review conversation
cleanup, guide-job retention, and unrelated dashboard/catalog edits out of this slice.

## Reuse Opportunities

- `getOperation`, existing operation receipts, and `createRequests` preserve status lookup and duplicate-request
  behavior without a new persistence design.
- `releaseRetainedIfDrained` and `preserveTaskOwnerOrClose` protect running operations, background tasks, pending
  results, and concurrent continuation. Do not replace them with observer-count eviction.
- `createOwnerConnectionRegistry` provides device-close handling. Reuse its contract for operation streams.
- Existing notification identity filtering in `observeOperationBrowserNotifications` supports stable compact final
  Agent-stop events.
- `makeManagedSessionFixture`, existing backend/transport fixtures, and `defineGitFixture` provide real owners and saved
  evidence without provider calls.
- `/tmp/runwield-workspace-memory-proof-0NNeqi/` contains the original isolated experiment. Port useful cases into
  repository tests; do not require this temporary directory during validation.

## Implementation Steps

1. Settled operation records retain only an explicit compact result. Every listed settlement path releases
   transcript/tool/image/session-info payloads and resolved callbacks. Late events cannot restore them. `getOperation`
   still returns correct success/failure, Session identity, generation, and notification data through both in-memory and
   receipt-backed cases.
2. Duplicate create and continuation requests still return the original accepted operation and Session after compaction.
   Reusing a request ID with different input remains rejected. Existing create-request reservations and metadata remain
   intact. No new request expiry, duplicate model turn, or second Session is introduced.
3. Remote notification subscriptions close and leave `remoteNotificationStreams` when their observed operation settles.
   A subscription promise that resolves after settlement closes immediately. Service shutdown clears owned
   maps/listeners after accepted work has settled, without prematurely canceling retained background work or allowing
   late callbacks to repopulate cleared payloads.
4. `ownerSessionOperationStreamApi` serializes only when the reader can accept data. At most one encoded snapshot plus a
   dirty/version marker is retained for each observer. Completion leaves no producer listener and supplies a compact
   final result before EOF when read. Request abort, body cancel, revocation, enqueue failure, and repeated close all
   release registrations without affecting the Agent operation.
5. A coalesced snapshot retains current busy state, pending question/review, queued steering, and applicable Agent-stop
   notification. `SessionSurface` treats completion as completion, restores committed history once, and prevents stale
   responses from changing another Session. Poll fallback never overlaps requests and aborts pending reads on teardown.
6. Existing completed-event assertions in `background-create.integration.test.ts` and
   `plan-workflow-gates.integration.test.js` are adapted, not deleted: collect task identities during live observation
   or from saved history, and assert completed Agent output and Agent changes through committed timeline reads. Preserve
   same-Session task delivery, no replay revival, eventual runtime disposal, workflow gating, and follow-up success.
   Full completed `operation.events` retention is intentionally retired. The new resource tests and memory-script
   scenarios distinguish payload disposal and bounded transport from fake success. They use real service/routes and
   saved fixtures; external model/transport fixtures are permitted, but no fake `setOperation`, Plan writer, or
   lifecycle owner replaces production logic.
7. Workspace requirements and acceptance scenarios describe the delivered memory and reconnect behavior. Document
   compact retry metadata and active-snapshot size as remaining limits. Preserve links to Core continuity and do not
   claim the deferred review/history work shipped.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

```sh
deno run -A scripts/run-tests.js src/ui/workspace/workspace-operation-memory.test.ts src/ui/workspace/session-continuation.integration.test.ts src/ui/workspace/background-create.integration.test.ts src/ui/workspace/background-continuation.integration.test.ts src/ui/workspace/background-stop.integration.test.ts src/ui/workspace/shutdown-continuation.integration.test.ts src/ui/workspace/plan-workflow-gates.integration.test.js src/ui/workspace/workspace-session-ux.test.tsx
deno task workspace:check
deno task workspace:build
deno run -A scripts/build-workspace-runtime.ts
deno run -A scripts/workspace-memory-check.ts --scenario operations
deno run -A scripts/workspace-memory-check.ts --scenario combined
deno task seams:check
```

Use isolated HOME/database fixtures. Tests that change environment or cwd use `withProcessGlobalTestLock`; never run
`deno test` directly. The new script must run with a fixed workload and timeout, record all results, and fail incomplete
or memory-guarded runs.

**Payload and lifecycle regressions:**

- Complete 20 and then 100 operations with unique text/tool/image fixtures through actual local and remote settlement
  paths. Assert settled records, listeners, remote subscription closures, and pending terminal-response state retain no
  transcript payload. In unread-response cases, permit only the one already-enqueued encoded snapshot; after
  drain/cancel no payload remains. Use tagged payloads and retained-object inspection/heap snapshots to detect arrays
  moved into hidden response closures; external-buffer counts alone cannot detect unencoded retained strings. Keep only
  allowed compact notification events. Changing payload size tenfold must not increase post-settlement retained payload
  bytes. A count-only cap or moving arrays to another map must fail.
- Verify original status, generation, same Session identity, same-input retries, different-input rejection,
  failure-before-Session-creation, and saved history after compaction. Include create, continuation, background-result,
  and reopened review/workflow paths. Do not infer local settlement from the remote-only scratch proof.
- Run a pending question/review and a background task while all browser observers disconnect. The live work remains
  usable, answers still resolve once, the background result reaches the same Session, and existing idle disposal
  eventually occurs. No observation cleanup changes delivery workflow state.
- Complete a fast operation before the browser observes it. The correct current Agent-stop alert appears once; duplicate
  snapshots and restored history stay quiet. Pending reviews and current busy state survive slow-reader coalescing.

**Transport regressions:**

- Through the real API Response, append 500 distinct 1 KiB events with the body unread. Assert one initial queued
  snapshot at most; after demand resumes, only the latest needed snapshot and terminal result follow, not 502 historical
  snapshots. For this fixture, incremental external-buffer retention must remain below **4 MiB**, compared with the
  measured 127.5 MiB. Record garbage-collection method and subtract a warmed no-subscriber control.
- Repeat with three readers: one fast, one throttled, and one unread. Each has an independent bound. The fast reader
  receives current content and completion; the stalled reader does not block the producer or other readers.
- Request abort without body cancel, explicit body cancel, device revocation, and stream completion each reduce observer
  registrations to zero. Cover close/notify races, already-aborted requests, and a remote subscription that resolves
  late. Subscribe to an already completed operation: the synchronous initial callback must not lose the unsubscribe
  function returned afterward; receive its compact result, then EOF, with zero registrations.
- Repeat over a real loopback HTTP server with a throttled/disconnected client, not only an in-memory Response. Verify
  producer progress, final status and zero listener registrations after disconnect. Distinguish application queue memory
  from socket buffers.

**Browser and combined regression:**

- Use the slice-1 fixture server and a uniquely named `agent-browser` session. Exercise a streamed operation, force
  fallback polling with a delayed response, change Sessions while it is pending, and reconnect after completion. Confirm
  one in-flight poll, aborted obsolete reads, no false interruption, complete saved history, and intact drafts/images.
  Record the actual localhost URL, console errors, and failed requests.
- After warming the source and compiled owner Workspace route sets (the exact fixture launcher from slice 1, not the
  remote Shared Space server), run two batches of ten fixture cycles: start/continue, observe, switch Sessions, open
  Plan and Code Review, settle, and reconnect. The second batch may retain compact identity metadata but no payloads or
  extra listeners. For the fixed fixture, require no more than **10 MiB additional retained heap** and **4 MiB
  additional external buffers** between batches. Record RSS separately, with the 1 GiB safety guard from slice 1. Guard
  exits fail; do not require RSS to fall immediately after collection.
- The combined scenario covers real saved transcript fixtures and real review page handlers. It must not claim to
  exercise provider/model behavior if its Agent events came from external test fixtures. Inspect current content and
  final status so disabling the stream, dropping updates, or returning empty history cannot pass.

Protected behavior: saved conversation and full workflow reports, image/draft failure recovery, Agent/model choices,
duplicate-submit protection, current reviews/questions, steering, notifications, and background results after browser
closure. Obsolete queued snapshots and finished live payload retention are the only intended removals. Existing tests
for retained task owners and interruption recovery must remain behavioral tests, not be deleted to accommodate cleanup.

## Edge Cases & Considerations

- Compact retry metadata still grows with operation/request count. This deliberate limit avoids changing retry semantics
  or introducing a storage migration in a leak fix.
- One active snapshot can be large. This slice prevents repeated queued copies; it does not promise a universal
  process-memory ceiling or truncate uncommitted conversation.
- A finished operation can share a runtime with a running Background Task. Release its payload, not the task owner.
- EOF and the browser's EventSource error callback can race with processing a terminal snapshot. Completion must win;
  teardown is idempotent.
- Byte measurements can vary by runtime. Deterministic payload/listener and response-content checks remain mandatory
  alongside heap samples; a measurement limit change requires evidence, not silent rebaselining.
- Keep the renderer regression from slice 1 green. Otherwise combined measurements cannot isolate operation growth.
