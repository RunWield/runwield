---
planId: "a987b089-d345-4a3e-a882-905d86620a43"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/models/model-registry.ts"
    - "src/shared/session/session.js"
    - "src/shared/session/agents.js"
    - "src/shared/session/agent-assets.js"
    - "src/shared/session/named-invocation.ts"
    - "src/shared/settings.js"
    - "src/shared/session/execution-backend.ts"
    - "src/shared/session/skill-catalog.ts"
    - "src/shared/remote/"
    - "src/tools/see-image.ts"
    - "docs/domain-language.md"
    - "docs/adr/018-remote-ssh-local-personal-authority.md"
    - "docs/plans/remote-ssh-development/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T02:05:48.458Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 2
dependencies:
    - "01-establish-the-remote-connection-and-matched-runtime"
targetBranch: "epic/remote-ssh-development"
userVerifiedAt: null
status: "validated"
validatedCommit: "01d9e08dd39dbafb7b17e515a4d5d0abcda4b3dd"
---

# Bridge Local Models and Personal Resources

## Context

The remote Agent must use the laptop's personal model authentication and customization without copying credentials or
creating a remote personal profile. The current execution path combines cwd, settings, resources, model resolution, and
persistence, so the split must happen at real ownership boundaries rather than through remote-mode conditions in each
tool.

