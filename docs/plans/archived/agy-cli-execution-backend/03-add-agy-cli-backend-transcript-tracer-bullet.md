---
planId: "595d0348-5882-4ee2-b2a4-d0b7a12d0128"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/models/model-execution.ts"
    - "src/shared/session/execution-backend.ts"
    - "src/shared/session/session.js"
    - "src/shared/session/backends/agy-cli/"
    - "src/shared/models/agy-cli-models.test.ts"
    - "src/shared/session/agy-cli-model-selection.test.ts"
    - "src/shared/session/agy-cli-execution.test.ts"
    - "src/shared/session/session-transcript-projection.test.js"
    - "src/shared/session/root-session.test.js"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-23T20:02:05.462Z"
status: "validated"
origin: "internal"
parentPlan: "agy-cli-execution-backend"
order: 3
dependencies:
    - "02-register-agy-cli-backend-models"
userVerifiedAt: null
archivedAt: "2026-09-15T18:22:33.131Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/agy-cli-execution-backend/03-add-agy-cli-backend-transcript-tracer-bullet.md"
targetBranch: "feature/agy-cli-execution-backend"
---

# Add Agy CLI Backend Transcript Tracer Bullet

## Context

Child 02 made each explicit, non-empty `agy-cli/<model-id>` reference a valid external-CLI model descriptor, but its
execution guard still rejects the backend. This child opens that guard only after it adds a real Antigravity execution
path. Selected root and HostedSession-backed isolated Agent turns must run through `agy`, not fall through to Pi.

RunWield must remain the source of truth. Each turn starts a new `agy` process and rebuilds its conversation input from
the RunWield Session Transcript, as the Claude CLI backend does. Antigravity conversation files and conversation IDs are
not required for replay or continuation.

The user chose temporary global custom-agent materialization without a separate approval prompt. Selecting an
`agy-cli/*` model is sufficient consent. RunWield creates a clearly owned `runwield-<agent-name>-<short-unique-id>`
selector for one root Agent Session or one isolated turn, then removes the unchanged owned file on dispose. The selector
is an internal process/config identifier. User-facing RunWield surfaces continue to show the canonical Agent Display
Name, such as Router or Planner.

This child deliberately does not add MCP lifecycle tools. Antigravity output can become assistant text, but no prose,
marker, or Antigravity tool record can approve a Plan, complete execution, finish AI code review, or otherwise change
RunWield workflow truth.

## Objective

Make selected `agy-cli/*` root and isolated Agent turns execute through `AgyCliExecutionSession`. The backend must place
the complete RunWield system prompt in a temporary global Antigravity custom-agent definition, pass the exact selected
model to `agy --model`, rebuild prior conversation from the RunWield Session Transcript, stream assistant text through
existing runtime events, and persist exactly one final assistant message plus whitelisted backend metadata in the normal
Session Transcript.

## Approach

Extend the current `ExecutionSession` dispatch used by Pi and Claude. Keep Pi and Claude behavior unchanged. Add an Agy
wrapper and session class that own one process per turn, while the execution-session object retains only RunWield
messages and temporary custom-agent ownership across root turns.

```text
resolved agy-cli/<model-id>
  -> build AgyCliExecutionSession
  -> create runwield-<agent>-<unique-id>/agent.md
  -> verify exact selector through agy /agents
  -> serialize RunWield transcript + current user request
  -> agy -p <conversation> --model <model-id> --agent <selector>
  -> stream assistant text and usage
  -> append RunWield final assistant/backend metadata
  -> remove owned agent.md when the Agent Session is disposed
```

The command is a direct argument array and also uses `--output-format stream-json` and `--disable-slash-commands`. It
must not use a shell, `--continue`, `--conversation`, or `--dangerously-skip-permissions`. The Agent Definition and
final system prompt exist only in `agent.md`; they are never copied into the user-text conversation.

Before MCP support exists, prompt assembly excludes RunWield Custom Tool descriptions and adds a clear backend note:
RunWield workflow tools are unavailable in this slice, assistant prose is non-terminal, and the Agent must not claim
that it changed workflow state. Antigravity `tool_info` remains display-only parser data and is not converted to a
Workflow Tool Event.

