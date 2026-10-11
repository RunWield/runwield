---
planId: "30b4b5d9-8c70-4e11-a314-6132bf9ee2a0"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/root-session.js"
    - "src/shared/session/file-session-store.ts"
    - "src/shared/session/file-session-store-owner.ts"
    - "src/shared/session/file-session-store-types.ts"
    - "src/shared/session/file-session-activation-state.ts"
    - "src/shared/session/file-session-control.ts"
    - "src/shared/session/managed-operation.ts"
    - "src/shared/session/segment-rollover.ts"
    - "src/shared/session/session-transcript-projection.js"
    - "src/shared/session/image-attachments.js"
    - "src/shared/session/runtime/managed-operations.ts"
    - "src/shared/session/runtime/lifecycle.ts"
    - "src/shared/session/runtime/managed-sync.ts"
    - "src/shared/session/runtime/images.ts"
    - "src/shared/remote/control.ts"
    - "src/shared/remote/supervisor.ts"
    - "src/shared/remote/personal-resources.ts"
    - "docs/adr/015-file-authoritative-session-bundles.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T02:05:49.075Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 3
dependencies:
    - "01-establish-the-remote-connection-and-matched-runtime"
    - "02-bridge-local-models-and-personal-resources"
targetBranch: "epic/remote-ssh-development"
---

# Guard Remote Session Writer Access

## Context

