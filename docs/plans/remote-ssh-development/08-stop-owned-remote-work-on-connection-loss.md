---
planId: "2459d3ce-f00b-45e9-bf8f-1f27a80eb132"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/remote/supervisor.ts"
    - "src/shared/remote/supervisor.test.ts"
    - "src/shared/linux-process-group.ts"
    - "src/shared/remote/process-group.test.ts"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-17T16:54:29Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 8
dependencies:
    - "01-establish-the-remote-connection-and-matched-runtime"
    - "07-carry-remote-context-through-delivery-workflows"
targetBranch: "epic/remote-ssh-development"
userVerifiedAt: null
status: "reviewed"
validatedCommit: "9eceb74f31185c0377de6ff435a52932d3da25e7"
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

### Decisions from planning

- **Subreaper descendant sweep (owner decision, 2026-10-17).** The supervisor becomes a Linux child subreaper, so
  orphans of any descendant reparent to it instead of `init`. On stop, it terminates every live descendant. No spawn path
  needs to register its processes. The owner accepts that this also stops `nohup` or `&` servers that an Agent started
  during the connection.
- Set aside: an explicit per-spawn registry (Pi bash, MCP stdio, and every spawn site would need wiring; a missed site
  leaks) and graceful-abort-only (fails the forced-kill scenario).
- **No reaping during the connection (owner decision, plan review).** Exited adopted orphans stay as zombies until the
  supervisor exits. Set aside: restricted reaping on each health tick, which needs a `waitpid` binding and a rule that
  the supervisor never makes other detached spawns after setup, and which hangs cleanup if it ever reaps a Bun-spawned
  child.

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

All stop paths already meet in the outer `finally` of `runRemoteSupervisor`. The sweep enters there, in two phases
around the existing unmount:

```diff
 runRemoteSupervisor (src/shared/remote/supervisor.ts)
+  setChildSubreaper()                 # first step after the Linux check; failure → throw, nothing started
   stty, input pump, header, mount, view (existing)
   inner finally: stop view group + input pump, send "shutdown" (existing)
   outer finally:
     stop view / pump if still running (existing)
+    sweep phase 1: descendants outside the supervisor's own session
     personalMount.close()              (existing unmount)
+    sweep phase 2: every remaining descendant
-    remove SIGHUP/SIGINT/SIGTERM handlers   (was before unmount)
+    remove SIGHUP/SIGINT/SIGTERM handlers   (now after phase 2)
     restore stty (existing)
```

