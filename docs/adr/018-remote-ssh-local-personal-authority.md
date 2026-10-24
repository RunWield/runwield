---
status: accepted
---

# Remote SSH with Local Personal Authority

## Context and Constraints

Remote development uses an existing Linux project without a laptop checkout or source synchronization. The owner
requires the terminal interface, Agent, and project tools to run remotely. Personal settings, model credentials,
memories, and saved Session history remain laptop-owned. Work is connected-only, not an unattended worker.

Pi uses synchronous transcript operations. The owner selected a synchronous laptop-owned save bridge after the
[remote Session-save proof](../work-records/2026-10-06-validated-laptop-owned-remote-save-proof.md). The owner accepted
per-entry network latency and a finite blocking wait on save failure. A personal-resource mount alone cannot enforce the
native Session Writer Lock or prove a laptop commit.

Remote hosts are Linux x86-64 and ARM64. The first release uses Pi-backed models; Claude CLI and Antigravity CLI are
excluded. Personal resource trees are accessed directly through a laptop mount; custom dependencies are best effort.
RunWield must supply its own core capabilities.

The owner accepts broad laptop-account file access from trusted remote hosts. A notice and Agent instructions set the
intended scope. Filesystem confinement and hostile-server isolation are not first-release requirements.

## Decision and Rationale

Split execution from personal authority:

- Remote Core owns the TUI, Agent loop, and project tools. Workflow capabilities follow the same execution boundary;
  their delivery scope is defined in the [Remote SSH PRD](../prd/remote-ssh-prd.md).
- The laptop owns authenticated model requests, personal-data services, and authoritative Session bundles.
- OpenSSH supplies terminal transport and forwarding. A connection-scoped laptop service supplies model and personal
  operations; no permanent daemon or hosted Workspace dependency is required.
- Remote SSHFS mounts the laptop's full `~/.wld` at a fresh private remote path through standard OpenSSH SFTP. Personal
  settings, Agents, prompts, and Skill file edits use laptop files directly, without resource copies or synchronization.
  The remote project and its `.wld` stay on the server. Other enabled personal resource roots can be mounted explicitly.
- Session persistence does not use the personal mount. An in-memory remote Pi manager sends each entry through a
  synchronous save bridge. The laptop writes and synchronizes the evidence before it acknowledges the save. Metadata,
  compaction, and attachments use the same ownership boundary. No second saved remote transcript is created.
- Coarse Session-control operations create or begin a managed operation, checkpoint it, mark it uncertain, and list
  target-scoped history. Create/begin requests carry a client-generated admission nonce. If their reply is lost,
  cancellation names that admission, including before acquisition completes; it does not replay admission or user work.
  This lets the laptop release an acquired writer even when the remote caller never received its operation ID. Session,
  operation, and admission identifiers cross this control boundary; native activation proofs, lock handles, and laptop
  storage locators stay on the laptop.
- The laptop's native Session Writer Lock is the authority. Each managed operation acquires fresh ownership. Checkpoint
  publishes a generation and releases ownership; idle terminals hold no writer. A save failure stops dependent work,
  records uncertainty, and releases ownership. Each operation hydrates fresh laptop evidence rather than treating an
  idle remote snapshot as authoritative. Saved Agent, model, and thinking settings therefore survive concurrent
  connections; explicit selections for the new operation apply after hydration. Recovery uses durable laptop evidence,
  never automatic effect replay.
- Host identity consists of the effective hostname, user, port, and verified host key. Only an exact match reuses
  history. Certificate configurations without a stable reported key use hostname, user, and port. The canonical remote
  primary root identifies the project; execution cwd and temporary mount roots remain separate facts.
- Laptop-only history views read published transcript evidence without SSH, repair writes, or a writer lock. A connected
  remote TUI can continue the same saved Session through target-scoped control operations.