The option set aside is Antigravity's long-lived `--input-format stream-json` mode. It is faster, but it accepts only
new user messages and cannot reconstruct prior assistant history from the RunWield transcript after a restart. Depending
on `--conversation` would make Antigravity's private conversation store required state. Separate Agy modules are also
preferred over widening Claude-specific command and stream schemas.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/models/model-execution.ts` — accept `agy-cli` as executable now that dispatch exists, while preserving the
  typed rejection for unknown backend values.
- `src/shared/session/execution-backend.ts` — add the Agy wrapper, message access, steering-target handling, disposal,
  and recognition without changing the Pi or Claude wrapper contracts.
- `src/shared/session/session.js` — compose Agy sessions, omit unavailable RunWield tools from their prompt, route root
  and isolated turns through them, preserve Agent Display Names, and make unsupported Agy steering fail safely rather
  than call a missing method.
- `src/shared/session/backends/agy-cli/` — extend the spike modules with temporary custom-agent definition formatting
  and lifecycle, exact model command arguments, transcript serialization, successful-turn stream handling, and
  `AgyCliExecutionSession`.
- `src/shared/models/agy-cli-models.test.ts` and `src/shared/session/agy-cli-model-selection.test.ts` — replace child
  02's deliberate unsupported-backend expectation with executable dispatch while preserving exact model IDs, deferred
  selection safety on real setup failure, and unknown-backend rejection.
- `src/shared/session/agy-cli-execution.test.ts` — prove root, follow-up, isolated, disposal, transcript, runtime-event,
  display-name, and no-workflow-signal behavior through a generated fake `agy` executable.
- `src/shared/session/session-transcript-projection.test.js` and `src/shared/session/root-session.test.js` — prove Agy
  transcript entries replay through RunWield data with normal Agent Display Names and no dependency on Antigravity logs.
- `docs/domain-language.md` — add Antigravity CLI as an implemented Execution Backend example and keep RunWield's
  Session Transcript and workflow authority explicit.

`src/shared/session/agent-handler.ts` is not expected to change. Its current workflow path already consumes accepted
Workflow Tool Events and does not interpret assistant prose. Child 04 owns MCP workflow-tool bridging, and child 05 owns
the full failure taxonomy, timeout policy, replayable backend-status errors, and hardened continuation/cancellation.

## Reuse Opportunities

- `src/shared/session/backends/claude-cli/execution-session.ts` — reuse transcript reconstruction, user/backend/model/
  assistant entry ordering, runtime text and usage events, basic abort/dispose shape, and one-process-per-turn
  ownership.
- `src/shared/session/backends/agy-cli/{custom-agent,command,process,stream-parser,spike}.ts` — promote the proven
  direct command, exact `/agents` verification, safe global-file ownership, parser, and real subprocess boundary into
  normal execution without retaining the removed proof script or a repository-local fake executable.
- `src/shared/session/session.js#assembleFinalSystemPromptWithContextProjection` — build the same Agent Definition and
  Project/Session context as other backends, then add only the Agy child-03 capability note.
- `src/shared/session/request-dispatch.ts` — keep request IDs, attempt IDs, retry classification, and completion/failure
  recording backend-neutral.
- `src/shared/session/session-transcript-projection.js` — reuse normal user, assistant, active-Agent, and model replay;
  Agy conversation data must not become a second projection source.
- `src/testing/process-global-lock.ts#withProcessGlobalTestLock` and `scripts/run-tests.js` — isolate `HOME`, `PATH`,
  and generated fake executables so tests never touch the developer's Antigravity configuration.

## Implementation Steps

- [ ] The child-02 target branch state is the implementation base. `assertModelExecutionBackendSupported` accepts
      `"pi"`, `"claude-cli"`, and `"agy-cli"` only; unknown persisted backend values still throw
      `UnsupportedModelExecutionBackendError`, and no Agy descriptor can fall through to Pi construction.
- [ ] `ExecutionSession` has a first-class `{ kind: "agy-cli", session: AgyCliExecutionSession }` member. Root message
      access, wrapper recognition, steering-target selection, and disposal handle all three backends without changing Pi
      or Claude behavior or passing a raw Agy session where a wrapper is required.
- [ ] `buildExecutionSession` routes a resolved `agy-cli/*` model to `AgyCliExecutionSession` for both root and isolated
      calls. Root replacement remains transactional: a failure during temporary-agent creation or exact `/agents`
      preflight leaves the prior root Agent and selected model usable.
- [ ] Each Agy execution session creates one global custom-agent directory named
      `runwield-<sanitized-agent-name>-<short-unique-id>`. Its `agent.md` has valid Antigravity front matter and the
      exact assembled RunWield system prompt body. The unique suffix prevents concurrent Sessions from sharing cleanup
      ownership. No extra approval interaction occurs because explicit Agy model selection is the consent boundary.
