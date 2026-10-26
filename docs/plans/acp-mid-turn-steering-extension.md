---
planId: "2684dd2f-5c90-4866-b41c-442de9655ac5"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/acp/server.js"
    - "src/acp/server.test.js"
    - "src/shared/session/runtime/queues.ts"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/acp-implementation-details.md"
    - "docs/user-facing-features.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-19"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "65541d2566f8a21e7a1658f65932878287ef9238"
workRecord:
    status: "generated"
    recordId: "b1bc1bf7-3bf5-48ec-8aba-d587fcdabcfa"
    path: "docs/work-records/2026-10-21-acp-mid-turn-steering-extension.md"
    lastAttemptAt: "2026-10-21T18:10:47.955Z"
status: "verified"
---

# ACP Mid-Turn Steering Extension

## Context

ACP clients cannot steer a RunWield Agent during a running turn. A second `session/prompt` for the same Session is
rejected with `-32002` ("already has an active prompt"). TUI and Workspace can steer the same Session through
`SessionRuntime.steerSession`.

ACP v1 does not define steering. The ACP v2 draft prompt lifecycle explicitly leaves steering unspecified. The working
convention in the ecosystem is the `_session/steering` extension implemented by Claude's ACP adapter
(`@agentclientprotocol/claude-agent-acp`) and reported to work with `codex-acp` and the Agent Shell client:

