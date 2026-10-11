# Product Requirements Document: Remote SSH

Last updated: 2026-09-24 EDT

**Status:** Remote conversation, laptop history, image paste, and connected resume are implemented and verified on the
compiled macOS laptop/Linux `sct` pilot with matching build identity and an authenticated synthetic OpenAI-compatible
streaming provider. See [journey evidence](#conversation-journey-evidence). Remote Memory, delivery workflows, and the
production-provider/platform matrix remain target scope. **Document role:** Transient feature proposal.
[RunWield Core](runwield-core-prd.md) owns shared installation, location, connection cleanup, and Session continuity
requirements; this document keeps the remaining remote journey clear.

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

The conversation journey covers connection, normal Agent turns with core project tools and laptop Pi models, laptop
clipboard images, offline history, and connected resume. It passed the qualified `sct` pilot below. Memory, delivery
workflows, and local browser review extend this journey in the remaining child Plans.

Command forms:

```sh
wld remote sct:~/my-awesome-project
wld remote sct
wld remote sessions
```

`sct` is an SSH configuration alias or hostname. The first command opens the remote folder; the second opens the remote
user's home. `~` refers to the remote user's home, not the laptop's. A remote folder need not be a Git repository.

1. Connect with the user's existing SSH configuration and authentication.
2. Prepare compatible RunWield tools without a second personal setup.
3. Open the TUI on the server in the requested directory. Show the host and folder clearly.
4. Work with the usual Agents, models, memories, and workflows. Project operations use the server.
5. Open reviews in the laptop browser and return decisions to the same Session.
6. Disconnect to stop active work. Reconnect and use saved history to continue.

For conversation turns, `wld remote <target>` connects without selecting saved history. After the first message, the
Session appears in laptop history. Use `wld remote sessions` without SSH to read it in the normal transcript renderer,
with no composer. Its footer names the target and says to connect with `wld remote <target>`, then use `/resume`.
Connected `/resume` lists only the current target's Sessions. Local TUI, ACP, Workspace, and `/load-plan` lists omit
remote Sessions.

On a macOS laptop, Ctrl+V in the connected TUI reads the current laptop clipboard image, not a server clipboard. Image
bytes are saved in the laptop-owned Session before the transcript uses an `attachment:<id>` reference. These references
and image markers stay valid in offline history and after reconnect; they contain no temporary mount path.
Project-relative image reads still use the remote project.

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

**Scope and maturity:** Remote conversation and saved-history journeys passed the compiled macOS/Linux `sct` pilot with
an authenticated synthetic provider. Full remote delivery and provider/platform qualification remain target scope. The
[Core installation](runwield-core-prd.md#installation-and-updates),
[project context](runwield-core-prd.md#project-context-and-initialization), and
[recovery](runwield-core-prd.md#execution-validation-and-recovery) capabilities own the current subset.

**Current conversation-only behavior:** `wld remote <host>[:<directory>]` uses OpenSSH configuration, authentication,
and host verification, resolves an existing remote directory (remote home by default), and opens the normal remote TUI
there. Git is optional. The remote Linux host needs `python3`, SSHFS/FUSE for the personal mount, a writable private
cache, and an executable compatible with the preflight for the matching glibc-linked Linux x86-64 or ARM64 build. The
local machine needs OpenSSH and an explicitly built matching development bundle; see
[build steps](runwield-core-prd.md#installation-and-updates). Runtime preparation checks build/protocol identity and
checksums, reuses or repairs private cache entries, and does not run a remote personal installer or start a personal
profile. Normal runtime startup also requires executable `mnemoteca`, `cymbal`, and `ketch` helpers on the remote
`PATH`; private binary staging alone does not supply them. Connection loss and exit clean up owned processes, with
uncertain termination reported when it cannot be confirmed. The launcher starts a connection-owned stock SFTP server and
SSHFS mount of the laptop's full `~/.wld` at a fresh private remote root. A direct personal Skill file edit through this
mount changed the laptop file in both directions on the approved Linux `sct` pilot; the remote project's `.wld` remained
remote. The normal TUI accepts conversation turns with any Agent and core project tools through the laptop model
connection. Opening an empty composer creates no saved Session or writer lock. The first message starts laptop-owned
history; personal resources are not copied. Workflow execution and browser review follow in their owning child Plans.

**Current acceptance scenarios:**

- Given an SSH alias and an existing remote directory, when the matching development bundle connects, the view shows the
  canonical remote directory and warns that the active stock SFTP connection permits broad laptop-account access.
  Conversation reads, edits, and commands use the server, not a same-named laptop folder.
- Given a remote home without Git, when the user omits the directory, the TUI opens at that home. Without a submitted
  message, it creates no saved Session.
- Given a missing directory, denied SSH access, missing `python3`, unsupported host architecture, incompatible
  executable, or mismatched artifact, connection fails rather than falling back to another path or runtime. A retry can
  repair interrupted private runtime staging without overwriting a personal or package-managed installation.

**Requirement: Open the requested remote location.** Both connection forms work with SSH aliases and hostnames. Existing
SSH user, key, port, jump-host, and host-verification behavior remains effective. Paths are data, not shell commands. An
invalid or inaccessible folder fails clearly; RunWield must not silently work in another folder or create the target.

**Remaining target requirement: Prepare RunWield automatically.** A supported host does not need a prior RunWield
installation or provider login. RunWield prepares compatible required tools and reports progress. It does not overwrite
a remote user's existing profile or package-managed installation. Missing permission or unsupported platform errors
identify the real prerequisite; ordinary internal setup and repair stay automatic.

**Remaining target acceptance scenario:** Given a supported host without RunWield, when the user connects, full release
setup completes without manual profile copying. Current runtime preparation follows the
[Core installation contract](runwield-core-prd.md#installation-and-updates).

**Shared requirements:** [Installation and updates](runwield-core-prd.md#installation-and-updates),
[project context](runwield-core-prd.md#project-context-and-initialization).

### Local personal environment

**Scope and maturity:** Remote conversation uses mounted personal resources and the laptop model connection in the
normal remote TUI. The `sct` conversation pilot and earlier bidirectional personal-file proof support this boundary. The
full customization and production-provider matrices remain target qualification.

**Requirement: Use one personal environment.** Direct access to the laptop’s `~/.wld` through a private connection-owned
mount is demonstrated on `sct`, not copied or synchronized personal resources. Conversation turns use local user
settings, model selections, Agents, complete Skill trees, and prompts. Enabled personal resources outside `~/.wld` can
be mounted separately when needed. Remote project `.wld` overrides must retain normal precedence and stay on the server.
Personal file edits through the current mount change laptop files directly; there is no special resource-save step. A
reconnected Session must see current local data, not a stale remote profile.

**Requirement: Keep authenticated model execution local.** Normal remote turns route through the laptop model
connection. The compiled `sct` conversation journey used an authenticated synthetic OpenAI-compatible SSE provider on
the laptop; production-provider compatibility remains separate qualification. RunWield does not copy provider
credentials, private SSH keys, or an entire local environment to the server as setup. Supported model requests and
authentication run in the laptop runtime with the existing local sign-in. The full `~/.wld` mount includes
credential-bearing files; trusted remote hosts have broad laptop-account file access through standard SFTP. This is not
credential confinement. A selected provider must not silently change to another provider or billing method.
Compatibility failures explain the limitation before the affected turn starts.

**Requirement: Use customizations honestly.** Complete personal Skill trees and other supported resources are read
through the mount without making working copies; local paths must not accidentally select unrelated remote files.
Machine-specific scripts and MCP integrations are best effort, not a promise that every local executable works remotely.

**Current bounded proof scenarios (not ordinary remote user turns):**

- Given the approved Linux `sct` connection and a personal Skill file, when the file is changed through the mounted
  root, the laptop sees the change; a laptop edit is visible remotely. The project `.wld` stays on the server.
- Given the optional native Pi proof on the built macOS laptop and Linux `sct` runtimes with a synthetic HTTP provider,
  when the remote-only project sentinel is read by its restricted tool, two provider requests occur and the second
  includes that sentinel. Cancelling the proof closes the upstream request; two reconnects repeat the bounded path. This
  does not establish production-provider compatibility or a platform matrix. The later conversation pilot verifies
  normal Session persistence and resume.

**Conversation and customization acceptance scenarios:**

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

**Scope and maturity:** **Preserve local history** passed the compiled `sct` conversation journey with a synthetic
provider. `wld remote sessions` reads laptop history offline. Connected remote `/resume` continues only Sessions for the
current target. The [Core Session continuity](runwield-core-prd.md#session-continuity) and
[laptop-owned save contract](runwield-core-prd.md#laptop-owned-remote-session-saves) own shared history and save
behavior. The connection-wide personal mount is not a Session writer. Remote Memory is target scope in
[child05](../plans/remote-ssh-development/05-keep-memory-and-integrations-on-their-owning-machine.md); workflow context
and rollover on resume are target scope in
[child06](../plans/remote-ssh-development/06-carry-remote-context-through-delivery-workflows.md).

**Target requirement: Read and update the same local memories.** Core Memory injection, recall, additions, and deletions
use local storage and preserve project/global scope. Work Record retrieval reads the remote project's canonical records.
A successful personal-data save means the change is saved locally, not merely queued on the server until exit.

**Requirement: Keep project knowledge correctly scoped (Sessions delivered; Memory target).** Unrelated remote folders
must not share Sessions because their names match. Session identity follows the
[Core remote project locator](runwield-core-prd.md#project-context-and-initialization): exact host identity and
canonical project root, separate from the execution cwd and temporary mount paths. An ambiguous host match never merges
history; confirmation for ambiguous aliases remains target scope.

For Memory, a remote project can use an intended existing local collection without requiring a local checkout. When that
relationship cannot be established safely, ask once rather than guess; retain the choice for later connections. A new
remote-only project can have locally stored memories of its own. This must not silently remap local projects.

**Requirement: Preserve local history.** Saved remote conversation history remains on the laptop after disconnect. The
first submitted message creates the saved Session, not connection or an empty composer. Offline history uses the normal
TUI transcript renderer without a composer; one footer names the target and the reconnect command followed by `/resume`.
Reading history starts no SSH connection and takes no Session Writer Lock. Reconnect and target-scoped `/resume`
continue the same Session with its saved Agent and model. Local TUI, ACP, Workspace, and `/load-plan` lists hide remote
Sessions. Resume never repeats unfinished tool effects. Workflow context on remote resume remains target behavior in
child06.

**Conversation acceptance scenarios:**

- Given unrelated same-named folders on two servers, when both receive conversation turns, their saved Sessions remain
  distinct. A remote worktree shares its primary checkout's project identity but keeps its own execution cwd.
- Given an empty remote composer, when the user connects and exits without a message, no saved Session appears. The
  first submitted message creates laptop history before the model request starts.
- Given a saved remote conversation and an offline host, when the user runs `wld remote sessions`, history is readable
  in the normal renderer without a composer, SSH, or a writer lock. Its footer explains how to reconnect and resume.
- Given a reconnected target, when the user opens `/resume`, only exact-matching target Sessions appear. Selecting one
  continues its saved conversation without a local clone or replay of earlier tools.
- Given a saved remote Session, local TUI, ACP, Workspace, and `/load-plan` lists do not offer it as local work.
- Given loss during a Session save, RunWield does not report success without laptop evidence or overwrite newer saved
  history on reconnect. The next operation uses committed evidence and does not repeat the uncertain effect.

**Target Memory acceptance scenarios:**

- Given existing global and selected project memories, when the remote Agent recalls them, it receives the correct
  scopes. A successful store or delete is visible from local RunWield before disconnect.
- Given unrelated same-named folders on two servers, their project memories stay distinct unless the user deliberately
  selects shared project memories.

**Shared requirements:** [Project context](runwield-core-prd.md#project-context-and-initialization),
[Session continuity](runwield-core-prd.md#session-continuity), [Work Records](runwield-core-prd.md#work-records).

### Remote workflows and local review

**Scope and maturity:** Target extension in
[child06](../plans/remote-ssh-development/06-carry-remote-context-through-delivery-workflows.md) and local browser
review in [child07](../plans/remote-ssh-development/07-open-remote-reviews-in-the-local-browser.md). Existing approval
and validation meanings remain unchanged. Conversation turns and core project tools passed the `sct` pilot. Workflow
handoffs, child Sessions, write delegation, Plan review, and transcript rollover belong to the remaining workflow
extensions.

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

**Scope and maturity:** Connected-only conversation supervision and recovery passed the `sct` pilot: killing the owned
SSH transport during a turn retained saved entries, and reconnect/resume continued the same Session without replay.
Workflow recovery remains target scope. The supervisor stops its owned processes on exit or detected loss, independently
of a blocked save thread. Session-save uncertainty follows the
[Core remote-save recovery contract](runwield-core-prd.md#laptop-owned-remote-session-saves). This does not change
Workspace browser-disconnect behavior.

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
  checkout. Baseline: the conversation, image, offline-history, and connected-resume journey passed the `sct` pilot with
  an authenticated synthetic provider. The full remote workflow remains the release outcome.
- Observe first-use setup effort and successful return visits in an owner pilot. No time target or adoption threshold
  has been agreed; record friction before setting either.
- Pass the data-scope, wrong-machine, review, provider, and disconnect acceptance scenarios on each advertised supported
  combination. A successful chat alone is not evidence of a complete remote workflow.

## Delivery and Feasibility Limits

The complete release includes connected remote development workflows as well as conversation. The
[feasibility report](../research/remote-ssh-feasibility.md) found a plausible path for Pi API/OAuth providers, including
Codex through Pi and local/custom API endpoints. A 2026-09-20 throwaway proof then demonstrated the narrow Pi model path
with local authentication, remote tools, streaming, cancellation, tunnel loss, and a fresh connection. A later bounded
native Pi proof on built macOS and Linux `sct` runtimes used a synthetic HTTP provider, observed two requests with a
remote-only sentinel in the second, closed the upstream request on cancellation, and reconnected twice. The approved
`sct` pilot also verified direct bidirectional personal Skill file access through stock SFTP/SSHFS. The later
[conversation journey](#conversation-journey-evidence) verifies ordinary turns, offline history, and connected resume
under [child04](../plans/remote-ssh-development/04-run-and-resume-remote-sessions-with-local-history.md). Production
providers, Memory, workflows, and the platform matrix retain their separate qualification scope.

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
current connection mounts laptop personal files and opens the normal remote TUI for conversation turns. It can create
and continue a saved **Session** whose history belongs to the laptop. A **Remote project locator** binds that history to
an exact host identity and canonical remote project root; execution cwd and mount paths are separate facts. Memory,
workflows, child Sessions, write delegation, Plan review, and transcript rollover remain target relationships. The
compiled `sct` conversation journey passed with an authenticated synthetic provider.

## Evidence and Open Checks

### Conversation journey evidence

The matching-identity compiled macOS laptop and Linux `sct` runtimes completed the live conversation journey with an
authenticated synthetic OpenAI-compatible SSE provider on the laptop:

- Opening and leaving an empty composer produced no saved transcript.
- A remote-only sentinel reached the provider through project tools. A remote write left the distinct laptop file
  unchanged.
- Ctrl+V read the laptop's current clipboard image. Its bytes reached the laptop provider, and saved history used a
  stable attachment reference.
- `wld remote sessions` rendered the normal transcript with no composer and a reconnect footer while SSH was denied; it
  started no SSH process.
- Reconnect and `/resume` retained the same Session ID and earlier remote context.
- Killing the owned SSH transport during a turn retained saved entries. Reconnect/resume did not repeat earlier model
  requests, tool calls, or the remote write; saved evidence contained one write-tool result.

This verifies the conversation journey, not a production-provider or platform matrix. The pilot used authentic helper
installations verified on `sct` under `/usr/local/bin` for runtime preflight. Observed startup was about 35 seconds warm
and about 100 seconds on first cold use, before further performance fixes; these samples are not speed promises. Remote
Memory remains in [child05](../plans/remote-ssh-development/05-keep-memory-and-integrations-on-their-owning-machine.md),
and full delivery workflows remain in
[child06](../plans/remote-ssh-development/06-carry-remote-context-through-delivery-workflows.md).

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
