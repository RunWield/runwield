---
status: accepted
---

# ADR-010: SessionRuntime Sibling Adapter Boundary for ACP

## Context

ADR-009 established Session Host as the external integration boundary and moved session-scoped runtime state into
`HostedSession`. After the Slice 1 refactor, the TUI is no longer supposed to own root session lifecycle, but important
turn orchestration, UI prompting, event rendering, and handoff loops still live near the interactive TUI adapter.

RunWield now needs ACP support without making ACP a wrapper around TUI code. Future clients such as Workspace WebUI,
Takopi/Telegram, IDE integrations, and other transports should attach to the same core runtime surface as the TUI.

## Decision

Introduce a `SessionRuntime` layer above `SessionHost`/`HostedSession` and below all user-interface adapters.
`src/shared/session/session-runtime.ts` is its sole public source surface. Private TypeScript owners under
`src/shared/session/runtime/` divide events, queues, managed operations, lifecycle, turns, reads, settings, workflow,
image, and local-shell behavior without exposing those implementations to consumers. `SessionRuntime` owns
adapter-neutral session operations such as create, load, prompt, cancel, close/dispose, event emission, and interaction
requests. The TUI and ACP stdio server are sibling adapters over `SessionRuntime`; future WebUI, Takopi, Slack/Discord,
or other clients should be additional siblings rather than children of the TUI or ACP adapter.

Session-scoped capabilities must attach to a specific `HostedSession`. Shared agent switching and pending root-swap
application are session-layer behavior, not TUI behavior, so core workflow modules and tools should use a session-layer
helper rather than importing the TUI adapter. Adapter-specific rendering, transport framing, and user input collection
stay outside the core runtime. The ACP adapter maps `SessionRuntime` events and interaction requests to ACP v1 messages,
using standard ACP primitives where possible and RunWield-specific ACP extensions/fallbacks where no standard primitive
exists.

The command registry owns shared built-in command names, aliases, descriptions, hints, and surface availability. ACP and
Workspace consume that registry instead of keeping separate command policy, while TUI-only presentation and process
controls stay unavailable outside the TUI. Built-in names remain reserved before prompt-template or Skill expansion.

Pair checkpoints are normal multi-turn Session conversation on TUI, Workspace, and ACP. Adapters render the checkpoint
report through the ordinary event stream and accept follow-up messages through their normal prompt path. They do not
advertise or collect a Pair checkpoint form. The shared runtime restores the durable checkpoint and execution context
before root Agent activation. Background Task completion is generated Session input, not a user follow-up: it does not
resolve the checkpoint or answer an interaction.

The Hosted Session owns a bounded, process-local Background Task registry independently of a disposable root Agent turn.
SessionRuntime schedules completed results through root-targeted steering or managed generated turns; adapters show
those turns in the existing conversation. The shared runtime rejects the first eligible `task_completed` call while
Background Tasks run and reports their IDs and kinds. It explains that the next eligible call cancels remaining tasks
and accepts completion. Every accepted completion suppresses pending and queued task results, even when no tasks run;
normal turn settlement still permits result delivery. Cancellation is not successful test evidence, and later work may
start new tasks. ACP may emit updates after an earlier prompt response, without extending that response or fabricating a
client request. Workspace can keep its Session owner while tasks remain after a browser tab closes. Neither adapter
takes over task control from another process.

Each Hosted Session carries an absolute project root. Shared catalogs, layered settings, Plans, workflow metrics, memory
commands, validation, and Worktree operations resolve from that root rather than the server process cwd. A Hosted
Session id is an in-process runtime identity and is deliberately distinct from both persisted SessionManager ids and
transport-facing ACP session ids, so loading the same persisted conversation never aliases mutable runtime state.

Adapters consume ordered semantic events and install a typed interaction adapter. They do not pass a rendering object to
`createPromptReadySession()`, `loadSession()`, or `promptSession()`. During the remaining workflow migration,
`SessionRuntime` owns a private compatibility presentation port that translates legacy engine output calls into the same
event stream; this port is not an adapter extension API. New UIs should use `getSessionSnapshot()`, runtime events,
runtime actions, and interaction requests only.

## Consequences

- ACP must not import or call `src/ui/tui/chat-session.js` TUI internals to submit prompts.
- TUI-specific orchestration that is actually session behavior should move into `SessionRuntime` or lower-level shared
  modules.
- Adapter-neutral event and interaction contracts become first-class and reusable by future WebUI/Takopi integrations.
- The first ACP MVP carries medium complexity because it includes the shared runtime seam, not just JSON-RPC method
  handlers.
- Rich external workflow UX can evolve incrementally on top of the interaction contract without requiring another
  TUI-to-core refactor. ACP uses native forms when the client advertises them. Otherwise, all select, text, and approval
  questions, including command menus, use ordinary chat messages. Built-in commands and Agent turns share one live
  operation: the ACP response for a question ends before the Runtime operation does, and the next ACP prompt answers
  through the existing broker. This adapter presentation creates neither a new Session nor a new workflow authority.
  The generic path avoids command-specific fallbacks and works where loopback question pages cannot be reached. Menus
  require a number in range or a unique exact label/value match, trimmed and case-insensitive; only unmatched `cancel`
  cancels a menu. Text and `user_interview` retain their own answer rules. Plan, Code, and Artifact Review keep browser links, and the Artifact Review feedback
  decision keeps its browser question page.
- Same-session turn exclusion and cancellation settlement are runtime invariants. Cancellation does not release the turn
  or permit disposal until the underlying Agent Session prompt settles; different Hosted Sessions remain independently
  promptable.
- Production modules under `src/shared` and `src/tools` cannot import `src/ui` or `src/acp`; automated boundary tests
  enforce the dependency direction.
- TUI composition, terminal integration helpers, and their tests live under `src/ui/tui`. The `src/shared` tree is
  reserved for reusable runtime, session, model, workflow, Plan, tool-support, and platform policy.
- Core requests user attention through semantic runtime events. Desktop notification delivery and terminal activation
  are TUI adapter behavior, so ACP or future server adapters never target the host terminal implicitly.