This slice targets the model and customization part of the Remote SSH PRD's
[Local personal environment](../../prd/remote-ssh-prd.md#local-personal-environment): **Use one personal environment**,
**Keep credentials local**, and **Use customizations honestly**. The lasting owners are Core's
[Models and providers](../../prd/runwield-core-prd.md#models-and-providers) and
[Agent and skill customization](../../prd/runwield-core-prd.md#agent-and-skill-customization). Preserve settings
precedence, the single Skill catalog, model selection, and temporary-provider-failure recovery. Session persistence
remains owned by a later child; this child must not enable ordinary remote user turns.

**Dependency evidence, 2026-09-24:** Child 01 exists in commit `e00d34ce`, reachable from `origin/main`, but is absent
from this worktree and the local Epic branch at `e22c9318`. Execution must first include that delivered dependency. Its
actual integration points are `src/shared/remote/control.ts:startRemoteControlService`,
`src/shared/remote/supervisor.ts`, and `src/cmd/remote/index.ts`. Do not implement a second connection service.

**Owner clarification:** Mount the laptop's global `~/.wld` folder through SSHFS. Personal resource edits through the
mount change the laptop files directly. The connected working directory is the remote folder; its project `.wld` remains
on the server. No repository is copied, mounted from the laptop, or synchronized. Project overrides retain precedence
over personal settings and resources.

| Path or operation                       | Location                                |
| --------------------------------------- | --------------------------------------- |
| Global RunWield `~/.wld` access         | Laptop files accessed through the mount |
| Connected project, including its `.wld` | Remote filesystem                       |
| Project shell, Git, builds, and tests   | Remote environment                      |
| Authenticated model requests            | Laptop model runtime                    |

The personal mount provides direct access, not synchronization between two copies. Do not copy personal resources or
introduce a special personal-resource save operation. This owner decision replaces the parent Epic's narrower
Session-only mount and copied-resource approach. Reconcile the affected architectural guidance and child references in
the implementation change.

This child supplies mounted personal resources and model access. Child 03 still owns guarded Session writes; child 04
activates durable remote Sessions; child 05 owns Memory and integration placement; child 08 qualifies shipped helpers. A
full personal mount does not authorize remote code to become the model credential owner or open a personal database.

## Objective

Let remote Core use the laptop's model catalog and streaming service, and access personal settings, Agents, prompts, and
complete Skill trees through a mounted laptop `.wld` folder. Personal file edits reach the laptop directly. Preserve
remote project overrides and supported Pi behavior without copying credentials or silently selecting another backend.
The trusted mount is not a credential-access sandbox.

## Approach

Extend the connection-scoped personal service from child 01 with explicit capabilities. Keep
`createRunWieldModelRuntime` and provider callbacks on the laptop; send safe model metadata and stream events across the
authenticated bridge. Mount the laptop personal folder through stock OpenSSH SFTP and SSHFS, then compose mounted
personal resources with bundled defaults and remote project overrides at Session construction. Ordinary edits to mounted
personal resource files are laptop edits, not changes to disposable copies.

```text
remote Agent -> safe catalog and stream request -> laptop model runtime -> provider
remote personal file read/write -> SSHFS mount -> laptop .wld
remote project read/write -> remote checkout
```

**Mount the source folder, not the remote user's home.** Mount laptop `~/.wld` at a private connection-owned remote
path. Pass that global resource root explicitly to settings and resource readers. Do not replace the server user's
existing `.wld`, change project-tool HOME, or interpret a laptop absolute path as a server path. Instructions and
resource expansions must show the actual mounted path for personal file edits. Project cwd stays remote.

Enabled personal `.agents` resources and installed-package prompt roots can sit outside `.wld`. Resolve these on the
laptop and provide explicit additional resource-root mounts through the same owned stock-SFTP transport when needed. Do
not copy them or discover same-named remote personal folders instead. Preserve internal relative paths; unresolved
absolute links or machine-specific dependencies report the affected resource, not a false successful load.

**Keep existing owners for structured state.** Existing settings controls send their setting change to the laptop
settings owner and await completion; synchronous Pi settings reads use a current snapshot. Do not turn synchronous
`RunWieldSettingsStorage.withLock` into an asynchronous callback or trust a mounted lock. This is not a new
resource-save command: ordinary Agent, prompt, and Skill edits use normal file operations through the mount. Direct file
edits retain the same limitations as direct edits during an ordinary local Session.

**The broad mount is not managed Session write access.** RunWield's transcript, manifest, and generation writers must
use child 03's operation-scoped guarded path, never the connection-wide personal alias. Direct trusted-user filesystem
access is not confined, just as stock SFTP was never confined. This child creates no saved Session or remote Memory
store. Child 04's empty-start rule must distinguish the personal mount from a Session writer mount.

**Use Pi's public runtime API.** Build the remote catalog projection with `ModelRuntime.create`, an
`InMemoryCredentialStore`, no models file, and network discovery disabled. Register native proxy providers with
`createProvider`/`registerNativeProvider`; proxy `stream` and `streamSimple` separately. Replace built-in providers with
credential-free projections, including unavailable projections for providers absent from the laptop catalog, so remote
environment keys cannot become a fallback. Return availability without dummy credentials. The laptop resolves actual
provider/model identifiers against `createRunWieldModelRuntime`.

Keep OAuth, discovery, endpoint resolution, headers, and provider callbacks local. Transfer serializable request
options, not functions. Preserve RunWield-owned callback behavior through named local policies. An unsupported custom
hook must fail clearly, not disappear. Route vision fallback through the same runtime; replacing only the main Agent
stream would leave `see-image.ts` requesting credentials remotely.

Reuse stock SFTP and SSHFS, not a custom server. The focused live pilot may use a verified installed SSHFS binary and
usable FUSE; child 08 remains responsible for private helper distribution and the advertised platform matrix. Missing
host prerequisites fail before capability readiness. Do not copy the credential store or serialize provider functions.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/models/model-registry.ts` and Pi backend adapters — expose a credential-free catalog/status contract and
  complete streaming/cancellation behavior while runtime and auth stay local.
- `src/shared/session/session.js` and model selection modules — resolve remote Pi models without falling through to
  credentials on the server or unsupported CLI defaults.
- `src/shared/settings.js`, `src/shared/session/agents.js`, and `src/shared/session/agent-assets.js` — merge local
  personal resources with bundled and remote project-owned configuration.
- `src/shared/session/skill-catalog.ts`, `named-invocation.ts`, and Pi resource setup in `session.js` — preserve full
  Skill trees and resource-relative lookups through the one Core catalog. Pi discovery remains disabled, including after
  resource reload; it must not become a second catalog.
- `src/shared/remote/`, `src/cmd/remote/index.ts`, and connection tests — extend authenticated control with model
  operations and own stock-SFTP/SSHFS startup, mount readiness, independent supervision, and cleanup.
- `src/shared/session/execution-backend.ts`, model selection/readiness, and `src/cmd/resume/index.ts` — refuse CLI
  selections without losing saved model identity or falling through to a different backend.
- `src/tools/see-image.ts` and Session provider tests — route vision completion through local authentication and retain
  retry, temperature, cancellation, and summarization behavior.
- `src/shared/package-resources.ts` and personal instruction readers — resolve laptop resource roots without loading
  unrelated remote personal resources or starting package-owned personal services remotely.
- `docs/domain-language.md` — extend the existing Remote SSH connection relationship with mounted global resources and
  remote project ownership; retain an ordinary Session, not a new Session type.
- The owning Remote SSH and Core PRD sections, ADR-018, the parent Epic, and affected child 03/04/05/08 references —
  replace copied-resource guidance and distinguish connection-wide personal mounts from guarded Session writes. Keep the
  later children's implementation scope and only mark tested model/resource behavior delivered.

## Reuse Opportunities

- `createRunWieldModelRuntime` and `RunWieldCredentialStore` — retain them as laptop-side authorities.
- Existing model selection and compatibility checks — extend them with execution-location facts instead of building a
  second selector.
- Stock OpenSSH SFTP and the SSHFS proof — reuse mounted file access, while retaining the proof's limits on locking,
  stalled I/O, directory synchronization, and writes beneath a lost mount. Bundled asset extraction stays separate.
- Pi stream shapes and the proven prototype bridge — reuse the event vocabulary while filling contract gaps found during
  implementation.

## Implementation Steps

- Child 01's delivered connection code is present before integration. `startRemoteControlService` and its launcher own
  authenticated catalog, stream, cancel, and structured-settings operations. Operations require a live connection and
  request identity; wrong credentials, stale connections, and shutdown reject new effects. Health checks remain
  responsive while a provider or mounted file operation blocks.
- The personal service returns allowlisted model metadata and authentication/subscription status, while endpoint URLs,
  headers, discovery, token refresh, OAuth callbacks, and provider functions execute only on the laptop. Remote
  `ModelRuntime` projections use no credential files or environment fallback and do not expose secret-returning APIs.
- The remote Pi path preserves stream ordering, terminal events, `.result()`, tool calls, usage, reasoning, images,
  supported options, retry/timeout behavior, summarization, errors, and upstream cancellation for the verified provider
  matrix. Real Pi `createAgentSession` accepts the projected runtime, model changes/cycling use its availability, and
  compaction and `see-image` completion use the bridge. Each stream settles `.result()` exactly once on success, error,
  cancellation, or transport loss. Retrying a transport request cannot start a duplicate paid model request; existing Pi
  retry policy still governs failed model attempts without replaying completed tools.
- Remote model selection covers root, saved, preset, delegated, execution, repair, and Guided Review choices; Claude CLI
  and Antigravity CLI fail before a provider request with no model or billing substitution.
- The launcher mounts the full laptop `~/.wld` through owned stock SFTP and SSHFS at a fresh private remote path. Mount
  readiness verifies laptop-backed reads/writes before exposing the root to resource consumers. The mount uses
  synchronous writes and conservative caching; setup does not copy the personal profile or change the remote HOME.
  Underlying mount directories deny fallback writes and are never reused for a successor connection.
- Personal settings and resource readers use the mounted laptop folder, not the remote user's personal profile. Ordinary
  edits to mounted Agent, prompt, and Skill files change the laptop originals without a separate save API or
  synchronization pass. Project settings writes retain remote primary-checkout ownership; project resource reads retain
  current-worktree precedence, including the existing exact-project settings exception for validation worktrees.
  `settings.js` and settings/model/theme/thinking controls acknowledge structured changes only after the laptop owner
  completes the write. Read-modify-write occurs under the real local settings lock; retries reconcile request identity
  rather than overwrite a newer change. Cached settings are refreshed after acknowledgement and isolated by connection.
  No settings success is reported from an unconfirmed cached write.
- Complete personal Skill directories, including executable scripts and sibling files, are accessed through the mount
  with preserved relative paths. `skill-catalog.ts` retains project `.wld`, enabled project `.agents`, personal `.wld`,
  enabled personal `.agents`, then bundled precedence. External Skills cannot claim bundled names or directory aliases.
  Pi's `noSkills: true` and empty `skillsOverride` remain effective. Enabled personal roots outside `.wld` have explicit
  mounted mappings; neither laptop path strings nor symlinks may silently resolve to unrelated remote personal files.
  Agent scalar/prompt-body merging, protected tools, global instructions, and Prompt Template precedence retain current
  behavior.
- Missing custom CLIs, machine-specific paths, native binaries, or third-party dependencies fail visibly for the
  affected skill without blocking unrelated RunWield core behavior or moving project execution to the laptop.
- Reconnect mounts current laptop files without merging or restoring copied resources. Shutdown detaches owned mounts;
  cleanup never recursively deletes laptop content through a live mount. Loss does not permit writes into an underlying
  remote directory or a fallback remote profile. The independent supervisor stops dependent work on transport loss or
  stalled storage; adopt the Epic's 30-second storage-request deadline without treating it as proof of termination.
  Cleanup revokes owned serving access before removing only confirmed-unmounted temporary directories.
- The normal remote command remains connection-only: no user turns, credential migration, writable Session manager,
  personal Memory initialization, or MCP startup is enabled by mounting resources. Tests exercise the production
  model/resource adapters with an in-memory Pi Agent Session and synthetic project tools. Later children activate
  ordinary Sessions and integrations.
- The Core and Remote SSH PRD requirements and scenarios distinguish delivered Pi/resource behavior from untested
  providers, custom dependencies, persistence, and workflow behavior. ADR-018 and the parent Epic reflect the approved
  full personal mount rather than copied skills. The existing glossary records mounted global resources and remote
  project ownership, without claiming durable remote Sessions already run. Child 03/04 references preserve managed
  writer exclusion while explicitly allowing the earlier personal mount; child 05 retains local database/integration
  ownership, and child 08 retains helper packaging and platform qualification.

## Verification Plan

- **Model bridge:** Add focused tests under `src/shared/remote/` using the real authenticated service, public Pi
  runtime, and an instrumented HTTP model provider. A remote in-memory Agent Session reads a unique project sentinel;
  the provider's second request must contain that tool result. Assert that only the laptop provider request carries the
  synthetic credential, and that a planted remote environment key or auth file is not read or used. Compare catalog and
  wire data against explicit allowlists. A stub stream, local tool loop, or credential-copy implementation must fail.
- **Pi contract:** Test text, thinking, tool-call events, usage, images, both stream modes, terminal `.result()`,
  reasoning/sampling/cache/timeout options, subscription status, model cycling, compaction, and `see-image` completion.
  Use the actual Session integration, not a standalone proxy test alone. Record received options at the instrumented
  provider. Test a synthetic OAuth renewal whose changed credential appears only in laptop storage. Real callbacks must
  run on their owning side; unsupported custom hooks fail explicitly rather than being dropped.
- **Failure and selection:** Abort a remote stream and disconnect its transport; observe the provider request close and
  a settled result with no live retry timer. Submit the same request identity twice and confirm one upstream request.
  Exercise transient retry then success without repeated tools. Test explicit, preset, saved/resume, delegated,
  execution, repair, and Guided Review model resolution: CLI choices produce a clear refusal before any model request or
  CLI spawn, never a default Pi selection. Ordinary local CLI support remains unchanged.
- **Real mount:** Use stock SFTP and SSHFS with a synthetic laptop home and a different remote home/project. Through
  ordinary remote file tools, create, edit, rename, and delete personal Agent, Prompt Template, and nested Skill files.
  Before disconnect, inspect laptop bytes directly. Edit a file on the laptop and verify a fresh remote resource load
  sees it. Execute a nested Skill script using its sibling file. A copied-resource implementation must fail these
  checks.
- **Project ownership:** Use a real Git fixture with a linked worktree. Verify project Agent/Skill/prompt overrides read
  from the selected remote worktree; normal project settings write in the remote primary checkout and the exact-project
  exception stays exact. Same-named laptop project sentinels and the remote user's personal profile must remain
  unchanged. Verify `.agents` disable/conflict rules, mounted external roots, protected Agent tools, and empty Pi Skill
  discovery after reload through existing catalog and named-invocation APIs.
- **Settings writes:** Exercise existing model/theme/settings controls with delayed and lost replies. They must not
  report success before laptop bytes change. Concurrent local and remote structured updates must preserve unrelated
  fields. Retrying a completed operation must not repeat it or overwrite a newer value. A new connection must use
  current laptop settings, not another connection's cached manager. Use real settings files and locks.
- **Mount loss:** Pause the stock serving process while SSH health continues, then test ordinary exit, transport loss,
  launcher death, and forced unmount. Check the separate storage deadline, stop of dependent owned work, failed writes
  under the lost mount, no fallback profile, and no recursive deletion of laptop content. Keep an unrelated process
  alive as a control. Remount at a fresh path and verify committed laptop edits remain. Record cleanup uncertainty if an
  operating-system call cannot be interrupted; do not label it successful cleanup.
- **Startup and ownership:** Extend child 01 entry-isolation tests to permit the owned personal mount but still reject
  ordinary user turns and Session creation. No remote Memory database, credential migration, or personal MCP startup
  occurs. Trace both `root-session.js:createRootSessionManager()` and `FileSessionStoreOwner.ensure()` →
  `openFileSessionStore()` through their actual path resolvers. Neither may derive managed Session storage from the
  connection-wide mounted global resource root. Test remote construction without guarded operation access: it must not
  obtain a writable Pi manager or open a managed store through that alias. In-memory tests and an empty startup
  directory alone do not prove this. Child 03's real competing-writer and stale-handle qualification remains required
  before child 04 activation.
- **Commands:** Run
  `deno run -A scripts/run-tests.js src/shared/remote/ src/shared/models/ src/shared/settings.test.js
  src/shared/session/skill-catalog.test.ts src/shared/session/named-invocation.test.ts
  src/shared/session/agents-shared-practice.test.ts src/shared/session/session-prompt.test.js
  src/shared/session/__tests__/agent-model-override.test.js src/cmd/resume/index.test.ts src/tools/see-image.test.js`
  as one shell command, plus focused provider retry/replay/temperature tests in `src/shared/session/`. Use
  `deno task seams:check` and `deno task doc-links:check`. All automated fixtures use the repository's isolated test
  runner; tests changing HOME/cwd use `withProcessGlobalTestLock`. Do not add seams for owned settings or storage.
- **Live provider proof:** With matching built laptop/Linux artifacts, use the same supervised production adapters in a
  bounded in-memory acceptance flow on `sct` or another approved host. A remote-only sentinel must reach a second
  locally authenticated Pi request. Test cancellation, reconnect, direct mounted personal edits, a remote project `.wld`
  edit, and a custom Skill with a missing CLI. Confirm that the dependency error does not disable core tools. Record the
  exact provider, Pi version, host architecture, mount options, and results. Do not claim the entire Pi or platform
  matrix from the previously recorded Codex prototype.
- **Protected behavior and documents:** Retain local TUI/ACP/Workspace settings and resource precedence, CLI selection,
  transient-provider recovery, saved model identity, and Skill expansion tests. No local feature is removed. Only the
  new remote path excludes credential/profile initialization and independent Pi Skill discovery. Confirm the owning PRD
  scenarios, ADR-018, glossary, and affected child references describe the mounted global/remote project split; untested
  durable Sessions, workflows, integrations, and platforms stay target or deferred.

Expected: direct personal edits reach laptop bytes while the connection is live; project effects stay remote; no
personal-copy synchronization exists. Model service responses contain no credentials. The full `.wld` mount can expose
credentials to the trusted remote account, so no confinement or forensic-erasure claim is made.

## Edge Cases & Considerations

- A saved unsupported CLI model must stay identifiable so continuation can explain the refusal instead of silently
  selecting a Pi default.
- Provider-specific callbacks cannot cross the bridge as serialized functions; define the request so they execute on
  their owning side.
- A resource tree can contain user secrets because the user placed them there. Do not claim secret detection or
  hostile-host isolation.
- Model cancellation and transport cancellation can race. Settlement must produce one terminal result without leaving a
  live provider request.
