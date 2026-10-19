---
planId: "2459d3ce-f00b-45e9-bf8f-1f27a80eb132"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/remote/supervisor.ts"
    - "src/shared/remote/supervisor.test.ts"
    - "src/shared/linux-process-group.ts"
    - "src/shared/foreground-process.ts"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
createdAt: "2026-10-17T16:54:29Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 8
dependencies:
    - "01-establish-the-remote-connection-and-matched-runtime"
    - "07-carry-remote-context-through-delivery-workflows"
targetBranch: "epic/remote-ssh-development"
---

# Stop Owned Remote Work on Connection Loss

## Context

Connected-only operation is a promise: when the laptop goes away, no RunWield work continues on the server. Today the
supervisor keeps that promise only when the remote TUI shuts down cleanly.

The supervisor stops one process group, the remote TUI ("view"). Every tool subprocess leaves that group:

```text
supervisor (SSH command, Linux)
└── view (own group)                      ← supervisor stops this group only
    ├── Pi bash command (own group)       ← detached by Pi bash.js
    ├── git / worktree call (own group)   ← spawnForegroundProcess, often no abort signal
    ├── validation CI shell (own group)   ← validation-local-ci.ts
    ├── background shell (own group)      ← background-tasks.ts
    └── `nohup server &` from an Agent    ← reparents to init when the view dies
```

- `spawnForegroundProcess` and `spawnForegroundShell` always spawn `detached: true` on Unix
  (`src/shared/foreground-process.ts`). Pi's bash tool does the same.
- On SIGTERM, the view disposes its Sessions and aborts Agents and active interactions, so most subprocesses get an abort
  signal. That works only when the view responds within the 5-second grace period.
- When the view is force-killed (for example, while it is blocked on a synchronous Session save) or crashes, those
  groups are orphaned and keep running. Git calls with no abort signal are not stopped even on a clean shutdown.