- [ ] Root sessions retain the temporary agent until dispose; isolated sessions retain it only for their one turn.
      Disposal removes only an unchanged file and directory created by that session. Partial construction, failed
      preflight, process failure, root replacement, and isolated-session `finally` paths also invoke ownership-checked
      cleanup. A crash can leave a clearly named file, but later runs neither overwrite nor claim it.
- [ ] RunWield presentation remains authoritative for identity. Runtime events, TUI/Workspace state, transcript entries,
      replay, and ordinary errors use the canonical Agent Display Name. They do not expose or derive identity from the
      temporary Agy selector. The selector can appear only in direct Antigravity config inspection or explicit manual
      crash-cleanup guidance.
- [ ] `prepareAgyCliStreamCommand` receives the exact non-empty model selector and emits direct arguments equivalent to
      `agy -p <serialized-conversation> --model <selector> --agent <temporary-selector> --output-format stream-json
      --disable-slash-commands`.
      It uses no shell, `--continue`, `--conversation`, or `--dangerously-skip-permissions`. The custom-agent definition
      and RunWield system prompt never occur in the serialized user-text argument.
- [ ] Before every Agy turn, transcript reconstruction reads the current RunWield branch and serializes its effective
      user and assistant history plus the current request with the same named-invocation expansion and duplicate-display
      avoidance rules used by Claude CLI. A second root turn demonstrably receives the first RunWield assistant
      response. Deleting Antigravity conversation/log files between turns does not change the result.
- [ ] Agy prompt composition exposes no RunWield Custom Tool as available before child 04. A backend-specific note says
      that lifecycle tools are unavailable, assistant prose is non-terminal, and no completion claim changes workflow
      state. The existing Agent Handler receives no Workflow Tool Event from Agy text or `tool_info`.
- [ ] The successful-turn parser accepts the documented `event` envelopes and already-supported spike variants, emits
      only assistant text deltas while streaming, requires one successful terminal `result`, and returns final text,
      usage, and an optional conversation ID. It does not persist `tool_info`, raw stderr, prompts, config paths,
      command environments, or the temporary selector.
- [ ] A successful durable turn appends the normal RunWield user message, whitelisted `runwield.execution_backend` data
      (`version`, `backend`, `provider`, `model`, `outputFormat`, request/attempt IDs, and optional external
      conversation ID), model state, and exactly one final assistant message. Usage emits through the existing runtime
      event. Replay needs only the RunWield Session Transcript.
- [ ] Images fail before global-file creation, process start, or transcript mutation. Agy `low`, `medium`, and `high`
      thinking values map to `--effort`; unset or `off` omits the flag; unsupported RunWield levels fail before global
      file creation. Live steering is explicitly unsupported in this tracer bullet and returns “not accepted” without a
      missing-method error, transcript change, or Pi/Claude regression. Basic abort/dispose kills an active process;
      child 05 adds complete cancellation status and timeout semantics.
- [ ] `docs/domain-language.md` lists Antigravity CLI as an implemented Execution Backend and keeps the invariant that
      RunWield owns Session Transcript, replay, Workflow Tool Events, and Plan Lifecycle truth.

## Approval Confirmation

No Work Records are proposed for supersession. The Claude CLI Epic Work Record is a precedent, not work replaced by this
Plan.

## Verification Plan

- Automated backend and vertical behavior:
  `deno run -A scripts/run-tests.js src/shared/session/backends/agy-cli/agy-cli-backend.test.ts src/shared/session/agy-cli-execution.test.ts`
- Automated model guard/selection and transcript behavior:
  `deno run -A scripts/run-tests.js src/shared/models/agy-cli-models.test.ts src/shared/session/agy-cli-model-selection.test.ts src/shared/session/session-transcript-projection.test.js src/shared/session/root-session.test.js`
- Automated backend-neutral regressions:
  `deno run -A scripts/run-tests.js src/shared/session/claude-cli-execution.test.ts src/shared/session/session-prompt.test.js src/shared/session/abort-active-session.test.js`
- Automated project gates: `deno task check`, `deno task seams:check`, then `deno task test` because Session dispatch,
  model switching, transcript replay, and root/isolated execution all change.