- Clipboard images use a connection-scoped authenticated byte bridge from the laptop. Ctrl+V reads the current laptop
  clipboard, not a server clipboard or a cached startup image. The save bridge persists attachment bytes on the laptop
  before transcript references are recorded. Stable `attachment:<id>` references and image markers survive reconnect
  without exposing laptop paths or temporary mount roots. Project-relative image reads still execute remotely.
- One remote Session-owned Pi MCP integration handles both origins. Project MCP processes use remote execution cwd;
  personal MCP processes use laptop home cwd with minimal inherited and configured environment. An authenticated
  connection-scoped relay forwards native MCP messages; only enabled personal names, not executable definitions, cross
  its configuration boundary. Pi retains naming, discovery, resources, results, cancellation, and reconnect ownership.
  A second laptop tool host would split that authority and is not used.
- Personal MCP home cwd is stable across launch folders, not a sandbox or a selected checkout. Memory collection
  sharing does not map files. Roots and paths remain remote metadata without translation. Disconnect stops owned
  processes and pending starts; neither failed sends nor uncertain calls are replayed. Native cancellation does not
  guarantee rollback of accepted actions. Server output remains trusted content and can contain secrets.
- Remote review servers stay with project files; SSH forwards their full origin to a laptop browser.

This extends [ADR-015](015-file-authoritative-session-bundles.md). It preserves Pi entry formats, file-authoritative
history, native locks, operation-scoped ownership, and recovery without automatic effect replay. Ordinary local Sessions
keep their formats, identifiers, directories, and behavior.

The personal mount exposes the whole laptop `~/.wld`, including files that hold credentials. Standard SFTP is not a
directory sandbox: the trusted remote client can request other files allowed by the laptop account. Normal setup does
not copy credentials or SSH keys; neither that rule nor the private mount path confines a trusted remote user.
Authenticated model requests execute on the laptop. No separate laptop shell service is part of this design.

### Alternatives

**Guarded mounted Session files:** Evaluated with stock SFTP/SSHFS and a restricted SFTP prototype. The owner set this
approach aside after the save-bridge proof. A mount still needs operation-scoped writer ownership, local settlement, and
recovery. The bridge keeps those decisions with the existing laptop store instead of coupling them to writable channel
and mount lifetimes.

**Custom restricted SFTP server:** The prototype proved lock lifetime and stale-handle rejection, but was not a complete
server. Standard SFTP remains the personal-resource transport; a new SFTP implementation is not required for Session
saves.

**Plain SSH or copied personal profile:** Excluded because it creates a second personal setup or copies credentials and
history. Direct mounted personal files avoid a second authoritative profile; they do not restrict trusted-server access.

**Local Agent with forwarded project tools:** Not selected because the product runs the terminal and Agent remotely.
**Remote-authoritative history with exit-time sync** violates local save semantics. **Timeout lock takeover** violates
single-writer guarantees.

## Implications

- SSHFS/FUSE availability and stock SFTP packaging remain personal-resource compatibility obligations, not Session
  commit evidence.
- A synchronous save can block the Agent thread until acknowledgement or a finite failure deadline. Supervision runs
  outside that thread. Save failure stops model and tool progress even when SSH itself remains healthy.
- Broad file access requires honest notices. Agent instructions and mountpoint permissions are not protection against a
  hostile server or a user who changes permissions.
- Remote file effects and laptop history cannot commit in one atomic transaction. Recovery checks saved evidence and
  never blindly repeats an uncertain model request, tool call, edit, or publication action.
- Mount paths are temporary. Durable project locators, Session IDs, and Memory bindings must not contain them.
- A custom Skill can lack a CLI or contain machine-specific paths. Read its mounted resources directly and expose real
  failures without weakening core verification.
- The architecture depends on OpenSSH and Pi behavior, but not a forked Pi persistence format or a RunWield-owned SFTP
  server. A future transport change must preserve bundle format, identity, ownership, and save-before-progress
  semantics.

The [Remote SSH Epic](../plans/remote-ssh-development.md) owns implementation and qualification work. The
[Remote SSH PRD](../prd/remote-ssh-prd.md) distinguishes delivered conversation behavior from target workflow,
review, and release capabilities.
