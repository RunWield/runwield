---
planId: "c6cd4307-3a82-4f5d-9ddb-fd3f9d57bd19"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cli.ts"
    - "src/cmd/registry.js"
    - "src/cmd/remote/"
    - "src/shared/foreground-process.ts"
    - "src/shared/remote/"
    - "src/ui/tui/"
    - "scripts/compile.js"
    - "scripts/write-version.js"
    - "scripts/release-assets.js"
    - "docs/domain-language.md"
    - "docs/adr/018-remote-ssh-local-personal-authority.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T02:05:47.752Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 1
dependencies: []
targetBranch: "epic/remote-ssh-development"
userVerifiedAt: null
status: "validated"
validatedCommit: "6d7ce6b66647bd720bb365bfe337f990bad23925"
---

# Establish the Remote Connection and Matched Runtime

## Context

RunWield needs a safe entry point for projects that exist only on a remote Linux host. The laptop must use normal
OpenSSH configuration and host verification, prepare an exact matching remote runtime, and retain control of every
process and channel it starts. This slice establishes that connection boundary without allowing a user turn or writable
remote Session; later children add personal capabilities and Session persistence.

The [parent Epic](../remote-ssh-development.md) supplies the agreed architecture. This child starts delivery of:

- [Remote connection and setup](../../prd/remote-ssh-prd.md#remote-connection-and-setup): **Open the requested remote
  location** and **Prepare RunWield automatically**. Folder resolution and dormant terminal startup land here; Agent
  file/tool operations remain for later children.
- [Disconnect and recovery](../../prd/remote-ssh-prd.md#disconnect-and-recovery): **Do not continue unattended** and
  **Preserve work and report uncertainty**, limited here to connection-owned processes and setup resources.
- Core [installation](../../prd/runwield-core-prd.md#installation-and-updates),
  [project context](../../prd/runwield-core-prd.md#project-context-and-initialization), and
  [recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): proposed remote setup/location additions
  preserve **Install required local runtime pieces without hiding package ownership**, **RunWield repairs its own
  machinery automatically**, and **Ask only for an outcome-level decision or a genuine external prerequisite**.

No existing requirement is removed. Ordinary local terminal user interface (TUI), Agent Client Protocol (ACP), and
Workspace startup remain unchanged. Child 08 owns full helper packaging and release qualification; this child must not
advertise a complete remote development feature.

## Objective

Make `wld remote host[:path]` resolve and prepare the intended remote location, start a connection-scoped remote
Core/TUI in a dormant state, and clean up owned resources safely. Establish the remote runtime and authenticated control
contract that later children extend.

## Approach

Use OpenSSH as the connection authority. Resolve paths remotely and prepare an exact matching runtime in private,
versioned storage. Keep the connection supervisor in a separate process from the remote TUI.

```text
laptop: wld remote target
  OpenSSH configuration, authentication and host verification
  fixed bootstrap + separately encoded target data
  verified runtime transfer and atomic preparation
  authenticated connection control and health checks
remote: supervisor
  canonical directory and platform result
  connection-only TUI using existing terminal components
```

**Dormant means no chat startup.** `startInteractiveSession()` already delays writer admission, but still reads personal
settings, constructs model state, and can offer onboarding. Use `RunWieldTui`/`initTUI` with an embedded theme and a
small connection view instead. Show the host, canonical directory, trust notice, readiness limit, and exit controls. Do
not install the ordinary chat input controller or create a saved Session. Later children add capability-backed Session
activation; this child rejects all user turns.

**Development builds are prepared explicitly.** The owner chose a build step before connection, not automatic
compilation during connection. Extend existing compile/version machinery with a machine-readable build identity and
checksummed artifact metadata. A short Git hash or `dev` string alone is not sufficient. The launcher selects a matching
local Linux artifact and transfers it; if none exists, it reports the exact build command. Released launchers select
only their exact release asset and verify it. Child 08 qualifies the complete helper bundle and supported matrix.

**Loss timing is agreed:** health checks every 5 seconds, loss after three missed replies, immediate start of shutdown,
and a 5-second graceful period before forced termination. A blocked TUI cannot block monitoring. These deadlines do not
prove termination and never authorize Session Writer Lock takeover. Storage-request monitoring belongs to later
children.

Keep the named control operations small: authenticated handshake, readiness, health, and shutdown. The laptop hosts the
connection-scoped service that child 02 extends; no model, Memory, settings, shell, or Session-write operation is
exposed here. Use private SSH pipes or authenticated loopback forwarding. Carry the fresh credential in a private
channel, not in command arguments, URLs, or files. Terminal input remains separate from bootstrap/control data.

Do not run the ordinary installer remotely; it can change profiles and install personal state. Reusing normal chat
startup would be smaller in lines of code, but would violate the no-personal-setup boundary.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cli.ts`, `src/cmd/registry.js`, and a focused remote-command module — parse and dispatch the two remote command
  forms without shell interpolation.
- `src/shared/remote/` (new) and `src/shared/foreground-process.ts` — own connection control, runtime preparation,
  supervision, and cleanup. Existing foreground helpers have forceful process-group cleanup but no independent monitor,
  interactive terminal transport, or graceful deadline. Preserve their existing callers' cancellation behavior.
- `src/ui/tui/` — compose the dormant connection view from existing terminal components without chat, settings, model,
  onboarding, or persistence startup. Do not redesign ordinary chat.
- `scripts/compile.js`, `scripts/write-version.js`, `scripts/release-assets.js`, and generated build metadata — bind
  launcher and remote artifacts to the same build inputs/protocol and verify transferred bytes. Reuse current GNU/Linux
  target names and checksum conventions; do not introduce another release/version authority.
- CLI/help, connection/process, compile/asset, and TUI tests — prove wrong-machine prevention, startup isolation,
  matching-runtime selection, and independent cleanup through real process boundaries.
- `docs/domain-language.md` — define **Remote SSH connection** and update the stable Core, Session, and Project Runtime
  State relationships made true by this slice.
- `docs/adr/018-remote-ssh-local-personal-authority.md` and the owning PRDs — record the implemented connection boundary
  while later capabilities remain target behavior.

## Reuse Opportunities

- `src/shared/foreground-process.ts:spawnForegroundProcess` — reuse explicit process-group ownership for compatible
  subprocesses, not broad process-name cleanup. Its `done` result waits for the direct child, not every descendant.
- `src/ui/tui/tui.ts`, `tui-manager.ts`, and `tui-crash-guards.ts` — reuse rendering, terminal restoration, and crash
  cleanup. Avoid `chat-session.ts` and `chat-input-controller.ts` startup side effects.
- `src/cli.ts` and `src/cmd/registry.js` — reuse normal command dispatch and help behavior.
- OpenSSH — reuse user configuration, keys, jump hosts, host verification, terminal allocation, and forwarding.
- Existing compile/version metadata — reuse RunWield build identity instead of inventing a second version source.

## Implementation Steps

1. `src/cli.ts`, `src/cmd/registry.js`, and `src/cmd/remote/index.ts` dispatch `wld remote host[:path]` as a CLI-only
   command with normal help. Neither target form falls through to Router, local project initialization, model setup, or
   Session storage. Private runtime/supervisor entry points dispatch before registry imports and personal startup;
   helper/browser initialization and fatal cleanup respect that classification. Existing CLI/ACP/Workspace defaults
   remain unchanged.
2. The connection code passes the destination literally to OpenSSH without accepting target text as SSH options. Remote
   command execution uses a fixed bootstrap with separately encoded data; a local argument array alone is not sufficient
   because SSH runs remote command text through a shell. Remote resolution handles home/default-home, relative and
   absolute paths, symlinks, access checks, and Git primary-checkout/worktree facts. Missing or inaccessible targets
   fail without creating them or falling back. Report canonical remote cwd separately from connection recipe and
   project-root evidence; never apply laptop path APIs to remote locators or create durable host/Session mappings in
   this child.
3. Compile output includes machine-readable build/protocol identity and per-target checksums for the launcher and Linux
   runtime. Common identity covers effective source/resources, dependency lock/configuration, and compiler
   version/options; target triple and artifact checksum are separate target-specific fields, so matching macOS and Linux
   builds can agree. Dirty builds with the same Git commit cannot compare equal when their included inputs differ.
   Exclude generated identity/output files to avoid a circular fingerprint. Generate both artifacts from unchanged
   common inputs and fail if those inputs change during preparation. Retain the existing human-readable `VERSION`.
   Document the explicit build and artifact-discovery procedure, using existing `--target`/`--output` support where
   possible. Missing development artifacts never trigger compilation or a released-build fallback during connection.
4. Runtime preparation maps Linux x86-64 and ARM64 to the existing GNU target triples, verifies artifact checksum and
   embedded identity/protocol, and executes a private preflight before declaring readiness. Reject unsupported OS/CPU,
   incompatible runtime libraries, corrupt assets, or missing prerequisites with the actual cause. Use private
   user-writable versioned cache storage, not remote PATH `wld`, a personal profile, or a package-owned install. Staging
   plus atomic promotion prevents partial use; concurrent preparations cannot replace a good cache with partial bytes. A
   subsequent attempt repairs interrupted staging automatically and revalidates reusable artifacts.
5. The laptop connection service and remote supervisor accept only the current authenticated connection. Handshake
   validates build/protocol identity before readiness. Fresh unpredictable credentials travel in private SSH channels;
   no normal output, diagnostic, process argument, URL, or persisted remote file contains them. Any listener binds
   loopback only; missing, wrong, expired, and prior-connection credentials fail without affecting a valid connection.
   Child 01 exposes only handshake/readiness/health/shutdown, not a general command executor or personal-data service.
6. Separate supervision remains responsive while the TUI is blocked. It monitors both control health and terminal
   closure, detects launcher death without a final stop request, and owns the SSH channels, remote TUI, and helper
   process groups it starts. Checks run every 5 seconds; three missed replies start shutdown. Graceful termination gets
   5 seconds before forced termination. Normal exit, Ctrl-C, setup failure, control loss, and terminal loss all revoke
   admission and stop owned work. Cleanup confirms actual exits where possible and reports uncertainty otherwise;
   unrelated processes survive. Reconnect uses fresh credentials and ownership records; stale PID numbers or timeouts
   are not permission to kill another process or take a lock.
7. A real remote `RunWieldTui` view shows host, canonical cwd, connection status, the current no-turn limitation, and
   exit controls. It explains that later Session access uses standard OpenSSH SFTP with broad laptop-account file
   access, not a sandbox, and clearly states that no such access is open in this slice. Text, pasted input, slash
   commands, shell shortcuts, attachments, and onboarding cannot start a turn or mutate personal state. Use an embedded
   theme and no ordinary chat input controller. There is no Agent, provider request, saved Session, writer lock, SFTP
   process, SSHFS mount, personal resource copy, or remote personal-profile initialization.
8. Failure and exit remove only owned temporary connection resources. Preserve existing profiles, package installs,
   project files, and verified runtime caches. Interrupted setup is recoverable on the next connection; it does not
   require the user to delete RunWield metadata. No Session-lock or storage behavior is changed in this child.
9. `docs/domain-language.md` defines **Remote SSH connection**, its avoided aliases, and the implemented remote
   execution relationship with Core/TUI and Project Runtime State. State that a connection does not create a new Session
   type; saved Session relationships remain target behavior until later children deliver them.
10. ADR-018 references distinguish the parent-selected architecture from delivered capability. Preserve its proposed
    status in this child; acceptance of the full decision is assigned to child 08. Update the linked Core capability
    requirements/scenarios and Remote SSH proposal with the tested connection subset, exact prerequisites, and remaining
    targets. Do not retire the transient PRD or mark model, mounted storage, persistence, workflows, reviews, or
    complete remote support delivered.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

Use only `deno run -A scripts/run-tests.js` or `deno task test`; never direct `deno test`. Tests use sandboxed homes and
real temporary directories/Git fixtures. External SSH/network/process/clock boundaries may be controlled; do not replace
owned preparation, authentication, or cleanup with injected success results.

- **Commands:** generate existing source-run version metadata with `deno run -A scripts/write-version.js`. Run new tests
  with `deno run -A scripts/run-tests.js src/cmd/remote/ src/shared/remote/`. Include connection-view tests there or add
  their exact paths to this command. Run preserved boundary tests with
  `deno run -A scripts/run-tests.js src/cmd/__tests__/registry.test.ts src/cmd/help/index.test.ts src/cli-context-files.test.ts src/shared/foreground-process.test.ts src/shared/agent-browser-session.test.ts src/shared/package-install.test.ts scripts/compile.test.js scripts/write-version.test.js scripts/release-assets.test.js src/ui/tui/chat-session.test.ts src/ui/tui/tui-manager.test.ts src/ui/tui/tui-crash-guards.test.js`.
  Run `deno task doc-links:check` and `deno task seams:check`. Workflow Validation runs full CI separately.
- **Target and dispatch tests:** exercise the actual CLI with an isolated SSH executable fixture, then the production
  bootstrap through a real shell and temporary filesystem. Cover both command forms, remote home, relative paths,
  spaces, quotes, `$()`, semicolons, symlinks, Git worktrees, non-Git folders, denied access, missing folders, and
  option-like destinations. Sentinel commands must not execute. Assert exact decoded target and remote cwd, not only
  argument strings. A same-named laptop project remains unread/uninitialized as project context and unchanged. SSH
  configuration, authentication, and host verification are not bypassed by generated flags.
- **Runtime preparation tests:** use real artifact bytes, checksums, cache directories, and the production selector.
  Cover both GNU target triples, absent artifacts, wrong architecture/build/protocol, corrupted content, interrupted
  staging, concurrent attempts, successful retry, and cache reuse. Two source snapshots with the same Git commit and
  different included content must have different identities. A matching but non-executable runtime fails preflight. No
  partial artifact becomes runnable. These tests fail for PATH fallback or a version-string-only comparison.
- **Control tests:** connect to the actual service and verify valid handshake/readiness/health/shutdown plus refusal of
  wrong, absent, old, or mismatched credentials/protocol. Inspect listener addresses, captured logs/errors, child
  arguments, and on-disk connection files for credential leakage. An unauthorized shutdown must not terminate the valid
  connection. Closing a connection invalidates its credential.
- **Dormant TUI tests:** start the private runtime under a pseudo-terminal with sentinel remote settings, credentials,
  skills, and project files. Exercise text, paste, slash, shell, attachment, and exit input paths. Observe the real
  view's host/cwd and no-turn message; assert no Agent/provider activity, settings migration, personal storage,
  transcript, mount, onboarding, or project mutation. Include a normal empty home, not just fixtures where writes would
  fail. Merely hiding the input box is not sufficient.
- **Independent cleanup tests:** run real supervisors, a child plus grandchild, and an unrelated sentinel process.
  Freeze the TUI process, kill the launcher, close terminal/control channels independently, and suppress health replies
  without closing transport. Confirm detection after three scheduled misses, graceful then forced termination, fresh
  reconnect, and survival of the unrelated process. Observe actual process exits; do not equate a sent signal or direct
  child's `done` result with complete cleanup. Preserve foreground-process pre-abort, descendant cleanup, forceful
  cancellation, and one-settlement tests; no existing local behavior is intentionally removed.
- **Live connection flow:** build the launcher and matching GNU/Linux artifacts with the documented explicit procedure.
  On a clean supported Linux x64 host run `wld remote <alias>:<existing-folder>` and `wld remote <alias>` over real
  OpenSSH. Repeat on ARM64 where available and record any untested matrix row. Compare displayed cwd with an independent
  remote `pwd -P`; verify symlink/worktree and home-without-Git cases. Inspect remote process executable/build identity,
  screen, and profile snapshots. Exit via the shown control and Ctrl-C. An unchanged laptop sentinel and no remote
  personal profile are required. At least one actual built Linux-runtime flow is required, not a fake SSH response.
- **Live failures:** against disposable fixtures, test changed host keys, denied SSH access, missing directory,
  unsupported platform, missing/mismatched artifact, interrupted transfer, transport kill, launcher death, and a blocked
  control network path while the remote TUI is stopped. Measure detection and termination from last successful health
  reply; confirm no stale connection survives as usable and unrelated processes remain. A killed tunnel alone does not
  prove silent-loss detection. Never change the user's real host-key records for this test. Record unavailable
  host/network-test prerequisites as missing evidence rather than a pass.
- **Semantic Review:** trace production `wld remote` through real transfer, embedded handshake, remote process startup,
  and independent supervision. An echo-only screen, simulated preparation, always-rejecting connector, or control loop
  running in the TUI must fail acceptance. Check that PRDs/glossary name only the delivered subset and that no full
  Session, FUSE, provider, or release-matrix claim is inferred from this slice.

## Edge Cases & Considerations

- An SSH alias can change without changing host identity; keep the connection recipe distinct from durable host
  evidence.
- Remote macOS, Windows, unsupported libc/kernel combinations, and 32-bit ARM must fail clearly rather than select a
  nearby artifact.
- A blocked remote process can exceed a termination deadline. Stop dependent work, but do not claim an unconfirmed
  process has ended.
- This slice must not expose a partially functional remote user turn before local model and Session authority exist.
- Standard GNU/Linux is the build target, not a promise for every libc/kernel. Record the actual executable baseline;
  FUSE/SSHFS prerequisites and complete helper packaging belong to children 03/08, not dormant connection startup.
- OpenSSH can honor user `ProxyJump`, keys, ports, and prompts without RunWield copying them. Do not disable host
  checks, require passwordless access, or force noninteractive authentication merely to simplify tests.
- Terminal closure and control-channel health are distinct. A healthy control channel cannot keep a closed TUI alive;
  terminal input cannot be consumed as a control message.
- The child changes no native Session Writer Lock path and creates no durable remote project identity. Later children
  own identity reconciliation, personal capabilities, and writable activation.
- Execution owner: engineer. Autonomous implementation is suitable; record missing live-host prerequisites explicitly
  and ask only when an external prerequisite or a change to the approved boundary requires owner input.
