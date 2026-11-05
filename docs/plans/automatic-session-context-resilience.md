---
planId: "a72d1a30-d67c-4a90-ae8b-27b754fe55ae"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "deno.json"
    - "deno.lock"
    - "src/shared/session/session-context-resilience.ts"
    - "src/shared/session/session-context-resilience.test.js"
    - "src/shared/session/session.js"
    - "src/shared/session/session-prompt.test.js"
    - "src/shared/session/session-subscribers.test.js"
    - "src/shared/session/hosted-session.js"
    - "src/shared/session/hosted-session.test.ts"
    - "src/shared/session/abort-active-session.test.js"
    - "src/shared/session/runtime/turns.ts"
    - "src/shared/session/runtime/agent-settings.ts"
    - "src/shared/session/runtime/managed-operations.ts"
    - "src/shared/session/session-runtime.test.js"
    - "src/shared/session/session-runtime-events.js"
    - "src/shared/session/session-runtime-events.test.js"
    - "src/shared/session/types.js"
    - "src/shared/session/agent-handler.ts"
    - "src/shared/session/agent-handler.test.ts"
    - "src/shared/session/root-workflow-turn.ts"
    - "src/shared/session/request-dispatch.ts"
    - "src/shared/session/background-tasks.ts"
    - "src/tools/delegate-agent.ts"
    - "src/tools/__tests__/delegate-agent.test.ts"
    - "src/cmd/compact/index.ts"
    - "src/cmd/compact/index.test.js"
    - "src/ui/tui/runtime-adapter.ts"
    - "src/ui/tui/runtime-adapter.test.ts"
    - "src/acp/event-mapper.ts"
    - "src/acp/server.test.js"
    - "src/ui/workspace/components/SessionTimeline.jsx"
    - "src/shared/session/session-transcript-projection.js"
    - "docs/sessions.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/session-context-resilience-prd.md"
    - "docs/adr/010-session-runtime-sibling-adapters-and-acp.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-07-20T23:46:14-04:00"
origin: "internal"
userVerifiedAt: null
status: "ready_for_work"
---

# Automatic Session Context Resilience

## Context

RunWield must compact long Pi Agent Sessions without repeated ineffective attempts, lost messages, or false task
completion. Current RunWield adds pre-request checks and an early Engineer threshold. It also patches Pi's private
`_checkCompaction()` and calls `_runAutoCompaction()`. These paths do not share a verified recovery decision.

The inspected dependency family is Pi 0.87.1, selected by `^0.87.1` imports. Pi now checks context before the next
assistant response. It exposes an Agent `finishTurn` callback and public `compaction_end` recovery measurements.
However, an ended Agent loop can restart through AgentSession when queues remain. The compaction result event is not an
awaited permission to continue. The missing prerequisite is supported control over recovery, all automatic compaction
paths, and queue-safe continuation—not basic mid-run compaction.

The existing three tests in `session-context-resilience.test.js` passed during re-review. They use a bare Agent and
check guessed method names, so they do not prove the current AgentSession behavior. Replace that evidence with real
AgentSession characterization. Historical issue <https://github.com/earendil-works/pi/issues/4325> and the historical
Work Record `dc467de9-9e61-4746-a4c0-c7b3cecae1c9` are background, not proof that this capability is present today.

