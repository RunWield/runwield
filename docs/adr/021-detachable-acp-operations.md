---
status: proposed
---

# Detachable ACP operations

## Context and Constraints

`wld acp` runs its Session runtime in its own process. When the client closes the connection, `closeMachinery` in
`src/acp/server.ts` cancels the active turn, waits for it to settle, and the process exits. A client restart during a
Plan execution therefore interrupts it.

The owner requires that running work continue when an ACP client restarts. RunWield Remote, Desktop, and Factory need
this. The owner rejects a daemon: no long-lived `wld` service that outlives its work.

Existing constraints:

- [ADR-014](014-file-authoritative-session-bundles.md): the Session writer lock belongs to the active managed operation;
  no lease, heartbeat, or forced takeover. Each managed operation opens a private local socket that another process can
  use to observe, answer, steer, and cancel it.
- [ADR-017](017-remote-ssh-local-personal-authority.md) rejects a permanent daemon.
  [ADR-020](020-electron-workspace-acp-client.md) defers an always-on service.
- ACP v1 defines `session/cancel` and `session/close` as explicit stops. It does not define what happens to running
  work when a connection drops, so either choice is compliant.

## Decision and Rationale

**Closing an ACP connection detaches running work instead of cancelling it.** The process keeps running until its
current managed operation settles, including a wait on an unanswered question, and then exits. Explicit
`session/cancel` and `session/close` still cancel.

**A new connection reaches detached work through standard ACP plus the existing live-operation socket.** `session/list`
reports whether each Session is idle, running in another process, or waiting for input. `session/resume` attaches the
new connection. While another process runs the operation, the new process relays the pending question and its answer,
live progress from the moment of attachment, and the final result over that operation's socket. Updates produced while
no client was attached are not replayed. The final outcome is also in committed history.

Alternatives considered:

| Option                                                                   | Why not chosen                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Keep cancel on disconnect                                                | Fails the owner requirement.                                                                             |
| `wld acp` as a stdio proxy to a long-lived runtime process per Project   | A daemon; the owner rejected it.                                                                         |
| A custom local-socket transport so clients reconnect to the same process | Needs a longer-lived process and a documented custom transport, and helps only first-party clients.      |
| Exactly-once replay of missed updates with Core event positions          | Needs an ordered event log across processes; deferred until users need missed progress.                  |
| Pi Durable checkpoints so a new process continues the work itself        | Experimental API; covers the agent loop only; replaces Session storage. Factory plans to adopt it first. |

## Implications

- Every ACP client gets detach without code changes. A client that relied on disconnect to stop work must send
  `session/cancel` or `session/close`.
- A client that launches `wld acp` must not kill it when the client exits. For example, it must use a separate process
  group, and `KillMode=process` under systemd.
- An orphaned `wld acp` is bounded by its operation. It holds no lock and runs no process after settlement.
- A detached question with no client waits, as it does in the TUI. `session/list` makes it findable.
- If the process running the work dies, crash recovery from durable evidence still applies. Surviving process death
  needs durable checkpoints, such as Pi Durable, and is out of scope.
- The live-operation socket becomes a cross-version contract between `wld` binaries. It needs a version field and must
  refuse versions it does not know.
