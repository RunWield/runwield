---
status: proposed
---

# Remote SSH with Local Personal Authority

## Context and Constraints

Remote development must use an existing Linux project without a laptop checkout or source synchronization. The owner
requires the terminal interface, Agent, and project workflows to run remotely. Personal settings, model credentials,
memories, and saved Session history remain locally owned. Work is connected-only, not an unattended worker.

The connection boundary resolves an existing remote directory, prepares a matching Linux runtime, mounts the laptop's
full `~/.wld` through stock SFTP/SSHFS at a private remote root on the approved Linux `sct` pilot, and displays a
dormant TUI. Direct bidirectional personal Skill file edits were verified; project `.wld` stays remote. A bounded native
Pi bridge proof on built macOS and Linux `sct` used a synthetic HTTP provider, returned a remote-only sentinel in the
second of two requests, closed an upstream request on cancellation, and reconnected twice. The normal view starts no
user Agent turn or saved Session. The rest of the local-personal-authority split remains proposed, not a claim of
ordinary remote Session support.

Pi uses synchronous transcript file operations. Replacing one model function or one Session-store interface does not
separate all personal state from project execution. The owner chose to retain Pi's filesystem interface through a mount
rather than introduce a per-entry network persistence protocol.

Remote hosts are Linux x86-64 and ARM64. The first release uses Pi-backed models; Claude CLI and Antigravity CLI are
excluded. Personal resource trees are accessed directly through the laptop mount; custom dependencies are best effort.
RunWield must supply its own core capabilities.

The owner explicitly accepts broad laptop-account file access from trusted remote hosts. A notice and Agent instructions
set the intended scope. Filesystem confinement and hostile-server isolation are not first-release requirements.

## Decision and Rationale

Split execution from personal authority:

- Remote Core owns project tools, Plans, Git, worktrees, validation, repair, and publication.
- The laptop owns authenticated model requests, personal-data services, and authoritative Session bundles.
- OpenSSH supplies terminal transport and forwarding. A connection-scoped local service supplies model and personal
  operations without a permanent daemon.
- Remote SSHFS mounts the laptop’s full `~/.wld` at a fresh private remote path through standard OpenSSH SFTP. Remote
  personal settings, Agents, prompts, and Skill file edits operate directly on laptop files, without resource copies,
  synchronization, or a special resource-save operation. The remote project and its `.wld` remain on the server. Other
  enabled personal resource roots outside `~/.wld` can be mounted explicitly when needed.
- Managed Session writes use separate operation-scoped guarded access, not the connection-wide personal mount. No second
  saved remote transcript is created; Pi retains its entry format and synchronous file API.
- The laptop's existing native Session Writer Lock remains the authority. The actual SFTP-serving process must retain
  the lock for its whole writable lifetime, including after launcher failure. A coordinator also retains ownership
  through local evidence publication. An old writable channel ends before a successor can own the Session. No error,
  disposal, or rollover path may explicitly unlock shared ownership while the old serving process can still write.
- Local Core owns manifest commits, recovery evidence, and required local file/directory synchronization. Mounted
  directory-fsync success is not sufficient evidence of a laptop commit.
- Every managed operation gets fresh writable access. The underlying mountpoint is protected against accidental writes
  after unmount. Idle terminals do not retain writer ownership. Connection monitoring never authorizes lock takeover.
- Remote review servers stay with project files; SSH forwards their full origin to a laptop browser.

This extends [ADR-015](015-file-authoritative-session-bundles.md) to a remote execution location. It does not replace
file-authoritative history, native locks, operation-scoped ownership, or recovery without automatic effect replay.
Ordinary local Sessions keep their current behavior.

The personal mount exposes the whole laptop `~/.wld`, including files holding credentials. Standard SFTP is not a
directory sandbox: the trusted remote client can also request other files allowed by the laptop account. Normal setup
does not copy credentials or SSH keys; neither that rule nor the private mount path confines a trusted remote user.
Authenticated model requests and provider callbacks still execute in the laptop runtime. No separate laptop shell
service is part of this design.

### Alternatives

**Explicit per-entry saves:** Evaluated. An in-memory remote Pi manager could send entries to a local service and await
confirmation. This avoids FUSE, but requires correct integration with synchronous appends, metadata, compaction,
workflow records, and segment rollover. The owner chose mounted file access instead. Mounts still need local settlement
and recovery; they do not make network failures disappear.

**Custom restricted SFTP server:** A fixed-file prototype proved lock lifetime and stale-handle rejection. It is not a
complete server. The owner chose standard SFTP and trusted-host access rather than owning a new protocol implementation
or adding confinement machinery.

**Plain SSH or copied personal profile:** Excluded because it creates a second personal setup or copies credentials and
history. Direct mounted personal files avoid a second authoritative profile; they do not restrict trusted-server access.

**Local Agent with forwarded project tools:** Not selected because the agreed product runs the terminal and Agent
remotely. **Remote-authoritative history with exit-time sync** violates local save semantics. **Timeout lock takeover**
violates existing single-writer guarantees.

## Implications

- SSHFS/FUSE availability, stock SFTP lock-descriptor retention, sync extensions, and platform packaging become
  compatibility obligations. Their maintenance cost replaces some Pi persistence-adaptation cost.
- File calls can block. Supervision must run outside the blocked Agent and distinguish storage-service failure from a
  healthy SSH connection. Safety wins over forced takeover when a process cannot yet be terminated.
- Broad file access requires honest notices. Agent instructions and mountpoint permissions are not protection against a
  hostile server or a user deliberately changing permissions.
- Remote file effects and local history cannot commit in one atomic transaction. Recovery checks actual evidence and
  never blindly repeats an uncertain tool or publication action.
- Mount paths are temporary. Durable project locators, Session IDs, and Memory bindings must not contain those paths.
- A custom skill can lack a CLI or contain machine-specific paths. Read its mounted resources directly, expose real
  failures, and leave custom dependency setup to the user without weakening core verification.
- The architecture depends on OpenSSH and Pi behavior, but not a forked Pi persistence format or a RunWield-owned SFTP
  implementation. Replacing the mount later must preserve bundle format, identity, ownership, and save semantics.

This record remains proposed for the full remote feature. The approved connection mount and optional synthetic-provider
Pi proof do not establish ordinary authenticated model turns, guarded Session mounts or saved history, remote workflows,
browser review, or production release support. The [Remote SSH Epic](../plans/remote-ssh-development.md) holds the
prototype findings, verification limits, rollout, and remaining integration work.
