# Product Requirements Document: Remote SSH

Last updated: 2026-09-24 EDT

**Status:** Proposed full remote experience. A connection-only development subset prepares a matched remote runtime,
mounts the laptop's full `~/.wld` through stock SFTP/SSHFS on the approved Linux `sct` pilot, and opens a dormant remote
TUI. An optional bounded native Pi bridge proof is available; neither path enables ordinary user turns or saved
Sessions. **Document role:** Transient feature proposal. [RunWield Core](runwield-core-prd.md) owns the delivered
installation, location, and connection cleanup requirements; this document keeps the remaining target behavior clear.

## Background

Developers work on servers that already contain their code and development tools. They should be able to open RunWield
there without a second personal setup. The requested experience is connected remote development, like VS Code Remote
SSH—not an unattended worker.

## Problem and Value

Today, running `wld` on another machine uses that machine's settings, credentials, memories, and Session storage. Users
must recreate their environment, and personal data can diverge. Copying the local profile also copies sensitive and
machine-specific state.

The goal is one command to work on remote files with the user's existing RunWield environment. The local machine keeps
personal data; the server keeps project files. This removes setup friction for developers whose projects do not run on
their laptop. Demand beyond the owner's stated use case has not been measured.

## Audience and Scope

**Primary audience:** An individual developer with working SSH access to a trusted development server and an existing
local RunWield setup.

**Included:** Remote TUI, remote folders or home, automatic RunWield setup, local personal data, remote project tools,
local browser reviews, connected-only execution, and saved Session resume.

**Not included:** Unattended execution, source-code synchronization, a required local checkout, multi-user
collaboration, hosted Workspace registration, remote ACP clients, migration of an existing local Session to another
checkout, or automatic installation of every project dependency. Hostile-server isolation is not promised.

## Product Fit and Main Journey

The following is the **target** journey, not a current workflow. Only the connection-only part of steps 1–3 is
available; the view does not accept a user request or start the normal TUI conversation.

Command forms (currently connection-only; full workflow proposed):

```sh
wld remote sct:~/my-awesome-project
wld remote sct
```

`sct` is an SSH configuration alias or hostname. The first command opens the remote folder; the second opens the remote
user's home. `~` refers to the remote user's home, not the laptop's. A remote folder need not be a Git repository.

1. Connect with the user's existing SSH configuration and authentication.
2. Prepare compatible RunWield tools without a second personal setup.
3. Open the TUI on the server in the requested directory. Show the host and folder clearly.
4. Work with the usual Agents, models, memories, and workflows. Project operations use the server.
5. Open reviews in the laptop browser and return decisions to the same Session.
6. Disconnect to stop active work. Reconnect and use saved history to continue.

The TUI runs remotely. This does not require model calls, credentials, or personal storage to run remotely too; their
placement is an architecture question constrained by the ownership below.

| Data or activity                                                                                             | Product ownership                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Personal settings, model configuration, credentials, Agents, skills, and prompt templates                    | Local machine                        |
| Personal project/global memories and Session history, including Session attachments                          | Local machine                        |
| Project files, project settings/instructions, Plans, Work Records, Git, worktrees, and Project Runtime State | Remote project/environment           |
| Project reads, edits, shell commands, code search, builds, and tests                                         | Remote environment                   |
| Human review interaction                                                                                     | Local browser, acting on remote work |

“Everything stays local” applies to personal data, not remote source files or project artifacts. Reading remote source
into a prompt or review does not constitute a synchronized checkout. Installed tools and project-owned state can remain
on the server after exit; a separate saved personal profile must not remain.

## Capability Requirements

### Remote connection and setup

