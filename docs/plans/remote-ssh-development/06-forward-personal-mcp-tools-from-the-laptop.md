---
planId: "5df960b5-5c59-41b7-935a-3dc7511ad917"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/mcp/config.ts"
    - "src/shared/mcp/integration.ts"
    - "src/shared/remote/control.ts"
    - "src/shared/remote/mcp-bridge.ts"
    - "src/shared/remote/entry.ts"
    - "src/shared/remote/remote-mcp.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/adr/0019-pi-owned-mcp-integration.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-11T00:00:00.000Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 6
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
targetBranch: "epic/remote-ssh-development"
userVerifiedAt: null
status: "reviewed"
---

# Forward Personal MCP Tools from the Laptop

## Context

Child05 is delivered. A remote Session gets personal Model Context Protocol (MCP) server names from the laptop, never
from the server user's personal `mcp.json`. Project servers start remotely after normal safety and override checks.
Personal servers are listed but not started, so their tools are missing.

This child delivers the Epic's **Reviewable integration default** in
[Personal resources, integrations, and Memory](../remote-ssh-development.md#personal-resources-integrations-and-memory):
personal MCP servers run on the laptop with their existing credentials, and their tools reach the remote Agent.

### Owning requirements and current evidence

- **Change:** Core [Agent and skill customization](../../prd/runwield-core-prd.md#agent-and-skill-customization),
  **Trusted MCP tools**, and Remote SSH [Local personal environment](../../prd/remote-ssh-prd.md#local-personal-environment),
  **Run MCP servers on their owning machine**, gain callable personal servers. Replace the current
  `not started remotely` limitation only when forwarding is implemented.
- **Preserve:** project override/disable and file-safety rules; root Agent access across handoff; no inherited MCP
  access for delegated or isolated Agents; native Pi names, resources, updates, progress, results, and reconnect.
- **Preserve:** [Disconnect and recovery](../../prd/remote-ssh-prd.md#disconnect-and-recovery) stops owned work and does
  not replay uncertain tool effects. This child adds its laptop server processes to existing connection cleanup.
- **Architecture:** accepted [ADR-0019](../../adr/0019-pi-owned-mcp-integration.md) now gives Pi ownership of MCP
  behavior. `McpIntegration.call` in the old draft does not exist. Public `createMcpExtension` and `McpTransport` in the
  pinned Pi 1.0.0 packages support the selected relay without another MCP client or naming system.

No scope moves to siblings. Child07 still owns delivery workflow context; child08 owns browser review; child09 owns
release/platform qualification. This child proves personal MCP through ordinary remote conversation.

## Objective

A remote root Agent lists and calls the effective personal MCP tools through Pi. Personal servers run on the laptop
with laptop configuration, minimal inherited environment, and laptop home as the working directory (`cwd`). Project servers run remotely with the
Session execution cwd. `/mcp` shows each location and real connection status; reconnect reaches the correct process.

## Approach

### Decisions from planning

- **Forward the MCP transport, not a second tool API.** The user selected Pi's existing MCP handling with a connection
  to laptop server processes. Keep one Session-owned `McpIntegration` in the remote runtime. Pi still owns discovery,
  naming, conversion, resources, live updates, cancellation, and reconnect.
- **Personal server cwd is the laptop home.** The user selected this instead of the directory where `wld remote` was
  launched. Relative commands and arguments resolve there; no path arguments are rewritten.

> [!WARNING]
> **Laptop home is a starting folder, not project access or a sandbox**
>
> A relative command such as `./scripts/mcp-server` must exist under laptop home. A server that resolves relative file
> arguments against its cwd can read or write home-relative files rather than project files. Network-only servers
> usually do not depend on cwd. Personal servers still have the laptop account's normal access; choosing home does
> not restrict that access.

**Sharing Memory does not map files.** `bindRemoteMemory` saves the remote identity and selected collection name, not
an association to a laptop checkout path. Even when the user confirms that both folders are the same project, their
files, branches, and uncommitted changes can differ. This Plan does not use that Memory choice to select MCP cwd.
Project-file servers should be project-defined and run remotely. A personal server that intentionally reads a laptop
checkout needs explicit configuration supported by that server, such as absolute arguments; a new RunWield per-server
cwd setting or checkout mapping is outside this child.

Using the launch folder would preserve some relative scripts but make behavior depend on where `wld remote` starts.
Automatically selecting a same-project laptop folder would risk stale reads or changes to the wrong copy. Neither is
selected by this Plan.

```text
remote Session-owned McpIntegration → Pi createMcpExtension
  project server  → existing StdioTransport → remote process, remote execution cwd
  personal server → authenticated MCP transport relay
                    → laptop StdioTransport → laptop process, laptop home cwd
```

`createMcpExtension({ createTransport })` and Pi's public `McpTransport` interface already provide this boundary.
RunWield supplies the cross-machine transport; it does not implement another discovery manager or serialize Pi tool
functions. This replaces the draft's laptop `McpIntegration` host and tool-list/call routes. That approach would require
separate update/resource handling and coordination of Pi's shared resource tools.

The laptop loads personal commands, arguments, and environment values from `readPersonalMcpConfig`. The remote side
receives only safe server identity metadata. `resolveMcpConfig` still applies project overrides and disables before it
opens any personal transport. The laptop accepts a configured personal server name, never an executable or environment
sent by the remote caller.

Each transport belongs to one remote integration and this authenticated connection. Open, ordered message exchange, and
close are bounded transport operations in a new `src/shared/remote/mcp-bridge.ts`; `control.ts` supplies authentication,
readiness, and shutdown. Preserve bidirectional MCP messages, including notifications. A failed connection is not a
reason to resend a tool request. Pi may reconnect a server for later calls, but an uncertain call is never replayed.

Do not copy credential-bearing MCP configuration to the server. Server responses remain user-selected server output,
not a promise that arbitrary tool content cannot contain secrets. The existing trusted-host personal mount is not a
credential sandbox. A personal server that needs remote project files remains best effort and may need user
configuration.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/mcp/integration.ts` — retain one Pi host for both locations; select transports from effective server
  origin, include personal-only inventories, and report location without the old inactive label.
- `src/shared/mcp/config.ts`, `src/shared/remote/settings-bridge.ts` — preserve the merge owner and expose only explicit
  safe personal descriptors. Keep full personal definitions laptop-only.
- `src/shared/remote/mcp-bridge.ts` (new) — own the authenticated transport client and connection-scoped laptop stdio
  registry, ordered message forwarding, and close races. Small protocol types can be split if needed.
- `src/shared/remote/control.ts`, `entry.ts` — mount relay routes behind existing authorization/readiness; configure the
  remote client and close transports on every existing shutdown path.
- `src/shared/session/runtime/agent-settings.ts` and HostedSession ownership paths — verify reload, handoff, replacement,
  and disposal retain existing integration lifetime. Change only what relay cleanup requires.
- `src/shared/remote/remote-mcp.test.ts`, remote runtime fixtures, and `src/shared/mcp/fixture-server.ts` — real-process
  placement, native protocol behavior, cancellation, and failure evidence. Add focused relay tests.
- Core and Remote SSH PRDs — update the named requirements and acceptance scenarios, leaving sibling targets explicit.
- `docs/adr/018-remote-ssh-local-personal-authority.md`, `docs/adr/0019-pi-owned-mcp-integration.md` — record the remote Pi
  host/laptop process split and its rationale without changing Session storage or trust policy.
- `docs/domain-language.md`, `docs/user-documentation/mcp.md` — describe MCP Server Configuration placement, laptop home
  cwd, root Agent access, and path/cancellation limits using existing terms.

No new MCP transport configuration is exposed to users. HTTP/OAuth server configuration, codemode, remote external CLI
backends, and transparent access to remote files from laptop servers remain outside this child.

## Reuse Opportunities

- `resolveMcpConfig`, `readPersonalMcpConfig`, and `isSafeProjectMcpFile` retain configuration authority and precedence.
- Pi `createMcpExtension`, `McpTransport`, and `StdioTransport` retain MCP semantics and process shutdown. Reuse the
  minimal `getDefaultEnvironment()` plus configured `env` rule on both machines.
- `McpIntegration.bindRoot`, `syncTools`, and HostedSession disposal retain tool policy and Session lifetime.
- `startRemoteControlService` retains loopback, bearer authorization, handshake, readiness, and health supervision.
- `LocalModelBridge` demonstrates streamed responses, abort handling, and rejection of repeated effects. Reuse those
  patterns, not settings-write retry logic: MCP sends must not replay uncertain tool calls.
- `withRemoteRuntimeFixture` and the MCP fixture server provide real subprocesses and separate homes without new seams.

## Implementation Steps

1. `resolveMcpConfig` remains the sole merge owner. Only effective personal entries open laptop transports; overridden
   or disabled personal entries never start. Unsafe configuration files retain existing rejection rules; an unsafe
   project file must not suppress a valid personal entry. `/mcp/config` sends an
   explicit allowlisted descriptor, not a spread of credential-bearing definitions. Existing local and ACP precedence
   is unchanged.
2. `src/shared/remote/mcp-bridge.ts` implements Pi's public `McpTransport` interface and a laptop registry of
   `StdioTransport` instances. A client-generated, connection-scoped transport ID identifies each process lifetime.
   Open resolves a currently enabled personal server name with `readPersonalMcpConfig`; remote payloads cannot supply
   commands, arguments, env, or laptop cwd. Personal processes use `getHomeDir()` and the existing minimal environment
   rule. Project processes still use the remote Session cwd.
3. The relay supports open with a server-to-remote message stream, ordered remote-to-server sends, and idempotent close.
   Attach stdio listeners before startup; `start()` resolves only after startup succeeds. Forward JSON-RPC messages in
   both directions, including progress, tool-list changes, resource messages, and `notifications/cancelled`. Serialize
   sends per transport without waiting for a tool result, so cancellation can pass an executing call. Bound frames and
   buffered output; support Pi's current 16 MiB message limit rather than the settings route's small body limit.
4. Authentication and readiness precede admission in `control.ts` and are checked again after asynchronous reads and
   startup. A closed ID cannot reopen; close-before-open prevents a delayed open from spawning. Repeated open/send
   identities never spawn twice or send a message twice. Use send sequence identity and reject duplicates or gaps;
   do not retry failed sends. A broken response stream or failed send closes that transport, rejects pending calls,
   and never treats partial output as success. A later Pi reconnect gets a fresh ID and never resends the failed call.
5. `startMcpIntegration` includes personal entries and chooses the relay only for `location: laptop`. It continues to
   use one `createMcpExtension` for the whole effective configuration, so Pi owns cross-server name collisions and
   shared resource tools. An empty or failed personal inventory still binds the root for later updates/recovery.
   `entry.ts` configures the relay connection before runtime MCP access. No parallel tool inventory or conversion
   layer is introduced.
6. `/mcp` reports `laptop` or `remote` with real status, not `not started remotely`. `/mcp reconnect <server>` uses Pi's
   existing command and restarts the owning transport without a model request. Automatic relay/startup errors contain
   no argv, env values, bearer token, or raw subprocess exceptions. Normal server tool output retains Pi's contract;
   do not add a general content scrubber or promise secret confinement.
7. Remote turn abort reaches Pi's native cancellation message and the laptop server. A call aborted before tool dispatch
   does not emit `tools/call`. Session reload/disposal closes its transports; Agent handoff and runtime ownership
   transfer keep them. One Session's close leaves another's servers usable. Every control shutdown path, including health loss,
   closes laptop transports and startup races; final service close awaits owned stdio cleanup. Late messages cannot
   reach a replacement transport. Cancellation does not promise rollback or termination of server work that ignores
   the MCP cancellation notification.
8. The named PRD requirements and scenarios match the delivered behavior. ADR-018 and ADR-0019 describe the chosen
   transport split, ownership, no-replay rule, and limits. The glossary updates **MCP Server Configuration** and
   **Remote SSH connection** without inventing a new Session or Bridged Tool type. User MCP docs explain home cwd,
   unchanged paths, location/status, reconnect, and trusted server output. Keep remote workflows, `/sleep`, and
   unqualified platform/provider scope as targets or deferred work.

## Verification Plan

### Focused commands

Use Bun 1.4.3 and `bun run install:locked` before checks. Use the isolated runner, sandboxed homes, real Git fixtures,
and `withProcessGlobalTestLock` for process-global changes. Do not introduce seams for owned MCP or Session machinery.

- `bun scripts/run-tests.js src/shared/mcp src/shared/remote/remote-mcp.test.ts src/shared/remote/mcp-bridge.test.ts src/shared/remote/control.test.ts src/shared/session/__tests__/session-tools-policy.test.js`
- `bun run seams:check`
- `bun run doc-links:check`
- `bun run fmt:check docs/plans/remote-ssh-development/06-forward-personal-mcp-tools-from-the-laptop.md` and explicit
  changed source/document paths.

### Automated behavior

- **Real remote turn:** extend `withRemoteRuntimeFixture` so a root Agent discovers and calls a personal-only fixture.
  The fixture records PID, host, cwd, and a unique call marker; assert laptop home cwd, laptop-only marker access, and
  one call. A second model request receives that result. In the same setup a project server reports remote execution
  cwd. A decoy server-user personal config never starts. The current implementation fails this test because personal
  tools do not exist; a fabricated catalog/result also fails the process-log and second-request assertions.
  Repeat with a Memory binding that shares a local project's collection: personal cwd remains laptop home, not the
  local checkout or launch folder. No local checkout is selected as an implicit counterpart to the remote project.
- **Selection before spawn:** project replacement and `enabled:false` each prevent the corresponding personal process
  from starting. Keep unsafe-file and worktree-primary-config checks. Capture requests/responses for config, open,
  send, failure, and status; unique configuration argv/env secrets and bearer credentials never appear in payloads or
  automatic diagnostics. Authorization headers are required, not counted as leaked payload. Deliberate server result
  content is not a secret-filtering guarantee.
- **Native Pi parity across the relay:** test paginated discovery, normalized-name collisions across personal/project
  origins, text, images, structured output, server errors, and progress before completion. Both origins' resources
  remain accessible through Pi's shared resource tools. A server-initiated `roots/list` request receives the remote
  project URI unchanged while its actual process cwd remains laptop home. Oversized output saved by Pi is readable in
  the remote runtime, not a laptop temporary path. Preserve normal schemas, annotations, and native naming.
- **Updates and recovery:** change an initially empty personal fixture's tool list, then withdraw a tool; the same root's
  next model request reflects both changes. A failed personal startup leaves the Session usable; fixing the fixture
  and `/mcp reconnect` restores calls without a model request for the command. Handoff retains callable tools; reload
  closes obsolete processes and rereads effective config. Delegated/isolated Agents still receive no inherited MCP.
- **Cancellation at the server:** add a cooperative delayed fixture that keeps reading stdin while work is pending.
  Wait for its call-start log, abort the real remote turn, and assert receipt of `notifications/cancelled`, cancelled
  settlement, and no delayed-effect marker. Also abort before dispatch, during connection startup, and while queued
  behind another Agent tool; no call marker may appear. The current fixture's blocking `slow` branch and an immediately
  aborted promise are not sufficient evidence.
- **Ownership and loss:** two Sessions have independent laptop processes. Closing one stops only its processes. Test
  close during startup, close-before-open, repeated close, turn loss during a call, stream loss, and service shutdown.
  Assert owned PID exit, unrelated process survival, no late results, and no replay after a fresh connection. Exercise
  all control revocation paths, including health loss; use existing clock boundaries where needed.
- **Admission and framing:** unauthenticated, not-ready, stale-connection, unknown-server, executable-bearing,
  duplicate-open, duplicate/gapped-send, malformed, and oversized requests produce no additional spawn or call effect.
  Test split NDJSON chunks and bounded output overflow. A lost send acknowledgement cannot trigger a second call.

### Protected behavior and semantic review

Retain existing MCP tests for local/ACP merging, independent Session lifetime, handoff/replacement, minimal environment,
root restrictions, native resources/results/updates, and reconnect. Only the child05 assertions that personal servers
never start and display `not started remotely` are replaced; server-profile exclusion and project placement survive.
Local external CLI behavior remains unchanged and covered by its existing suites.

Inspect the call path: both locations enter one Pi extension; the relay only transports protocol messages and owns its
stdio lifetime. No custom naming, tool conversion, result-path rewrite, configuration retry, or second discovery
manager can satisfy this Plan. Check the PRDs, ADRs, glossary, and user docs together; no sibling target is marked
shipped by this child.

### Live pilot

On the existing `sct` pilot, use matching compiled laptop/Linux builds and a disposable remote project. Call one
network-only personal fixture/tool with laptop-only configuration and one project tool. Inspect actual host/PID/cwd
logs and `/mcp` location/status, then reconnect the personal server and call it again. Cancel a cooperative slow call,
drop the owned SSH connection during another call, reconnect, and confirm no effect replay or orphan laptop process.
Use synthetic secrets and remove only owned fixtures/processes. Record the observed build/host and results; this is
not release-matrix qualification. If `sct` is unavailable, report the live check as unverified, not passed.

## Edge Cases & Considerations

- **Path-dependent servers:** home cwd is intentional. MCP root metadata still describes the remote Session project;
  those paths need not exist on the laptop. Do not reinterpret a remote path as a laptop checkout, copy project files,
  or rewrite tool arguments. Document the limit; this transport cannot infer a custom server's filesystem intent.
- **Configuration changes:** a running transport keeps its startup definition. A fresh open/reconnect rechecks current
  laptop configuration; a removed or disabled name fails rather than using cached commands. `/reload` rebuilds the
  effective merge. No cross-machine config snapshot or migration is needed.
- **External effects:** cancellation is native MCP cancellation, not rollback. A non-cooperative server may finish an
  accepted action. Disconnect cleanup terminates owned processes, but cannot undo accepted network effects. Preserve
  uncertainty and never repeat a call automatically.
- **Control loss:** a lost close request is backed by connection health shutdown. Never keep a transport alive by
  reconnecting its event stream and replaying protocol messages.
- **Reviewable implementation assumption:** use authenticated HTTP with a newline-delimited JSON (NDJSON) response
  stream for laptop-to-remote messages and ordered POST sends in the other direction, reusing the control listener. Keep details internal;
  do not add a public MCP transport setting, persistent daemon, or user-managed relay.
