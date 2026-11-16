# PRD: RunWield Session Host and ACP Integration

**Document role: Living central PRD.** Principles and lasting requirements for ACP clients, including first-party
Workspace access, external-client compatibility, and chat-channel integration.

Keep this document as current product guidance. Fold lasting requirements from completed feature PRDs here;
implementation steps belong in Plans, architectural choices in ADRs, and delivery evidence in Work Records.

**Status:** Working ACP integration with JetBrains AI Chat, the Air plugin, and OpenAB chat workflows\
**Author:** Gandazgul + RunWield Ideator\
**Last Updated:** 2026-11-01

---

<a id="1-objective"></a>

## Objective

Make RunWield usable from external clients through **Agent Client Protocol (ACP)** with the same conversations, Agent
behavior, and Plan workflows available in the TUI.

**Current compatibility (owner confirmed 2026-10-06):** JetBrains AI Chat and the Air plugin can drive RunWield. OpenAB
works end to end with Discord, Slack, and its other supported chat platforms. Other ACP-compatible clients are expected to work
through the same protocol. Internal conformance checklists do not make these working integrations future scope.

The continuing product requirements are:

1. **OpenAB/Telegram compatibility:** one trusted operator can complete and recover a RunWield workflow through
   Telegram, using OpenAB as a replaceable reference ACP client.
2. **Full ACP v1 compliance:** supported capabilities behave according to the protocol and interoperability claims are
   backed by evidence independently of Telegram.

Personal Workspace and ACP share the same user outcome: the owner can continue a saved Session from another screen
without closing an idle client. Neither channel introduces a separate conversation or approval model.

OpenAB is a replaceable validation host for the personal ACP workflow.

<a id="2-problem-statement"></a>

## Problem Statement

RunWield began as a TUI-first product. External-client support must prove more than sending a prompt: users need
progress, structured questions, browser Plan review, execution, validation, cancellation, and useful recovery after
interruption.

The [ACP implementation audit](../acp-implementation-details.md) records current capability coverage and remaining gaps.
Those gaps are delivery work, not permanent product restrictions.

OpenAB is the selected reference chat host because it connects chat channels to ACP. A RunWield-owned multi-channel
gateway is deferred until a demonstrated product need justifies it.

<a id="3-product-decisions"></a>

## Product Decisions

- ACP is the external-client contract; clients should not need bespoke RunWield integrations for ordinary workflows.
- OpenAB is the first reference chat host and remains replaceable. Prefer generic upstream contributions; a passing,
  reviewed contribution branch plus an open PR is sufficient for the first proof.
- OpenAB supports end-to-end personal workflows through Discord and its other supported chats.
- Use standard or generic ACP interactions where supported. Unsupported interactions must be visible rather than
  silently answered.
- Plan review remains in the browser. Telegram delivers the link and reports feedback or approval outcomes.
- Telegram access and Shared Plan links have separate permissions. No account-linking system is required.
- External clients preserve RunWield's execution, worktree, validation, and recovery behavior.
- Interrupted work with uncertain effects requires an informed next action; loading a Session does not authorize blind
  repetition of commands.

<a id="4-architectural-references"></a>

## Architectural References

- [Runtime and adapter boundaries](../adr/010-session-runtime-sibling-adapters-and-acp.md)
- [Session continuity](../adr/014-file-authoritative-session-bundles.md)
- [Protocol coverage and implementation details](../acp-implementation-details.md)

## Capability Requirements

ACP owns protocol access, external-client compatibility, and channel-specific journeys. Shared Session and Plan behavior
is owned by Core; Workspace owns the first-party desktop/browser journeys.
Stage labels below are delivery scope, not new lifecycle states or claims of shipped interoperability.

