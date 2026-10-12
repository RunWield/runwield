# PRD: RunWield Session Host and ACP Integration

**Document role: Living central PRD.** Principles and lasting requirements for external ACP clients, protocol
compatibility, and chat-channel integration.

Keep this document as current product guidance. Fold lasting requirements from completed feature PRDs here;
implementation steps belong in Plans, architectural choices in ADRs, and delivery evidence in Work Records.

**Status:** Working ACP integration with JetBrains AI Chat, the Air plugin, and OpenAB chat workflows\
**Author:** Gandazgul + RunWield Ideator\
**Last Updated:** 2026-10-06

---

<a id="1-objective"></a>

## Objective

Make RunWield usable from external clients through **Agent Client Protocol (ACP)** with the same conversations, Agent
behavior, and Plan workflows available in the TUI.

**Current compatibility (owner confirmed 2026-10-06):** JetBrains AI Chat and the Air plugin can drive RunWield. OpenAB
works end to end with Discord and its other supported chat platforms. Other ACP-compatible clients are expected to work
through the same protocol. Internal conformance checklists do not make these working integrations future scope.

The continuing product requirements are:

1. **OpenAB/Telegram compatibility:** one trusted operator can complete and recover a RunWield workflow through
   Telegram, using OpenAB as a replaceable reference ACP client.
2. **Full ACP v1 compliance:** supported capabilities behave according to the protocol and interoperability claims are
   backed by evidence independently of Telegram.

Personal Workspace and ACP share the same user outcome: the owner can continue a saved Session from another screen
without closing an idle client. Neither channel introduces a separate conversation or approval model.

OpenAB is a practical validation host, not a permanent RunWield infrastructure commitment. A future SaaS deployment may
fork OpenAB or build a purpose-optimized integration layer if tenancy, throughput, operations, or channel UX require it.

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
- OpenAB supports end-to-end personal workflows through Discord and its other supported chats. Team identity and SaaS
  operations remain separate scope.
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
- [Session continuity](../adr/015-file-authoritative-session-bundles.md)
- [Protocol coverage and implementation details](../acp-implementation-details.md)

## Capability Requirements

ACP owns external-client compatibility and channel-specific journeys. Shared Session and Plan behavior is owned by Core.
Stage labels below are delivery scope, not new lifecycle states or claims of shipped interoperability.

