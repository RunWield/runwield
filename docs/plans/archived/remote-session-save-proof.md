---
planId: "12d49502-432a-4d2a-8c5e-475ff0a869f4"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "prototypes/remote-session-save-proof/"
    - "docs/plans/remote-session-save-proof.md"
    - "docs/plans/remote-ssh-development/03-guard-remote-session-writer-access.md"
planDeviations:
    - id: "call_MpKxFr0gVoVSbBgMtafCEkAS|fc_0c362b0e1e339e50016ac2a7b812d887d1bd17be7e9ef500fb"
      supersededRequirement: "Use Pi 0.87.1, described by the Plan as the installed, locked dependency, for the real Pi Session persistence proof."
      replacementRequirement: "Use the execution checkout's locked Pi 1.0.0 for the real Pi Session persistence proof. Inspect and verify its in-memory Session construction and persistence hooks before implementation. Record the actual version and compatibility findings. Do not modify production dependencies."
      reason: "The execution checkout locks Pi 1.0.0. The owner approved using that version without changing production dependencies."
      approvedAt: "2026-10-04T19:24:02.072Z"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-09-26T00:24:00-04:00"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "2fe7311d87fb4808889c978248f1c7523edfba9b"
workRecord:
    status: "generated"
    recordId: "b4ee683d-de4d-4f5f-8f91-b3513e1970c4"
    path: "docs/work-records/2026-10-06-validated-laptop-owned-remote-save-proof.md"
    lastAttemptAt: "2026-10-06T12:19:00.047Z"
archivedAt: "2026-10-30T03:46:41.102Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/remote-session-save-proof.md"
---

# Prove Laptop-Owned Remote Session Saves

## Context

The owner approved a throwaway proof before choosing how remote Pi saves laptop-owned Session history. The
[production child](../remote-ssh-development/03-guard-remote-session-writer-access.md) remains paused. Its research records
Warp's explicit remote file requests and the Pi persistence findings; neither establishes this proposed save path.

Pi 0.87.1 supports an in-memory Session manager. RunWield already intercepts its synchronous `_persist` and
`_rewriteFile` methods in `src/shared/session/root-session.js`. A dedicated Deno Worker could send explicit save
requests to the laptop while Pi waits for confirmation. Only laptop RunWield would hold the Session Writer Lock and
write history. No stock-SFTP lock inheritance would be needed for these writes.

A local Deno 2.9.7/macOS ARM64 check proved only that an asynchronous Worker can notify a thread blocked in
`Atomics.wait`. It did not use Pi, SSH, a file store, or a compiled executable. The important unknowns are save
ordering, interrupted-save recovery, and the effect of synchronous network waits on terminal responsiveness.