The owning capability is [Core: Compaction and image context](../prd/runwield-core-prd.md#compaction-and-image-context),
including **Retain useful conversation and attachment context**. The linked
[Session Context Resilience proposal](../prd/session-context-resilience-prd.md) supplies target requirements for useful
recovery, same-assignment continuation, cancellation, and content-free status. This change adds their verified Pi
behavior and removes growth-only retries after ineffective compaction. Manual compaction, resume controls, disabled
compaction settings, Named Invocation expansions, and useful conversation context must survive.

[Core: Session continuity](../prd/runwield-core-prd.md#session-continuity) and
[Execution, validation, and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery) remain
authoritative for Session identity, workflow preservation, and recoverable interruptions. Terminal user interface (TUI),
Agent Client Protocol (ACP), and Workspace must present equivalent outcomes. The user retained the upstream-first
architecture: no private Pi workaround. Approval is for later implementation until the public dependency contract below
is proven.

On re-review, the user confirmed two trigger policies:

- Engineer-family Agents retain the early trigger at `min(floor(W * 0.5), 80000)` tokens. The current family is
  Engineer, Plan Engineer, Frontend Engineer, and Validation Repair Engineer.
- All other Pi Agents retain the standard trigger strictly above `W - R`, where `W` is the active model context window
  and `R` is its effective `compaction.reserveTokens`.
- Post-compaction recovery must prevent repeated ineffective compaction. Context growth alone must not restart that
  loop. No new user-facing threshold setting is required.

The user also confirmed that useful Engineer compaction may leave context above the early trigger and still continue,
provided it is safe under `W - R`. In that case, early compaction stays disarmed. Context growth does not re-arm it.
Failed or ineffective compaction still pauses automatic recovery and continuation.

Known workflow phase changes are a separate concern. Planning-to-execution and semantic-review-to-Engineer-repair use
explicit fresh Session Transcript Segments with bounded seed packets. This Plan protects unexpectedly long activity
inside whichever segment is current; it must not compact and reuse a predecessor transcript when the workflow requires
transactional segment rollover.

## Objective

After the public Pi prerequisite is proven, add coordinated automatic context resilience for root, foreground isolated,
and background delegated Pi Agent Sessions. Other Execution Backends retain their existing behavior; this Plan does not
claim control over compaction inside Claude CLI or Antigravity CLI.

RunWield will detect pressure at a completed internal turn, prevent another provider request, serialize automatic
compaction per Hosted Session, verify recovered headroom, and continue the same assignment without a second User Request
or workflow dispatch. Failed or ineffective recovery must pause automatic intervention and leave the Session usable and
cancelable with actionable status instead of causing a compaction loop or provider context-window error.

The coordinator operates only within the current transcript segment. Explicit workflow-owned rollover takes precedence
and resets context-health state for the activated successor segment.

## Approach

### Public dependency gate

> [!WARNING]
> **The complete public contract is not yet proven**
>
> Start with Pi 0.87.1. Its new hooks satisfy only part of this Plan. Keep feature implementation on hold if the real
> AgentSession cannot pass the contract tests. A dependency upgrade, method-name check, or passing old fixture is not
> sufficient evidence.

The released interface must let RunWield, without private property/method access:

- evaluate or request a graceful stop after a completed internal turn and before queue polling or another provider call;
- preserve the completed assistant response and all tool results without an aborted transcript artifact;
- run automatic compaction with normal Pi summaries and `threshold` lifecycle events;
- inspect `tokensBefore`, `estimatedTokensAfter`, cancellation, and failure before deciding whether to continue;
- continue from the compacted context through a supported Agent Session operation while preserving steering/follow-up
  ordering and Agent Session settlement; and
- suppress continuation after cancellation, failed recovery, or unsafe post-compaction pressure.

The contract must also cover Pi's native pre-response, post-run, and overflow paths. None may compact outside the shared
arbiter or continue after a recovery veto. Do not patch `Agent.createLoopConfig()`, `_checkCompaction()`, or
`_runAutoCompaction()`, or call `agent.continue()` around AgentSession. Do not use subscriber-driven `abort()` as a
graceful-stop substitute. Upgrade the related Pi packages together only if a newer released family is needed. Keep
imports and lockfile aligned; avoid unrelated upgrades.

### One owner for compaction policy

`session-context-resilience.ts` owns threshold selection, measurement, compaction serialization, and continuation.
Callers provide the real Hosted Session, Agent identity, Pi Session, and operation signal. They do not choose
thresholds, supply replacement policy, or inject RunWield-owned storage and workflow functions. `session.js` keeps Agent
construction and subscription. Adapters only render Core outcomes.

```text
Runtime turn / isolated Pi turn
  runPrompt
    context-resilience policy owned by Hosted Session
      public Pi completed-turn control
      shared compaction arbiter
      measure -> continue same assignment OR pause
```

The Hosted Session retains root health for the current segment across managed-operation dehydration and root rebuilds. A
WeakMap keyed only by a disposable Pi AgentSession is insufficient. Agent changes recompute eligibility without
forgetting a failed recovery on unchanged root context. Each isolated child has separate health, but all children,
including background children, share the Hosted Session arbiter. Detach disposed children. Segment rollover detaches
predecessor operations and starts clean successor health; it never compacts or continues the sealed predecessor.

Replace the existing Engineer threshold wrappers and pre-request private call, rather than adding a second controller.
Move their Pair checkpoint and request-attempt snapshot restoration to supported compaction lifecycle handling. Preserve
Named Invocation context edits and Pi's own summaries. This keeps future threshold changes in one policy owner.

### Trigger and recovery policy

Use the active model's effective settings, including `getCompactionSettings(model)` overrides:

- Standard safety threshold: `T = max(0, W - R)`, with pressure only at `usage > T`.
- Engineer early threshold: `E = min(floor(W * 0.5), 80000)`, with pressure at `usage >= E` while early compaction is
  armed. Apply it only to `AGENTS.ENGINEER`, `PLAN_ENGINEER`, `FRONTEND_ENGINEER`, and `REVIEWER_FEEDBACK_ENGINEER`.
  Other Agents never use `E`.
- Minimum useful recovery: `M = min(R, floor(T / 2))`. Require strict progress when `M = 0`.
- Standard paused re-arm band: `S = max(0, T - M)`.
- Engineer early re-arm band: `SE = max(0, E - M)`. This uses the same recovery margin, not a new percentage setting.

The user chose the two triggers, useful continuation above `E`, and no growth-only re-arm. `SE` is the implementation
assumption that applies the existing reserve-derived recovery margin to the early trigger. A zero-margin case must still
land strictly below `E` before early re-arm, since the early trigger is inclusive.

After any automatic attempt, determine the next early-trigger state from the recovery estimate, not a boolean return
value. Effective recovery may continue at or below `T`, even above `E`. Keep early compaction armed only if resident
usage lands at or below `SE` and strictly below `E`; otherwise disarm it. A later measurement can re-arm it only on
those same boundaries. Setting the next state during a successful compaction adds no extra `rearmed` event to that
lifecycle. Do not restore the old 5%-or-8K growth rule. Standard protection at `T` remains active for Engineers when
early compaction is disarmed; this is the safety fallback, not permission to repeat the early attempt as context grows.

On failed or ineffective recovery, stop the current automatic continuation and latch recovery pause. Capture usage at
that failure. Later unchanged or growing usage must not clear the latch, even if an early attempt failed below `S`. For
non-Engineers, clear it only after a measured reduction reaches `S`. For Engineers, require reduction into both bands:
`usage <= min(S, SE)` and `usage < E`. Manual recovery or a model/settings change that makes the same usage fit these
recomputed bands can also re-arm. Toggling auto-compaction off and on with unchanged capacity is not recovery.

After the paused operation settles, a later user request may use safe context without automatic retries. Check its full
prepared size against `T`; if unsafe, pause before submission. Do not resume the interrupted assignment automatically
merely because a later measurement clears the latch.

A compaction is effective only when Pi reports finite non-negative `tokensBefore` and `estimatedTokensAfter`, the
estimate lands at or below `T`, and it recovers at least `M` tokens (or makes strict progress when `M` is zero). Before
an initial User Request, include its estimated tokens when checking both the trigger and post-compaction safety. An
effective pre-request compaction then submits the original prepared request exactly once; it emits
`compacting(threshold), compacted(threshold)` but no continuation events or internal continuation entry because the
assignment has not started. If the prepared request alone exceeds `T` even against an empty history, skip compaction,
stop before provider submission, and emit only `paused(oversized_request)`. If the request can fit alone but attempted
compaction leaves total estimated context above `T` or recovers less than `M`, emit
`compacting(threshold), ineffective(insufficient_recovery), paused(insufficient_recovery)` and do not submit it. A
compaction error instead emits `compacting(threshold), failed(compaction_failed), paused(compaction_failed)`.

Recompute `W`, `R`, `T`, `E`, `M`, `S`, and `SE` when Agent identity, model, context window, enabled flag, or effective
reserve changes. Do not treat an unknown post-compaction usage report as zero: retain Pi's finite recovery estimate
until newer usage replaces it. A model/settings change is not itself proof of safe recovery.

Automatic compaction disabled by settings, or `disableAutoCompaction` for an isolated invocation, must remain disabled.
Preserve the isolated invocation's existing fail-before-provider sizing behavior. A manual `/compact` is still explicit
user action and may run when the arbiter is free. Missing or invalid capacity cannot authorize automatic continuation
based on guessed headroom.

On effective recovery, continue with an internal custom message having `customType:
"runwield_context_continuation"`,
`display: false`, no details payload, and fixed content telling the Agent to rely on the compaction summary, continue
the same assigned work, and avoid repeating unchanged discovery. The entry may persist privately in the Session
Transcript as model context, but must not emit a Runtime `USER_MESSAGE`, appear as user-authored replay, rerun the Agent
Handler, restart Router Triage, change the active Agent, release Runtime busy state, or advance Plan Lifecycle. Use the
public Pi continuation/queue interface atomically: user steering and follow-up messages already queued at the
continuation decision point retain their native order ahead of the internal continuation; no message may be duplicated
or dropped. Before each task-provider submission, recheck the actual projected context, including queued user input,
Named Invocation expansions, images, and generated continuation. A safe summary estimate alone cannot authorize an
unsafe next request. If newly queued input leaves that request unsafe after recovery, pause without another automatic
compaction of the unchanged recovered history; retain the queued input for normal recovery handling.

### Workflow and delegated outcomes

A recoverable context stop is not a provider failure or completed task. `runPrompt()` raises typed
`ContextResiliencePaused`; root handling returns `{ kind: "context_paused" }` and Runtime settles with `ok: true`
without changing the active Agent or In-Progress Plan. Classify this outcome in `runRootTurn()` before
`failRequestDispatch()` and in `agent-handler.ts`; do not let it enter backend-failure retry logic. Record a distinct
paused request-attempt phase with truthful `requestRecorded` for pre-submission versus mid-run pauses. It is not a
failed or completed attempt. Existing transcript entries stay readable. Internal continuation retains the same request
and attempt identities; it does not prepare a second dispatch or emit `BACKEND_CONTINUATION_REQUEST`.

Workflow Tool Events, not transcript tool-result scans, remain the authority. In `root-workflow-turn.ts`, an accepted
terminal handoff wins over predecessor compaction or continuation. Preserve feedback-only Plan review behavior and
consume accepted events once. A context pause cannot fabricate a workflow event, consume a pending Task Completion as
success, or erase a completion that was already accepted. `WorkflowStepCompleted` stays an internal handoff signal, not
user cancellation. Session Transcript Segment Rollover follows the existing workflow owner after the outgoing operation
settles.

Foreground delegation maps the typed pause to one tool result with `isError: true` and
`details.error: "context_resilience_paused"`, then disposes the child. The parent remains active; partial child output
is not a successful handoff. A background delegation has already returned its task ID: its existing Background Task
record settles `failed` with a deterministic `context_resilience_paused` error and one normal completion notification.
Do not fabricate a second foreground tool result. Background children receive the coordinator even though they skip
foreground subscribers. Unexpected implementation errors retain existing error handling.

### Cancellation and manual compaction

User cancellation preserves existing RunWield semantics: it clears all queued user steering/follow-up messages and any
still-queued internal continuation, emits the existing queued-message dequeue events, emits exactly one `CANCELLATION`,
emits context `canceled` at most once, never emits `TERMINAL_ERROR`, and wins every race against compaction or
continuation. Once the private internal continuation entry has been persisted and its provider turn has started,
cancellation aborts that active turn and preserves the transcript entry; it does not require unsupported transcript
rollback, and no later continuation/provider call may start. Manual `/compact` and automatic intervention share the
Hosted Session arbiter. A manual request acquires the lease when free; if any automatic or manual compaction already
owns it, the command returns immediately with `{ ok: false, error: "compaction_in_progress" }` and starts no second
compaction. Automatic waiters remain first-in-first-out (FIFO) and remeasure after acquiring the released lease.

Place the manual busy check before `runManagedStandaloneMutation()` can wait for the active operation. If a prompt is
active but no compaction owns the arbiter, retain the existing managed-operation wait; do not hold a compaction lease
while waiting for that prompt. Recheck and acquire atomically inside the managed operation. Preserve Session Writer Lock
ownership. Distinguish cancellation from context pause before Runtime's `TERMINAL_ERROR` catch.

### Status on every Session surface

Core emits one validated `context_resilience` event per transition. Keep the original status/reason contract below and
its content-free numeric fields. Replace duplicate generic automatic-compaction messages. Route the same event through
TUI, ACP, and Workspace's existing system-event row; do not add a new visual pattern. Record semantic outcomes as
append-only custom entries in the current Pi transcript, using the existing pattern for backend status. Project those
entries with stable event IDs so live and reloaded history agree without duplicate rows. They are display evidence, not
a new workflow authority. Hidden continuation must never become a user-authored replay message or resolve a Pair
checkpoint.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `deno.json` — change the related Pi constraints only if a newer released family is required to pass the public
  contract. The current baseline is 0.87.1, not 0.80.x.
- `deno.lock` — lock the verified Pi release family; do not execute unrelated dependency upgrades.
- `src/shared/session/session-context-resilience.ts` — own the Engineer-only early trigger, standard safety policy,
  shared arbiter, useful recovery, early disarm, failure pause, and public Pi continuation. New production code is
  TypeScript under ADR-013; do not add a JavaScript baseline exception.
- `src/shared/session/session-context-resilience.test.js` — characterize the released public Pi contract and cover the
  policy, state machine, long autonomous run, compaction serialization, queue ordering, continuation, pause, and re-arm.
- `src/shared/session/session.js` — replace private compaction calls and Engineer wrappers with one public-policy path
  for root, foreground isolated, and background Pi turns. Preserve checkpoint/request snapshots and prepared prompt
  estimation. Classify pause before backend-failure recording; leave non-Pi backend dispatch unchanged.
- `src/shared/session/session-prompt.test.js` — verify pre-request estimation, fail-before-provider behavior, internal
  continuation, no duplicate User Request/routing, and ordinary behavior below threshold.
- `src/shared/session/session-subscribers.test.js` — verify completed-turn observation and canonical context-resilience
  emission without duplicate generic compaction statuses.
- `src/shared/session/hosted-session.js` — retain the coordinator and current-segment root health across Pi Session
  disposal, plus isolated-child health and cancellation. All compaction shares one arbiter per Hosted Session.
- `src/shared/session/hosted-session.test.ts` — cover arbiter exclusivity, active-turn cancellation/settlement,
  disposal, and isolation between Hosted Sessions.
- `src/shared/session/abort-active-session.test.js` — verify the shared abort path handles streaming and compaction for
  root and every registered transient Agent Session without duplicate aborts.
- `src/shared/session/runtime/turns.ts`, `runtime/agent-settings.ts`, and `runtime/managed-operations.ts` — integrate
  pause/cancellation settlement, fail-fast manual compaction, and health retention across ordinary dehydration. Keep
  `session-runtime.ts` as the public facade; policy belongs in the private owners.
- `src/shared/session/session-runtime.test.js` — cover cancellation races, recoverable paused settlement, busy-state
  continuity, root/transient parity, and independent Hosted Session progress.
- `src/shared/session/session-runtime-events.js` — add one canonical `context_resilience` event with validated status,
  reason, message, and content-free pressure/recovery fields.
- `src/shared/session/session-runtime-events.test.js` — enforce the new event's exact required fields/enums and producer
  payload allowlist.
- `src/shared/session/types.js` — add a `context_paused` Agent turn result so recoverable pressure is distinguishable
  from normal completion and handoff without becoming a provider/runtime error.
- `src/shared/session/agent-handler.ts`, `root-workflow-turn.ts`, and `agent-handler.test.ts` — distinguish a pause from
  a consume-once accepted Workflow Tool Event. Do not restore the retired transcript-outcome scanner.
- `src/shared/session/request-dispatch.ts` and its tests — record paused attempts without marking backend failure or
  generating a second request. Preserve legacy attempt records and genuine backend-failure continuation.
- `src/shared/session/segment-rollover.test.js` and execution/repair handoff tests — verify predecessor suppression and
  clean successor health through real workflow boundaries.
- `src/tools/delegate-agent.ts`, `src/shared/session/background-tasks.ts`, and background task tests — map foreground
  and background pause outcomes through their different existing settlement paths. Do not present partial output as
  successful work.
- `src/tools/__tests__/delegate-agent.test.ts` — verify delegated Agent cancellation and context pause preserve tool
  settlement, report `context_resilience_paused` deterministically, and respect Hosted Session compaction serialization.
- `src/cmd/compact/index.ts` — handle Runtime's `compaction_in_progress` result without reading success-only compaction
  fields and display one concise retry-later message.
- `src/cmd/compact/index.test.js` — cover shared-arbiter acquisition, immediate `compaction_in_progress` behavior,
  manual-compaction re-arm, and non-duplicated manual/automatic status.
- `src/ui/tui/runtime-adapter.ts` — render canonical context-resilience messages without implementing policy or
  normalization in the TUI.
- `src/ui/tui/runtime-adapter.test.ts` — verify each user-visible context outcome renders once.
- `src/acp/event-mapper.ts` — map the same semantic event to ACP text plus structured `_meta` status/reason fields.
- `src/acp/server.test.js` — verify ACP receives equivalent outcomes without Session content or TUI-specific semantics.
- `src/ui/workspace/components/SessionTimeline.jsx` and Session history/event projection tests — render the new event
  once with the existing system-event row, in both live and saved history. Reuse `docs/design-system.md` patterns and
  `--rw-*` tokens; no redesign is in scope.
- `src/shared/session/session-transcript-projection.js` and the existing live-event persistence path — preserve semantic
  context outcomes and exclude the hidden continuation from user-message replay.
- `docs/sessions.md` — document Engineer-only early compaction, standard thresholds for other Agents, useful recovery,
  continuation, pause/re-arm, cancellation, and `/compact`, `/context`, and `/session` behavior.
- `docs/prd/runwield-core-prd.md`, `docs/prd/session-context-resilience-prd.md`, and affected references — fold lasting
  requirements/scenarios into the owning Core capability when implemented, retain unmet scope as target/deferred, and
  retire the transient proposal only after its unique intent is preserved.
- `docs/adr/010-session-runtime-sibling-adapters-and-acp.md` — record shared policy ownership, the public-Pi constraint,
  and health retention across disposable Pi Sessions. Preserve ADR-012 rollover precedence and ADR-015 file authority;
  update their references only if needed. No new domain concept or glossary alias is proposed.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `@earendil-works/pi-coding-agent` and `pi-agent-core` — characterize current public `finishTurn`, recovery events,
  model-effective settings, `shouldCompact()`, projected context, and compaction/continuation operations. Reuse Pi's
  summaries and transcript format; do not infer missing behavior from hook names.
- `src/shared/session/session.js` — reuse prepared User Request token estimation, Agent Session metadata, and
  subscription lifecycle while moving compaction policy out of this broad module.
- `src/shared/session/session-runtime-events.js` — reuse fail-fast canonical event creation so TUI and ACP remain
  sibling consumers of one semantic contract.
- `src/shared/session/hosted-session.js` — reuse per-Session turn ownership and transient Agent registration to scope
  the arbiter and cancellation.
- `src/shared/session/session-context-report.js` — reuse existing context-window/usage normalization where applicable;
  adapters must not inspect Agent Session internals.

## Implementation Steps

- [ ] Step 1: `session-context-resilience.test.js` characterizes the real released AgentSession with a deterministic
      provider and real SessionManager, starting with 0.87.1. It proves completed tool persistence, graceful stop before
      another provider request, native mid-run compaction, recovery veto, queued-message behavior, and cancellation.
      Bare-Agent fixtures and guessed method-name checks no longer claim to prove the prerequisite. If any required
      control needs private access, the dependency remains blocked: retain truthful characterization evidence, make no
      production feature change, and do not report this Plan implemented.
- [ ] Step 2: The selected Pi family passes the full public contract, and imports/lockfile agree. Upgrade `pi-ai`,
      `pi-agent-core`, `pi-coding-agent`, and compatible `pi-tui` only when necessary. Record the verified version and
      supported operations. Dependency regressions are distinguished from feature regressions with focused baseline
      tests before integration.
- [ ] Step 3: `session-context-resilience.ts` is the sole owner of `W/R/T/E/M/S/SE`, Engineer eligibility, early disarm,
      useful recovery, and failure pause. Non-Engineers use only `T`; Engineers continue safely above `E` after useful
      recovery. Unchanged or growing context cannot clear a failure latch or re-arm early compaction. Model-effective
      settings, disabled compaction, inclusive/exclusive boundaries, zero margin, and invalid measurements are covered.
- [ ] Step 4: Hosted Session health survives same-segment dehydration and root rebuilds, while each isolated child has
      separate health. A shared FIFO arbiter serializes every native and RunWield automatic/manual compaction path.
      Waiters start no provider request, remeasure on acquisition, and release on every settlement path. Public Runtime
      manual compaction returns `compaction_in_progress` before waiting when already busy, without holding a lease while
      waiting for an otherwise active prompt.
- [ ] Step 5: `runPrompt()` and public Pi lifecycle integration use that policy before prompt submission and completed
      internal-turn continuation. Original prepared requests, images, and transition steering are counted and submitted
      once. The old Engineer growth rule and private `_checkCompaction`/`_runAutoCompaction` wrappers are removed from
      the managed path. Pair checkpoint and request-attempt snapshots still survive compaction through public hooks.
- [ ] Step 6: Effective mid-run recovery uses one hidden `runwield_context_continuation` through a supported
      AgentSession operation. Existing steering/follow-up order is preserved; user messages precede this generated
      entry. The same request/attempt, Agent Handler invocation, Runtime busy operation, and assignment remain active.
      Pre-request compaction adds no continuation entry or continuation events.
- [ ] Step 7: Typed context pause passes through `runRootTurn()`, `root-workflow-turn.ts`, `agent-handler.ts`, and
      Runtime without provider-failure recording or task-completion claims. `request-dispatch.ts` records paused
      attempts with truthful `requestRecorded`; old entries and genuine backend-failure continuation stay compatible.
      Accepted Workflow Tool Events remain consume-once and outrank predecessor continuation. Feedback-only review
      behavior is preserved; no transcript-outcome scanner is introduced.
- [ ] Step 8: Foreground isolated and background delegated Pi Sessions use the same coordinator and arbiter. Foreground
      pause returns one failed delegation result; background pause settles its existing task as failed and notifies
      once. Both dispose child resources without reporting partial text as success. Other Execution Backends keep their
      existing routing and failure behavior.
- [ ] Step 9: User cancellation stops waiting, graceful-stop, compaction, measurement, and continuation work. It clears
      pending user queues and unstarted internal continuation, preserves already persisted entries, emits one Runtime
      cancellation and at most one context cancellation, and holds busy/writer ownership until settlement. It does not
      emit `TERMINAL_ERROR`. `WorkflowStepCompleted` follows handoff rules instead of user-cancel cleanup.
- [ ] Step 10: `session-runtime-events.js` validates one canonical `context_resilience` event with statuses
      `compacting`, `compacted`, `continuing`, `continued`, `ineffective`, `paused`, `canceled`, `failed`, and
      `rearmed`; reasons `threshold`, `oversized_request`, `compaction_failed`, `insufficient_recovery`, `user_cancel`,
      `manual_recovery`, and `capacity_recovery`; a Core-generated `message`; and optional finite numeric
      `usagePercent`/`recoveredPercent`. Normal automatic stages use `threshold`. A manual recovery uses
      `manual_recovery`; measured/capacity recovery uses `capacity_recovery`. Emit re-arm only on an actual latch or
      early-disarm transition that meets its applicable bands. `oversized_request` is a pause reason only. Reject
      prompt, summary, tool, file-content, URL, and arbitrary-details payload keys.
- [ ] Step 11: TUI, ACP, and Workspace render each canonical outcome once. ACP `_meta` includes only the allowed context
      fields plus standard Runtime metadata. Workspace reuses the current system-event row; saved status agrees with
      live status, and hidden continuation is never user-message replay. No adapter calculates pressure policy.
- [ ] Step 12: Execution and AI-review repair handoff tests prove that accepted handoffs suppress predecessor
      compaction/continuation before rollover, then activate a successor with clean health. Ordinary same-segment
      hydration does not reset health. Pair checkpoint authority, Named Invocation expansions, cancellation, and request
      identity remain protected after compaction.
- [ ] Step 13: The Core compaction capability and its acceptance scenarios match delivered behavior. Consolidate lasting
      intent from `session-context-resilience-prd.md`, retain unimplemented targets explicitly, update affected links,
      and retire the transient proposal when reconciled. Session docs and ADR-011 describe the shared owner and public
      dependency constraint without competing old policy. Existing glossary meanings are preserved; do not introduce a
      new domain term for internal policy flags.

## Approval Confirmation

No Work Record supersession is proposed. Approval does not assert that the dependency gate is satisfied. Save for later
unless the complete public AgentSession contract has been verified; a partial gate result is not feature completion.

## Verification Plan

- Automated prerequisite gate: exercise a real AgentSession, SessionManager, native queues, and public lifecycle with a
  deterministic provider. After a pressured completed turn, assert no task-provider call before verified recovery, one
  persisted result per completed tool call, and no `stopReason: "aborted"` artifact from graceful stopping. Queue
  messages before the stop and prove AgentSession cannot restart past a veto. Native threshold and overflow recovery
  must respect the same arbiter and veto. Public result notification alone does not pass. Failure leaves the feature
  unimplemented; do not keep an obsolete test that claims Pi lacks mid-run compaction.
- Test setup: fake only the external model/provider boundary, not RunWield's coordinator, workflow events, storage,
  locks, or Runtime. Use real Git/Session fixtures and the sandboxed runner. Tests that mutate cwd or HOME use
  `withProcessGlobalTestLock`; production reads use `getCwd()`/`getHomeDir()`. No new owned injection seam is allowed.
- Automated focused tests: run
  `deno run -A scripts/run-tests.js src/shared/session/session-context-resilience.test.js
src/shared/session/session-prompt.test.js src/shared/session/session-subscribers.test.js
src/shared/session/hosted-session.test.ts src/shared/session/abort-active-session.test.js
src/shared/session/session-runtime-events.test.js src/shared/session/session-runtime.test.js
src/shared/session/agent-handler.test.ts src/shared/session/request-dispatch.test.ts
src/shared/session/background-tasks.test.ts src/shared/session/background-tasks-extra.test.ts
src/shared/session/segment-rollover.test.js src/shared/session/session-transcript-projection.test.ts
src/tools/__tests__/delegate-agent.test.ts src/cmd/compact/index.test.js
src/ui/tui/runtime-adapter.test.ts src/acp/server.test.js src/ui/workspace/workspace-session-ux.test.tsx`.
  Include new focused integration suites through the same runner. Never use direct `deno test`.
- Existing coverage: preserve manual/resume compaction, automatic-disabled behavior, image and Named Invocation context,
  completed tool persistence, active-Agent identity, genuine backend failure recovery, steering transfer, Pair
  checkpoints, independent Session progress, and execution/repair rollover. Replace tests for the old 5%-or-8K re-arm
  policy and guessed missing Pi APIs. Their obsolete assertions must stop existing; their useful pressure/queue coverage
  must not.
- Long-run fixture: script at least six internal turns with deterministic large tool results. Assert the provider-call
  sequence is `pressure turn -> compaction call -> continuation turn` with no oversized provider call between pressure
  and compaction; Agent Handler invocation count remains `1`; Runtime emits one outer `TURN_START`, remains busy, and
  emits one outer `TURN_END` only after continuation settles.
- Pre-request recovery: with pressure caused by resident context plus the prepared User Request, assert the event
  sequence is exactly `compacting(threshold), compacted(threshold)`, the original request produces exactly one Runtime
  `USER_MESSAGE` and one provider submission, and no `runwield_context_continuation`, `continuing`, or `continued`
  occurs.
- Trigger matrix: for `W=128000`, `R=16384`, assert `T=111616`, `E=64000`, `M=16384`, `S=95232`, and `SE=47616`. Each of
  the four Engineer identities triggers at `64000`, not `63999`. A Router, Planner, Reviewer, and ordinary delegated
  Agent do not compact at `64000` or `111616`; they trigger at `111617`. With `W=200000`, `E=80000`; a larger model does
  not increase the Engineer cap. Exercise production policy through real `runPrompt()` and a mid-run AgentSession, not
  just a pure formula test. A pass-through to Pi must fail the early-trigger cases.
- Effective standard recovery: for a non-Engineer at `W=128000`, `R=16384`, a result
  `{tokensBefore:118000, estimatedTokensAfter:90000}` emits exactly
  `compacting(threshold), compacted(threshold),
continuing(threshold), continued(threshold)`, continues once, and
  permits a later standard attempt only above `T`.
- Useful Engineer recovery above the early trigger: with `W=200000`, `R=16384`, recover from `120000` to `90000`. Assert
  one continuation and no early compaction at `90000`, `98000`, or later growth below `T=183616`. Explicitly cross the
  old 8K growth boundary. The early trigger stays disarmed; standard protection still intercepts `183617` before
  provider submission and checks useful recovery. No-op policy or the old growth guard must fail this test.
- Early re-arm: for that Engineer, `SE=63616`. A later measurement at `63617` does not re-arm; `63616` does. Compaction
  can trigger again only on a later crossing to `80000`. An Agent/model rebuild with unchanged context does not erase
  disarm. Repeat at `M=0` to prove usage exactly `E` cannot immediately re-arm an inclusive trigger.
- Ineffective/failure recovery: every attempted automatic compaction first emits `compacting(threshold)`. A result above
  `T` or recovery below `M` then performs zero continuation provider calls and emits exactly
  `ineffective(insufficient_recovery), paused(insufficient_recovery)`; a missing result or compaction error emits
  exactly `failed(compaction_failed), paused(compaction_failed)`. Both make zero additional automatic compaction
  attempts without genuine recovery into the applicable bands. Add an Engineer failure at `80000` with no reduction:
  although already below standard `S`, unchanged/growing usage and repeated same-segment hydration must not re-arm or
  compact again. A later safe user request can run without an automatic retry; an unsafe one cannot reach the provider.
  A request exceeding `T` against empty history attempts no compaction and emits only `paused(oversized_request)`. A
  request above `E` but below `T` is not oversized. Missing, NaN, infinite, or negative recovery measurements cannot
  authorize continuation.
- Failure-pause re-arm: after a non-Engineer failure above `S`, manual compaction to exactly `S` emits one
  `rearmed(manual_recovery)`; a capacity change placing usage at exactly the new `S` emits one
  `rearmed(capacity_recovery)`. `S+1` does neither. Engineer failure re-arm must also satisfy `SE` and `usage < E`. Mere
  off/on toggles and unchanged model capacity do not reset a pause. Model-specific reserve overrides change the computed
  bands. Neither re-arm path silently restarts a settled assignment.
- Queue order: queue one steering message and two follow-up messages before continuation. Assert their persisted/model
  order remains Pi-native and all three precede the single `runwield_context_continuation` entry; assert no duplication,
  dropped messages, or Runtime `USER_MESSAGE` for the internal entry. Then queue a large message during compaction: the
  summary alone fits `T`, but the full next request does not. Assert zero unsafe provider submissions, no immediate
  second compaction of unchanged history, retained queued input, and no duplicate user-message events.
- Root pause: force ineffective recovery through the real Runtime. Assert typed `ContextResiliencePaused`, handler
  `{ kind: "context_paused" }`, `ok: true` settlement, unchanged active Agent/workflow/Plan Lifecycle, and no backend
  failure or `BACKEND_CONTINUATION_REQUEST`. Pre-submit attempts record `requestRecorded:false`; mid-run attempts record
  true. Reload request-attempt entries and verify old failed/completed entries still behave correctly. No second attempt
  or original-request replay is created by internal continuation. A genuine later user request still follows ordinary
  dispatch; the guard prevents generated replay, not intentional user input.
- Workflow races: race pressure against accepted triage, terminal approved `plan_written`, and durable `task_completed`
  events. Assert consume-once workflow behavior and no predecessor continuation after an accepted handoff. Feedback-only
  review stays in its planning conversation. Stale transcript tool results create no event or transition. A pause with
  no accepted event cannot claim task completion. An accepted completion is not discarded by a competing pause.
- Same-segment lifetime: pause or disarm early compaction, settle a real managed operation (disposing its Pi root), then
  send a follow-up or run `/compact`. The Hosted Session retains health, performs no unchanged-context automatic retry,
  and re-arms only from actual recovery. A fresh successor segment is tested separately.
- Delegated pause: force ineffective recovery in a foreground Pi child. Assert it emits pause status, starts no
  continuation, is disposed, and returns one parent tool result with `isError:true` and
  `details.error:"context_resilience_paused"`. Repeat with a background child: the original task ID remains the same,
  its task settles failed with that error, resources/lease are released, and one completion arrives through the normal
  background delivery path. No second foreground result or successful partial handoff appears. Ordinary parent
  settlement must not cancel a still-running background child; explicit Stop keeps existing cancellation semantics.
- Cancellation: queue one steering and one follow-up message, then cancel once in each state (`waiting_for_lease`,
  `stopping`, `compacting`, `measuring`, `continuing`). Assert both queued user messages and any still-queued internal
  continuation are removed, each queued Runtime message receives one dequeue transition, one Runtime `CANCELLATION` and
  at most one `canceled(user_cancel)` occur, `TERMINAL_ERROR` count is zero, no new provider call starts after
  cancellation, busy changes to false once after settlement, no arbiter lease leaks, and a later User Request is
  accepted. When cancellation occurs after the internal continuation entry is persisted and its turn starts, assert the
  active turn aborts, the private entry remains in the Session Transcript, and no additional continuation starts.
- Hosted Session isolation: pressure two Agent Sessions in one Hosted Session and one in another. Assert maximum
  concurrent compactions are `1` for the first Hosted Session and independently `1` for the second; all automatic
  waiters settle. While an automatic lease is held, `/compact` returns `compaction_in_progress` and the concurrent
  compaction count remains unchanged; when idle, manual `/compact` acquires the same lease.
- Adapter parity: feed canonical events from a real recovery operation to TUI, ACP, and Workspace consumers. Assert one
  displayed text per event. ACP `_meta` contains only `type`, `status`, `reason`, `usagePercent`, and `recoveredPercent`
  plus standard Runtime metadata. Verify the producer allowlist rejects content-bearing extra keys. Reopen the persisted
  root Session and assert the same saved outcomes, stable row identity, and no user-message replay of continuation.
- Preserved authority: compact and reopen a Session with a Pair checkpoint, request-attempt snapshot, Named Invocation
  expansion, and image attachment. The checkpoint still needs a genuine later user decision; generated continuation
  cannot approve it. Request identity and model-visible expansion survive, and isolated-child compaction cannot restore
  root-only metadata into the child.
- Manual command through Runtime: while root or background automatic compaction owns the arbiter, `compactSession()`
  returns `compaction_in_progress` before the blocked compaction is released. With an active prompt and no compaction,
  it waits without holding the arbiter; after settlement it acquires safely. Manual instructions, cancellation, existing
  completion notifications, and re-arm remain correct.
- Segment-boundary composition: place the execution segment near pressure, dispatch a semantic repair rollover, and
  assert no predecessor compaction or hidden continuation occurs; the fresh repair segment starts with clean
  context-health state and remains independently protected if its own usage later crosses threshold.
- Semantic review: inspect the call path to confirm one policy owner covers pre-request, mid-run, post-run, overflow,
  manual, and background paths. No private Pi compaction patch or bypass remains; a forwarding wrapper or disconnected
  policy module cannot satisfy the integration tests. Confirm paused request records do not become backend failures.
- Manual browser check: start `deno task workspace:dev` at `http://127.0.0.1:5173` from the execution worktree. Use a
  named headed `agent-browser` session to open the Session surface and exercise effective recovery, useful Engineer
  recovery above `E`, ineffective pause, and Stop with a deterministic provider. Confirm one concise existing-style
  status row per transition, uninterrupted busy state through continuation, usable input after settlement, unchanged
  Agent/Plan, and no console errors. Reload the saved Session and check status/history parity. A rendering fixture is
  supplemental; it does not replace real Runtime/persistence tests. No local Plan review UI is needed for these checks.
- Documentation: map each Core/proposal recovery and cancellation scenario to the tests above. Confirm PRD maturity,
  Session docs, ADR references, and existing glossary terms agree with implemented behavior. Do not claim non-Pi
  compaction control or a passed dependency gate without evidence.

## Edge Cases & Considerations

- The full public Pi contract remains unproven. Approval should save this Plan for later, not authorize a private
  compatibility shim. Current `finishTurn` and recovery events are partial support, not proof of a continuation veto.
- Pi's private `_runAutoCompaction()` return value means whether to continue, not whether compaction succeeded. The new
  policy must measure public result data; neither a true nor false boolean proves useful recovery.
- Pi reports context usage as unknown immediately after compaction. Use the public compaction result's
  `estimatedTokensAfter` for recovery measurement and retain an explicit unknown state until later provider usage
  replaces the estimate.
- A single prepared User Request may exceed `T` even with an empty compacted history. Detect this before submission,
  emit exactly `paused(oversized_request)`, and recommend reducing the request or choosing a larger-context model;
  compaction cannot solve it.
- Repeated useful compactions are allowed after later threshold crossings. An Engineer early attempt must first re-arm
  below `SE`; the standard `T` safety fallback remains available after useful recovery. Failed/ineffective recovery
  latches automatic pause until genuine recovery meets the applicable bands. Being below `S` at an early failure is not
  itself recovery.
- Large reserve values can put `T` below `E`. Standard safety still wins; do not wait for an Engineer's early threshold
  when the prepared request is already unsafe under `T`.
- Assumption: context-health latches are live Hosted Session state. They survive ordinary same-segment dehydration and
  Agent/model rebuilds, but this Plan does not add a cross-process retry scheduler or durable health-state schema. A
  newly hosted Session measures current context before work; restoring exact prior pause flags across host exit is
  deferred. Saved status is historical evidence, not permission to resume an old operation.
- Tool results finish and persist before graceful stop. Never stop in the middle of tool execution or discard a result
  needed by the compaction summary or continuation.
- A waiting Agent Session holds no Hosted Session compaction lease and starts no provider call. On lease acquisition it
  remeasures because another Agent Session's compaction does not change its isolated context.
- Explicit workflow context boundaries outrank compaction. Never delay or replace a safely authorized successor-segment
  rollover merely to summarize context the successor is forbidden to inherit.
- User cancellation wins every race and must not be reported as ineffective recovery or trigger re-arm. It retains the
  established behavior of discarding queued user steering/follow-up messages. Manual `/compact` remains available after
  pause when the shared arbiter is free and must not produce duplicate automatic status.
- A disposed Delegated Agent Session cannot resume. Foreground pause returns one failed tool result; background pause
  finishes its existing task as failed. Any retry needs a fresh delegation. Never label partial child output as a
  successful result.
- User decisions preserve Engineer-only `E`, standard `T` for other Agents, and useful continuation above `E` without
  growth-only re-arm. The inherited `M/S` recovery margin remains; `SE` applies it to Engineer re-arm as a reviewable
  implementation assumption. No new user-facing percentage setting is introduced.
- Automatic model switching, an in-repository Pi fork, private Pi access, a replacement summarizer, arbitrary transcript
  compression, optional workflow metrics, extra `/settings` diagnostics, and durable storage of compaction summaries
  outside the Session Transcript are outside this Plan.