- [ACP Session access](#acp-session-access)
- [Protocol negotiation and interactions](#protocol-negotiation-and-interactions)
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
- Clients that advertise ACP forms receive native forms for select, text, and approval interactions. No OpenAB form
  contribution is required to answer `user_interview` in chat.
- Pair Execution uses ordinary ACP prompt turns and messages, not form elicitation. A checkpoint report ends one ACP
  request; questions and a later natural-language decision continue the same saved Session and execution context.
- Without forms, `user_interview` select and text questions appear in ordinary chat. Each question ends its ACP request
  while the Runtime tool and Session writer lock stay live. A later prompt answers through the existing broker. A number
  or unique exact label selects an option; other meaningful text selects Other with its full text. Bare Other gets one
  text follow-up. Blank required input and unsupported attachments do not answer. A lost process requires retry.
- Other no-form select, text, and approval questions still use a loopback browser URL. Command menus retain exact
  selections. Remote browser reachability is not claimed.
- Form cancellation, decline, and presentation failure settle the pending interaction so the same Session can accept
  another message without a manual cancel or reset. Multiple-choice forms preserve their labeled choices.
- Choice interviews include an optional Other-answer text field in the same ACP form. Selecting Other uses that text and
  requires a nonempty answer; selecting a listed choice ignores the text field.
- Unsupported interaction capabilities fail visibly and safely rather than selecting a default.
- Plan review links remain useful as normal text even when a client ignores `_meta.runwield` enhancements.
- Agent notices follow [Core conversation behavior](runwield-core-prd.md#tui-conversation): announce a real Agent switch
  once, without repeating it for activation, commands, or same-Agent rebuilds.
- Black-box compatibility coverage exercises the actual ACP wire behavior OpenAB depends on.

`session/resume` is not required for this stage. Correct durable `session/load` behavior is the interoperability
requirement.

**Acceptance scenarios:**

- When a client requests an unsupported protocol version, initialization negotiates supported behavior instead of
  pretending that version is supported.
- Given a no-form ACP client, when `user_interview` asks three questions, each reaches chat before its ACP response.
  Later prompts answer them in order without another Agent turn. The same tool returns ordered typed answers, including
  full Other and text answers. Defaults do not answer for the user.
- Given a required non-interview select, text, or approval interaction without native forms, a local browser question
  can collect its answer; if that page cannot be reached, no default is chosen.
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

<a id="62-required-user-journey"></a>

### Chat workflow access

<a id="telegram-workflow-access"></a>

**Scope and maturity:** Working end-to-end personal workflows through OpenAB with Discord and its other supported chat
platforms, confirmed by the owner on 2026-10-06. The Telegram journey below is a representative channel scenario, not a
restriction on currently working channels.

**Requirement: Carry the authorized operator through the shared Plan workflow.**

The authorized operator can reach the same RunWield planning, review, execution, and validation workflow through
Telegram. Plan review remains in the browser; Telegram supplies useful links, progress, questions, and outcomes. Channel
access and Shared Plan permissions remain independent.

The representative chat workflow lets the operator:

1. Submit a bounded FEATURE User Request in Telegram.
2. Start a new RunWield Session or reload the durable Session associated with the chat.
3. Receive streamed Agent messages, tool progress, relevant status, and actionable failure information.
4. Answer `user_interview` questions in chat without forms. Answer other select, text, and approval interactions through
   native forms or the local browser fallback; remote access to those pages is not proven.
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

A development tunnel is acceptable for concept validation. Production tenancy, account linking, billing, and
availability guarantees are not required.

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
- SaaS tenancy, account linking, billing, quotas, audit administration, or availability guarantees.
- A RunWield-owned multi-platform chat gateway.
- A permanent private OpenAB fork.
- Native Telegram transport in RunWield core.
- OpenAB-owned branches or worktrees for RunWield execution.
- Telegram-native Plan editing, Feedback, or approval that replaces Plannotator.
- Full RunWield slash/CLI command parity in Telegram.
- Media and attachment parity beyond what the validated ACP prompt path supports.
- Transparent replay of an interrupted model request, command, or tool side effect.
- Full ACP v1 compliance or stdio MCP server support before Stage 2.
- Workspace UI session-adapter work.

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
| **OpenAB's process-per-thread model may not scale efficiently.**   | Accept it for the single-operator proof; measure before adopting it for a hosted service. Preserve RunWield's multi-session Session Host for other clients.                                      |
| **Reference-client accommodations could leak into core.**          | Keep OpenAB-specific transport behavior outside RunWield; core changes must improve standard ACP or adapter-neutral Runtime semantics.                                                           |

<a id="10-future-work-unlocked"></a>

## Future Work Unlocked

- Validate Slack and Discord through the same OpenAB ACP core.
- Add richer IDE integrations through conforming ACP clients.
- Let the owner start, resume, or monitor the same Sessions across Workspace, ACP, and TUI.
- Evaluate a forked OpenAB deployment or RunWield-owned gateway for SaaS tenancy and scale.
- Add richer ACP session discovery, configuration, and workflow-specific presentation without weakening standard
  fallbacks.
- Run multiple chat-backed Hosted Sessions in one RunWield process when the chosen host can exploit that architecture.

<a id="11-references"></a>

## References

- ACP implementation audit: `docs/acp-implementation-details.md`
- SessionRuntime architecture decision: `docs/adr/010-session-runtime-sibling-adapters-and-acp.md`
- File-backed Session continuity: `docs/adr/015-file-authoritative-session-bundles.md`
- SessionRuntime and ACP MVP Work Record: `docs/work-records/2026-07-17-sessionruntime-and-acp-v1-stdio-mvp.md`
- OpenAB: <https://github.com/openabdev/openab>
- ACP v1 extensibility: <https://agentclientprotocol.com/protocol/v1/extensibility>
- ACP elicitation RFD: <https://agentclientprotocol.com/rfds/elicitation>