**Owner decision (2026-10-06):** the validated
[Session-save proof](../remote-session-save-proof.md#execution-results-2026-10-05) selected the **synchronous
laptop-owned save bridge with strict per-entry saves**. The original guarded stock SFTP approach is set aside. The owner
accepted the measured latency after clarification: the remote main loop blocks only while a save is in flight (10–45 ms
per entry on the healthy proof connection; 77 ms worst keystroke round trip), not on every keystroke; a stalled save
faults at a finite deadline (about 5 s in the proof) and independent Stop responded in 642 ms.

The connection-wide mount of laptop `~/.wld` supplies personal file access, not Session writer authority. Mounted locks
do not provide cross-machine exclusion, so the laptop's native Session Writer Lock must remain authoritative and the
laptop must stay the sole writer of Session history. Remote Pi therefore keeps no transcript file: it runs an in-memory
Session manager and saves each entry through an authenticated request to the laptop owner.

This slice builds the storage safety boundary before normal remote user turns depend on it (child04). It implements the
writer-ownership and recovery parts of the Remote SSH PRD's **Local memories and saved Sessions** and **Disconnect and
recovery** capabilities while preserving ADR-015 for ordinary local Sessions.

### Epic Scope Changes

- `04-run-and-resume-remote-sessions-with-local-history.md` (draft, not started) — its Approach and Implementation Steps
  assumed guarded mounted transcript access from this child; updated to reference the synchronous save bridge this child
  delivers.

## Objective

Deliver the production synchronous save bridge. Remote Pi runs an in-memory Session manager whose synchronous
persistence hooks send authenticated, ordered save requests to the laptop owner; the laptop validates authority and
request identity, writes each entry under its existing native lock, and acknowledges only after the intended bytes are
written and synchronized. Durability is strict per entry: no dependent model, tool, workflow, or publication action
proceeds before its entry is durably saved. Save faults stay sticky for the operation; recovery discards unsaved remote
state and reloads laptop evidence without replaying external effects. No remote transcript file exists, and neither the
personal mount nor mounted `tryLockSync` ever admits a remote Session writer.

## Approach

Extend the existing Session persistence boundary rather than treating any mounted filesystem as lock authority or
Session writer. Remote mode intercepts Pi's synchronous `_persist`/`_rewriteFile` at the established
`installDenoSessionPersistence` boundary and routes each save to the laptop; no caller-side awaits are added and Pi's
synchronous append contract is preserved.

```text
remote Pi append (synchronous, in-memory manager)
  capture immutable Session entry
  dedicated Deno Worker sends authenticated save request
    over the child02 remote control channel
  calling thread waits on shared memory with a finite deadline
laptop Session owner
  validate active operation, ordered request identity, immutable payload
  save the entry under the existing native lock
  acknowledge only after the bytes are written and synchronized
remote append returns; dependent work may continue
```

Mechanics the proof validated and this child carries into production:

- The Worker owns network progress; the blocked thread never depends on a main-thread callback.
- A finite total wait bounds each save. A timeout means an uncertain outcome and a sticky fault, never lock expiry or
  takeover by another writer.
- Request identities reconcile retries against saved evidence; identical retries change no bytes, and conflicting
  content under the same identity or stale-operation requests are refused.
- A late reply cannot clear a fault or complete another request.
- The independent remote supervisor (child02) can stop owned work while the save thread is blocked.

Set aside by the owner decision: the guarded stock SFTP design (fresh per-operation SFTP channel, mount identity, and
lock-retaining serving process) and the prototype custom SFTP server. Neither is implemented; no SFTP or SSHFS machinery
is added for Session writes.

The two research sections below are retained as evidence for this decision. Where they describe the choice as open, the
2026-10-06 decision above closes it.

### Planning research: Warp SSH (2026-09-25)

**Question:** Does Warp provide a simpler way to support remote Agent work without copying project files or implementing
an SFTP server? This research informs the storage choice; it does not approve a replacement for this draft's approach.
The owner considers hosting our own SFTP server excessive. A native helper, laptop Python dependency, and direct
operating-system calls from Deno have not been selected.

**Findings from first-party documentation and source:**

- Warp installs a version-matched companion server on the remote host. It performs file reads/writes, repository
  watching, Git operations, and indexing there. The local application receives results and incremental updates over the
  existing SSH connection. This is not whole-project directory synchronization.
  [SSH extension documentation](https://docs.warp.dev/terminal/warpify/ssh/).
- Its SSH transport starts `remote-server-proxy` and uses the SSH subprocess's stdin/stdout as a message channel. The
  proxy connects to a shared remote daemon through a Unix socket. The inspected file-operation path does not mount a
  filesystem or use SFTP. SCP is available for installing the remote binary; that is not ongoing project-file sync.
  [SSH transport source](https://github.com/warpdotdev/warp/blob/0e075a07257a0614c7933b420d11ec5c47db705b/app/src/remote_server/ssh_transport.rs),
  [proxy source](https://github.com/warpdotdev/warp/blob/4d374f50960a86ad4ee9f2be1a8fe031a1b2c10e/app/src/remote_server/unix/proxy.rs).
- Warp defines explicit requests such as `ReadFileContextRequest`, `WriteFile`, `RunCommandRequest`, and `SaveBuffer`.
  Messages use length-prefixed Protocol Buffers. Editor buffers use client/server versions: `BufferEdit` carries an
  expected server version; mismatches return current state. Disk changes can produce `BufferConflictDetected` rather
  than silently replacing unsaved edits.
  [Message definitions](https://github.com/warpdotdev/warp/blob/4d374f50960a86ad4ee9f2be1a8fe031a1b2c10e/crates/remote_server/proto/remote_server.proto),
  [message encoding](https://github.com/warpdotdev/warp/blob/4d374f50960a86ad4ee9f2be1a8fe031a1b2c10e/crates/remote_server/src/protocol.rs).
- The current SSH-extension documentation excludes both Windows remote hosts and the Windows client. It therefore does
  not prove a three-platform adapter. Warp also forwards account credentials for some remote account-backed features;
  this is not evidence for RunWield's laptop-owned provider-authentication requirement.
  [Requirements](https://docs.warp.dev/terminal/warpify/ssh/#requirements).

**Inference for RunWield:** Warp avoids the mounted-file problem by making the file-owning process execute explicit
requests. Our unresolved issue is different: remote Pi uses synchronous file operations to save Session history whose
owner is on the laptop. Warp's remote-project file path does not establish how to retain our laptop Session Writer Lock
inside stock SFTP, nor does it establish Warp's conversation-storage or crash-recovery guarantees.

A narrower alternative worth comparing is explicit Session persistence requests to the existing laptop owner, while
keeping the Agent/TUI and project tools remote. That could remove SFTP lock inheritance for Session writes without
removing the separately agreed personal-resource mount. It would require adapting Pi persistence, metadata, compaction,
rollover, and save acknowledgements; the sources do not prove that this is less work or mechanically complete.

**Recommendation and open decision:** Do not introduce a custom SFTP server based on this research. Compare the actual
Pi integration cost of explicit Session saves with stock-SFTP lock retention before selecting additional dependencies.
The current draft remains unsubmitted pending that choice and implementation feasibility checks. Do not infer a new
Agent location, Windows support commitment, history format, or relaxed writer guarantee from this comparison.

### Pi persistence comparison (2026-09-25; not an approved design change)

**Finding:** Explicit laptop-owned saves are mechanically plausible without moving the Agent, changing Pi's transcript
format, adding laptop Python, or shipping a native launcher. They are not a completed remote Session implementation. The
strongest candidate preserves Pi's synchronous append contract rather than introducing a background save queue.

**Source evidence:**

- Cached Pi 0.87.1, the locked dependency in this checkout, exposes `SessionManager.inMemory(cwd, options, entries)`. It
  loads an existing header/entries without filesystem writes and retains the header's Session ID. `_appendEntry()` calls
  `_persist()` synchronously. Messages, custom records, context edits, model changes, labels, and compaction entries
  reach this path.
- `src/shared/session/root-session.js:installDenoSessionPersistence` already intercepts `_persist` and `_rewriteFile`
  through a Proxy. Extending this existing integration is more bounded than replacing every metadata recorder. These are
  Pi implementation details, not a documented pluggable storage interface; pin/version compatibility tests remain
  necessary.
- `src/shared/workflow/workflow-tool-events.ts:publishWorkflowToolEvent` appends the accepted record before waking its
  waiters. A synchronous save acknowledgement preserves that order. An async `_persist()` Promise would be ignored, so a
  queue flushed only at turn end could permit validation or publication before saving the acceptance record.
- Pi's lower-level `Agent.processEvents()` awaits listeners, but `AgentSession.subscribe()` does not. The awaited path
  could support an async design for normal message events. It does not cover all workflow metadata, compaction,
  standalone mutations, or lifecycle writes. Pi also emits some events before appending; live output remains distinct
  from proof that history was saved.
- In-memory construction performs legacy entry migration without saving it. Validate the supplied header and arrange
  laptop-owned migration before admitting later writes. `newSession()`, in-memory `createBranchedSession()`,
  `setSessionFile()`, and static `forkFrom()` are not all captured by the two persistence hooks; audit actual callers
  and route supported lifecycle operations through the laptop owner instead of inventing local paths.

**Candidate call path:**

```text
remote Pi append (synchronous)
  capture immutable Session entry
  dedicated Deno Worker sends authenticated save request
  Pi waits for that request's acknowledgement
laptop Session owner
  validate operation, sequence and current ownership
  save entry under existing native lock
  return matching acknowledgement
remote Pi append returns
```

A bounded, file-free runtime check on Deno 2.9.7/macOS ARM64 established that a Worker can finish asynchronous work and
notify a main thread blocked in `Atomics.wait`. The check returned `ok` and the expected shared-memory value after a 50
ms Worker delay, with a 2-second maximum wait. It establishes only the runtime primitive: no Pi, network request,
compiled executable, disk commit, Linux, or Windows was tested. No repository tests or personal-data writes were run.

**Required correctness:** The Worker must process the network acknowledgement independently of the blocked thread; using
a callback on that thread would deadlock. Completion/error information must be available through shared memory. Use a
finite total wait, separate request identities, and protection against late replies. A timeout means uncertain outcome,
not lock expiry. The laptop rejects requests from settled or stale operations and reconciles duplicate request
identities against saved evidence without replaying Agent/tool effects.

Persistence failures must remain recorded for the entire operation, even when a metadata recorder catches an exception.
Pi updates its in-memory tree before `_persist`; a failed manager must not subsequently authorize workflow progress or
publish success. Stop dependent work, then discard/reload that manager during recovery. Do not reset the failure on a
late acknowledgement. Define save acknowledgement separately from final generation publication, and test local
synchronization before claiming durable completion.

**Change surface common to either explicit-save design:**

- `root-session.js` — create/hydrate in-memory managers and capture entries without a remote transcript file.
- `runtime/managed-operations.ts`, `runtime/lifecycle.ts`, `runtime/managed-sync.ts`, and `segment-rollover.ts` —
  replace remote transcript `stat`/read/sync assumptions with laptop-owned create, inspect, rollover, and settlement
  operations.
- `file-session-store*.ts`, `file-session-control.ts`, and `session-transcript-projection.js` — keep locking, evidence,
  manifests, recovery and committed projections on the laptop; reuse their existing rules rather than duplicate them.
- `image-attachments.js`, `runtime/images.ts`, Session artifact readers and Memory-backup output — distinguish personal
  Session storage from remote project artifacts and avoid using a temporary or invented remote Session path.
- `src/shared/remote/control.ts` and the remote supervisor from child02 — extend the existing authenticated service and
  independent supervision; preserve personal-resource mounting and the guard against unapproved Session writes.

This checkout remains at `e22c9318`; child02 source was inspected through Git (`origin/main` at `c7b2f75d`). The newer
`requireLocalSessionWriter()` guard exists in `root-session.js` and the file store. It must not be removed globally to
make an explicit-save path work. Execution must integrate the delivered child dependencies before source changes.

| Choice                          | What it simplifies                                                   | Main cost or unresolved risk                                                                                              |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Guarded stock SFTP              | Preserves synchronous filesystem behavior and file readers           | Native handle transfer, serving-process lifetime, mount failures and platform qualification                               |
| Async Session-save queue        | Keeps the Agent event loop responsive during network waits           | Save barriers across Agent, workflow, compaction and lifecycle paths; end-of-turn flush is insufficient                   |
| Synchronous Session-save bridge | Preserves append-return ordering; laptop remains sole managed writer | Worker transport and bounded waits; network latency blocks the calling event loop; lifecycle/path adaptation still needed |

**Recommendation for owner review:** Prefer the synchronous Session-save bridge as the next bounded proof, not a
production claim. It concentrates ordering in the existing persistence boundary rather than many caller-side waits. The
personal-resource mount remains unchanged; this does not promise isolation from deliberate writes through broad
trusted-host file access. A remote Session entry must never use that mount as its persistence fallback.

Before adopting the bridge, prove real Pi append/metadata/compaction through authenticated transport, delayed saves
blocking workflow acceptance, Worker death, lost/late acknowledgements, stale-operation refusal, laptop recovery, and
zero saved remote transcript. Measure per-turn delay and TUI responsiveness at realistic network latency; a finite wait
bounds a stall but does not keep keyboard handling responsive. Keep the existing independent supervisor able to stop
owned work during a blocked save. Full Windows support remains outside the evidence.

The owner authorized a throwaway proof on 2026-09-26; see the [proof Plan](../remote-session-save-proof.md). The proof
ran and passed on 2026-10-05. On 2026-10-06 the owner selected the synchronous Session-save bridge with strict per-entry
saves; the Objective and Implementation Steps of this Plan now describe that design.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/root-session.js` — hydrate the remote in-memory Session manager from laptop-supplied validated
  header/entries and route remote-mode persistence through the save bridge; keep the `requireLocalSessionWriter` guard.
- `src/shared/session/file-session-store.ts`, `file-session-store-owner.ts`, `file-session-store-types.ts`,
  `file-session-activation-state.ts`, and `file-session-control.ts` — laptop-side save admission: ordered request
  identities, authority validation, save under the native lock, acknowledgement after write and sync,
  duplicate/stale/conflict refusal, and unchanged recovery and publication.
- `src/shared/session/runtime/managed-operations.ts`, `runtime/lifecycle.ts`, `runtime/managed-sync.ts`,
  `managed-operation.ts`, and `segment-rollover.ts` — replace remote transcript `stat`/read/sync assumptions with
  laptop-owned create, inspect, rollover, and settlement operations.
- `src/shared/session/session-transcript-projection.js` — project transcripts from laptop evidence only.
- `src/shared/session/image-attachments.js` and `runtime/images.ts` — distinguish personal Session storage from remote
  project artifacts; durable references contain no connection-specific path.
- `src/shared/remote/control.ts`, `supervisor.ts`, and `personal-resources.ts` — add the authenticated save endpoint to
  the existing child02 control service; keep independent supervision able to stop owned work during a blocked save; keep
  the personal mount from ever serving as Session persistence.
- `docs/adr/015-file-authoritative-session-bundles.md` — record the explicit-save extension: the laptop stays sole
  writer, no lease is introduced, and mounted writes are never authoritative.
- The owning Core and Remote SSH PRD sections — record the delivered writer guarantee, the measured per-entry blocking
  behavior, and unresolved platform evidence.

## Reuse Opportunities

- `installDenoSessionPersistence` in `root-session.js` — the established `_persist`/`_rewriteFile` interception point;
  extend it for remote mode instead of replacing metadata recorders.
- Existing file Session store, native locks, manifests, generations, recovery descriptors, publication, and rollover
  paths — the laptop owner reuses them unchanged as sole writer; the bridge adds admission, not a second store.
- `publishWorkflowToolEvent` append-before-wake ordering and recorder error behavior — preserved exactly; the bridge
  must not weaken them.
- Child02's `src/shared/remote/control.ts` authenticated service and `supervisor.ts` independent supervision — the save
  endpoint extends the existing channel; no new transport.
- The proof's recorded mechanics (Worker plus shared-memory wait, sticky faults, identity reconciliation) — reference
  evidence in the proof Plan. The prototype code was disposable and no longer exists; production implements fresh
  against production modules.

## Implementation Steps

- Remote Session construction hydrates a Pi in-memory Session manager from laptop-supplied, validated header/entries; no
  remote transcript file is created, and legacy entry migration happens laptop-side before the first write is admitted.
- Remote-mode persistence interception routes `_persist` and `_rewriteFile` to the save bridge; each append returns only
  after the laptop acknowledges the exact entry bytes. No caller-side awaits are added.
- The dedicated Worker carries every save request over the authenticated control channel; the calling thread waits
  through shared memory with a finite deadline and never depends on a main-thread callback. Worker death wakes the
  caller through the fault path.
- The laptop owner admits saves only for the active operation and the next ordered request identity, validates the
  immutable payload, writes and synchronizes under its native lock, and acknowledges only after the intended bytes
  exist. Identical retries reconcile against saved evidence without duplicating; conflicting content under the same
  identity and stale-operation requests are refused.
- Lifecycle operations outside the two hooks (`newSession`, `setSessionFile`, in-memory branching, static fork,
  constructor-time migration) are audited and routed through laptop-owned operations; each is either supported through
  the bridge or blocked in remote mode, never silently treated as captured.
- A save fault is sticky for the whole operation: dependent model, tool, workflow, and publication work stops even when
  a metadata recorder catches the exception; a late acknowledgement cannot clear the fault; no success is published
  after an unresolved fault.
- Segment rollover and settlement commit predecessor evidence and successor lineage under continuous laptop ownership;
  an old operation's delayed request cannot alter successor bytes and is refused after settlement.
- Recovery discards unsaved remote manager state, reloads from laptop evidence through digest-based inspection and the
  preparing → hydrated → checkpointing transitions, and never replays model requests, tool calls, or external effects. A
  saved-on-disk entry is distinguished from one never accepted.
- Neither the connection-wide personal mount nor any mounted `tryLockSync` result admits a remote Session writer; the
  `requireLocalSessionWriter` guard stays in force, and a remote Session entry never uses the personal mount as
  persistence fallback.
- Attachments and image references distinguish personal Session storage from remote project artifacts; durable
  transcript references contain no connection-specific mount path.
- ADR-015 records the explicit-save extension and the owning PRD sections record the delivered writer guarantee, the
  measured per-entry blocking behavior, and remaining unqualified platforms — in the same change, without weakening
  local Session guarantees.

## Verification Plan

- Automated ordering: with a real file Session store and real lock, hold the laptop acknowledgement after the bytes are
  saved and observe that the remote append has not returned and no dependent model, tool, or workflow action has begun;
  hold a Workflow Tool Event save and observe the actual waiter blocked until acknowledgement; force a swallowed
  metadata-save error and confirm later work stays stopped. These fail if the interception enqueues or returns success
  early.
- Automated faults and recovery: Worker death, transport disconnect, late reply after the deadline, duplicate and
  conflicting retry, stale-operation delivery, and owner death each leave a sticky fault or an exact reconciliation;
  recovery reloads laptop evidence with no replay of the tool effect; a fresh operation remains usable afterwards.
- Automated exclusion and fallback: a second OS process cannot acquire the actual lock file while the laptop owner
  writes or publishes; remote-mode filesystem writes to transcript paths are denied; no personal-mount fallback path
  exists in remote persistence.
- Automated: run focused tests through `deno run -A scripts/run-tests.js <test paths>`, then `deno task seams:check` and
  `deno task ci`. Fake the environment with the existing store and Git fixtures; do not add a storage injection seam.
- Live: over a real SSH connection to the trusted `sct` pilot, run a full remote turn (user message, tool call, remote
  tool result, final reply, custom metadata, compaction), disconnect and reconnect, and resume from laptop evidence.
  Measure per-entry save latency and Stop response on the real connection and record the samples.
- Expected: every entry is durably saved before dependent work; identical retries change no bytes; no remote transcript
  exists; ordinary local Sessions and the personal mount behave exactly as before.

## Edge Cases

- Blocking is per entry and bounded: about 10–45 ms per save on a healthy connection, only while a turn is appending; a
  stall faults at the finite deadline (about 5 s in the proof) and Stop responds through the independent supervisor (642
  ms in the proof). These are samples, not product thresholds.
- A save reply is not a distributed transaction: a remote effect can finish before its result reaches the laptop. Report
  uncertainty from saved evidence; never repeat an external action to recover an acknowledgement.
- Pi memory can run ahead of disk: never continue a failed manager or let unsaved records authorize workflow progress.
- Pi's persistence hooks are implementation details, not a public plugin API: pin and version-compatibility tests
  against the locked Pi version are part of delivery, and an incompatible Pi upgrade must fail closed rather than write
  unguarded.
- An uninterruptible OS I/O call may exceed every application deadline. Preserve truthful recovery state and wait for
  actual lock release.
- Windows hosts and platforms other than the qualified pilot remain unverified. A failed platform check blocks remote
  mode; there is no unlocked fallback.

## Research — Laptop-Owned Explicit Saves (2026-10-05)

Recorded proof evidence for the owner's 2026-10-06 decision above. The proof itself changed no requirements, ADR, or
PRD; the production design in this Plan is the owner's selection after reviewing these
[results](../remote-session-save-proof.md#execution-results-2026-10-05).

| Check                                                                                | Result                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Pi AgentSession, SSH, laptop-native lock and byte-sync acknowledgement          | Passed; ten saves, one remote sentinel execution, actual compaction/metadata/workflow event and fresh reload.                                                                                                                         |
| Swallowed recorder failure, late reply, Worker death, owner death and SSH disconnect | Passed; sticky fault stops dependent work; recovery uses laptop evidence and never replays the tool.                                                                                                                                  |
| Duplicate/conflicting retry and absent/wrong credentials                             | Passed; identical retry changes no bytes; conflict/stale 409 and authentication 401.                                                                                                                                                  |
| OLD request held across publication and successor acquisition                        | Passed; actual held SSH payload returned 409 after reconnect, with successor bytes unchanged.                                                                                                                                         |
| Compiled macOS ARM64 native owner and Linux x64 Pi/Worker                            | Passed; same entry/Worker, normal and interrupted saves, real store recovery/publication, fresh compiled reload.                                                                                                                      |
| Added 0/50/150/500 ms acknowledgement delay, finite stall, independent stop          | Passed as measurements, not usability promises; keyboard round trips 77/327/841/2581 ms; stall 4967 ms; blocked remote stopped in 642.4 ms while laptop lock remained held.                                                           |
| Terminal controls and cleanup                                                        | Passed by machine PTY: all keys accepted, real Worker fault and saved-reply disconnect, fresh recovery without replay, exact fresh compiled reload; no owned processes/listeners/remote scratch remained. Unrelated watcher survived. |
| Owner terminal usability judgment                                                    | Not run; machine-driven terminal input is not owner acceptance.                                                                                                                                                                       |

Commands: `git check-ignore prototypes/remote-session-save-proof/`, then
`deno task prototype remote-session-save-proof`. The normal launcher now uses recorded owned scratch directories,
streamed SHA-256, gzip and resumable rsync through trusted `sct` SSH. Failed/interrupted transfers remain as evidence;
there is no localhost or source-runtime substitution. Runtime storage variables are set before imports, laptop children
use `clearEnv: true`, and remote runtime uses `env -i` without provider credentials or history fallback.

Execution source: `d17d7e2b6fb23e875e150cc236f139e04f9e7b23`, locked Pi 1.0.0 (owner-approved deviation), compiler Deno
2.9.7 on macOS ARM64; pilot Linux x64 has installed Deno 2.7.14. Raw final technical evidence is ignored under
`prototypes/remote-session-save-proof/runs/run-127f2e78bb62ab9e/{artifact,transport,faults,experiments}.json` and
`final-pty-launch.log`. The linked proof Plan contains artifact bytes/hashes, latency samples, failed logs and limits.
Final focused controls are in `focused-ui-controls.json`, `ui-verification.json` and
`runs/ui-1b344cb03249c63b/interactive-1791258634357/interactive.json`. Independent cleanup is in
`cleanup-final-local.json`, `cleanup-final-remote.log` and `cleanup-owned-remote-listener.log`: 106 recorded process
identities and 23 local listener probes passed; the unrelated compile watcher survived. The broad listener diff was
truncated by the command wrapper and is not counted as proof. Raw failed logs remain ignored. Linux SHA-256 is
`d7579e0637d9280d3b5481abe3040c57956eb9649bc0ac8176356a2ab692d512`; macOS SHA-256 is
`f8fad7a7cb49f68c3c6ee2d69f23fbb2cc3ebe4f80de7c88a46bd3c177ea579c`.

The actual store needs digest-based inspection/recovery and preparing → hydrated → checkpointing transitions; the
initial acquisition helper pins generation null, so restart uses `acquireSessionActivation` after recovery. Constructor
migration, lifecycle operations outside `_persist`/`_rewriteFile`, production rollover, attachments and other platforms
remain integration work. Directory sync after publication is not claimed to occur under the lock; sync is not a
power-loss guarantee, and killing an SSH forward is not a full network partition. The scratch save endpoint is not a
production API. The owner has since given that judgment: the 2026-10-06 decision above accepts the measured synchronous
main-loop cost and resumes this child on the save bridge.
