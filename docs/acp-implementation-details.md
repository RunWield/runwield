# ACP Implementation Details and Gaps

## Current compatibility — 2026-10-06

The owner confirmed working ACP integration with JetBrains AI Chat and the Air plugin, and end-to-end OpenAB workflows
through Discord and its other supported chat platforms. Other ACP-compatible clients are expected to work as well.

The September 21 audit below is a historical technical snapshot. Its pending checks and optional-feature gaps must not
be used to describe these working integrations as unavailable or awaiting end-to-end acceptance. Current product
requirements live in the [ACP PRD](prd/runwield-acp-protocol-prd.md). This update records owner confirmation; it does
not claim a new protocol audit or that every optional ACP capability is implemented.

## Historical audit — 2026-09-21

**Audit date:** 2026-09-21\
**Repository baseline:** ACP reasoning and exact-context implementation on the active Plan branch.\
**Verdict:** RunWield implements the main **ACP v1 stdio** Session path, model and reasoning selection, exact context
updates, shared commands, and form questions. This is not proof of full ACP v1 compliance. Queued-turn completion and
some interaction behavior still need work. Most missing features are optional under ACP, but several would materially
improve IDE use.

This is a source review with focused ACP test evidence, not a multi-client compatibility test. Recommendations below are
opinions, not approved scope or delivery commitments.

## Audit baseline

This document compares the current repository implementation against:

- ACP v1 overview, initialization, session setup, prompt turn, schema, transport, content, tool call, and extensibility
  documentation: <https://agentclientprotocol.com/protocol/v1/overview>
- ACP v1 stdio transport rules: <https://agentclientprotocol.com/protocol/v1/transports>
- ACP v1 initialization rules: <https://agentclientprotocol.com/protocol/v1/initialization>
- ACP v1 session setup rules: <https://agentclientprotocol.com/protocol/v1/session-setup>
- ACP v1 prompt-turn and cancellation rules: <https://agentclientprotocol.com/protocol/v1/prompt-turn>
- ACP v1 schema reference: <https://agentclientprotocol.com/protocol/v1/schema>
- ACP v1 content and tool-call references: <https://agentclientprotocol.com/protocol/v1/content> and
  <https://agentclientprotocol.com/protocol/v1/tool-calls>
- ACP v1 extension rules: <https://agentclientprotocol.com/protocol/v1/extensibility>
- Current ACP v1 form and URL elicitation: <https://agentclientprotocol.com/protocol/v1/elicitation>
- Session configuration: <https://agentclientprotocol.com/protocol/v1/session-config-options>
- Client filesystem access: <https://agentclientprotocol.com/protocol/v1/file-system>
- RunWield's `@agentclientprotocol/sdk` dependency in `deno.json` (`^1.4.0`, resolved to 1.4.0 in `deno.lock`).

The upstream v1 pages were checked on the audit date. Protocol version `1` does not mean every optional feature is
implemented. SDK version `1.4.0` is a separate version number. Current upstream v1 documents include elicitation;
calling all elicitation experimental is no longer an accurate description of those pages.

The implementation evidence comes from these source files:

- `src/cli.ts`
- `src/cmd/registry.js`
- `src/cmd/acp/index.ts`
- `src/acp/server.js`
- `src/acp/session-map.ts`
- `src/acp/event-mapper.js`
- `src/acp/interaction-mapper.js`
- `src/shared/session/session-runtime.ts`
- `src/shared/session/session-runtime-events.js`
- `src/shared/session/session-runtime-interactions.js`
- `src/acp/protocol-smoke.test.js`
- `src/acp/session-map.test.js`
- `src/acp/server.test.js`

## Short answer: is RunWield up to ACP v1?

**The main path works in the implementation; full compliance remains unproven.** The adapter:

1. negotiates `protocolVersion: 1` and reports the generated RunWield version;
2. creates Sessions and reloads saved conversations with history replay;
3. accepts client-supplied stdio MCP servers on new/load;
4. streams text, thoughts, tool activity, status, and review links;
5. waits for a cancelled active turn and its pending updates before returning `cancelled`;
6. reports cumulative mapped usage cost in the ACP object shape;
7. exposes model and reasoning selection through `configOptions`, with complete selection updates;
8. reports exact Runtime context usage and capacity without presenting estimates as exact;
9. accepts ACP image prompt blocks through the shared Runtime image path; and
10. advertises shared commands and uses native form questions or a local browser fallback.

Evidence: `src/acp/server.js` (`createInitializeResponse`, `createRunWieldAcpServer`), `event-mapper.js`,
`interaction-mapper.js`, and `server.test.js` under `src/acp/`.

**Still missing:** Session listing/resume, a native Agent selector, embedded resources, audio prompts, additional roots,
HTTP/SSE MCP, client filesystem/terminal use, standard Plan and Session-info updates, and rich tool diffs/locations.
Agent switching itself works through `/agent`; only its native selector is missing.