This proof informs **Preserve local history** and **Preserve work and report uncertainty** in the proposal's
[Local memories and saved Sessions](../../prd/remote-ssh-prd.md#local-memories-and-saved-sessions) and
[Disconnect and recovery](../../prd/remote-ssh-prd.md#disconnect-and-recovery) capabilities. Lasting owners are Core's
[Session continuity](../../prd/runwield-core-prd.md#session-continuity) and
[execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). No product
requirement, glossary definition, or architectural decision is changed or marked delivered by this proof. Ordinary local
Sessions, the personal-resource mount, and existing remote setup remain unchanged.

## Objective

Produce measured evidence for or against synchronous, laptop-owned Session saves using real Pi, real laptop-native
locks, and an authenticated SSH connection to the existing Linux `sct` pilot. Establish whether further production
planning is justified, not that full remote support is ready.

A demonstrated failure is a useful result. Do not redesign production until the proof's result has been reviewed.

## Approach

Keep executable code, private configuration, compiled proof artifacts, synthetic data and raw evidence in ignored
`prototypes/remote-session-save-proof/`. Use the project's Deno prototype launcher. A minimal terminal control surface
shows current operation/request identity, acknowledged entry, lock status and fault state. It offers normal save,
delayed acknowledgement, disconnect, Worker failure, reconnect and exit actions; skip visual polish.

```text
remote Pi in-memory manager
  synchronous append interception
  dedicated Worker sends save request over SSH-protected transport
  calling thread waits for matching confirmation
laptop RunWield file Session owner
  checks active operation and ordered request identity
  writes and synchronizes the synthetic transcript under its native lock
  replies with saved-entry evidence
remote append returns; dependent work may continue
```

Use the existing remote control authentication and SSH forwarding pattern from child02. Import production capabilities
read-only where usable. A scratch Session request handler is necessary because production has no such endpoint yet; keep
it inside the proof. Do not claim that the real production control endpoint now supports saves.

Use a deterministic synthetic model provider with a real Pi AgentSession and one harmless remote-only sentinel tool. It
avoids provider billing and makes the model/tool order reproducible. The tool result must reach a second model request.
It is not a substitute for the real Pi loop, real network transport, real locks, or real file writes.

Avoid an async save queue: returning a Promise from Pi's `_persist` does not make Pi await it. The proof must preserve
append-return ordering, including `publishWorkflowToolEvent` appending before it wakes workflow waiters.

**Bounds:** One laptop and Linux pilot, one active writer per synthetic Session, and finite fault-injection scenarios.
No production TUI changes, provider credentials, personal history, source synchronization, native helper, custom SFTP,
or new package-manager dependency. Existing SSH credentials are used normally, never copied to the remote host. The
separately agreed personal mount is not needed to save proof history.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `prototypes/remote-session-save-proof/` — ignored, disposable proof and evidence. Its README states assumptions,
  setup, the one-command launch and measured results. A local `deno.json` supplies `tasks.dev`.
- This Plan — durable result summary, source revisions, environment, observed failures and limits.
- `docs/plans/remote-ssh-development/03-guard-remote-session-writer-access.md` — link the result and retain the
  production pause until the owner selects the storage approach.

For this research change, the approved scope explicitly excludes modifications to production code, dependencies, root
configuration, PRDs, ADRs and the glossary. Executable proof code must remain ignored; do not force-add it for delivery.

## Reuse Opportunities

- Pi's installed, locked version: `SessionManager.inMemory`, entry IDs and actual AgentSession behavior — preserve its
  transcript shape and execute real append, metadata and compaction paths.
- `src/shared/session/root-session.js:installDenoSessionPersistence` — reproduce its narrow method interception inside
  the proof without changing production or pretending Pi exposes a public persistence plugin.
- `openFileSessionStore`, existing activation/publication methods and transcript evidence/projection functions — use the
  real laptop authority against scratch roots. Existing file-store/rollover fixtures show how to prepare these.
- `publishWorkflowToolEvent` and actual metadata recorders — exercise their ordering/error behavior rather than a toy
  replacement. Do not perform real Plan approval or publication.
- Child02's `src/shared/remote/control.ts`, `supervisor.ts` and model proof — reuse established transport/security and
  isolation patterns. This planning checkout is stale; execute from source containing completed children 01 and 02 and
  record its revision. Do not reconstruct or overwrite those completed implementations.
- `scripts/run-prototype.ts` — existing launcher; no per-proof root task.

## Implementation Steps

1. The proof runs with `deno task prototype remote-session-save-proof` after
   `git check-ignore prototypes/remote-session-save-proof/` confirms isolation. Its read-only source imports and locked
   Pi version are recorded. Each run owns a unique local scratch subtree and remote temporary directory. Child processes
   use sandboxed personal storage and Memory paths before importing runtime modules; no process mutates the caller's
   real HOME, Session history or Memory database. SSH retains normal host verification and existing authentication.
2. The laptop process uses the real file Session store and native lock on a synthetic bundle. The remote Pi manager
   contains supplied header/entries in memory and has no persisted transcript. Save requests identify the active
   Session/operation, sequence and immutable entry payload, not arbitrary writable laptop paths. The laptop validates
   authority and acknowledges only after the intended bytes are written and synchronized. Final generation publication
   is separately proven from laptop bytes. Do not treat swallowed directory-sync errors as proof of durability.
3. The Worker independently handles network progress while the calling thread waits. Shared memory carries matching
   completion/error information; it does not depend on main-thread callbacks. Finite waits handle missing responses.
   Faults remain recorded for the operation even if a metadata recorder catches an exception. A late reply cannot clear
   that fault or complete another request. Recovery discards unacknowledged in-memory state and reloads laptop evidence.
4. A real Pi turn saves a user message, assistant tool call, remote tool result and final reply. Actual custom metadata
   and a compaction path also reach the laptop. A fresh process reloads the saved header, IDs, parent relationships,
   custom records and compacted context. Initial history saves before the first model request, not only after an
   assistant response. Constructor-time migration and lifecycle operations outside the intercepted hooks are listed
   explicitly as supported checks or remaining integration work, never silently treated as captured.
5. The failure controls can pause acknowledgement after a local save, close the dedicated SSH transport, terminate the
   Worker, and terminate the laptop owner. A competitor uses the actual lock file. Reconnect and duplicate delivery
   reconcile saved entries without duplication or repeating the remote sentinel tool. An old operation's delayed request
   cannot modify the successor's bytes. Incorrect or absent connection credentials cannot acquire or mutate the bundle.
6. Measured ordering exercises the real `publishWorkflowToolEvent` append-before-wake behavior and a real recorder that
   catches append failures. No dependent model/tool/workflow action or success is permitted after an unresolved save
   fault. A synthetic side-effect counter is an observation of real callback execution, not the implementation of the
   workflow behavior. The proof records gaps where production integration would still be required.
7. The interactive proof reports normal and delayed-save timing, per-turn request count, longest main-loop pause,
   keyboard response and external stop time. Compare the observed connection with added 50 ms, 150 ms and 500 ms
   acknowledgement delays, plus one stalled request with a finite deadline. These are experiment inputs, not proposed
   product latency promises. The independent controller can stop owned work even while Pi's thread is blocked.
8. The same ignored proof entry and Worker can run as compiled laptop/Linux executables; at least the normal path and
   one interrupted save are exercised in that form. Failure to package or run is recorded as a blocker, not replaced by
   a source-only success claim. No production CLI entry is added for the proof.
9. All owned processes, listeners and remote scratch resources are closed or removed. Unrelated processes survive. Raw
   synthetic evidence may remain ignored locally. This Plan and the production child's research section receive a
   compact result table, commands, versions, artifact hashes where compiled, evidence locations and conclusion. Mark
   each scenario passed, failed or not run. Keep usability awaiting owner judgment unless the owner has exercised it.

## Approval Confirmation

No Work Records are superseded. Approval authorizes this isolated proof only, not adoption of a new persistence design,
production implementation, or expanded platform support.

## Verification Plan

**Launch:** `git check-ignore prototypes/remote-session-save-proof/`, then
`deno task prototype remote-session-save-proof`. The local launcher prints the concrete commands and owned scratch
locations. Keep checks inside the runnable experiment, not a new production test suite. If existing tests are needed,
use only `deno run -A scripts/run-tests.js <focused paths>` or `deno task test`, never direct `deno test`.

**Normal path:** Independently read laptop JSONL and published evidence after each save and after restart. Match actual
Pi entry IDs/content, metadata and compaction context. Inspect remote file activity and the scratch tree for persisted
history: a missing final file alone does not prove there was no temporary transcript. There must be no history fallback
through the broad personal mount. Reload must not execute the sentinel tool again.

**Ordering:** Hold an acknowledgement after the laptop has saved an entry. Observe that the remote append has not
returned and no dependent model/tool action has begun. Hold a root Workflow Tool Event save and observe the actual
waiter remains blocked until acknowledgement. These checks fail if interception merely enqueues or returns success.
Force a swallowed metadata-save error; later work remains stopped despite the caller's catch.

**Lock and crash:** A second OS process cannot acquire the actual lock while the laptop owner is writing or publishing.
After owner death, it can acquire; no other process can continue old authoritative writes. After restarting the owner,
inspect real transcript evidence rather than declaring success from a timeout or replaying the turn. Distinguish a save
already on disk from one never accepted.

**Retry and stale access:** Drop a reply after a save, repeat that same request, and count exact laptop entries and tool
executions. Identical retry creates no duplicate; conflicting content under the same identity is refused. Delay an old
request across settlement/reconnect and verify successor bytes are unchanged. Worker death wakes through the finite
wait/fault path; a late acknowledgement never turns that failed operation into success. A later fresh operation remains
usable after recovery.

**Usability checkpoint:** Show the owner the interactive latency cases and measured pauses. Ask whether keyboard/Stop
behavior is acceptable. Record the answer separately from correctness. Without that answer, report the measurements and
leave usability unconfirmed; do not choose a production threshold on the owner's behalf.

**Scope and reporting:** `git diff --stat` and `git status --short` show only intended Plan evidence changes; no
production code or dependency edits. Independent cleanup checks confirm tracked PIDs/listeners and remote directories
are gone. Retain failures as evidence. Document whether to proceed, revise the transport, or stop. A loopback-only,
source-only, mocked-file-store or append-only run cannot be reported as the full proof.

Existing local TUI, ACP, Workspace, lock/recovery tests and personal mounting behavior are not changed or removed. The
linked PRD scenarios remain targets, ADR-018 remains a proposal, and glossary terms retain current meaning.

## Edge Cases & Considerations

- **No latency promise yet:** synchronous acknowledgement blocks the calling event loop. A successful safety proof may
  still be a poor user experience; the result must separate those conclusions.
- **Save reply is not a distributed transaction:** remote effects can finish before their results reach the laptop.
  Report uncertainty and inspect saved evidence; never repeat an external action to recover its acknowledgement.
- **Pi memory can get ahead of disk:** `_appendEntry` updates memory before persistence. Do not continue using a failed
  manager or let its unsaved workflow records authorize progress.
- **Real SSH is required:** use the established trusted `sct` pilot with fresh scratch paths. Missing access or runtime
  prerequisites yield a precise blocked result; do not bypass host checks or substitute localhost silently.
- **Prototype isolation is not a sandbox claim:** use no real personal data. Broad trusted-host access remains an
  accepted property of the separate personal mount, not protection supplied by this save protocol.
- **Limited coverage:** no full remote project identity, attachment transfer, production segment-rollover workflow,
  all-provider compatibility, Windows qualification, network-partition equivalence, or power-loss durability claim.
  Carry these into later production planning; a killed SSH process is not a real network partition.
- **Future implementation remains a decision:** after evidence and owner review, revise child03, its dependent child04,
  and the affected ADR/PRD references together if the owner adopts explicit saves. Do not change them during this proof.

## Execution Results — 2026-10-05

Execution was autonomous after the owner changed the collaboration mode. Production child03 remains paused. These are
research results, not delivery of remote support or approval of a storage design. The owner has not exercised the
terminal, so usability remains unconfirmed.

**Environment and source:** execution revision `d17d7e2b6fb23e875e150cc236f139e04f9e7b23`; locked Pi **1.0.0**, as
approved in the Plan deviation; laptop Deno **2.9.7**, macOS ARM64; trusted `sct` pilot Linux x64, installed Deno
**2.7.14**. Both proof executables were compiled by laptop Deno 2.9.7. No production source, dependency, configuration,
PRD, ADR, or glossary was changed. `git check-ignore prototypes/remote-session-save-proof/` confirmed isolation.
Read-only imports include the real file Session store, native locks, HostedSession, workflow event publisher/waiter, and
workflow-context recorder. Source hashes are in ignored `source-inventory.json`.

**Commands:** `deno task prototype remote-session-save-proof` is the normal launch. It compiles the same ignored
`entry.js` and included `save-worker.js` for `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`. Linux compilation
uses `--deny-write`; both use the full frozen npm snapshot, `--cached-only`, and explicit Worker inclusion. The laptop
owner and fresh reload process use the compiled macOS executable, with no source fallback. A recorded interrupted
transfer can be resumed with
`PROOF_RESUME_ARTIFACT=/absolute/path/to/owned/artifact.json deno task prototype remote-session-save-proof`. The final
technical/terminal run used this normal launcher with a recorded owned transfer inventory. Completed runs remove the
remote directory; their inventory is not a reusable remote cache.

The normal launcher now uses streaming SHA-256, gzip and `rsync --partial --inplace --timeout=45` through trusted SSH,
with `ServerAliveInterval=10` and `ServerAliveCountMax=3`. It records the owned directory before transfer, retains
failed attempt logs, and verifies both compressed and unpacked remote hashes. An injected transfer interruption resumed
in the normal launch. A later transfer was stopped before its controller deadline and resumed through the normal launch.
Upload time is not Session-save latency. Scratch HOME, Pi and Memory paths are supplied before runtime imports; local
runtime children use `clearEnv: true`, and remote runtime uses `env -i`. No provider credentials are sent.

| Scenario                                                                      | Result                         | Observable evidence                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real AgentSession normal turn, metadata, compaction and Workflow Tool Event   | Passed                         | Ten saves; two turn model requests plus compaction; sentinel executed once and its result reached the second turn request.                                                                                                                         |
| Initial save and append-before-dependent-work ordering                        | Passed                         | Each added-1000 ms reply was held after laptop bytes existed; append and actual workflow waiter remained blocked; native competitor excluded ten times.                                                                                            |
| Final publication and fresh compiled reload                                   | Passed                         | Laptop bytes, IDs, parents, custom records and compacted context matched; generation 0 digest matched the manifest; lock released. Reload registered no tool and ran no turn.                                                                      |
| Actual metadata recorder catches a refused save                               | Passed                         | Zero entries saved and no sentinel call; sticky fault prevented the turn.                                                                                                                                                                          |
| Late reply after main wait expires                                            | Passed                         | Six saved entries, one sentinel call; terminal timeout remained despite the late reply.                                                                                                                                                            |
| Worker death before tool-result delivery                                      | Passed                         | Five saved entries, one sentinel call; finite 5500 ms main wait stopped continuation.                                                                                                                                                              |
| Laptop owner death with saved reply pending                                   | Passed                         | Six saved entries; native competitor acquired after actual process death.                                                                                                                                                                          |
| Dedicated SSH forward disconnect                                              | Passed                         | Six saved entries; live laptop owner retained its native lock; failed operation did not continue.                                                                                                                                                  |
| Recovery after all five faults                                                | Passed                         | Fresh managers used only laptop bytes; no model/tool replay; exact reconciliation, publication, lock release and fresh compiled reload passed. Changed-history recovery published generation 1 after real store recovery to generation 0.          |
| Identical retry, conflicting retry, stale operation, absent/wrong credentials | Passed                         | Identical SSH retry changed no bytes; conflicting/stale identities returned 409; absent/wrong credentials returned 401.                                                                                                                            |
| OLD delivery held across settlement and reconnect                             | Passed                         | Actual SSH-delivered payload held before admission while predecessor published and successor acquired its native lock; later delivery returned 409 and successor bytes were unchanged. A fresh successor append/publication still worked.          |
| Remote history fallback                                                       | Passed in this bounded runtime | Filesystem writes denied; direct fallback write refused; remote scratch held only executable and sentinel. No personal mount or localhost substitute.                                                                                              |
| Compiled macOS/Linux normal and interrupted paths                             | Passed                         | Same packaged entry/Worker; compiled laptop native owner throughout final run, compiled Linux Pi/Worker, and fresh compiled laptop reload.                                                                                                         |
| Finite stall and independent external stop                                    | Passed                         | Stalled save faulted at 5007.1 ms with no model/tool; independent stop completed in 642.4 ms while laptop lock remained held.                                                                                                                      |
| Terminal controls                                                             | Passed by machine-driven PTY   | All normal/delay/disconnect/Worker-failure/reconnect/keyboard/exit keys were accepted against the compiled pair; saved-reply disconnect and Worker timeout were observed; fresh recovery did not replay the tool. Owner judgment remains separate. |
| Owner usability judgment                                                      | Not run                        | Machine-driven keys are not an owner exercise or acceptance.                                                                                                                                                                                       |

### Timing samples

Each normal latency case used a fresh real AgentSession over SSH, ten saves and one sentinel execution. Connection setup
measures tunnel readiness, separately from save waits. Main-loop gaps use a 5 ms monotonic sampler. Keyboard bytes
travel through live SSH stdin to Pi's main loop; keyboard round-trip uses the independent controller's send/receive
clock, not subtraction between host clocks. Consecutive synchronous saves can block the keyboard longer than one save.

| Added acknowledgement delay ms | Connection setup ms |   Save waits ms | Longest sampled main-loop gap ms | Keyboard round-trip ms |
| -----------------------------: | ------------------: | --------------: | -------------------------------: | ---------------------: |
|                              0 |              1211.9 |       10.3–42.8 |                            124.3 |                     77 |
|                             50 |              1212.5 |       59.5–97.8 |                            378.9 |                    327 |
|                            150 |               363.2 |     161.0–197.2 |                            896.5 |                    841 |
|                            500 |               701.2 |     512.1–662.3 |                           2753.0 |                   2581 |
|                     7000 stall |              1551.9 | fault at 5007.1 |                           5024.3 |                   4967 |

These are experiment samples, not latency thresholds. The stalled manager acknowledged zero entries. The independent
stop controller is separate from Pi's blocked thread. It distinguishes a zombie from a live PID and can escalate TERM to
KILL if the owned PID remains live after 100 ms; neither a deadline nor remote death releases the live laptop lock.

### Artifacts, evidence and limits

| Artifact      |     Bytes | SHA-256                                                            |
| ------------- | --------: | ------------------------------------------------------------------ |
| Linux x64     | 957807192 | `d7579e0637d9280d3b5481abe3040c57956eb9649bc0ac8176356a2ab692d512` |
| macOS ARM64   | 844782994 | `f8fad7a7cb49f68c3c6ee2d69f23fbb2cc3ebe4f80de7c88a46bd3c177ea579c` |
| Gzip transfer | 271804217 | `1332d590cbb2a6734eb9520f6d0079027e0d7e64dc5cdd5a676524192e37ace1` |

Raw evidence is ignored under `prototypes/remote-session-save-proof/`:

- `runs/run-127f2e78bb62ab9e/{readiness,artifact,transport,faults,experiments}.json` and `final-pty-launch.log` contain
  the final compiled correctness, recovery, latency, held-OLD and external-stop results. `pty-controls.json` records
  machine key bytes and exit 0, not owner judgment.
- `runs/ui-1b344cb03249c63b/interactive-1791258634357/interactive.json`, `focused-ui.log`, `focused-ui-controls.json`,
  and `ui-verification.json` contain the final control check: exit 0, all nine key actions accepted, Worker fault,
  disconnect while saved reply pending, fresh recovery, twelve final entries, one sentinel execution, and a fresh
  compiled reload matching unchanged laptop bytes. This check used
  `deno run -A --frozen --config deno.json prototypes/remote-session-save-proof/ui-launch.js` under a machine PTY and
  the same compiled artifacts; `verify-ui.js` independently checked its outcomes. Reconnect now clears the displayed
  predecessor fault only when a fresh manager/operation exists. Lock state and busy/pending identity update live.
- Earlier `runs/fault-c9db7658c340f9b6/faults.json` and `fault-resumed-run.log` retain the first five passing fault
  cases.
- `final-launch.log` retains the first increment's passing saves/faults/latency/held-OLD results and failed stop probe.
  That probe used only `kill -0`; the corrected controller checks process state and permits escalation. Do not count
  this earlier whole launch as passed.
- `transfer-interruption.log`, `pty-transfer-interrupted.log`, and its controls JSON retain deliberate interruptions;
  `rebuild-interrupted.log` retains a cancelled stale instrumentation build. `clock-independent-timing.log` records a
  focused controller stopped before the artifact was ready; its scenarios were not run. Earlier SCP, compilation and
  recovery failures remain in `fault-*.log` and workflow logs. No failed log was converted to pass evidence.

The real store's initial acquisition pins generation null. Changed-history restart therefore uses actual
`inspectSessionActivation` and `recoverSessionControl` transcript evidence, then `acquireSessionActivation` with the
recovered generation and preparing → hydrated → checkpointing phases. Recovery discards unsaved Pi memory; it never
repairs uncertainty by replaying the sentinel.

Constructor migration, `newSession`, `setSessionFile`, branching, static fork, production rollover and attachments
remain outside these intercepted hooks. The proof does not qualify all providers or Windows. Explicit transcript sync
failures propagate. Production publication catches directory-sync errors, so the proof separately syncs
bundle/transcript parents after publication and does not claim those checks occurred under a still-held lock. Sync is
not a power-loss proof; killed SSH is not a full network partition. The scratch endpoint is not a production save API.

**Cleanup:** `cleanup-final-local.json` checked 106 recorded process identities and 23 local listener ports: no owned
process or listener remained. The unrelated compile watcher (PID 70012) survived. Independent `cleanup-final-remote.log`
found no proof scratch directories, executables in use, or artifact-transfer processes on `sct`;
`cleanup-owned-remote-listener.log` found the recorded UI SSH-forward port absent. The broad listener baseline diff was
truncated by the command wrapper and is retained as diagnostic evidence, not counted as a pass. Earlier partial-upload
directories were also absent. Raw local synthetic evidence and compiled artifacts remain ignored. `git status --short`
and `git diff --stat` show only these two intended Plan documents; the pre-existing managed frontmatter change was
preserved. No full CI suite ran; only focused actual proof checks ran.

**Conclusion:** the bounded safety and compiled-package proof supports design review of explicit laptop saves. It does
not select that design. The measured synchronous keyboard pauses require owner judgment before production planning can
resume. Requirements, architecture and production child03 remain unchanged and paused.