**Why two phases split by session.** The mount helpers (`sshfs` and its SSH proxy) must keep running until unmount, or
the unmount cannot be clean. They are spawned without `detached`, so they stay in the supervisor's own session (the SSH
terminal session). The view is spawned with `detached: true`, and Bun implements that with `setsid()` (checked with Bun
1.4.3: the child's session id equals its pid). Every process the view or its tools start is therefore in the view's
session or a newer one. The kernel never lets a process move back into an older session. So "outside the supervisor's
session" is exactly the view's tree plus its orphans, and phase 1 cannot hit a mount helper. Phase 2 runs after unmount
and stops any helper leftover, so the final statement "no descendant remains" is true.

```text
sweep(includeOwnSession)
  repeat
    scan /proc: live processes (not Z/X) whose parent chain reaches the supervisor
      phase 1 also drops processes whose session id equals the supervisor's
    first pass: SIGTERM each; later passes after the 5 s grace: SIGKILL each
    before each signal: re-read the parent chain and start time (stat field 22); skip on change
  until the scan is empty or the forced deadline (2 s after SIGKILL) passes
  survivors → "termination unconfirmed"
```

**Signal handlers stay until phase 2 ends.** The current code removes its SIGHUP/SIGINT/SIGTERM handlers before
unmount. When the SSH terminal hangs up during cleanup, a second SIGHUP would then kill the supervisor with the default
action, and its orphans would escape to `init`. The handlers are idempotent, so they stay registered until phase 2 ends.

> [!NOTE]
> **Pid reuse**
>
> Check the parent chain and start time (`/proc/<pid>/stat` field 22) again immediately before each signal. A process
> that exited and was replaced by an unrelated one is not a descendant and is never signalled. This is the same
> re-check discipline as `terminateOwnedLinuxGroup`; the window between check and signal is not closed with pidfds.

**Adopted orphans are not reaped during the connection.** Adopted orphans that exit become zombies of the supervisor.
Bun's event loop does not reap them; Bun's own source notes that a subreaper "would accumulate zombies" because only its
`spawnSync` loop calls `wait4(-1)`. The sweep ignores zombies, and `init` reaps them when the supervisor exits.

The supervisor does not reap them itself because it cannot reliably tell an adopted orphan from its own Bun-spawned child
(`stty`, `fusermount3`, the view). Reaping the wrong pid steals Bun's exit status. The await on that child then never
settles, and cleanup hangs. The cost of not reaping: `ps` shows `<defunct>` children of the supervisor for orphans that
already exited, and each one holds a pid against the user's process limit until disconnect. The owner accepted this
cost (see Decisions from planning).

Keep the sweep inside the supervisor module and `src/shared/linux-process-group.ts`. No tool, workflow, mount, or
Session code changes. Local RunWield does not use the subreaper.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/supervisor.ts` — set the subreaper flag first, run sweep phase 1 before unmount and phase 2 after
  it in the outer `finally`, and keep the signal handlers registered until phase 2 ends.
- `src/shared/linux-process-group.ts` — the descendant sweep and the `prctl` subreaper binding, next to the existing
  `terminateOwnedLinuxGroup`, with the same identity and uncertainty rules. The binding follows the `bun:ffi` and
  `libc.so.6` pattern in `src/shared/native-file-lock.ts`. If a separate small file reads better, that is the
  Engineer's call.
- `src/shared/remote/process-group.test.ts` — Linux unit tests for the sweep. They need no SSHFS, so they run on any
  Linux host.
- `src/shared/remote/supervisor.test.ts` — the production-supervisor fixture gains forced-kill orphans, a `nohup`
  daemon, and mount-order checks. These tests are opt-in (`WLD_TEST_SSHFS_STALL=1`, SSHFS, `/dev/fuse`, non-root).
- `docs/prd/remote-ssh-prd.md` — the Disconnect and recovery scope note and the stated limit.
- `docs/domain-language.md` — the **Remote SSH connection** entry states that connection cleanup stops every descendant
  process of the connection.

`src/shared/foreground-process.ts` and Pi's bash tool keep `detached: true`. Their own groups still serve per-command
cancellation; the sweep does not depend on group membership. `src/shared/remote/sftp-mount.ts` does not change: the
session rule keeps its helpers out of phase 1 without a new interface.

## Reuse Opportunities

- `terminateOwnedLinuxGroup` (`src/shared/linux-process-group.ts`) — its `/proc` scan, grace period, forced
  termination, and "unconfirmed" result are the pattern for the sweep.
- `bun:ffi` loading in `src/shared/native-file-lock.ts` — the pattern for the `prctl` binding.
- The existing `running()` helper and production-supervisor fixture in `src/shared/remote/supervisor.test.ts`.
- Existing supervisor stop paths (health loss, mount loss, input EOF, SIGHUP/SIGINT/SIGTERM, normal view exit, early
  setup failure) all reach the outer `finally` — add the sweep there; do not add a second stop path.

## Implementation Steps

- `runRemoteSupervisor` sets `PR_SET_CHILD_SUBREAPER` immediately after its Linux check, before the first `stty` call
  and before any spawn. If `prctl` returns an error, the supervisor throws a clear error ("Remote supervisor cannot
  own its subprocesses: PR_SET_CHILD_SUBREAPER failed"), and no terminal mode change, view, or mount happens.
- `src/shared/linux-process-group.ts` exports a descendant sweep that takes one choice: whether to include processes in
  the caller's own session. It finds live descendants of the calling process by their parent chain in `/proc`, sends
  SIGTERM, waits up to 5 seconds, sends SIGKILL, waits up to 2 more seconds, and re-scans on each poll so processes
  forked during the sweep are also stopped. It returns `true` only when a final scan finds no live descendant in scope,
  and `false` when one survives. A process whose `stat` cannot be read (`EACCES`/`EPERM`, for example another user's
  process under `hidepid`) is treated as outside the tree, because it cannot be shown to descend from the caller; the
  PRD limit names work run under another user.
- The sweep never signals the calling process, a process outside its descendant tree, or (when own-session processes
  are excluded) a process in the caller's session. Before each signal it re-reads the pid's parent chain and start
  time, and skips the pid when either changed.
- In the outer `finally` of `runRemoteSupervisor`, after the existing view and input-pump stops, phase 1 sweeps
  descendants outside the supervisor's session. `personalMount.close()` runs after phase 1. Phase 2 then sweeps every
  remaining descendant. Both phases also run on early setup failure and on interruption before the view exists.
- The SIGHUP, SIGINT, and SIGTERM handlers stay registered until phase 2 ends.
- If either phase returns `false`, the supervisor writes "Remote owned process termination is unconfirmed" to stderr
  and the entry exits with failure. When an earlier error is already propagating, that error stays the thrown one and
  the unconfirmed message is still written. Cleanup steps after the sweep (unmount, stty restore) still run.
- The supervisor makes no `waitpid` call and does not reap adopted orphans during the connection. The existing awaits on the view, input pump, model proof, mount helpers, and `stty` still settle.
- The Remote SSH PRD **Disconnect and recovery** scope note no longer calls full descendant termination target scope
  in child08. It states that owned subprocesses, including orphans after a forced TUI kill, stop on loss and on normal
  exit, and that Agent-started background servers stop with the connection. The not-promised paragraph names the
  limits: work handed to another service (for example `systemd-run`, a container daemon, `at`, an existing `tmux`
  server, or a remote API), work run under another user, and a supervisor that is itself force-killed. Its acceptance
  scenarios for owned subprocesses are marked delivered.
- The **Remote SSH connection** entry in `docs/domain-language.md` describes connection cleanup as stopping every
  descendant process of the connection.

## Verification Plan

These tests need Linux. Run them on `sct` or in a Linux container, and report where they ran. On macOS they skip.

Sweep unit tests (`src/shared/remote/process-group.test.ts`, any Linux host). Run the sweep inside a small spawned
fixture process that sets the subreaper flag itself, so the test process is never the sweep root:

- **Orphans and other sessions:** the fixture starts (a) a `detached` child that ignores SIGTERM, (b) a double-forked
  `setsid nohup sleep` that is adopted after its parent exits, and (c) a child in the fixture's own session. Phase 1
  stops (a) and (b) and leaves (c) running. A following phase 2 stops (c). A sweep that only signals process groups,
  only direct children, or ignores the session rule fails this test.
- **Unrelated process:** a `sleep` started by the test process (not a fixture descendant) survives both phases.
- **Late fork:** the fixture child is `sh -c "trap 'sleep 600 &' TERM; while :; do sleep 1; done"`. On SIGTERM it
  forks a new `sleep`. After the sweep, neither the shell nor the new `sleep` is running.
- **Uncertainty:** an unprivileged test cannot make a process that survives SIGKILL, and a fake `/proc` scan would be
  a new test seam, which `seams:check` forbids. Prove this branch by Semantic Review instead (below).

Production supervisor tests (`src/shared/remote/supervisor.test.ts`, opt-in with `WLD_TEST_SSHFS_STALL=1`, SSHFS,
`/dev/fuse`, non-root):

- **Forced view kill:** the fixture view starts the same (a), (b), and a plain child with no abort signal. The test
  SIGKILLs the view. Assert that the supervisor exits and all three are gone. Today the supervisor skips the group stop
  after the view exits, so this fails before the change.
- **Normal exit and loss:** the existing scenarios (`blocked`, `close`, `kill-launcher`, `silent-control`, and the
  setup scenarios) also assert that a detached descendant started by the view is gone.
- **Mount cleanup:** in the forced-kill scenario, the supervisor output has no "Remote mount cleanup failed" or
  "SSHFS cleanup uncertain" message, and the private `wld-sftp-*` directory is removed. The unit test above proves that
  phase 1 leaves own-session processes such as `sshfs` running.
- **Unrelated process:** the existing `unrelated` `sleep` survives every scenario.
- **Deadlines:** raise the test deadlines to cover the view grace plus the sweep grace and forced deadlines.

Semantic Review:

- The sweep returns `true` only after a final scan finds no live descendant in scope. A timer that expires never
  produces `true`. An unreadable process is never signalled.
- Phase 1 excludes the supervisor's own session; phase 2 does not. Phase 1 runs before `personalMount.close()` and
  phase 2 after it, on every path through the outer `finally`.
- A `false` result writes the unconfirmed message and leads to a non-zero exit from the `--remote-supervisor` entry.
- The signal handlers are removed only after phase 2.

Commands:

- `bun scripts/run-tests.js src/shared/remote/process-group.test.ts src/shared/remote/supervisor.test.ts` on Linux, and
  with `WLD_TEST_SSHFS_STALL=1` where SSHFS is available. Report which tests ran and which skipped.
- `bun run seams:check` and `bun run doc-links:check`.
- Live on `sct`: in a connected remote Session, start validation or a long `bash` command and an Agent-started
  `nohup sleep 600 &`. Kill the laptop SSH process. Confirm on the server that both processes are gone and that a
  `sleep` started in a separate SSH login survives.
- Protect: the existing tests for group termination (`process-group.test.ts`), the view grace period (`blocked`), health
  loss, setup interruption, model-proof stall, mount loss, and input EOF keep every current assertion. Only their
  deadlines may grow. No behavior is expected to stop existing.
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
- **Supervisor killed with SIGKILL.** The sweep needs the supervisor to run its `finally`. If the supervisor itself is
  SIGKILLed (for example by the out-of-memory killer), its orphans reparent to `init` and keep running. sshd does not
  do this on disconnect; it hangs up the terminal, which sends SIGHUP. The PRD states the limit.
- **Privilege changes.** A descendant that runs under another user (for example through `sudo`) cannot be signalled.
  If it is visible, the sweep reports termination as unconfirmed. If `/proc` hides it (`hidepid`), it is outside the
  guarantee; the PRD limit names work run under another user.
- **Cleanup time.** Worst case is the view grace (5 s + 2 s), then the sweep grace (5 s + 2 s), then unmount. The
  laptop already received "shutdown" before the sweep; the supervisor keeps its signal handlers, so a terminal hang-up
  during this time does not cut the cleanup short.
- **Zombies.** Exited orphans stay as `<defunct>` children of the supervisor until disconnect. The owner accepted
  this in plan review.