- [Extension definition](https://github.com/agentclientprotocol/claude-agent-acp/blob/1420994ced20919aad127a8bd0294de022449e35/src/acp-agent.ts#L634-L639)
- [Request and response shapes](https://github.com/agentclientprotocol/claude-agent-acp/blob/1420994ced20919aad127a8bd0294de022449e35/src/acp-agent.ts#L692-L738)
- [Capability advertisement](https://github.com/agentclientprotocol/claude-agent-acp/blob/1420994ced20919aad127a8bd0294de022449e35/src/acp-agent.ts#L3028-L3031)
- [`steer` implementation](https://github.com/agentclientprotocol/claude-agent-acp/blob/1420994ced20919aad127a8bd0294de022449e35/src/acp-agent.ts#L4295-L4388)
- [Agent Shell client support](https://github.com/xenodium/agent-shell/issues/773)

The user reported the symptom through OpenAB in Discord: a correction sent during a turn appears ignored. OpenAB holds
the next message until the current turn ends. A feature request has been sent to the OpenAB team. This Plan delivers the
RunWield side so OpenAB, or any client using the same extension, can steer RunWield.

**Owning PRD:** [ACP Protocol PRD — Protocol negotiation and interactions](../prd/runwield-acp-protocol-prd.md#protocol-negotiation-and-interactions).

- **Proposed addition:** a requirement and acceptance scenarios for the `_session/steering` extension.
- **Must survive:** "If work is currently running, the client reports that state without losing the user's input."
  Overlapping `session/prompt` rejection, cancellation settlement, and no-form chat question answering stay unchanged.
- **Out of scope:** OpenAB's client behavior and Discord reply placement. Those belong to OpenAB.

## Objective

An ACP client can call `_session/steering` while a RunWield turn is running. The message reaches the running Agent
through the same Runtime steering path TUI and Workspace use. The Agent's response continues on the original
`session/prompt` request, which ends only after the steered message is answered.

## Approach

Add one ACP request handler that translates the extension into the existing Runtime steering operation. No new Runtime
steering machinery is needed.

```text
client → _session/steering { sessionId, prompt, _meta? }
  acp/server.js handler
    resolve the ACP Session to its runtime Session (sessionMap)
    if a no-form chat question is waiting → promptRequired   (the reply must answer the question)
    convertAcpPrompt(prompt) → text, images
    runtime.steerSession(runtimeSessionId, text, images)
      queued: true            → { outcome: "injected" }
      reason: "not_streaming" → idle outcome (see decision below)
      managed rejection/error → JSON-RPC error, nothing claimed delivered
```

Delivery reuses existing behavior:

- `steerSession` holds the message during an Agent Handoff and injects it between tool calls otherwise.
- When the Agent consumes it, the Runtime emits `USER_MESSAGE`. The live ACP operation's subscription maps that to
  `user_message_chunk` with the steering message ID.
- The Agent's reply uses a new assistant `messageId`. A client can use that change to start a new chat message.

The extension is advertised in the **top-level** `InitializeResponse._meta.steering.supported`, which is where Claude's
adapter and Agent Shell put it, not inside `agentCapabilities`.

```diff
 return {
     protocolVersion: PROTOCOL_VERSION,
     agentCapabilities: { ... },
     authMethods,
     agentInfo: { name: "RunWield", version: VERSION },
+    _meta: { steering: { supported: true } },
 };
```

> [!TIP]
> **Follow the existing convention instead of inventing one**
>
> Using Claude's method name, parameters, and outcomes means one client implementation works for Claude, Codex, and
> RunWield. A RunWield-only `_runwield/steer` method would need a separate integration in every client.

### Idle Behavior

When no turn is running, Claude returns `startedNewTurn` by default and starts a detached turn. Clients that send
`_meta.steering.idleBehavior: "promptRequired"` instead receive `{ outcome: "promptRequired", reason: "noRunningTurn" }`
and submit a normal `session/prompt`.

| Option                                                        | Compatibility                                                           | Cost and risk                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Always return `promptRequired` when idle** (recommended) | Matches clients that opt in, including the behavior proposed to OpenAB. | Small. A client that ignores the outcome could drop the message, but it receives an explicit non-`injected` answer.                                                                                                                                    |
| B. Match Claude exactly: `startedNewTurn` unless opted in     | Matches clients written against Claude's default.                       | Larger. RunWield has no ACP turn without a `session/prompt` request except Background Task result turns. The live operation must track a detached turn, reject overlapping prompts during it, and handle Sessions not yet prompted on this connection. |

> **Question (idle-steering-behavior):** When a client sends _session/steering and no turn is running, what should RunWield do?
>
> **Answer:** A. Always return promptRequired; the client sends a normal session/prompt (smaller, recommended) (answered in review)

The Implementation Steps below assume option A. Option B adds one step: start the turn through the Runtime's
next-turn queue with `deliverWhenAvailable`, and make the live ACP operation treat that turn like a Background Task
result turn for busy state and settlement.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved
intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk
grows, or the Verification Plan no longer proves the objective.

- `src/acp/server.js` — `_session/steering` request handler, steering parameter validation, and the `_meta.steering`
  capability in `createInitializeResponse`. Advertise the method in `_meta.runwield.implementedMethods` too.
- `src/acp/server.test.js` — wire-level tests through the real ACP server and Runtime fixture.
- `src/shared/session/runtime/queues.ts` — no change is expected. `steerSession` already returns `queued`,
  `reason: "not_streaming"`, managed rejections, and delivery errors. Change it only if a test proves a needed outcome
  is missing.
- `docs/prd/runwield-acp-protocol-prd.md` — new requirement and acceptance scenarios in Protocol negotiation and
  interactions.
- `docs/acp-implementation-details.md` — wire contract: method, capability, parameters, outcomes, and errors.
- `docs/user-facing-features.md` — ACP feature list gains mid-turn steering for clients that support the extension.

Deliberately unchanged: `session/prompt` handling, `createLiveOperation`, and the TUI and Workspace steering paths.
`docs/domain-language.md` already defines **Steering Message** independent of surface, so no glossary change is needed.

## Reuse Opportunities

- `SessionRuntime.steerSession` (`src/shared/session/runtime/queues.ts`) — the shared steering owner: ordering,
  Agent Handoff holding, image preparation, and consumption events.
- `convertAcpPrompt` (`src/acp/server.js`) — converts ACP content blocks, including images and resource links, exactly
  as `session/prompt` does.
- `extractAcpBuiltinCommand` (`src/acp/server.js`) — detects slash commands so they are not steered.
- `operations` map and the live operation's `question` (`src/acp/server.js`) — tells whether a no-form chat question is
  waiting for the next user message.
- `throwInvalidParams`, `throwUnknownSession`, and `RequestError` with `ACP_INVALID_STATE` — existing error shapes.
- The Workspace steering integration test (`src/ui/workspace/session-continuation.integration.test.ts`, "Workspace
  steering reaches the running Agent once…") — pattern for holding a model response and asserting the second model
  request contains the steering text.

## Implementation Steps

- `createInitializeResponse` in `src/acp/server.js` returns top-level `_meta: { steering: { supported: true } }`, and
  `_meta.runwield.implementedMethods` includes `_session/steering`. The response still passes the `InitializeResponse`
  schema check.
- `src/acp/server.js` registers a `_session/steering` request handler. It validates that `sessionId` is a non-empty
  string and `prompt` is a non-empty array, and that `_meta.steering.idleBehavior` is absent or `"promptRequired"`.
  Invalid parameters return `-32602`.
- An unknown or closed ACP Session ID returns the same error `session/prompt` returns for an unknown Session.
- When the Session's live operation has a waiting no-form chat question, the handler returns
  `{ outcome: "promptRequired", reason: "questionPending" }` and does not steer. The client's follow-up `session/prompt`
  answers the question through the existing path.
- A prompt whose text is a slash command (as detected by `extractAcpBuiltinCommand`) returns `ACP_INVALID_STATE` with a
  message that slash commands cannot steer a running turn. It is not passed to the model.
- Otherwise, the handler converts the prompt with `convertAcpPrompt` and calls `runtime.steerSession` with the
  converted text and images. The ACP Runtime is created with `ownerProcessKind: "acp"`, so the default input surface is
  already correct. `queued: true` returns `{ outcome: "injected" }`.
- `reason: "not_streaming"` returns `{ outcome: "promptRequired", reason: "noRunningTurn" }`. The message is not queued
  for a later turn, so a client's follow-up `session/prompt` cannot deliver it twice.
- A managed-operation rejection or a thrown delivery error, such as an unsupported image, returns a JSON-RPC error. The
  handler never returns `injected` for a message the Runtime did not accept.
- The handler does not wait for the active `session/prompt` to settle. It responds while the turn is still running.
- `docs/prd/runwield-acp-protocol-prd.md` Protocol negotiation and interactions gains a named steering requirement and
  the acceptance scenarios listed in the Verification Plan. It states the extension is a RunWield-supported ACP
  extension following Claude's adapter, not ACP v1 standard behavior. OpenAB client support stays labeled as target
  behavior until OpenAB ships it.
- `docs/acp-implementation-details.md` documents the method, capability location, parameters, outcomes, and errors.
  `docs/user-facing-features.md` lists ACP mid-turn steering for clients that support the extension.

## Verification Plan

Automated, through the real ACP server and Runtime fixture (`withRuntimeCommandFixture`, faux model responses):

```sh
bun scripts/run-tests.js src/acp/server.test.js src/acp/protocol-smoke.test.ts
```

New tests in `src/acp/server.test.js`:

1. **Initialize advertises steering.** `initialize` returns `_meta.steering.supported === true` at the top level, and
   the frame passes `assertAcpFrameSchema("InitializeResponse", …)`.
2. **Steering reaches the running Agent once.** Hold the first model response. Send `session/prompt`, then
   `_session/steering` with `"Use the existing implementation."`. Assert:
    - the steering response is `{ outcome: "injected" }` and arrives **before** the `session/prompt` response;
    - after release, the second model request contains the steering text;
    - exactly one `user_message_chunk` with that text is emitted;
    - the reply after it uses a different assistant `messageId` than the first reply;
    - `session/prompt` ends with `end_turn` only after the steered reply is streamed.
      This test fails if the handler returns `injected` without calling `steerSession`, because the second model request
      would not contain the text.
3. **Idle steering does not deliver anything.** With no running turn, `_session/steering` returns
   `{ outcome: "promptRequired", reason: "noRunningTurn" }`, no model request is made, and a following `session/prompt`
   with the same text produces exactly one user message.
4. **Waiting chat question is not bypassed.** With a no-form `user_interview` waiting, `_session/steering` returns
   `promptRequired` with `reason: "questionPending"`. A following `session/prompt` answers the interview.
5. **Invalid input fails visibly.** An empty `prompt`, a missing `sessionId`, an unsupported `idleBehavior`, an unknown
   Session, and a slash command each return an error, and no model request includes the text.

Behavior that must still be protected:

- "ACP rejects overlapping prompts and cancels the real in-flight Runtime turn" still passes unchanged. A second
  `session/prompt` during a turn is still `-32002`.
- Existing cancellation, chat question, Background Task result turn, and `/plan-review` busy tests pass unchanged.

Manual check with a raw ACP client (for example, a short script over `wld acp` stdio): start a long turn, send
`_session/steering`, and confirm the correction affects the same turn's output.

PRD synchronization: the new ACP PRD scenarios match tests 1–5. The PRD does not claim OpenAB or Discord support for
steering.

## Edge Cases & Considerations

- **Steering arrives as the turn ends.** `steerSession` reports `not_streaming` if the Agent already stopped. The
  client receives `promptRequired` and sends a normal prompt. If the message was accepted, the Runtime delivers it
  before the turn settles, as it does for TUI and Workspace.
- **Agent Handoff.** `steerSession` holds the message for the replacement Agent and returns `queued: true`, so the
  client correctly receives `injected`.
- **Work owned by another process.** If TUI or Workspace runs the Session, the ACP process is not streaming it. The
  client receives `promptRequired`, and its `session/prompt` uses the existing `active_elsewhere` queueing.
- **Cancellation.** `session/cancel` keeps its current behavior. Pending steering follows the Runtime's existing
  clearing rules on abort.
- **`injected` confirms admission, not consumption.** The `user_message_chunk` confirms when the Agent read it. Docs
  must say so.
- **OpenAB `sender_context` blocks.** They are converted the same way as in `session/prompt`, so steering keeps the
  same sender context as an ordinary message.
- **Assumption:** slash commands are rejected rather than queued, matching TUI, which never steers a slash command.