**Scope and maturity:** Connection-only subset available with explicit development artifacts and a tested personal mount
on the approved Linux `sct` pilot. Ordinary Agent access and full remote setup remain proposed. The
[Core installation](runwield-core-prd.md#installation-and-updates),
[project context](runwield-core-prd.md#project-context-and-initialization), and
[recovery](runwield-core-prd.md#execution-validation-and-recovery) capabilities own the current subset.

**Current connection-only behavior:** `wld remote <host>[:<directory>]` uses OpenSSH configuration, authentication, and
host verification, resolves an existing remote directory (remote home by default), and shows its canonical location in a
dormant remote TUI. Git is optional. The remote Linux host needs `python3`, SSHFS/FUSE for the personal mount, a
writable private cache, and an executable compatible with the preflight for the matching glibc-linked Linux x86-64 or
ARM64 build. The local machine needs OpenSSH and an explicitly built matching development bundle; see
[build steps](../contributing.md#remote-development-bundle). Runtime preparation checks build/protocol identity and
checksums, reuses or repairs private cache entries, and does not run a remote personal installer or start a personal
profile. Connection loss and exit clean up owned processes, with uncertain termination reported when it cannot be
confirmed. The launcher starts a connection-owned stock SFTP server and SSHFS mount of the laptop's full `~/.wld` at a
fresh private remote root before showing the connection-only view on the approved Linux `sct` pilot. A direct personal
Skill file edit through this mount changed the laptop file in both directions; the remote project's `.wld` remained
remote. The normal view starts no user Agent turn, provider request, saved Session, or writer lock, and makes no
personal resource copy. An optional, bounded native Pi bridge proof is separate from the normal view. No ordinary
project execution or browser review is available through it. This is not a production remote release.

**Current acceptance scenarios:**

- Given an SSH alias and an existing remote directory, when the matching development bundle connects, the view shows the
  canonical remote directory and warns that the active stock SFTP connection permits broad laptop-account access. It
  does not accept ordinary Agent turns or edit project files through them.
- Given a remote home without Git, when the user omits the directory, the connection view opens at that home without
  creating a project or a saved Session.
- Given a missing directory, denied SSH access, missing `python3`, unsupported host architecture, incompatible
  executable, or mismatched artifact, connection fails rather than falling back to another path or runtime. A retry can
  repair interrupted private runtime staging without overwriting a personal or package-managed installation.

**Remaining target requirement: Open the requested remote location.** Both command forms work with SSH aliases and
hostnames. Existing SSH user, key, port, jump-host, and host-verification behavior remains effective. Paths are data,
not shell commands. An invalid or inaccessible folder fails clearly; RunWield must not silently work in another folder
or create the target.

**Remaining target requirement: Prepare RunWield automatically.** A supported host does not need a prior RunWield
installation or provider login. RunWield prepares compatible required tools and reports progress. It does not overwrite
a remote user's existing profile or package-managed installation. Missing permission or unsupported platform errors
identify the real prerequisite; ordinary internal setup and repair stay automatic.

**Target acceptance scenarios (not yet delivered):**

- Given a valid alias and existing remote folder, when the folder command runs, the full TUI opens there. Reading a file
  and executing a command use that folder on the server, even when the laptop has a same-named folder with different
  files.
- Given no folder argument, when the host command runs, the TUI opens in the remote user's home without requiring Git.
- Given a supported host without RunWield, when the user connects, setup completes without manual profile copying.
- Given a bad host key, denied access, or missing folder, connection fails without bypassing SSH checks or starting work
  in a fallback folder.

**Shared requirements:** [Installation and updates](runwield-core-prd.md#installation-and-updates),
[project context](runwield-core-prd.md#project-context-and-initialization).

### Local personal environment

**Scope and maturity:** The connection-owned personal mount and a bounded native Pi bridge proof exist on the approved
Linux `sct` pilot. Ordinary remote Sessions, model turns, and the full customization journey remain target behavior; no
separate remote personal profile is started.

**Requirement: Use one personal environment.** Direct access to the laptop’s `~/.wld` through a private connection-owned
mount is demonstrated on `sct`, not copied or synchronized personal resources. In the target ordinary remote Session,
local user settings, model selections, Agents, complete Skill trees, and prompts apply. Enabled personal resources
outside `~/.wld` can be mounted separately when needed. Remote project `.wld` overrides must retain normal precedence
and stay on the server. Personal file edits through the current mount change laptop files directly; there is no special
resource-save step. The target ordinary Session must see current local data on reconnect, not a stale remote profile.

**Requirement: Keep authenticated model execution local.** The bounded native Pi proof routes a synthetic HTTP provider
request from a remote in-memory Agent Session through the laptop bridge; this is not an authenticated production
provider or an ordinary user turn. RunWield does not copy provider credentials, private SSH keys, or an entire local
environment to the server as setup. Supported model requests and authentication run in the laptop runtime with the
existing local sign-in. The full `~/.wld` mount includes credential-bearing files; trusted remote hosts have broad
laptop-account file access through standard SFTP. This is not credential confinement. A selected provider must not
silently change to another provider or billing method. Compatibility failures explain the limitation before the affected
turn starts.

**Requirement: Use customizations honestly.** Complete personal Skill trees and other supported resources are read
through the mount without making working copies; local paths must not accidentally select unrelated remote files.
Machine-specific scripts and MCP integrations are best effort, not a promise that every local executable works remotely.

**Current bounded proof scenarios (not ordinary remote user turns):**

- Given the approved Linux `sct` connection and a personal Skill file, when the file is changed through the mounted
  root, the laptop sees the change; a laptop edit is visible remotely. The project `.wld` stays on the server.
- Given the optional native Pi proof on the built macOS laptop and Linux `sct` runtimes with a synthetic HTTP provider,
  when the remote-only project sentinel is read by its restricted tool, two provider requests occur and the second
  includes that sentinel. Cancelling the proof closes the upstream request; two reconnects repeat the bounded path. This
  does not verify real provider authentication, normal Session persistence, workflows, or a platform matrix.

**Target acceptance scenarios (not yet delivered as an ordinary remote Session):**

- Given a local Agent/model preset and a remote project override, when the Session starts, the effective settings match
  normal precedence without overwriting either machine's personal profile.
- Given a personal Agent, prompt, Skill file, or setting changed through the remote TUI, when the user later opens local
  RunWield, the file change or completed settings save is present on the laptop without copy-back or resource sync. A
  project `.wld` change instead remains with the remote project.
- Given a supported provider authenticated only on the laptop, when it performs a remote edit, no second provider login
  or setup credential copy is required. OAuth renewal, where used, updates local credentials. The trusted remote host
  can access laptop-account files through standard SFTP; the mount is not a credential sandbox.
- Given an incompatible provider or path-dependent integration, when it is needed, RunWield reports the specific limit
  instead of silently substituting a model, omitting required tools, or operating on laptop files.

**Shared requirements:** [Customization](runwield-core-prd.md#agent-and-skill-customization),
[models and providers](runwield-core-prd.md#models-and-providers).

### Local memories and saved Sessions

**Scope and maturity:** Proposed extension of project context and Session continuity. The connection-only view creates
no saved Session or writer lock. The existing connection-wide personal SFTP/SSHFS mount is not a Session writer: managed
transcript writes require separate guarded operation-scoped access.

**Requirement: Read and update the same local memories.** Core Memory injection, recall, additions, and deletions use
local storage and preserve project/global scope. Work Record retrieval reads the remote project's canonical records. A
successful personal-data save means the change is saved locally, not merely queued on the server until exit.

**Requirement: Keep project knowledge correctly scoped.** Unrelated remote folders must not share memories or Sessions
because their directory names match. A remote project can use an intended existing local Memory collection without
requiring a local checkout. When that relationship cannot be established safely, ask once rather than guess; retain the
choice for later connections. A new remote-only project can have locally stored memories of its own. This must not
silently remap existing local projects.

**Requirement: Preserve local history.** Saved remote Session history remains available locally after disconnect.
Reconnecting to the same remote project lets the user resume that Session with its saved Agent, model, and workflow
context. History identifies the remote target. Resume does not recreate unfinished tool effects automatically.

**Acceptance scenarios:**

- Given existing global and selected project memories, when the remote Agent recalls them, it receives the correct
  scopes. A successful store or delete is visible from local RunWield before disconnect.
- Given unrelated same-named folders on two servers, when both are used, their Session history and project memories
  remain distinct unless the user deliberately selects shared project memories.
- Given a saved remote conversation, when SSH closes, the local history remains readable. Reconnect permits continuation
  without restarting the conversation or requiring a local clone.
- Given loss during a personal-data save, RunWield does not report success without local evidence or overwrite newer
  local data on reconnect.

**Shared requirements:** [Project context](runwield-core-prd.md#project-context-and-initialization),
[Session continuity](runwield-core-prd.md#session-continuity), [Work Records](runwield-core-prd.md#work-records).

### Remote workflows and local review

**Scope and maturity:** Proposed extension; existing approval and validation meanings remain unchanged. The current
connection does not allow user turns, project tools, workflow actions, or browser reviews.

**Requirement: Complete normal Core work remotely.** Reading and editing, Git, code search, planning, isolated
execution, validation, repair, and publication use the remote project and its environment. This is not a shell-only
shortcut while other tools operate on the laptop. Existing permissions and external prerequisites still apply;
connecting does not silently grant access to local Git credentials.

**Requirement: Review remote work locally.** Plan and Code Review open in the user's local browser, show the actual
remote artifacts, and apply decisions to the correct live Session. Users need not configure tunnels or expose a public
review server. Closing only the browser does not end the SSH Session.

**Acceptance scenarios:**

- Given a project available only remotely, when the user takes a change through planning, review, execution, validation,
  and publication, all project effects and validation commands occur remotely and the local Session records the results.
- Given Plan or Code Review, when it opens, the laptop browser displays the remote content. Approval or feedback reaches
  the same Session. Closing and reopening the browser while SSH remains connected does not cancel the wait.
- Given remote home without Git or a project with missing build dependencies, RunWield retains the ordinary supported
  non-Git behavior or reports the relevant prerequisite; it does not invent a repository or validate on the laptop.

**Shared requirements:** [Plan review](runwield-core-prd.md#plan-review),
[execution, validation, and recovery](runwield-core-prd.md#execution-validation-and-recovery),
[work protection](runwield-core-prd.md#work-protection).

### Disconnect and recovery

**Scope and maturity:** Proposed connected-only Agent and workflow behavior. The current connection-only supervisor
stops its own view on exit or detected loss; there is no remote Agent or Session work to stop or recover. This does not
change Workspace browser-disconnect behavior.

**Requirement: Do not continue unattended.** Normal exit ends the remote TUI and stops active RunWield-owned work.
Unexpected connection loss stops new work and cancels active owned processes when loss is detected, including when the
laptop cannot send a final stop request. No detached Agent continues or restarts automatically. Unrelated server
processes must not be stopped.

**Requirement: Preserve work and report uncertainty.** Disconnect is neither workflow completion nor deliberate
abandonment. Remote edits and project artifacts remain. Local saved history remains. Unreceived output is not claimed as
saved; uncertain remote effects are checked on reconnect before further work or retry.

Instant network-loss detection, rollback of completed effects, and cancellation of an external action already accepted
by another service are not promised. Detection and process-cleanup behavior must be demonstrated before release; a
best-effort stop request alone does not meet connected-only operation.

**Acceptance scenarios:**

- Given an active Agent and a long-running owned subprocess, when the user exits normally, both stop and saved work
  remains. No background Agent continues after the TUI closes.
- Given abrupt laptop or network loss, when the server detects loss, owned work stops without requiring a final client
  message. Unrelated processes remain running.
- Given a remote edit or publication attempt whose result was not saved locally before loss, when the user reconnects,
  RunWield checks available evidence and reports the actual or uncertain result without repeating the action blindly.
- Given completed personal-data saves and remote edits, when the user reconnects, those saves and edits remain. No
  separate remote personal profile must be merged back manually.

**Shared requirements:** [Recovery](runwield-core-prd.md#execution-validation-and-recovery),
[Session continuity](runwield-core-prd.md#session-continuity).

## Success Measures

- Complete the remote-only project journey above without manual profile copying, a second provider login, or a local
  checkout. Baseline: the connection-only view and bounded personal-mount/model proofs exist, but an ordinary remote
  Session and full workflow do not.
- Observe first-use setup effort and successful return visits in an owner pilot. No time target or adoption threshold
  has been agreed; record friction before setting either.
- Pass the data-scope, wrong-machine, review, provider, and disconnect acceptance scenarios on each advertised supported
  combination. A successful chat alone is not evidence of a complete remote workflow.

## Delivery and Feasibility Limits

The connection-only subset is not the complete remote release. The smallest useful release is a complete connected
remote development journey, not just a remote prompt. The [feasibility report](../research/remote-ssh-feasibility.md)
found a plausible path for Pi API/OAuth providers, including Codex through Pi and local/custom API endpoints. A
2026-09-20 throwaway proof then demonstrated the narrow Pi model path with local authentication, remote tools,
streaming, cancellation, tunnel loss, and a fresh connection. A later bounded native Pi proof on built macOS and Linux
`sct` runtimes used a synthetic HTTP provider, observed two requests with a remote-only sentinel in the second, closed
the upstream request on cancellation, and reconnected twice. The approved `sct` pilot also verified direct bidirectional
personal Skill file access through stock SFTP/SSHFS. Neither proof establishes ordinary remote turns, saved Sessions,
production provider compatibility, workflow support, or a release matrix.

The owner has deferred Claude CLI and Antigravity CLI from the first release. Their existing native tools and local
sign-in remain coupled to one machine, so do not advertise them without a later proof. Copying credentials or silently
selecting another provider is not an acceptable workaround. Pi-backed providers are the initial compatibility scope.

The connection-only GNU/Linux x86-64 flow was exercised over OpenSSH on Linux 6.11.9 (Fedora 39, glibc 2.38), including
remote home without Git, an existing folder, a symlink to a Git worktree, Ctrl-C, and owned-process loss. The ARM64
runtime, older libc/kernel baselines, a disposable blocked-control network, and the release matrix remain unqualified.
Ordinary application build prerequisites remain the user's project environment, not automatic RunWield installation
scope.

The [Remote SSH Epic](../plans/remote-ssh-development.md) tracks the remaining integration and release boundaries. After
full delivery, fold lasting requirements into [RunWield Core](runwield-core-prd.md), retain unresolved scope explicitly,
fix references, and remove this transient proposal under project policy.

## Risks and Mitigations

- **Credential privacy mistaken for server isolation:** A trusted remote host can access the mounted full `~/.wld`,
  including credential files, and other laptop-account files through standard SFTP. Local authenticated model execution
  is not a credential-access boundary. Give an honest broad-access notice; do not claim confinement or forensic erasure.
- **False remote support:** CLI tools or local skill paths can operate on the wrong machine. Verify remote-only files
  and distinct local files, not just mocked tool calls. Personal resource edits must reach laptop files directly.
- **Silent data divergence:** Exit-only synchronization can lose memories or settings. Require local save confirmation
  during work and preserve existing local data on failure.
- **False disconnect success:** Ending the TUI can leave children running. Verify normal exit and loss without client
  cleanup. Preserve evidence when external effects cannot be confirmed.

## Domain Language and Proposed Relationships

**Remote SSH connection** is now defined in the [domain glossary](../domain-language.md#product-and-runtime). The
current connection mounts laptop personal files and displays a dormant remote TUI but does not contain or resume a saved
**Session**. The optional native Pi proof is bounded, not a product turn. Full remote project execution, ordinary local
model execution, and locally saved Session history remain target relationships.

## Evidence and Open Checks

The owner requested the two commands above, existing remote files with no local checkout, local personal data, and no
unattended work. [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) is the setup and interaction
reference, not proof of identical storage or shutdown behavior.

The [research report](../research/remote-ssh-feasibility.md) records source findings, official documentation, and
evidence limits. Before committing delivery scope, planning must resolve:

- Future Claude CLI and Antigravity CLI compatibility without remote credentials or a local checkout; this does not
  block the Pi-backed first release.
- Supported host builds and demonstrated connection-loss cleanup.
- Correct project Memory selection across all entry points, including Core injection and `/sleep`.

These are technical evidence gaps, not a need to repeat the product interview. If a gap requires a narrower product,
bring that specific scope decision back to the owner.