This child delivers the process part of the Remote SSH PRD
[Disconnect and recovery](../../prd/remote-ssh-prd.md#disconnect-and-recovery) capability:

- **Do not continue unattended**, and its scenarios: "an active Agent and a long-running owned subprocess both stop on
  normal exit" and "abrupt loss stops owned work without a final client message; unrelated processes remain running".
- Preserve: Session-save uncertainty and no-replay recovery (child03, child04, child07). Laptop-side MCP cleanup
  (child06). Workspace browser-disconnect behavior. Local (non-remote) process handling.

### Decision from planning

- **Subreaper descendant sweep (owner decision, 2026-10-17).** The supervisor becomes a Linux child subreaper, so
  orphans of any descendant reparent to it instead of `init`. On stop, it terminates every live descendant. No spawn path
  needs to register its processes. The owner accepts that this also stops `nohup` or `&` servers that an Agent started
  during the connection.
- Set aside: an explicit per-spawn registry (Pi bash, MCP stdio, and every spawn site would need wiring; a missed site
  leaks) and graceful-abort-only (fails the forced-kill scenario).

### Epic Scope Changes

- New child. It receives the owned-process termination work from `07-carry-remote-context-through-delivery-workflows`.
- `08-open-remote-reviews-in-the-local-browser` is renamed `09-…` and `09-package-and-qualify-remote-ssh-support` is
  renamed `10-…`. Their `order` and `dependencies` follow.

## Objective

When a remote connection ends for any reason, the supervisor stops every process that descends from it, including
orphans of a force-killed view, and leaves every other process on the server running.

## Approach

Ownership is process ancestry under the supervisor. A process that RunWield started on this connection, directly or
through any number of forks, is a descendant. The subreaper flag keeps orphans in that tree.

```text
supervisor start (Linux)
  prctl(PR_SET_CHILD_SUBREAPER, 1) through bun:ffi
    failure → refuse to start; no view, no mount
  spawn view, mount, pump (existing)

every health tick
  reap adopted orphans that have exited (never a supervisor-spawned child)

stop (loss, normal exit, signal, mount loss)
  stop view group                    (existing terminateOwnedLinuxGroup)
  sweep descendants
    scan /proc; keep processes whose parent chain reaches the supervisor
    skip the supervisor's own infrastructure (mount helper, input pump) until unmount
    SIGTERM each; wait up to 5 s; SIGKILL the rest; re-scan until none remain or the deadline passes
    a survivor → report "termination unconfirmed"; never report success
  unmount and clean up (existing order)
```

> [!WARNING]
> **Reaping must not steal Bun's child status**
>
> Adopted orphans become zombies of the supervisor. Reap only adopted processes, by exact pid. A `waitpid(-1)` call
> would consume the exit status of the view, mount helper, or pump, and Bun would never see those children exit.

> [!NOTE]
> **Pid reuse**
>
> Check the parent chain and start time (`/proc/<pid>/stat` field 22) again immediately before each signal. A process
> that exited and was replaced by an unrelated one is not a descendant and is never signalled.

Keep the sweep inside the supervisor module and `src/shared/linux-process-group.ts`. No tool, workflow, or Session code
changes. Local RunWield does not use the subreaper.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/supervisor.ts` — set the subreaper flag at start, reap adopted orphans, and run the descendant
  sweep in every stop path before unmount.
- `src/shared/linux-process-group.ts` — the descendant scan and termination logic, next to the existing
  `terminateOwnedLinuxGroup`, with the same identity and uncertainty rules.
- A small Linux FFI binding for `prctl` and `waitpid`, following the existing `bun:ffi` pattern in
  `src/shared/native-file-lock.ts`.
- `src/shared/remote/supervisor.test.ts` — Linux tests for forced-kill orphans, `nohup` daemons, and unrelated
  processes.
- `docs/prd/remote-ssh-prd.md` — the Disconnect and recovery scope note and the stated limit.
- `docs/domain-language.md` — the **Remote SSH connection** entry states that connection cleanup stops every descendant
  process of the connection.

`src/shared/foreground-process.ts` and Pi's bash tool keep `detached: true`. Their own groups still serve per-command
cancellation; the sweep does not depend on group membership.

## Reuse Opportunities

- `terminateOwnedLinuxGroup` (`src/shared/linux-process-group.ts`) — its `/proc` scan, grace period, forced
  termination, and "unconfirmed" result are the pattern for the sweep.
- `bun:ffi` loading in `src/shared/native-file-lock.ts` — the pattern for the `prctl` and `waitpid` binding.
- Existing supervisor stop paths (health loss, mount loss, input EOF, SIGHUP/SIGINT/SIGTERM, normal view exit) — add the
  sweep to the one shared stop sequence; do not add a second stop path.

## Implementation Steps

- On Linux, the supervisor sets `PR_SET_CHILD_SUBREAPER` before it spawns the view, mount, or input pump. If the call
  fails, the connection fails with a clear message, and no view or writable mount exists.
- Every supervisor stop path (normal view exit, health loss, mount loss, input EOF, SIGHUP, SIGINT, SIGTERM) runs the
  descendant sweep after it stops the view group and before it unmounts the personal mount.
- The sweep terminates every live descendant of the supervisor, including processes in other process groups or
  sessions and orphans adopted after the view died. It never signals the supervisor itself, its mount helper, or its
  input pump before unmount, and never signals a process outside its descendant tree.
- Before each signal, the sweep confirms that the pid still descends from the supervisor and still has the start time
  that the scan recorded.
- The sweep uses the existing timing: SIGTERM, a 5-second grace period, then SIGKILL. It re-scans for processes forked
  during the sweep. If a descendant survives the forced deadline, the supervisor reports that termination is unconfirmed
  and exits with failure.
- The supervisor reaps exited adopted orphans by exact pid on each health tick and during the sweep. Bun still observes
  the exit of the view, mount helper, input pump, and model-proof child.
- The Remote SSH PRD **Disconnect and recovery** section states that owned subprocesses stop on loss and on normal exit,
  that Agent-started background servers stop with the connection, and that work handed to another service (for example
  `systemd-run`, a container daemon, `at`, or a remote API) is not a descendant and is not stopped. Its acceptance
  scenarios for owned subprocesses are marked delivered.
- The **Remote SSH connection** entry in `docs/domain-language.md` describes connection cleanup as stopping every
  descendant process of the connection.

## Verification Plan

These tests need Linux. Run them on `sct` or in a Linux container, and report where they ran. On macOS they skip.

- Automated (Linux), forced kill: start the real supervisor with the test fixture. Inside the view, start (a) a
  `detached` process-group child that ignores SIGTERM, (b) a double-forked `setsid nohup sleep` daemon, and (c) a plain
  child with no abort signal. SIGKILL the view, then cut health. Assert that (a), (b), and (c) are gone after the grace
  and forced deadlines. A sweep that stops only the view group fails this test.
- Automated (Linux), unrelated processes: start a `sleep` outside the supervisor tree under the same user before the
  test. Assert that it survives every stop path.
- Automated (Linux), normal exit: an Agent-like child and a long-running descendant both stop when the view exits
  normally. The mount is unmounted after the sweep, not before.
- Automated (Linux), reaping: after adopted orphans exit, no zombie descendants remain after the next health tick, and
  the supervisor still observes the view's exit status.
- Automated (Linux), uncertainty: a descendant that cannot be stopped (simulated by a scan that keeps reporting it)
  produces the "termination unconfirmed" result and a failed exit, never success.
- Automated: `bun scripts/run-tests.js src/shared/remote/supervisor.test.ts src/shared/linux-process-group.test.ts`
  (add the second file if the sweep has unit tests), then `bun run seams:check` and `bun run doc-links:check`.
- Live on `sct`: in a connected remote Session, start validation or a long `bash` command and an Agent-started
  `nohup sleep 600 &`. Kill the laptop SSH process. Confirm on the server that both processes are gone and that a
  `sleep` started in a separate SSH login survives.
- Protect: the existing supervisor tests for group termination, grace periods, health loss, mount loss, and input EOF
  still pass unchanged. No behavior is expected to stop existing.
- Documents: the Remote SSH PRD scope note and the glossary describe only the delivered descendant sweep and its stated
  limit.

## Edge Cases & Considerations

- **Agent-started servers stop.** A `nohup` or `&` server that an Agent started is a descendant and stops with the
  connection. The owner accepted this. The PRD states it.
- **Escaped work.** Work handed to another service is not a descendant. Closing SSH cannot stop it. The PRD states the
  limit.
- **Uninterruptible I/O.** A process in uninterruptible sleep can outlive SIGKILL. Report it as unconfirmed; never
  report success, and never treat a timer as proof.
- **Containers without subreaper support.** `prctl` can fail in restricted environments. The connection then fails
  before any work starts, rather than run without the guarantee.
- **Several connections.** Each supervisor sweeps only its own descendants, so two connections from the same user do
  not affect each other.