- Objective-failing fake-process test: generate a fake `agy` executable in the sandboxed `PATH`. It must read the exact
  temporary `agent.md`, reject a missing or altered `--model`, derive its response from randomized prior RunWield
  user/assistant history plus the current request, and log received arguments. The test fails if dispatch falls through
  to Pi, returns a hard-coded/pass-through answer, omits the selected model or custom agent, copies the system prompt
  into user text, relies on `--conversation`, or does not supply the prior assistant response on turn two.
- Root behavior test: switch a real fixture Session from Pi to an explicit generated `agy-cli/<model-id>`, run two text
  turns, and prove both use Agy; the second process receives RunWield history; runtime deltas and usage are emitted; the
  transcript has one final assistant message per turn; active model/Agent identity stays correct; and replay after
  deleting all fake Antigravity conversation data reproduces the same visible history.
- Isolated behavior test: use the real HostedSession isolated runner, prove its Agy process receives an in-memory
  transcript and exact model, then prove its temporary custom-agent path is gone and the root Session model, messages,
  Agent Display Name, and workflow state are unchanged.
- Ownership and identity tests: run two same-role Agy sessions concurrently and prove distinct temporary selectors and
  independent cleanup. Assert all RunWield events and replay show the fixture Agent Display Name, never either selector
  or unique suffix. A changed or foreign file is preserved rather than deleted.
- Workflow-authority test: make the fake Agy output text resembling `plan_written`, `task_completed`, `review_complete`,
  and sentinel markers plus `tool_info`; prove no Workflow Tool Event, Plan Event, Plan Status change, Task Completion,
  or AI code review result occurs.
- Existing behavior protected: Pi remains the default and keeps its tool loop, Claude CLI keeps its command, transcript,
  and MCP behavior, unknown execution backends still fail with the typed error, and root replacement failures preserve
  the old usable root. No existing behavior is expected to stop. Child 02's temporary rejection of valid `agy-cli`
  execution is the only behavior intentionally removed.
- Manual with installed, authenticated `agy`: select one valid `agy-cli/<model-id>`, run two controlled non-terminal
  text turns, and confirm the second answer uses the first turn; RunWield shows the normal Agent Display Name; the
  selected model appears in Agy `init` data; no approval prompt appears; and the temporary
  `~/.gemini/config/agents/runwield-*` path is removed when the Agent Session is replaced or closed. Close and reopen
  RunWield, replay the Session without starting `agy`, and confirm both answers remain visible.
- Manual limitation check: ask the Agy-backed Agent to complete a workflow. It must explain that lifecycle completion is
  unavailable in this slice, and RunWield workflow state must remain unchanged until child 04 adds MCP tools.
- Glossary check: `docs/domain-language.md` describes the implemented Agy execution path and does not imply MCP,
  failure-hardening, image, or steering parity that this child does not deliver.

## Edge Cases & Considerations

- The global Antigravity directory is user-owned. Normal selection authorizes only creation of the unique RunWield path;
  it does not authorize changes to settings, permissions, unrelated agents, existing conflicting content, or parent
  configuration. Cleanup stays ownership- and content-checked.
- Temporary Agy selectors are not product identity. Antigravity has no separate display-name field, so direct inspection
  of its own agent list can show the internal selector while it exists. RunWield must never show that selector as the
  active Agent label.
- Transcript flattening resends history on every turn and costs more input tokens than a warm Agy process. This is the
  accepted cost of restartable RunWield-owned replay. Existing context-capacity checks must reject an oversized request
  rather than silently drop history.
- `init.agent` is metadata, not proof of installation. Exact `/agents` preflight remains required. `init.model` should
  match the selected model when present, and a mismatch fails rather than accepting fallback execution.
- Antigravity internal logs and conversation IDs are optional metadata only. The backend must never use “most recent”
  conversation state because concurrent RunWield Sessions would cross-contaminate.
- Agent instructions can still refer to lifecycle tools because they are shared definitions. The final Agy capability
  note must state the temporary limitation without weakening the Agent's other product rules. Child 04 removes this
  limitation when it supplies real MCP tools.
- Image delivery, Antigravity subagents, native-tool transcript parity, complete permission policy, status replay,
  failure taxonomy, timeout policy, robust cancellation, and live steering remain in later children. This child must
  still fail unsupported inputs before side effects and clean up its owned process/config resources.
- Tests must use `scripts/run-tests.js`, sandboxed `HOME`, and a generated fake executable. They must not require a real
  `agy` install, mutate the developer's Antigravity configuration, add a RunWield-owned dependency-injection seam, or
  restore removed proof helpers.