- [ACP Session access](#acp-session-access)
- [Protocol negotiation and interactions](#protocol-negotiation-and-interactions)
- [Workspace client access](#workspace-client-access) — development Project/Session slices; full workbench target
- [Chat workflow access](#telegram-workflow-access)
- [Interrupted-work recovery](#interrupted-work-recovery)
- [Reference-client portability](#reference-client-portability)
- [Advertised ACP conformance](#advertised-acp-conformance)

<a id="5-product-surface"></a>

### ACP Session access

**Scope and maturity:** Working Session access through JetBrains AI Chat, the Air plugin, and OpenAB. Other
ACP-compatible clients are expected to work through the same advertised protocol.

**Requirement: Load and continue the same Session through compatible clients.**

`wld acp` and `wld --mode acp` expose RunWield to ACP clients. The core experience includes Session creation and
loading, text and resource-link prompts, cancellation, closing, history replay, Agent and tool progress, usage, Plan
links, advertised slash commands, and structured questions. ACP executes all shared slash commands except `/copy`,
`/theme`, `/quit`, `/exit`, `/new`, `/resume`, and `/login`. A bare `/agent` opens Agent selection and is never routed
as a model request. Compatibility documentation must clearly state the capabilities actually available. A Background
Task may finish after an ACP prompt response has ended: the same live ACP Session emits subsequent result-turn updates
without a second client prompt or another response to the original request. Task limits and process-local ownership
follow [Core Session continuity](runwield-core-prd.md#session-continuity); loading after process exit restores saved
history, not a running task.

**Requirement: Treat ACP deletion as reversible archive.**

RunWield implements `session/delete` as the shared [Core archive state](runwield-core-prd.md#session-continuity), not
transcript deletion. It resolves a mapped or persisted ACP Session ID to the stable RunWield Session, including IDs
based on a Pi segment. The explicit request confirms stopping busy work: RunWield cancels through the owning Runtime or
live connection and waits for authoritative settlement before committing archive state and removing the mapping. Failure
to stop, settle, or persist returns an error instead of archive success. Successful, repeated, or unknown-ID deletion
returns `{}`. `session/close` only releases live resources; it does not archive. Workspace
[Project settings](runwield-workspace-prd.md#project-access-and-navigation) offers Unarchive; ACP `session/list` remains
unsupported.

**Requirement: Select models and reasoning levels through the client's native controls.**

New and loaded ACP Sessions expose the available models and active selection through standard `configOptions`.
Reasoning-capable models also expose the current reasoning level through the standard `thought_level` category.
`session/set_config_option` applies either choice to the same Session without making a model request or changing
defaults for future Sessions. Model, Agent, and reasoning changes keep the complete client selection current. Models
without reasoning support do not expose a reasoning selector. After a provider failure settles, the user can select an
available alternative and continue the conversation.

Shared requirements: [Core Session continuity](runwield-core-prd.md#session-continuity),
[Plan review](runwield-core-prd.md#plan-review),
[execution and recovery](runwield-core-prd.md#execution-validation-and-recovery), and
[local workflow metrics](runwield-core-prd.md#usage-measurement-and-export). ACP adapts these outcomes rather than
defining another lifecycle.

**Acceptance scenarios:**

- Given JetBrains AI Chat or the Air plugin configured to use `wld acp`, the user can drive RunWield workflows from that
  client while retaining RunWield planning, review, execution, and validation.
- Given OpenAB connected to Discord or another supported chat platform, the user can complete the RunWield workflow end
  to end from that chat, following browser review links when needed.
- Given a no-form ACP chat client and two saved Plans, `/load-plan` (or its `/load-plans` alias) lists numbered Plan
  choices in chat without a loopback question link or form request. Replying `2` loads the second Plan and shows its action menu.
  This also works when OpenAB sends a separate `openab.sender.v1` sender-context block before the numeric reply. Replying
  `View plan details` shows the summary and menu again. Replying `Cancel` ends the command without changing the Plan
  file; a later ordinary prompt reaches the model.
- Given `/load-plan` starts an Agent turn through Resume planning, its `user_interview` questions arrive in chat and
  replies reach the same waiting tool with the interview answer rules.
- Given `/agent` in a no-form client, replying with the exact value `guide` switches to Guide, sends one Agent-change
  notice, and updates the native configuration selection. `/model` and other command menus use the same chat path.
- Given another ACP-compatible client, ordinary workflows use the advertised protocol without a client-specific fork.
- Given a mapped or persisted ACP Session ID, when the client sends `session/delete`, it receives `{}` and the owning
  stable Session is archived with all transcript segments and Plan Associations intact. Repeating the request or
  deleting an unknown ID also returns `{}`.
- Given busy work owned by ACP or another RunWield surface, `session/delete` confirms Stop and waits for settlement
  before archive. A stop or persistence failure returns an error without claiming success.
- Given a saved Session, `session/close` releases its live resources without changing archive state. Explicitly loading
  an archived Session restores its saved conversation without unarchiving it.
- Given a Session created through ACP, when the process exits and a compatible client loads the returned Session
  identifier, it reaches the same saved conversation.
- Given the same Session open in an idle TUI, when an ACP client continues it, the open screen does not reserve it or
  create another conversation.
- When a client receives Plan links without RunWield-specific presentation metadata, the ordinary text links remain
  usable.
- Given a live Plan review, when the ACP client sends `/plan-review`, the response includes its current browser link as
  text when available, or reports that it is starting, rather than opening a second review. Given an idle Session with a
  previous review, the same command requests a new review of the current saved Plan under
  [Core Plan review](runwield-core-prd.md#plan-review), not a replay of a pending interaction.
- Given no previous review, busy work, or a missing, replaced, or ineligible Plan, when the ACP client requests
  `/plan-review`, it receives an explanation instead of an automatic approval or a stale review link.
- Given a new or reloaded Session in Discord through OpenAB, `/models` presents model choices and the current model.
  Selecting a model makes the next message use it in that same conversation, including after a provider limit error.
- An invalid model or reasoning choice, an unsupported reasoning choice, or a choice submitted during an active turn
  fails visibly without changing the Session configuration.
- Given a reasoning-capable model, when the user selects a reasoning level, the next message uses it in the same
  conversation and the choice remains current after reload.
- When `/model`, an Agent switch, or a reasoning change updates the active Session, the client receives the complete
  current selection.
- Given an ACP Agent starts a Background Task, when its original `session/prompt` ends before the task, the client
  receives the later result as updates in that same live Session without sending another prompt. Reopening the Session
  in a new process restores delivered history but does not restart the task.
- Given slash commands or agent turns executed via ACP with `workflowMetrics` enabled, RunWield records ordered command
  and execution observations under the primary project without sending metrics payload bytes over the ACP client
  protocol.

<a id="63-acp-compatibility-requirements"></a>

### Protocol negotiation and interactions

**Scope and maturity:** Current interactions support working external-client and OpenAB workflows. The dated
implementation audit retains technical observations, not a pending gate for user-facing availability.

**Requirement: Negotiate capabilities and settle interactions truthfully.**

Stage 1 proves the reference journey through the shared Session experience. Protocol requirements include:

- The standard `sessionId` returned by `session/new` remains loadable after the `wld acp` process exits and maps to the
  same saved RunWield Session.
- `initialize` negotiates the supported protocol version instead of echoing unsupported versions.
- Session creation and loading reject malformed MCP server configuration with an invalid-parameters error. They do
  not silently discard requested tools and report success.
- `usage_update.cost` uses the ACP cost object shape with cumulative USD Session cost. `usage_update.used` and `size`
  come from the Runtime's exact current context usage and effective capacity. If either value is unknown, RunWield does
  not send a context update or substitute a local estimate.
- ACP supports continuing the same saved Session used in TUI or Workspace. An idle open client does not prevent another
  client from continuing it. If work is currently running, the client reports that state without losing the user's
  input. Session storage and writer coordination follow ADR-015.
- Cancellation waits for Runtime settlement and final mapped updates before `session/prompt` returns `cancelled`.
  Cancelling a live Session also stops its owned Background Tasks; it does not send a late generated result turn.
- ACP sends `available_commands_update` for enabled built-ins, prompt templates, and Skills. Built-in names and aliases
  have precedence over prompt resources, including built-ins unavailable on ACP.
- Clients that advertise `clientCapabilities.elicitation.form` receive native forms for select, text, and approval
  interactions before any chat fallback. Without forms, these interactions, including all command menus and workflow
  questions, appear as chat messages answered by the next user message. No OpenAB form contribution is required.
- Pair Execution uses ordinary ACP prompt turns and messages, not form elicitation. A checkpoint report ends one ACP
  request; questions and a later natural-language decision continue the same saved Session and execution context.
- Each no-form chat question ends its ACP request with `end_turn` while the Runtime command or tool and Session writer
  lock stay live. The next prompt answers through the existing broker, not a new Agent turn. A lost process requires
  retry.
- Non-interview select and approval menus accept a number in range or a unique exact option label or value, trimmed and
  matched case-insensitively. A reply of `cancel` cancels the menu only when no option matches it. An invalid or ambiguous
  reply, including a slash command, leaves the menu waiting and repeats it with the reply rule. Approvals with no
  supplied options show Yes and No for accept and decline; approval choices retain their defined accept/cancel meaning.
- Chat replies exclude standalone `<sender_context>` text blocks that contain valid `openab.sender.v1` JSON metadata.
  Metadata alone, malformed metadata, multiple conflicting answers, and unsupported attachments do not select a menu option.
- Non-interview text questions accept nonblank text. `cancel` is ordinary text, not menu cancellation. Blank input and
  unsupported attachments do not answer chat questions.
- `user_interview` rules stay distinct: a number or unique exact label selects an option; other meaningful text selects
  Other with its full text. Bare Other gets one text follow-up. Blank required input and unsupported attachments do not
  answer. `cancel` remains an ordinary interview answer, not a cancellation word.
- Form cancellation, decline, and presentation failure settle the pending interaction so the same Session can accept
  another message without a manual cancel or reset. Multiple-choice forms preserve their labeled choices.
- Choice interviews include an optional Other-answer text field in the same ACP form. Selecting Other uses that text and
  requires a nonempty answer; selecting a listed choice ignores the text field.
- Unsupported interaction capabilities fail visibly and safely rather than selecting a default.
- Plan, Code, and Artifact Review keep browser review links. Artifact Review feedback, including empty acceptance,
  keeps its browser question page even when forms are supported. These review decisions do not use the generic chat
  fallback. Review links remain useful as normal text even when a client ignores `_meta.runwield` enhancements.
- Agent notices follow [Core conversation behavior](runwield-core-prd.md#tui-conversation): announce a real Agent switch
  once, without repeating it for activation, commands, or same-Agent rebuilds.
- Black-box compatibility coverage exercises the actual ACP wire behavior OpenAB depends on.

**Requirement: Admit mid-turn steering through the shared Runtime.**

RunWield supports `_session/steering` following Claude's ACP adapter extension, not an ACP v1 standard. Initialization
advertises top-level `_meta.steering.supported: true`. A supporting client can send steering without waiting for the
running prompt. Input uses ordinary ACP content conversion and the same Runtime steering owner as TUI and Workspace,
including Agent Handoff delivery.

`injected` confirms admission, not model consumption. A consumed message appears as `user_message_chunk`; its answer
uses a new assistant message ID and completes within the original prompt. Idle steering always returns
`promptRequired` with `noRunningTurn`, without queueing or delivering input. A waiting no-form question instead returns
`promptRequired` with `questionPending`, so the next ordinary prompt answers it. RunWield does not start a detached turn
from steering. Invalid parameters, unknown Sessions, and failed delivery return errors rather than claiming admission.
A waiting question takes precedence over slash-command detection; otherwise slash commands return errors. Normal
overlapping-prompt rejection and cancellation settlement remain unchanged.

OpenAB's immediate steering delivery and Discord reply placement are target client behavior; support for the extension
in RunWield does not establish OpenAB interoperability.

`session/resume` is not required for this stage. Correct durable `session/load` behavior is the interoperability
requirement.

**Acceptance scenarios:**

- Initialization advertises steering at top-level `_meta.steering.supported` in a schema-valid response.
- Given a running ACP turn, steering returns `injected` before the original prompt settles. The next model request
  includes the correction once, chat shows one consumed user message, and a new assistant message ID carries the reply
  before the original prompt ends.
- Given an idle Session, steering returns `promptRequired` with `noRunningTurn` and makes no model request. A later
  ordinary prompt delivers the same input once.
- Given a waiting no-form interview, steering returns `promptRequired` with `questionPending` without bypassing the
  question. A later ordinary prompt answers it.
- Empty prompt arrays, missing Session IDs, unsupported idle behavior, and unknown or closed Sessions fail visibly
  without delivering their text to the model. Slash commands also fail unless a waiting question owns the reply.
- When a client requests an unsupported protocol version, initialization negotiates supported behavior instead of
  pretending that version is supported.
- Given a no-form ACP client, when `user_interview` asks three questions, each reaches chat before its ACP response.
  Later prompts answer them in order without another Agent turn. The same tool returns ordered typed answers, including
  full Other and text answers. Defaults do not answer for the user.
- Given a no-form select, text, or approval question, it appears in chat without a loopback question URL. A later user
  message answers that same live interaction. Plan, Code, and Artifact Review still use browser links, and Artifact
  Review feedback still uses its browser question page.
- Given a waiting Plan picker, replies `9` (out of range), `banana`, and `/agent` each produce one did-not-match message
  that repeats the menu and reply rule. A later `1` still loads the first Plan. Case and surrounding whitespace do not
  prevent an exact unique label or value match; ambiguous matches do not select an option.
- Given a menu with no option matching `cancel`, replying `cancel` settles it as canceled without selecting a default.
  A matching Cancel option instead keeps that option's meaning. Text and interview questions treat `cancel` as an
  ordinary answer. With workflow metrics enabled, a canceled command records `canceled` when it settles.
- Given a waiting command menu, `session/cancel` settles the command before another prompt can start. The next ordinary
  prompt is accepted, and enabled workflow metrics record the command outcome as `canceled`.
- Given a no-form approval with no supplied options, the menu shows Yes and No; replies `1` and `2` map to accept and
  decline. Given a non-interview text question, a nonblank reply answers it; blank input and attachments leave it waiting.
- Given a client advertising forms, `/load-plan` uses `elicitation/create` for its Plan picker without chat menu text.
  Native interview forms retain their optional Other-answer field.
- When the user cancels a live turn, final updates and cancellation settle before the turn is reported available for
  another request. A task result that arrives after cancellation does not produce a new ACP turn.
- Given a result-driven ACP turn after the previous prompt returned, its updates and any required interaction use the
  same Session protocol channel; no extra response is sent for the earlier prompt, and task output cannot supply a user
  answer to an interaction.
- When a user cancels or declines an interview form, or the client reports that it expired, the pending turn settles and
  an ordinary follow-up message receives a response in the same Session.
- When an interview asks a multiple-choice or yes/no question, the form presents the supplied choices, Other, and an
  optional Other-answer field. Submitting Other with text returns that answer without a second form; submitting a listed
  choice ignores stray Other text. Blank Other submissions record no answer.
- When the client displays usage, `used` includes the Runtime's current context tokens, including cache counts, and
  `size` is the effective context window. After compaction or another unknown state, no estimated or false full-window
  update appears; a later exact Runtime value restores the update.
- When the client displays cost, the advertised ACP shape and cumulative USD Session cost are accurate.
- Given Pair Execution through ACP, the increment report returns `end_turn`. Later prompt requests can discuss it and
  then resolve it without a Pair form; final completion still requires a later accepted user turn.

### Workspace client access

**Scope and maturity:** The source-development desktop Session client controls a separate source `wld acp` subprocess
through a persistent SDK 1.4.0 / ACP v1 connection. Create, known-ID load, text prompts, streamed updates, form
elicitation, Stop, and close use an explicit Core-admitted Project binding. The version 1 Workspace Project group
implements list, open, register, relink, enable/disable, remove, and rescan on that same connection. Session discovery,
provider-independent history, and full-workbench parity remain targets. See
[Desktop Workspace](runwield-workspace-prd.md#desktop-workspace), accepted
[ADR-020](../adr/020-electron-workspace-acp-client.md), and the
[protocol baseline and capability inventory](../desktop-workbench-contract.md).

Shared UI serves desktop now and future hosted SaaS. The old local browser workbench still constructs its runtime in
its server and remains supported during this child; it will not be migrated to ACP. Standalone question, review, and
document hosts and Plan sharing survive the later cutover. Remote access and hosted identity remain future scope.

**Requirement: Carry the full workbench through the runtime contract.** A Workspace client can discover admitted
Projects and saved Sessions, read bounded history and current observations, converse, configure supported choices,
answer interactions, and perform revision-checked artifact/review/workflow operations without hosting Core execution
or writing canonical lifecycle state itself. Existing Core services own validation, access checks, request receipts,
writer exclusion, persistence, and recovery. Desktop and future hosted SaaS share UI; this does not select the hosted
transport or identity architecture.

**Requirement: Prefer standard ACP and negotiate the remainder.** Use standard capabilities where they cover an
operation, including Session discovery when supported by the selected baseline. Remaining workbench features are
explicitly advertised, versioned extensions. Missing required capabilities are explained before dependent mutations.
Extensions that anticipate ACP v2 follow its semantics where practical while v1 interoperability remains supported;
draft alignment is not a v2 conformance claim. No client must understand Workspace extensions for ordinary ACP work.

Workspace opt-in fixes admission policy for the connection. Core issues its identity and checks connection,
registration, and canonical-root agreement on Session operations, plus saved-Session membership on load. Missing or
stale metadata cannot fall back to ordinary cwd access. Disabled, removed, relinked, or unavailable roots refuse new
effects; owned Stop/close can still settle work with its original binding. Project management uses registration IDs,
so unavailable roots remain manageable. A picker or launch argument is only a candidate. Ordinary external ACP
clients retain registration-free cwd behavior. Exact payloads and structured refusals are in the
[Project protocol contract](../desktop-workbench-contract.md#workspace-project-protocol-version-1).

**Requirement: Recover observations without repeating effects.** A client can rebuild a current view after a dropped
subscription or process interruption. Stable runtime/Project/Session identity and authoritative revisions prevent
cross-host aliasing, stale decisions, and duplicate effects. Transport reconnect never independently grants permission
to replay a prompt or workflow action. File and review resources stay scoped to the selected runtime.

**Requirement: Distinguish authentication domains.** Core model-provider configuration is independent of a future
Workspace account and of remote-host trust. Local ACP use does not require hosted Workspace identity. Runtime network
transport, authentication, and disconnect semantics are separately specified before claiming remote support.
Current desktop model work reads existing Core credentials and global/Project/linked-worktree defaults in place.
Missing setup directs users to external `wld login`, then restart; no credentials enter renderer views or storage.
In-app setup belongs to [child 10](../plans/local-workspace-desktop/configure-model-providers-in-desktop-settings.md).
Provider-independent history and Archived Sessions belong to
[child 3](../plans/local-workspace-desktop/continue-saved-sessions-in-desktop.md), not a model-dependent load workaround.

**Acceptance scenarios:**

- **Current development slice:** List Projects without a model or registration. Register/relink requires bound consent
  for protected directories before writes. Manage missing/disabled roots by ID; removal preserves files and history.
- **Current development slice:** A raw opted-in ACP request with missing, foreign, stale, disabled, or mismatched
  Project context fails before effects. Load rejects another Project's saved Session; owned Stop/close still settles
  after access withdrawal. A separate ordinary ACP connection continues without registration.
- **Current development slice:** Unsupported Workspace versions fail before mutation and cannot fall back. ACP/shared
  runtime code has no executable import path into Workspace server modules; browser adapters use shared Core owners.
- **Current development slice:** Existing Core defaults and credentials drive model work without rewritten settings.
  Missing defaults explain external setup and leave Project management usable, not gated by Workspace identity.
- **Current development slice:** A native desktop client streams a real source-runtime turn, returns an exact choice
  and optional Other text through the pending form request, stops a held stream or question, then accepts another turn.
  Main launches the checkout runtime, not a global CLI; neither main nor shared UI constructs `SessionRuntime`.
- **Current development slice:** Close and reopen the process, load a known ID, and continue the same committed history.
  Replay arriving before the load response is retained once. Connection loss shows interruption and does not replay input.
- **Current development slice:** Stop or Close during a pending non-turn command form cancels its client request and
  settles the command before availability is reported. This does not expand request-context cancellation semantics.
- **Current development slice:** Incompatible peers fail before dependent new/load/prompt mutations; unsupported forms
  fail visibly. These checks do not establish full ACP conformance. Scoped evidence is in the
  [engineering contract](../desktop-workbench-contract.md#acceptance-evidence).
- **Full-workbench target:** A desktop client completes Session and integrated Plan review through the runtime contract
  without hosting Core execution or mutating canonical workflow state itself.
- **Full-workbench target:** A client discovers persisted Sessions, reads bounded history, and continues one also
  visible in an idle TUI; history and current settings agree with Core's committed state.
- An older runtime lacks a required workbench capability; the client explains incompatibility and sends no dependent
  mutation. An ordinary external ACP client continues working without the extension.
- A duplicate action, stale revision, or wrong-Project Session reference receives the same authoritative rejection or
  recorded result through either UI host, without a second execution.
- After lost observations, the client refreshes current evidence without duplicated transcript entries or replaying
  uncertain work. Provider setup failures identify provider setup rather than demanding Workspace cloud sign-in.

<a id="62-required-user-journey"></a>

### Chat workflow access

**Scope and maturity:** Working end-to-end personal workflows through OpenAB with Discord and its other supported chat
platforms, confirmed by the owner on 2026-10-06. The Telegram journey below is a representative channel scenario, not a
restriction on currently working channels.

**Requirement: Carry the authorized operator through the shared Plan workflow.**

The authorized operator can reach the same RunWield planning, review, execution, and validation workflow through
Telegram. Plan review remains in the browser; Telegram supplies useful links, progress, questions, and outcomes. Channel
access and Shared Plan permissions remain independent.

#### Telegram workflow access

The representative chat workflow lets the operator:

1. Submit a bounded FEATURE User Request in Telegram.
2. Start a new RunWield Session or reload the durable Session associated with the chat.
3. Receive streamed Agent messages, tool progress, relevant status, and actionable failure information.
4. Answer select, text, and approval questions, including command menus, through native forms when supported or chat
   otherwise, following the [interaction reply rules](#protocol-negotiation-and-interactions). Browser reviews and the
   Artifact Review feedback question remain separate.
5. Receive the public Shared Plan URL in Telegram.
6. Submit Feedback or approve the Plan in Plannotator.
7. Resume the same Session after approval and execute the Plan in a RunWield-owned worktree.
8. Receive execution and Workflow Validation progress and the terminal outcome in Telegram.
9. Cancel a live turn and receive its settled final updates before the turn is considered available again.
10. Restart OpenAB or `wld acp`, reload the same durable session, and continue without losing settled conversation
    history.
11. Recover safely when the process fails during Plan execution.

**Acceptance scenarios:**

- Given an unauthorized Telegram user, when they contact the bot, they cannot start or mutate the configured RunWield
  Session.
- Given the allowed operator, when they follow a Plan link and submit feedback or approval in the browser, the same
  waiting Session receives the outcome without account linking.
- When a bounded planned change completes its checks and delivery, Telegram reports the actual outcome rather than
  treating an Agent’s completion message as verification.

<a id="64-recovery-and-retry-requirement"></a>

### Interrupted-work recovery

**Scope and maturity:** Shared recovery requirements apply to current ACP workflows.

**Requirement: Preserve partial work and avoid uncertain replay.**

After a process failure, the user can reopen saved history and see whether associated Plan work was interrupted.
RunWield preserves partial work and automatically reconciles its own locks, settings, storage, and Plan synchronization.
It offers applicable actions such as continue, reopen for review, hold, or deliberately abandon. Only unresolved
external uncertainty or a consequential user decision requires the operator's choice; internal repair stays hidden.

The [Core completion requirement](runwield-core-prd.md#execution-validation-and-recovery) applies through ACP: confirmed
publication or deliberate abandonment are the only delivery conclusions. Protocol turn cancellation, process loss,
failed attempts, and retry limits do not abandon the workflow.

Continuing uses the current Plan and preserved work. It must not silently delete changes, repeat uncertain operations,
or submit a duplicate request. If the process handling a live question has stopped, explain that the question needs to
be retried. Exact continuation of an interrupted token, tool call, or command is outside this promise.

**Acceptance scenarios:**

- When OpenAB and RunWield restart between settled turns, the chat can return to the same saved Session and history.
- When execution is interrupted, reopening preserves partial work and automatically reconciles available evidence;
  remaining external uncertainty requires an informed choice without blindly repeating a command or deleting changes.
- When the process handling a live question is gone, the client explains the need to retry while retaining saved
  conversation.

<a id="65-openab-contribution-policy"></a>

### Reference-client portability

**Scope and maturity:** Current interoperability principle for working ACP clients.

**Requirement: Prove compatibility without permanent client-specific dependence.**

The `user_interview` chat path needs no OpenAB contribution branch or merge. Other Stage 1 gaps may still need generic
upstream changes. Stage 1 does not depend on maintainer merge timing. Completion of the broader reference journey
requires:

- an upstream PR for the required generic compatibility work;
- a passing integration pinned to a reviewed OpenAB contribution branch or commit;
- no permanent RunWield-maintained fork;
- a documented tested OpenAB version or commit.

OpenAB's current permission-request behavior is a broader security concern because it can automatically select
permissive responses. RunWield currently emits no ACP `session/request_permission` requests; its workflow interactions
use elicitation instead. Stage 1 must verify that the reference flow never enters the automatic permission path and must
not claim safe general permission brokerage. Interactive, deny-by-default permission handling should be offered upstream
separately and becomes a blocker if RunWield begins emitting standard ACP permission requests.

**Acceptance scenarios:**

- Given a passing reviewed OpenAB contribution commit and an open upstream PR, when the Stage 1 proof is assessed,
  upstream merge timing alone does not block it.
- When another conforming ACP client uses RunWield, it does not require OpenAB-specific behavior for ordinary advertised
  capabilities.
- Given the Stage 1 permission limitation, when the reference journey runs, it never enters automatic permission
  approval; documentation does not claim general safe permission brokerage.

<a id="7-stage-2--full-acp-v1-compliance"></a>

### Advertised ACP conformance

**Scope and maturity:** Stage 2 target; optional extensions and later channels are separately scoped.

**Requirement: Back advertised protocol behavior with interoperability evidence.**

Full ACP v1 compliance covers every required behavior for the capabilities RunWield advertises, including stdio MCP
support, protocol negotiation, authentication, notifications, usage, and cancellation. Verify interoperability with more
than one ACP client and keep public claims aligned with evidence.

Current conformance evidence and unfinished checks belong in the
[implementation audit](../acp-implementation-details.md), not a second checklist here. Protocol hardening can proceed
independently of the Telegram proof.

Optional listing, additional roots, rich media, embedded resources, and client filesystem or terminal delegation should
be evaluated on user value. Compliance does not require advertising unsupported options.

RunWield currently advertises `sessionCapabilities.delete: {}` and includes `session/delete` in its implemented-method
metadata. This capability is reversible archive as defined in [ACP Session access](#acp-session-access), not hard
deletion. ACP `session/list` remains unsupported and unadvertised.

RunWield currently advertises ACP image prompts. ACP image blocks use the shared Session image path: vision-capable
models receive the image directly, while text-only models can inspect the persisted attachment through `see_image` when
`visionFallback.model` is configured.

**Acceptance scenarios:**

- When a client initializes, delete is advertised and `session/delete` accepts the standard request and returns an empty
  result on success. Listing is not advertised; archive support does not imply `session/list` support.
- When RunWield advertises a capability, its required protocol behavior passes interoperability checks with more than
  one client before full compliance is claimed.
- When `session/new` or `session/load` receives a non-array MCP configuration, a stdio definition missing its required
  environment array, or an unsupported transport, it returns invalid parameters before creating or loading a Session.
- When an optional capability is unsupported, it is not advertised merely to satisfy a checklist; public coverage
  remains aligned with evidence.
- When an ACP client sends an image prompt, a vision-capable model receives the image. A text-only model with a
  configured vision fallback receives a persisted attachment reference and can inspect it with `see_image`.

## Historical Stage 1 Delivery Environment

The original Telegram-focused proof used the following environment. This is historical planning context, not a limit on
current JetBrains, Air, or OpenAB chat support:

- one Telegram bot created through BotFather;
- one private Telegram conversation;
- an explicit Telegram user allowlist;
- one configured RunWield project repository;
- OpenAB's unified service with public HTTPS webhook ingress;
- an independently reachable Shared Plan server;
- a pinned OpenAB release or contribution commit.

A development tunnel is acceptable for concept validation; the acceptance scope is one trusted operator.

## Historical Stage 1 Cross-Capability Acceptance

- An unauthorized Telegram user cannot start or mutate the configured RunWield Session.
- One authorized operator completes the required FEATURE journey from Telegram through a Verified Plan.
- At least one structured interaction is completed through OpenAB's generic elicitation support.
- Plannotator Feedback or approval resumes the waiting Session without Telegram account linking.
- Restarting OpenAB and `wld acp` between settled turns preserves the Telegram-to-session mapping and conversation.
- A forced interruption during execution preserves the workflow and automatically repairs internal state. It continues
  toward publication or deliberate user abandonment without discarding work or blindly replaying side effects.
- Live cancellation settles the Runtime turn and delivers final mapped updates before a new turn starts.
- RunWield remains usable by other conforming ACP clients without requiring OpenAB-specific behavior.
- The integration passes against a pinned OpenAB commit associated with an open upstream PR.

<a id="8-out-of-scope-for-stage-1"></a>

## Scope beyond personal client integration

Discord and other OpenAB-supported chats are already supported. Separate future scope includes:

- Multiple Telegram users, groups, topics, or concurrent project routing.
- A RunWield-owned multi-platform chat gateway.
- A permanent private OpenAB fork.
- Native Telegram transport in RunWield core.
- OpenAB-owned branches or worktrees for RunWield execution.
- Telegram-native Plan editing, Feedback, or approval that replaces Plannotator.
- Full RunWield slash/CLI command parity in Telegram.
- Media and attachment parity beyond what the validated ACP prompt path supports.
- Transparent replay of an interrupted model request, command, or tool side effect.
- Full ACP v1 compliance or stdio MCP server support before Stage 2.
- Full Workspace workbench protocol parity beyond the development Session slice.

<a id="9-risks-and-guardrails"></a>

## Risks and Guardrails

| Risk                                                               | Guardrail                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OpenAB is pre-1.0 and may change quickly.**                      | Pin the passing version or commit and maintain black-box compatibility coverage.                                                                                                                 |
| **Experimental ACP elicitation may evolve.**                       | Negotiate the capability, pin the tested ACP/SDK baseline, and isolate changes in the interaction adapters. Use a namespaced RunWield extension only if generic elicitation proves insufficient. |
| **Public Telegram webhook ingress expands attack surface.**        | Validate webhook authenticity, use explicit Telegram allowlists, and expose only the required route through HTTPS.                                                                               |
| **Shared Plan URLs can be forwarded.**                             | Treat them as capability links under the Shared Plan server's existing authorization and expiry policy; do not conflate them with Telegram identity.                                             |
| **Automatic ACP permission approval could authorize unsafe work.** | Confirm RunWield emits no permission requests in Stage 1, document the limitation, and pursue deny-by-default upstream handling before relying on the method.                                    |
| **A crash leaves ambiguous partial side effects.**                 | Preserve partial work, explain what is uncertain, and offer informed recovery choices without blind repetition.                                                                                  |
| **OpenAB's process-per-thread model may not scale efficiently.**   | Measure process and memory costs for the single-operator workflow. Preserve RunWield's multi-session Session Host for other clients.                                                             |
| **Reference-client accommodations could leak into core.**          | Keep OpenAB-specific transport behavior outside RunWield; core changes must improve standard ACP or adapter-neutral Runtime semantics.                                                           |

<a id="10-future-work-unlocked"></a>

## Future Work Unlocked

- Validate Slack and Discord through the same OpenAB ACP core.
- Add richer IDE integrations through conforming ACP clients.
- Let the owner start, resume, or monitor the same Sessions across Workspace, ACP, and TUI.
- Add richer ACP session discovery, configuration, and workflow-specific presentation without weakening standard
  fallbacks.
- Run multiple chat-backed Hosted Sessions in one RunWield process when the chosen host can exploit that architecture.

<a id="11-references"></a>

## References

- ACP implementation audit: `docs/acp-implementation-details.md`
- SessionRuntime architecture decision: `docs/adr/010-session-runtime-sibling-adapters-and-acp.md`
- File-backed Session continuity: `docs/adr/014-file-authoritative-session-bundles.md`
- SessionRuntime and ACP MVP Work Record: `docs/work-records/2026-07-17-sessionruntime-and-acp-v1-stdio-mvp.md`
- OpenAB: <https://github.com/openabdev/openab>
- ACP v1 extensibility: <https://agentclientprotocol.com/protocol/v1/extensibility>
- ACP elicitation RFD: <https://agentclientprotocol.com/rfds/elicitation>