**Fix before adding breadth:** truthful queued-turn completion, browser Other-answer support, and stop-reason detail.
Active-turn model changes also differ from current upstream guidance. See
[Required and high-priority gaps](#required-and-high-priority-gaps) and [Suggested next work](#suggested-next-work).

ACP makes many features optional. Missing an unadvertised optional feature is not, by itself, a compliance failure.
Browser Plan review is an intentional RunWield choice, not a missing standard ACP Plan editor.

## Architecture and transport

RunWield exposes ACP through two CLI entry points:

```bash
wld acp
wld --mode acp
```

`src/cli.ts` routes `--mode acp` before normal command/TUI dispatch so stdout can remain protocol-pure. The command
registry describes the ACP command as CLI-only and notes that stdout is reserved for ACP JSON-RPC frames. The command
implementation in `src/cmd/acp/index.ts` starts `startRunWieldAcpServer(Deno.stdin.readable, Deno.stdout.writable)` and
writes diagnostics to stderr with a `[RunWield ACP]` prefix.

The server in `src/acp/server.js` uses the ACP SDK's `ndJsonStream`, so the wire transport is newline-delimited UTF-8
JSON-RPC over stdio. That matches the ACP v1 stdio transport requirement that stdout contain only valid ACP messages and
that diagnostics go to stderr.

ACP is not a wrapper around the TUI. It is a sibling adapter over `SessionRuntime`, following
`docs/adr/010-session-runtime-sibling-adapters-and-acp.md`:

```text
ACP JSON-RPC stdio
    -> src/acp/server.js
    -> SessionRuntime
    -> SessionHost / HostedSession / Agent Session state
```

When the ACP connection closes, `startRunWieldAcpServer` calls `closeAllMappedSessions()`. Each mapped session is closed
through `closeMappedSession()`, which uses `runtime.closeSessionWhenIdle()` when available so active work is cancelled
and settled before the Hosted Session is disposed.

## Initialization and advertised capabilities

`createInitializeResponse()` in `src/acp/server.js` builds the initialize result.

| Capability or field                                                        | Current wire behavior                                                                                                                                                                                                    | Standard or extension                                                                                                       | Evidence            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `protocolVersion`                                                          | Always returns the SDK `PROTOCOL_VERSION` value, currently `1`.                                                                                                                                                          | Standard ACP v1 negotiation.                                                                                                | `src/acp/server.js` |
| `agentCapabilities.loadSession`                                            | `true`.                                                                                                                                                                                                                  | Standard stable v1 capability.                                                                                              | `src/acp/server.js` |
| `agentCapabilities.promptCapabilities`                                     | Advertises `image: true` and `_meta.runwield.contentTypes: ["text", "image", "resource_link"]`; no `audio` or `embeddedContext`.                                                                                         | Text, image, and resource-link support use standard content blocks; the explicit content-type list is a RunWield extension. | `src/acp/server.js` |
| `agentCapabilities.sessionCapabilities.close`                              | `{}`.                                                                                                                                                                                                                    | Standard stable v1 capability.                                                                                              | `src/acp/server.js` |
| `agentCapabilities.sessionCapabilities.delete`                             | `{}`.                                                                                                                                                                                                                    | Standard stable v1 capability; reversible archive.                                                                          | `src/acp/server.js` |
| `agentCapabilities.sessionCapabilities._meta.runwield.implementedMethods`  | Lists `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/close`, `session/delete`, `session/set_config_option`.                                                                                 | RunWield extension.                                                                                                         | `src/acp/server.js` |
| `agentCapabilities.sessionCapabilities._meta.runwield.updateNotifications` | Lists `session/update`.                                                                                                                                                                                                  | RunWield extension.                                                                                                         | `src/acp/server.js` |
| `authMethods`                                                              | `[]` by default. When the Client declares `clientCapabilities.auth.terminal === true`, or the registry probe declares `_meta["terminal-auth"] === true`, RunWield advertises one terminal method with `args: ["login"]`. | Standard stable v1 field plus narrow registry compatibility.                                                                | `src/acp/server.js` |
| `agentInfo`                                                                | `{ name: "RunWield", version: VERSION }`, where `VERSION` is the generated build version used by `wld --version`.                                                                                                        | Standard stable v1 field.                                                                                                   | `src/acp/server.js` |

The adapter stores `clientCapabilities` from `initialize` for later interaction mapping. Current production use covers
Terminal Auth capability detection during `initialize` and `clientCapabilities.elicitation.form` in
`src/acp/interaction-mapper.js`.

Terminal Auth is out of band. The ACP Client starts RunWield, reads the terminal auth method, launches the configured
command with `login` appended, waits for that terminal process to finish, and reconnects to `wld acp`. `wld login` uses
the same Login command handler as `/login`, but the setup-only TUI exits instead of creating a Session. The process
succeeds only after credentials and a usable default model are configured. Credentials remain in `~/.wld/auth.json` and
are not sent through ACP.

### Registry release follow-up

[Registry PR 580](https://github.com/agentclientprotocol/registry/pull/580) remains open and points to v0.10.0 release
archives. Do not describe registry installation as available yet. After the release that contains this ACP change
exists, update `runwield/agent.json` on that PR to the shipped version, change all five archive URLs, and replace every
SHA-256 value with the checksum of its matching archive. Keep the lowercase `runwield` ID, `license: "proprietary"`,
binary commands, platform entries, and the 16x16 monochrome `currentColor` icon.

Validate the updated PR from a fresh registry checkout with release URL checks available:

```bash
uv run --with jsonschema .github/workflows/build_registry.py
python3 .github/workflows/verify_agents.py --auth-check --agent runwield
```

The metadata cannot be finalized before those release archives exist. Merge of PR 580 is the publication boundary.

### Initialization behavior

ACP v1 version negotiation says the Agent must respond with the requested protocol version if it supports it; otherwise
it must respond with the latest version it supports. RunWield imports `PROTOCOL_VERSION` from the SDK. That constant is
`1`, so RunWield answers `1` for supported request `1` and unsupported request `99`.

## Implemented stable methods

| Method           | Advertised?                                      | Current behavior                                                                                                                                                                                                                                                                                                                                        | Important gaps                                                                                                                                                                  |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`     | Required baseline.                               | Stores client capabilities and returns `protocolVersion: 1`, Terminal Auth only for capable Clients, and generated `agentInfo.version`.                                                                                                                                                                                                                 | No known gap in the advertised initialize shape.                                                                                                                                |
| `session/new`    | Required baseline.                               | Validates absolute `cwd`, accepts stdio `mcpServers`, rejects other MCP transports and `additionalDirectories`, requires login plus a usable default model, creates a prompt-ready Runtime session, maps it to an ACP ID based on the persisted Pi segment ID, and returns `sessionId`, complete model/reasoning `configOptions`, and `_meta.runwield`. | MCP prompts are not supported; server resources are available through Pi resource tools.                                                                                        |
| `session/load`   | Advertised through `loadSession: true`.          | Validates like `session/new`, requires `sessionId`, optionally accepts `_meta.runwield.sessionPath`, accepts stdio `mcpServers`, loads a persisted Runtime session, replays mapped Runtime events as `session/update`, and returns complete model/reasoning `configOptions` and `_meta.runwield` after replay.                                          | Supports no additional roots; MCP prompts are not supported; server resources are available through Pi resource tools.                                                          |
| `session/prompt` | Required baseline.                               | Requires a mapped `sessionId`, converts prompt blocks to one text string, installs an interaction adapter and Session event subscription, streams mapped `session/update` notifications, waits for Runtime settlement and pending update sends, and returns a `stopReason`.                                                                             | Only text and flattened resource links; success returns `end_turn`, cancellation returns `cancelled`, rejected turns return errors. Queued work is a separate limitation below. |
| `session/cancel` | Required baseline notification.                  | Looks up the mapped Runtime session, marks the active ACP prompt cancelled, and calls `runtime.cancelSession()`. Unknown sessions are ignored because this is a notification. The notification does not complete the prompt by itself.                                                                                                                  | No known ordering gap in the advertised cancel path.                                                                                                                            |
| `session/close`  | Advertised through `sessionCapabilities.close`.  | Requires a mapped `sessionId`, marks active prompt cancelled, calls `closeSessionWhenIdle()` when available, removes the ACP mapping, and returns `_meta.runwield.closed`.                                                                                                                                                                              | Response shape is acceptable because `_meta` is allowed, but standard clients will ignore the RunWield-specific closure details.                                                |
| `session/delete` | Advertised through `sessionCapabilities.delete`. | Resolves mapped or persisted ACP IDs to the stable Session, stops and settles busy work, archives through the shared file store, releases the ACP mapping, and returns `{}`. Unknown and already archived IDs succeed idempotently.                                                                                                                     | No ACP listing or Unarchive method; restore through Workspace Project settings.                                                                                                 |

A Session subscription stays active after `session/prompt` returns `end_turn` while the host owns Background Tasks. The
Runtime can start a later result turn without a new client prompt. Its output and interactions use `session/update` and
the existing interaction mapping on the same ACP Session ID. The earlier prompt receives only one response. An idle
`session/cancel` stops owned tasks; `session/close` also releases their host owner. The tasks are not saved jobs and do
not resume after process exit. See [Session background work](user-documentation/sessions.md#background-tasks).

`session/set_config_option` accepts the `model` option with a provider-qualified model value from the shared selectable
model catalog. For a reasoning-capable active model, it also accepts the standard `thought_level` option with `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Both options use the same Session owners as the terminal and
Workspace, return the complete ordered `configOptions`, and emit `config_option_update`. They make no model request and
preserve future Session defaults. Unknown, unavailable, or unsupported choices return `-32602`; an active turn or failed
mutation returns `-32002`. Shared model commands, Agent changes, and reasoning changes also emit complete config
options. Repository wire tests cover next-turn reasoning, refusal without mutation, unsupported models, and reload.

### Deletion is reversible archive

`session/delete` resolves both currently mapped ACP IDs and persisted IDs based on Pi transcript segments to the owning
stable RunWield Session. The request itself confirms stopping busy work, including work on another surface. RunWield
uses the owning Runtime or existing live-session connection and waits for authoritative activation settlement before
archive. Stop, settlement, or persistence failures return an error instead of success.

Archive preserves the Session ID, every transcript segment, Plan Associations, and Plan and workflow state. Ordinary
history and TUI resume omit the Session; associated Plans retain its link and archived status. Workspace
[Project settings > Archived Sessions](prd/runwield-workspace-prd.md#project-access-and-navigation) offers Unarchive.
Direct links and explicit `session/load` do not silently unarchive it. `session/close` remains live-resource cleanup,
not archive. `session/list` is still unsupported and unadvertised.

## Unsupported agent methods

`src/acp/server.js` registers structured `-32004` errors for these methods:

- `authenticate`
- `logout`
- `providers/list`
- `providers/set`
- `providers/disable`
- `session/list`
- `session/fork`
- `session/resume`
- `session/set_mode`
- `nes/start`
- `nes/suggest`
- `nes/close`

For stable optional methods such as `logout`, `session/list`, `session/resume`, and `session/set_mode`, this is an
optional coverage gap when the method is not advertised. It is not itself a baseline conformance failure. Provider, NES,
and fork methods are SDK surfaces outside the stable agent-method list checked in the current
[v1 schema](https://agentclientprotocol.com/protocol/v1/schema). They are not required v1 gaps. Form elicitation is
covered by current v1 documentation and must not be grouped with those methods.

## Session identity model

Do not treat the ACP ID, live Runtime ID, stable RunWield ID, and Pi segment ID as interchangeable.

| Identity            | Purpose                                               | Current mapping                                                                                                        |
| ------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ACP `sessionId`     | ID the client retains for prompt/cancel/close/load.   | New Sessions use `acp-<snapshot.sessionManagerId>`, with a Runtime-ID fallback. Load retains the client's supplied ID. |
| Runtime Session ID  | Live, in-process Hosted Session.                      | Recreated on load; can change during Runtime replacement.                                                              |
| `runwieldSessionId` | Stable saved conversation across transcript segments. | Stored in the file-backed Session bundle. Load reports this in `_meta.runwield.persistedSessionId` when available.     |
| `piSessionId`       | One persisted transcript segment.                     | Exposed as `snapshot.sessionManagerId` for managed Sessions; currently supplies the new ACP ID.                        |

`session/load` strips an `acp-` prefix before resolving the saved conversation. It returns no standard `sessionId`
field; the client continues using its original ID. The new/load `_meta.runwield.persistedSessionId` values can differ:
new currently reports the Pi ID, while load prefers the stable RunWield ID. Clients should keep the standard ACP ID, not
substitute that metadata value.

Evidence: `src/acp/server.js` new/load handlers; `src/acp/session-map.ts` (`createRecord`,
`normalizeAcpSessionIdForLoad`); `src/shared/session/session-runtime.ts` (`getSessionSnapshot`). The real reload test in
`src/acp/server.test.js` checks continuation with the returned ACP ID and explicitly checks the differing metadata IDs.

Accepted [ADR-010](adr/010-session-runtime-sibling-adapters-and-acp.md) separates live and transport identities;
accepted [ADR-015](adr/015-file-authoritative-session-bundles.md) defines stable file-backed Session identity across
segments. This review does not claim that the new ACP ID is already the stable bundle ID.

## Prompt content handling

`convertAcpPromptToText()` accepts only these prompt content blocks:

| ACP prompt block | Current handling                                                        | Interop note                                                                                                        |
| ---------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `text`           | Appends `block.text` to a newline-joined text prompt.                   | Baseline supported.                                                                                                 |
| `resource_link`  | Appends `[Resource: label <uri>]` text using `title`, `name`, or `uri`. | Baseline accepted, but support is lossy because metadata is flattened into text and no resource fetch is performed. |
| `resource`       | Rejected as unsupported.                                                | Optional, gated by `promptCapabilities.embeddedContext`; RunWield does not advertise it.                            |
| `image`          | Converts base64 data and MIME type to a Runtime image attachment.       | Advertised through `promptCapabilities.image`; direct vision and `see_image` fallback use shared Runtime behavior.  |
| `audio`          | Rejected as unsupported.                                                | Optional, gated by `promptCapabilities.audio`; RunWield does not advertise it.                                      |

The Runtime receives converted text as `initialRequest` and image blocks as `initialImages`. It persists image bytes in
the Session. Vision-capable models receive them directly. Text-only models receive attachment markers and `see_image`
when `visionFallback.model` is configured. Other ACP prompt metadata is not forwarded. Built-in slash commands are
dispatched before this conversion; attachments beside a built-in command do not become model context.

### Shared commands

ACP advertises enabled built-ins, Prompt Templates, and `skill:<name>` entries through `available_commands_update` on
new/load and catalog changes. Built-in names and aliases take precedence. `/agent` opens Agent selection without a model
turn. `/model` and other supported shared commands remain usable. There is no direct thinking-level slash command in the
registry. Reasoning control is exposed through the standard ACP `thought_level` configuration option.

ACP excludes `/copy`, `/theme`, `/quit`, `/exit`, `/new`, `/resume`, and `/login`. The shared `/logout` command is
available; the distinct ACP `logout` method is not.

Evidence: `src/acp/server.js` (`buildAcpAvailableCommands`, `dispatchAcpBuiltinCommand`), `src/cmd/registry.js`, and
`src/acp/server.test.js` command/catalog tests.

## `session/update` event mapping

`src/acp/event-mapper.js` maps adapter-neutral Runtime events into ACP `session/update` notifications.

| Runtime event                                     | ACP update                                      | Current details                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message`                                    | `user_message_chunk`                            | Sends text content and message id; replay metadata remains under `_meta.runwield`.                                                                               |
| `assistant_text_delta`                            | `agent_message_chunk`                           | Sends text content and message id; agent name, message kind, workflow marker, and approval marker are extension metadata.                                        |
| `assistant_thinking_delta`                        | `agent_thought_chunk`                           | Sends text content and agent-name metadata.                                                                                                                      |
| `tool_start`                                      | `tool_call`                                     | Sends id, title, kind, status `in_progress`, raw input, and tool-name metadata.                                                                                  |
| `tool_update`                                     | `tool_call_update`                              | Sends id/title/kind/status `in_progress`, full content snapshot, and `rawOutput`.                                                                                |
| `tool_end`                                        | `tool_call_update`                              | Sends status `completed` or `failed`, full content snapshot, `rawOutput`, and duration metadata.                                                                 |
| `usage`                                           | `usage_update`                                  | Sends exact current Runtime context tokens as `used` and effective capacity as `size` only when both are known. Optional cost is cumulative for the ACP Session. |
| `plan_review_link`                                | `agent_message_chunk`                           | Sends the review-link message as text and includes Plan/review metadata under `_meta.runwield`.                                                                  |
| `agent_changed`                                   | `agent_message_chunk`                           | Sends `Active agent: <name>` only for a committed root handoff; activation and same-Agent rebuilds are suppressed.                                               |
| `system_status`, `cancellation`, `terminal_error` | `agent_message_chunk` when a message is present | Status and cancellation events without a message are dropped.                                                                                                    |
| Other Runtime events                              | no ACP update                                   | Other unmapped events are dropped; see the additional mappings below.                                                                                            |

Additional mappings in `src/acp/event-mapper.js`:

- `model_changed` and `thinking_level_changed` send readable text notices.
- `command_catalog_changed` sends `available_commands_update`.
- `interaction_resolved` and `interaction_canceled` send text when a message is present.
- Status events can carry validation progress under `_meta.runwield.validationProgress`.

The server also sends `config_option_update` after model or reasoning selection and relevant model, Agent, or reasoning
changes. Session naming, workflow context, busy/input state, task lists, and other unmapped events have no standard ACP
update here.

Runtime tool content supports text and images. ACP diffs, terminal handles, and file locations are not emitted. The
programmatic tool name is in `_meta.runwield.toolName`, not the current v1 standard `name` field. Upstream recommends
sending `name` when available, so this omission misses a protocol recommendation even though the field is optional.
Initial status is `in_progress`; this is valid for an already-running tool, not a compliance defect by itself.

Evidence: `src/acp/event-mapper.js`, `src/acp/server.js`, and
[ACP tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls).

### Usage update behavior

ACP v1 defines `usage_update.cost` as an optional object with `amount` and `currency`. RunWield keeps a cumulative USD
total on each ACP Session record. Live, setup, and replayed Runtime `usage` events add their per-message `costUsd` to
that total before mapping. The wire value is `cost: { amount: <Session total>, currency: "USD" }` when the total is
greater than zero. If no priced message exists, `cost` is omitted.

Cost is accumulated from mapped events in memory and rebuilt from replay on load. It is not a direct read of durable
Session totals; accurate totals depend on receiving each relevant usage event once.

Context reporting uses `SessionRuntime.getSessionSnapshot()` at each live, setup, or replay mapping point. A
`usage_update` is sent only when `contextUsage.tokens` is an exact nonnegative number and `contextWindow` is positive.
`used` therefore includes the Runtime's cache-aware current context total, and `size` is the effective model capacity.
The mapper does not use the latest message's `inputTokens` and does not use `used` as a fallback capacity. A missing
snapshot, `tokens: null` after compaction, or unavailable capacity suppresses the update until a later usage event has
exact values. Cost still accumulates while a context update is suppressed.

Evidence: `src/acp/event-mapper.js` (`mapRuntimeEventToAcpUpdate`), `src/acp/server.js` (`mapEventWithSessionCost` and
Runtime subscriptions), `src/acp/session-map.ts` (`addUsageCost`), and the exact-context wire test in
`src/acp/server.test.js`.

## Prompt completion and stop reasons

ACP v1 stop reasons are `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, and `cancelled`.

RunWield currently returns:

- `cancelled` when the active ACP prompt was cancelled or the Runtime reports that stop reason;
- `end_turn` for successful Runtime results;
- a JSON-RPC error (`-32002`) for `ok: false`, except when the request is queued as described below.

There is no explicit mapping for `max_tokens`, `max_turn_requests`, or model `refusal`. Do not describe ordinary
execution/provider errors as model refusals. Evidence: `src/acp/server.js`, `session/prompt` handler.

### Queued prompts are a separate gap

If another surface is running work in the same saved Session, ACP can queue the message and immediately return
`end_turn` with `_meta.runwield.queued: true`. This happens before the queued message runs. A standard client that
ignores extension metadata can mistake this for a completed turn.

The early queue path does not install the normal ACP event subscription or interaction adapter. Later execution is
therefore not covered by the ordinary streaming/question path. The managed-session integration test proves that queued
model requests run after writer release; it does not prove their output and questions reach the ACP client.

Evidence: `src/acp/server.js` (`session/prompt`, `active_elsewhere` and `managed_operation_in_progress` branches);
`src/acp/managed-session.integration.test.ts`. This conflicts with the normal
[ACP prompt contract](https://agentclientprotocol.com/protocol/v1/schema#session%2Fprompt), which returns when the turn
is complete. It needs a client-visible, truthful waiting/completion path, not only extension metadata.

## Cancellation behavior

`session/cancel` is a notification. RunWield handles it by:

1. finding the Runtime session id for the ACP session id;
2. calling `sessionMap.markCancelled(sessionId)`, which only sets the active prompt's `cancelled` flag; and
3. calling `runtime.cancelSession(runtimeSessionId)`.

`session/prompt` awaits the Runtime prompt promise. It then awaits all pending `session/update` sends. If the prompt
record was marked cancelled, it returns `{ stopReason: "cancelled" }`. The Runtime cancellation message, such as
`Agent run canceled.`, is sent before the prompt response.

A second `session/prompt` for the same ACP Session is still rejected with `-32002` while the cancelled turn is settling.
After the cancelled response is sent, the next prompt can start.

## Interactions and Plan review

RunWield's ACP interaction adapter maps Runtime interaction requests into client requests when possible.

| Runtime interaction           | Current behavior                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `select`                      | Native `elicitation/create` form with labeled choices and an optional Other-answer field.                                |
| `text`                        | Native form with an answer field, optional default, and placeholder description.                                         |
| `approval`                    | Native choice form; accepted approval values approve, other choices cancel. This is not ACP tool permission.             |
| `plan_review` / `code_review` | Sends a normal text link and waits for the RunWield browser review decision.                                             |
| `artifact_review`             | Sends the artifact link; feedback or empty acceptance uses the browser question path even if native forms are supported. |
| Pair Execution checkpoint     | Uses ordinary ACP messages across prompt turns; no form elicitation is advertised or requested.                          |
| Other interaction types       | Unsupported.                                                                                                             |

Native forms are part of the current
[v1 elicitation documentation](https://agentclientprotocol.com/protocol/v1/elicitation). RunWield does not use URL-mode
elicitation or `elicitation/complete`; its browser links are normal text plus metadata.

The adapter sends form elicitations when the client advertises `clientCapabilities.elicitation.form`. Without forms,
only `user_interview` select/text questions use ordinary ACP chat messages and later prompt replies. The question update
precedes an `end_turn` response, but the Runtime operation and Session lock remain live. The next request attaches
before the broker gets its answer. Each new question gets another ACP response. A number or unique exact label selects a
choice; other meaningful text selects Other with its complete text. Bare Other gets one text follow-up. Blank required
input and attachments do not consume the question. Cancellation, close, and process exit settle or discard this
process-local wait, not a durable suspended tool. Undelivered updates from remote answers stay on the connection for the
next request. Pair checkpoints instead end their Runtime operation.

Other no-form select/text/approval interactions use a loopback browser question page. The page needs its token and
rejects answers that do not carry the same local Origin. If the page is not available, ACP gets an actionable
unsupported response.

The non-interview browser fallback is not equivalent to native forms for Other answers. Its question payload omits
`otherOptionValue`, and its answer handler does not return `otherText`. That is a RunWield browser interaction gap, not
a missing ACP feature. Native form decline/cancel responses settle as cancellation; invalid answers return unsupported.

RunWield emits no `session/request_permission` calls. Workflow approval forms and Plan review are not substitutes for
client-controlled tool authorization. Pair checkpoints use ordinary ACP prompt turns and do not use permission requests.

RunWield does not provide an ACP-native Plan editor. Review stays in RunWield browser pages, as the
[ACP PRD](prd/runwield-acp-protocol-prd.md#product-decisions) intends. Standard ACP `plan` updates are progress lists,
not a replacement for RunWield Plan Feedback and approval.

Evidence: `src/acp/interaction-mapper.js` (`createAcpInteractionAdapter`, `requestBrowserQuestion`, `buildSchema`) and
`src/shared/session/browser-question.ts` (`startBrowserQuestionServer`).

## Error behavior

The adapter uses these JSON-RPC error codes in `src/acp/server.js`. Some are standard protocol errors, not
RunWield-specific codes.

| Code     | Name in source        | Current use                                                                                                                                                                           |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-32000` | `ACP_AUTH_REQUIRED`   | Login/default-model setup is missing.                                                                                                                                                 |
| `-32602` | `ACP_INVALID_PARAMS`  | Invalid IDs, relative `cwd`, unsupported prompt content, invalid/non-stdio MCP config, additional roots, or invalid model selection. Valid non-empty stdio `mcpServers` are accepted. |
| `-32001` | `ACP_NOT_FOUND`       | Unknown ACP Session or unable to load a saved Session.                                                                                                                                |
| `-32002` | `ACP_INVALID_STATE`   | Overlapping/rejected turns, duplicate load mapping, active-turn model change, or failed model activation.                                                                             |
| `-32004` | `ACP_NOT_IMPLEMENTED` | Registered-but-unimplemented methods.                                                                                                                                                 |

Unexpected runtime failures propagate through the ACP SDK as internal errors.

## Required and high-priority gaps

These are accuracy, compatibility, or RunWield journey gaps, not a list of mandatory missing methods. Priority is this
audit's recommendation.

| Priority | Remaining gap                                                                                                   | Why it matters                                                                                                                                                                             | Evidence                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Queued prompts return `end_turn` before execution; no normal ACP stream/question setup on the early queue path. | Clients can see a completed turn while work is still waiting. This differs from the standard prompt lifecycle.                                                                             | `src/acp/server.js`, prompt queue branches; `managed-session.integration.test.ts`.                                                                                                          |
| High     | Non-interview browser questions lose Other-answer text.                                                         | The chat fallback fixes `user_interview`, not the browser question page used by other interactions. Remote browser access remains unproven.                                                | `src/acp/interaction-mapper.js`; `src/shared/session/browser-question.ts`; [Protocol negotiation and interactions](prd/runwield-acp-protocol-prd.md#protocol-negotiation-and-interactions). |
| Medium   | Model config changes reject active turns.                                                                       | Current upstream config docs allow changes while generating. RunWield deliberately requires idle state; resolve or document this compatibility difference before a full-conformance claim. | `src/acp/server.js`, `session/set_config_option`; [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options#setting-a-config-option).                         |
| Medium   | No explicit token-limit, request-limit, or refusal stop mapping.                                                | Clients cannot reliably explain all reasons a turn stopped.                                                                                                                                | `src/acp/server.js`, prompt response mapping.                                                                                                                                               |
| Verify   | Multi-client and cross-surface journeys remain unproven by this review.                                         | Source and fixture tests do not establish successful IDE/remote workflow use.                                                                                                              | [ACP PRD: Advertised ACP conformance](prd/runwield-acp-protocol-prd.md#advertised-acp-conformance).                                                                                         |

The old negotiation, generated-version, reload, stdio MCP, cancellation-order, cost-object, reasoning-control, and
context-accuracy issues are addressed in current source and covered by `src/acp/server.test.js`. That does not close the
separate issues above. In particular, a queued model call is not proof that the client received its result.

## Optional stable v1 coverage gaps

These omissions are not baseline violations when the related capability is not advertised or the optional method is not
used. Once supported, that feature's protocol rules apply.

| Missing area                           | Current state                                                         | User value / limit                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `session/list`                         | Unsupported and unadvertised.                                         | Find existing conversations in an IDE instead of retaining IDs manually.                                                   |
| `session/resume`                       | Unsupported and unadvertised.                                         | Reconnect without history replay; `session/load` already provides continuation with replay.                                |
| Agent config option                    | Model and reasoning selection are exposed; Agent selection is not.    | A native Agent control would make existing `/agent` behavior easier to discover.                                           |
| Legacy modes / `current_mode_update`   | No `session/set_mode` or mode updates.                                | Useful only for clients that still require modes instead of config options.                                                |
| Additional directories                 | Non-empty lists rejected.                                             | Multiple repositories/roots in one Session; requires correct Core scope, not just another request field.                   |
| Embedded resources                     | `resource` blocks rejected; no `embeddedContext`.                     | Exact client-supplied file content, including content unavailable on local disk.                                           |
| Audio prompts                          | Rejected; no `audio` capability.                                      | Voice input or audio analysis; not needed for ordinary coding requests.                                                    |
| HTTP/SSE MCP                           | Rejected; only stdio accepted.                                        | HTTP enables hosted MCP tools. Upstream recommends HTTP for new Agents; SSE is deprecated by MCP.                          |
| Client file reads/writes               | No ACP filesystem requests.                                           | Editor buffers, unsaved changes, and client-side change tracking; local tools currently use the process filesystem.        |
| Client terminal methods                | No delegation or terminal handles.                                    | IDE-native command output; local command execution already exists.                                                         |
| `session/request_permission`           | Never emitted.                                                        | Client-native approval of sensitive tool calls, if RunWield adopts that interaction. Not required for every tool.          |
| Standard `plan` update                 | Not emitted.                                                          | A simple client-visible progress list; not a Plan editor or approval record.                                               |
| `session_info_update`                  | Not emitted.                                                          | Keep the displayed Session title/metadata current.                                                                         |
| Tool diffs, locations, standard `name` | No native diff/location output; tool name is extension metadata only. | Show changed files, jump to locations, and identify tools without RunWield-specific parsing.                               |
| URL elicitation / completion           | No native URL-mode requests or completion notifications.              | Better client handling of external interaction links; current browser links are text.                                      |
| Protocol `logout` / Agent Auth         | Unsupported; Terminal Auth is implemented instead.                    | Native logout or in-protocol login only where a client needs it. Terminal Auth intentionally does not call `authenticate`. |
| Boolean/grouped config controls        | Not exposed by the model-and-reasoning option builder.                | Optional presentation choices, not a need by themselves.                                                                   |

Implementation evidence: `src/acp/server.js` capability declarations and unsupported handlers,
`src/acp/model-options.ts`, `src/acp/event-mapper.js`, and `src/acp/interaction-mapper.js`. Protocol basis:
[schema](https://agentclientprotocol.com/protocol/v1/schema),
[content](https://agentclientprotocol.com/protocol/v1/content),
[Session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls), and
[config options](https://agentclientprotocol.com/protocol/v1/session-config-options).

MCP prompts remain outside the current integration (`src/shared/mcp/integration.ts`). MCP server resources are available
on request through Pi resource tools. These are MCP features, not separate mandatory ACP v1 agent methods. Provider
management, Session fork, and NES are not counted as missing stable v1 requirements here.

## Standard behavior and RunWield extensions

- `elicitation/create` form mode is standard capability-gated behavior in current v1 docs. It does not imply that every
  client supports forms or every RunWield interaction.
- `_meta.runwield` carries Session mapping, queued state, replay, tool, validation, and review details. Clients may
  ignore it. Ordinary messages and outcomes must remain useful without it.
- Browser question and review links are RunWield behavior. Local question URLs require their per-question token and
  same-origin submission. A loopback URL does not prove remote browser reachability.
- Browser Plan review remains separate from standard ACP Plan progress and tool permissions. Adding either standard
  feature would not replace the browser approval workflow.

Evidence: `src/acp/server.js`, `event-mapper.js`, and `interaction-mapper.js`; current
[elicitation](https://agentclientprotocol.com/protocol/v1/elicitation) and
[extensibility](https://agentclientprotocol.com/protocol/v1/extensibility) docs.

## Current automated coverage

The repository contains these checks. They were read, not rerun for this update.

- `src/acp/protocol-smoke.test.js`: SDK 1.4.0 imports, protocol version, elicitation names, standard `thought_level`,
  cost/usage schemas, and Terminal Auth shapes.
- `src/acp/session-map.test.js`: ACP/Runtime mapping, cancellation records, and cost state.
- `src/acp/server.test.js`: real Runtime wire tests for initialization, stdout purity, generated version, stdio MCP,
  new/load/replay, model and reasoning selection, provider-failure recovery, exact context usage, commands/catalog
  reload, forms, cancellation ordering including request ID `0`, close, event metadata, and serialized schemas.
- `src/acp/interaction-mapper.test.js`: form selection/approval, unsupported Pair checkpoints, browser cancellation, and
  origin checks.
- `src/acp/managed-session.integration.test.ts`: load across segments and queued execution after another writer releases
  the Session.
- `src/acp/segment-stable-identity.test.js`: an explicitly supplied stable ACP ID is stored separately from Pi IDs.

Important limits:

- Exact-context wire tests cover the real fixture Runtime path, but do not prove every provider's context accounting or
  complete cross-surface cost accounting.
- Queue tests do not establish ACP delivery of later output or questions.
- The stable-ID unit test supplies its own ID; the real new/load test is the evidence for client-returned IDs.
- Browser fallback tests can take an unavailable-page path. They do not prove remote access to non-interview browser
  questions. The chat interview wire tests exercise the real tool and ACP requests, not an OpenAB deployment.
- The ACP import check tests direct imports, not every transitive dependency.
- This audit did not perform live tests with multiple clients, packaged installations, or remote review links. The
  [ACP PRD](prd/runwield-acp-protocol-prd.md#advertised-acp-conformance) requires multi-client evidence before claiming
  full compliance.

Work Record search failed on a malformed record during this audit. No retrospective completion claim here depends on
that search; the cited source and test files establish the inspected state. Existing-feature gaps need stronger checks
as well as tests for any newly advertised capability.

## Suggested next work

**Opinion, not a delivery plan:** improve trust first, then make RunWield's existing strengths accessible through normal
client controls. Do not implement every optional method just to lengthen the feature list.

### Fix existing behavior first

1. Keep queued work visibly pending until its real outcome, and deliver its output and questions to the client.
2. Preserve Other answers in browser fallback and verify a complete browser question journey.
3. Improve stop reasons, resolve the active-turn config difference, and test the ordinary workflow with more than one
   real client.

These are correctness and compatibility work, not optional feature expansion. See the evidence in
[Required and high-priority gaps](#required-and-high-priority-gaps).

### High-value optional features

| Feature                                        | My recommendation                    | Why RunWield benefits                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/list` + `session_info_update`         | Highest-value Session addition.      | The same-conversation promise is easier to use when clients can find saved Sessions and show their current names. Load already supplies continuation. |
| Embedded resources                             | Prioritize for IDE use.              | File mentions should carry the exact content the user selected, not only a URI the model may or may not read.                                         |
| Agent config option                            | Extend the model and reasoning list. | Expose existing Agent choices without requiring users to learn slash commands. Preserve shared defaults and override behavior.                        |
| Tool diffs, locations, and standard tool names | Add for better IDE feedback.         | Users can inspect changes and follow file activity without custom `_meta` support.                                                                    |
| Standard `plan` updates                        | Useful after correctness fixes.      | Show a small progress list for long work. Derive it from actual workflow state; do not create another Plan or approval authority.                     |

These are optional in ACP, but I would not treat them as low-value extras for an IDE-facing coding product.

### Useful when a concrete client needs them

| Feature                  | Recommendation                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client filesystem reads  | Valuable for unsaved editor buffers. Embedded resources can cover explicitly attached content first; client reads cover later Agent-initiated reads.                              |
| Client filesystem writes | Add only with clear handling of editor buffers, worktrees, and saved files. Native editor tracking is useful, but blindly redirecting all writes could target the wrong checkout. |
| HTTP MCP                 | Worth adding for hosted tools. Prefer it over legacy SSE; current upstream guidance recommends HTTP even though it is optional.                                                   |
| Tool permission requests | Useful if sensitive tool operations need native client approval. Keep this separate from Plan approval and verify client handling before relying on it.                           |
| URL elicitation          | Useful for client-native external-interaction handling. It does not by itself make localhost review links remotely reachable.                                                     |
| Additional roots         | Add when real multi-repository work requires it; preserve one clear project/worktree context.                                                                                     |
| `session/resume`         | Add if replay is measurably slow or a target client requires no-history reconnect. It is not needed to continue a Session today.                                                  |

### Truly optional for current RunWield use

- **Audio:** defer unless voice/audio work becomes a real need; text and screenshots cover the usual coding journey.
- **Client terminal delegation:** local execution and tool output already exist. Add only for a demonstrated IDE
  terminal or remote-execution need.
- **Legacy modes:** prefer config options. Add `session/set_mode` only for a target client's compatibility; upstream
  says config options supersede modes and recommends both during transition when exposing mode-like settings.
- **SSE MCP:** defer legacy transport unless a required server supports nothing else; prioritize HTTP.
- **Additional auth flows/native logout:** Terminal Auth and shared commands cover the current local setup. Add another
  flow only when a client cannot use that route.
- **Boolean/grouped config controls:** choose them only for an actual setting or a large option list.
- **MCP prompts/resources, provider management, fork, and NES:** assess separately when needed; none should block the
  advertised v1 path merely because the SDK contains related APIs.

Keep browser Plan review. The missing standard progress display is worth adding; replacing RunWield's review and
approval workflow with a custom ACP Plan editor is not necessary.

Recommendation basis: the inspected behavior above; the
[ACP PRD's Session-continuity and browser-review goals](prd/runwield-acp-protocol-prd.md); accepted
[ADR-010](adr/010-session-runtime-sibling-adapters-and-acp.md) and
[ADR-015](adr/015-file-authoritative-session-bundles.md); and the linked upstream optional-capability rules.

## Related documents

- [RunWield Session Host and ACP Integration PRD](prd/runwield-acp-protocol-prd.md)
- [ADR-010: SessionRuntime Sibling Adapter Boundary for ACP](adr/010-session-runtime-sibling-adapters-and-acp.md)
- [SessionRuntime and ACP v1 stdio MVP Work Record](work-records/2026-07-17-sessionruntime-and-acp-v1-stdio-mvp.md)
