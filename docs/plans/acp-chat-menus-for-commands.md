---
planId: "ed3d4357-895e-4968-ad80-1ae3cfea82f0"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/acp/server.js"
    - "src/acp/interaction-mapper.js"
    - "src/acp/interview-chat.ts"
    - "src/shared/session/runtime/lifecycle-loading.ts"
    - "src/acp/server.test.js"
    - "src/acp/interaction-mapper.test.js"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/adr/010-session-runtime-sibling-adapters-and-acp.md"
    - "docs/acp-implementation-details.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-18"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
---

# ACP Chat Menus for Commands

## Context

`/load-plan` is already registered for ACP, and it already skips the terminal-only directory prompts on ACP. It still
does not work end to end from Discord through OpenAB. The problem is how its menus are shown.

Every menu in a built-in command goes through `runtime.requestInteraction`. The ACP adapter
(`createAcpInteractionAdapter` in `src/acp/interaction-mapper.js`) then shows it in one of two ways:

| Client                                 | Command menus today                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Supports ACP forms (JetBrains, Air)    | Native `elicitation/create` form. This works.                                 |
| No forms (OpenAB in Discord, upstream) | `Open this RunWield question to continue: http://127.0.0.1:…` (loopback page) |

A loopback link only works at the machine that runs `wld acp`. From a phone, `/load-plan` stops at its first menu. The
same is true for `/agent`, `/model`, and every other command picker, and for select, text, and approval questions that
an Agent workflow asks outside `user_interview`.

There is a second gap. `dispatchAcpBuiltinCommand` holds one ACP request open for the whole command. When `/load-plan`
continues into a Planner turn, that turn's `user_interview` questions also go to the loopback page. The chat-answer path
in `createInterviewOperation` only runs for ordinary prompt turns.

Owner decisions from this planning conversation:

- The solution is generic. `/load-plan`, `/agent`, `/model`, and every other menu use the same path.
- **ACP forms come first.** When the client advertises `clientCapabilities.elicitation.form`, RunWield keeps using
  native forms.
- **Chat menus are the fallback.** Without forms, select, text, and approval questions appear as chat messages and the
  next user message answers them. The chat menus replace the loopback browser question page for these questions.

PRD and architecture documents affected:

- [ACP PRD — Protocol negotiation and interactions](../prd/runwield-acp-protocol-prd.md#protocol-negotiation-and-interactions):
  **changes** the requirement "Other no-form select, text, and approval questions still use a loopback browser URL" to
  chat menus. "Command menus retain exact selections" survives and becomes the chat reply rule.
- [ACP PRD — Chat workflow access](../prd/runwield-acp-protocol-prd.md#telegram-workflow-access): step 4 **changes**
  from "native forms or the local browser fallback" to "native forms or chat".
- [ACP PRD — ACP Session access](../prd/runwield-acp-protocol-prd.md#acp-session-access): **adds** a scenario that
  `/load-plan` completes from a no-form chat client.
- [ADR-010](../adr/010-session-runtime-sibling-adapters-and-acp.md) states "Command menus, approvals, and reviews do not
  use this path." That decision changes for command menus and approvals. Reviews keep their browser links.

Must survive unchanged:

- Native form behavior for clients that support forms, including the Other-answer field.
- `user_interview` chat rules: number or unique exact label selects; other text selects Other with its full text; bare
  Other gets one text follow-up; blank input and attachments do not answer.
- Plan, Code, and Artifact Review stay browser review links. The Artifact Review feedback step keeps its browser
  question page.
- Pair checkpoints keep using ordinary ACP prompt turns.
- Cancellation waits for settlement before `session/prompt` returns `cancelled`.
- `/plan-review` with a live review returns the current link without a second review.

## Objective

A user in a no-form ACP chat client can run `/load-plan`, pick a Plan, choose an action, and continue into planning,
review, or execution by replying in chat. `/agent`, `/model`, and all other command and workflow menus work the same
way. Clients with native forms see no change.

## Approach

**Run every built-in command inside the same live operation that ordinary prompt turns use.** That operation already
knows how to end one ACP request when a question reaches chat, keep the Runtime work alive, and let the next request
answer. Then widen the chat path from `user_interview` to every select, text, and approval question when the client has
no forms.

The prompt handler today:

```text
session/prompt
  /plan-review fast path
  operation pending question? → parse reply → operation.attach
  slash command? → dispatchAcpBuiltinCommand   (one request, own subscription, own adapter)
  else → createInterviewOperation + runtime.promptUserTurn
```

After the change:

```diff
 session/prompt
   /plan-review fast path
   operation pending question? → parse reply → operation.attach
-  slash command? → dispatchAcpBuiltinCommand   (one request, own subscription, own adapter)
+  slash command? → createLiveOperation + run definition.execute inside it
-  else → createInterviewOperation + runtime.promptUserTurn
+  else → createLiveOperation + runtime.promptUserTurn
```

The adapter decision, for every interaction:

```text
requestInteraction(interaction)
  plan / code / artifact review → browser review link (unchanged)
  pair checkpoint               → unsupported (unchanged)
  client has forms              → elicitation/create form (unchanged)
  select / text / approval      → chat question through the live operation
```

The chat reply rules live in one module, so the format and the parsing cannot drift apart:

```text
parseChatReply(interaction, text)
  user_interview question → current rules (number, unique label, else Other text)
  text question           → nonblank text is the answer
  select / approval menu
    number in range, or exact label, or exact option value (trimmed, case-insensitive) → that option
    "cancel" when no option matches it → canceled
    anything else → no answer; the menu is shown again with the reply rule
```

What the user sees in Discord:

```text
you:      /load-plan
RunWield: Load plan:
          1. acp-chat-menus-for-commands — draft
          2. workspace-memory-footprint — ready_for_work
          Reply with a number or the exact option name, or "cancel".
you:      1
RunWield: Plan loaded: acp-chat-menus-for-commands
          What would you like to do?
          1. Resume planning
          2. Review plan
          ...
```

> [!TIP]
> **One operation for turns and commands**
>
> A command such as `/load-plan` can start an Agent turn. If commands had their own request model, the Agent's
> `user_interview` questions would need a second chat path. With one operation, a question asked by a command menu and
> a question asked by an Agent turn started from that command take the same route.

Rejected option: a `/load-plan`-only chat branch. It is a special case in general code, and `/agent`, `/model`, and the
other menus would still stop at a loopback link.

Rejected option: keep the browser page as a second fallback after chat. The owner chose forms first and chat second. A
loopback link is not reachable from the chat clients that need the fallback.

### Cancel by reply

A chat client may have no Stop button, and some menus have no Cancel option. The `/load-plan` Plan picker is one. A
reply of `cancel` that matches no option cancels the menu, and the command handles it as it handles a canceled form.

> **Question (chat-menu-cancel-word):** Should replying "cancel" (when no option is named cancel) cancel an open chat menu? Text questions and user_interview questions keep treating "cancel" as an ordinary answer.
>
> **Answer:** Yes (answered in review)

## Expected Change Surface

This list is guidance, not an allowlist. Verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent:
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `src/acp/server.js` — `createInterviewOperation` becomes the live operation for prompt turns and built-in commands.
  `dispatchAcpBuiltinCommand` runs its command inside that operation. Its separate subscription, adapter install, and
  per-request `sendMessage` go away. The prompt handler parses pending replies with the general parser. The
  `/plan-review` busy check looks only at an unsettled operation.
- `src/acp/interaction-mapper.js` — without forms, select, text, and approval go to the operation's chat presenter
  instead of `requestBrowserQuestion`. `requestBrowserQuestion` stays only for the Artifact Review decision.
- `src/acp/interview-chat.ts` → `src/acp/chat-interaction.ts` — formats and parses chat questions for menus, text, and
  `user_interview`. The rename is needed because the module no longer serves only interviews.
- `src/shared/session/runtime/lifecycle-loading.ts` — `answerInteraction` accepts any live select, text, or approval
  interaction instead of only `user_interview`. Review, Pair, and other types stay rejected.
- `src/acp/server.test.js`, `src/acp/interaction-mapper.test.js`, `src/acp/interview-chat.test.ts` →
  `src/acp/chat-interaction.test.ts`, `scripts/bun-test-files.json` — new behavior tests and the renamed test file.
- `docs/prd/runwield-acp-protocol-prd.md`, `docs/adr/010-session-runtime-sibling-adapters-and-acp.md`,
  `docs/acp-implementation-details.md`, `docs/architecture.md` (ACP adapter paragraph),
  `docs/user-facing-features.md` (ACP list) — describe chat menus as the no-form fallback.
- `docs/domain-language.md` — the **Pending Structured Interaction** definition describes no-form ACP questions for
  menus, text, and approvals, not only interviews.

Deliberately not changed: `src/cmd/load-plan/*` and the other commands. They already talk through `uiAPI.promptSelect`
and `promptText`. The fix belongs in the ACP adapter, which owns presentation.

## Reuse Opportunities

- `createInterviewOperation` in `src/acp/server.js` — request attach and detach, queued updates, cancellation
  settlement, `SESSION_REPLACED` handling, and background-task result turns. Reuse it; do not build a second operation.
- `createAcpCommandUiAPI` in `src/acp/server.js` — keeps mapping `promptSelect` and `promptText` to
  `runtime.requestInteraction`.
- `formatInterviewQuestion` and `parseInterviewReply` in `src/acp/interview-chat.ts` — the base for the general
  formatter and parser.
- `withRuntimeCommandFixture`, `startTestServer`, `readThroughResponse`, and the interview chat tests in
  `src/acp/server.test.js` — the pattern for end-to-end no-form tests over the real ACP wire.

## Implementation Steps

1. `src/acp/chat-interaction.ts` exports `formatChatQuestion(interaction)` and `parseChatReply(interaction, text)`.
   `src/acp/interview-chat.ts` no longer exists, and every importer uses the new module.
    - For `user_interview` questions (`interaction._meta.source === "user_interview"`), the output is the same as today
      for the same inputs.
    - For other select and approval menus, the message lists numbered option labels, adds the option description after
      `—` when present, and ends with the reply rule. An approval with no options is shown as `1. Yes` and `2. No`,
      which map to accept and decline.
    - A menu reply selects an option when it is a number in range, an exact label, or an exact option value (trimmed,
      case-insensitive). If the cancel-word decision is yes, `cancel` that matches no option returns a `canceled`
      response. Any other reply returns `null`.
    - An approval reply returns `accepted` or `canceled` using `isApprovalAcceptedValue`.
    - For text questions that are not interviews, nonblank text is the answer, and blank text returns `null`.
2. In `src/acp/interaction-mapper.js`, a client without `elicitation.form` sends every select, text, and approval
   interaction to the chat presenter. The `presentInterview` option is renamed to `presentChatQuestion`. No loopback
   question page opens for these types. Clients with forms still get `elicitation/create`. Plan, Code, and Artifact
   Review behavior is unchanged.
3. `answerInteraction` in `src/shared/session/runtime/lifecycle-loading.ts` answers a live interaction of type
   `select`, `text`, or `approval` whatever its `_meta.source`. It returns `false` for other types and for interactions
   that are no longer active.
4. `src/acp/server.js` has one live operation factory (renamed from `createInterviewOperation` to
   `createLiveOperation`). Both ordinary prompt turns and built-in commands start through it. The operation exposes:
    - a way to send an agent message chunk through its ordered queue, so command output after the first request ended
      reaches the next attached request;
    - an explicit Runtime Session replacement that moves the interaction adapter and event subscription to the new
      Session ID. `/load-plan` uses this when it adopts a Plan's planning Session through `replaceRuntimeSession`;
    - `COMMAND_CATALOG_CHANGED` handling that sends `available_commands_update`, as `dispatchAcpBuiltinCommand` does
      today.
5. A built-in command dispatched over ACP runs `definition.execute` inside the live operation. When a chat question is
   delivered, the current `session/prompt` returns `end_turn` while the command keeps waiting. The next prompt answers
   that question. The request attached when the command settles returns `end_turn`, or `cancelled` after cancellation.
   Unknown, unavailable, and `--help` commands keep their current one-request responses.
6. A prompt that arrives while a chat menu waits is parsed with `parseChatReply`. A `null` result does not answer the
   menu. RunWield sends one message that says the reply did not match and repeats the menu, and the response is
   `end_turn`. This includes slash commands typed while a menu waits.
7. An Agent turn started by a command, such as `/load-plan` → Resume planning, asks its `user_interview` questions in
   chat, and they are answered with the interview rules.
8. Slash-command metrics record the finish when the command settles, not when the first ACP request ends. `/agent` and
   `/model` pickers still record `opened`, then `dispatched` on selection. A command canceled by `session/cancel` or by a
   `cancel` reply records `canceled`.
9. The `/plan-review` busy check in the prompt handler treats a Session as busy only when it has an active prompt or an
   **unsettled** operation. A settled command or turn left in the operations map does not make the Session busy.
10. `docs/prd/runwield-acp-protocol-prd.md` states that clients without forms get select, text, and approval questions,
    including command menus, as chat messages answered by the next message, with the reply rule from Step 1. It removes
    the loopback browser fallback claim for these questions, updates Chat workflow access step 4, and adds the
    acceptance scenarios listed in the Verification Plan.
11. The accepted ADR-010 implication describes the current decision: native forms when advertised, chat questions for
    select, text, and approval otherwise, and browser links for reviews. No sentence says command menus or approvals are
    excluded from chat.
12. `docs/acp-implementation-details.md` describes chat questions for all no-form select, text, and approval
    interactions. It removes the "Non-interview browser questions lose Other-answer text" gap row. The browser question
    page appears only for the Artifact Review decision. `docs/architecture.md` and `docs/user-facing-features.md` say
    the same in their ACP sections.
13. In `docs/domain-language.md`, **Pending Structured Interaction** says that, in a no-form ACP client, each chat
    question (interview, command menu, text, or approval) ends one ACP request while the Runtime work stays live, and
    the next request answers it.

## Verification Plan

Automated, focused:

```sh
bun scripts/run-tests.js src/acp/server.test.js src/acp/interaction-mapper.test.js src/acp/chat-interaction.test.ts
bun run seams:check
bun run check
bun run lint
```

New behavior tests. Each one must fail on the current code.

- **`/load-plan` in a no-form client** (`src/acp/server.test.js`, real ACP wire, `withRuntimeCommandFixture` with two
  draft Plans in `docs/plans/`, `initialize` without `elicitation`):
    - `/load-plan` returns `end_turn` after one agent message that lists both Plans as numbered options. No
      `elicitation/create` request is sent, and no `127.0.0.1` URL appears.
    - Reply `2` → the response includes `Plan loaded: <second plan>` and the numbered action menu.
    - Reply `View plan details` → the Plan summary and the action menu again.
    - Reply `Cancel` → the command settles and the Plan file is unchanged. A following ordinary prompt reaches the model.
- **Reply rule**: with the Plan picker open, replies `9`, `banana`, and `/agent` each return one "did not match" message
  that repeats the menu. The command is still waiting, and a following `1` loads the first Plan.
- **Cancel reply** (if the cancel-word decision is yes): `cancel` at the Plan picker ends `/load-plan` without loading
  a Plan. The command metrics row records `canceled`.
- **Command-started Agent turn**: `/load-plan` → `1` → `Resume planning`. The fixture model calls `user_interview`.
  The question arrives in chat, its request returns `end_turn`, and the reply reaches the same tool result.
- **`/agent` in a no-form client**: `/agent` lists Agents in chat, and `guide` (exact value) switches to Guide, with
  one Agent-change notice and a `config_option_update`.
- **Session cancel during a menu**: `session/cancel` while the Plan picker waits settles the command. The next prompt
  is accepted, and the metrics outcome is `canceled`.
- **Forms still win**: with `elicitation.form`, `/load-plan` sends `elicitation/create` for the Plan picker and sends
  no chat menu text.
- **Adapter unit** (`src/acp/interaction-mapper.test.js`): without forms, select, text, and approval call
  `presentChatQuestion` and start no browser question server. Artifact Review feedback still uses the browser question
  page.
- **Parser unit** (`src/acp/chat-interaction.test.ts`): number, exact label, exact value, case and whitespace, out of
  range, approval yes/no without options, cancel word, blank text, and unchanged `user_interview` results.
- **Broker**: `answerInteraction` answers a pending command `select` and returns `false` for a pending `plan_review`.

Existing coverage that must stay protected:

- All current `user_interview` chat tests (three-question flow, Other follow-up, held responses, cancellation between
  requests, ordered answers) pass unchanged, except for renamed imports.
- `/agent` with forms, `/plan-review` live link, `/plan-review` busy while a prompt is pending, `/reload` catalog
  update, background-task result turns, and Pair checkpoint tests pass unchanged.

Expected to stop existing:

- "ACP interaction adapter falls back to a local browser question without form capabilities" tests behavior that the
  owner removed. Rewrite it to assert chat presentation for the same select question. Do not delete it without that
  replacement.

Manual (owner, through OpenAB in Discord with the built `wld`):

1. `/load-plan` → reply with a number → View plan details → Cancel. Every menu shows in chat with no link.
2. `/load-plan` → pick a draft Plan → Resume planning → answer a Planner question in chat.
3. `/agent` and `/model` → pick by number. The next message uses the selection.
4. In JetBrains or Air, `/load-plan` still shows native forms.

PRD synchronization check: the ACP PRD, ADR-010, the ACP implementation details, and the glossary all describe chat
menus as the no-form fallback. None claims that remote browser question pages work, and none still says command menus
use the loopback page.

## Edge Cases & Considerations

- **Long menus.** `/model` can list many models, and the Plan picker can list many Plans. One chat message carries the
  full list. Chat clients may split or truncate long messages; matching by exact option value (for example
  `openai/gpt-5`) helps. Paging is out of scope.
- **Reply race.** A reply can arrive after another surface (TUI or Workspace) answered the same question. The existing
  `expectedInteractionId` check keeps the old reply from answering the next question. Keep it for menus.
- **Process loss.** A chat menu is a process-local wait, like interview questions. After `wld acp` restarts, the user
  runs the command again. This matches the [Interrupted-work recovery](../prd/runwield-acp-protocol-prd.md#interrupted-work-recovery)
  promise.
- **Session adoption.** `/load-plan` can move the ACP Session to the Plan's planning Session. Today
  `dispatchAcpBuiltinCommand` updates the Session map but does not move the interaction adapter to the new Session.
  Step 4 makes the operation move both. The `/load-plan` no-form test covers the stay-here path. Adoption is covered
  only if the fixture creates an associated Session; otherwise check it in manual step 2.
- **Optional text questions.** Chat cannot send an empty message, so optional text prompts such as "Optional hold
  reason" need some text in chat. This is acceptable for now.
- **Assumption:** the Artifact Review feedback step keeps its browser question page, because it belongs to the Artifact
  Review surface. Moving it to chat is a separate change.
