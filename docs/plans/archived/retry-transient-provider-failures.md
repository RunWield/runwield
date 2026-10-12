---
planId: "01d970e6-db23-4636-887d-b29193831935"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/session.js"
    - "src/shared/session/provider-errors.ts"
    - "src/shared/session/session-transcript-projection.js"
    - "src/shared/session/session-subscribers.test.js"
    - "src/shared/session/deferred-validation-repair.integration.test.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/settings.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-24"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "ca7e722f15568a880061c82010425e3596f27eea"
workRecord:
    status: "generated"
    recordId: "942e23d4-63cc-4125-9c28-0e075c3cf5bf"
    path: "docs/work-records/2026-09-24-retry-transient-provider-failures-with-clear-notices.md"
    lastAttemptAt: "2026-09-24T20:25:20.579Z"
archivedAt: "2026-09-29T21:49:31.429Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/retry-transient-provider-failures.md"
---

# Retry transient provider failures with clear messages

## Context

Codex subscription requests routinely stop with `Unexpected EOF`. RunWield shows that raw error and does not retry it.
The owner wants clear messages for API failures and automatic retries for temporary failures. The owner confirmed that
existing defaults must remain: three retries after the initial request, with waits of 2, 4, and 8 seconds.

Source inspection found that Pi recognizes many connection, timeout, rate-limit, and server errors, but not bare
`Unexpected EOF`. RunWield's `sanitizeApiErrorMessage` only cleans HTML-bearing 404 errors. Retry exhaustion also
bypasses that helper. Saved assistant errors are not currently projected by `createReplayEvents`.

The Pi upgrade merged during planning. Final inspection used installed Pi 0.87.1; its EOF classification gap remains.
This is source evidence, not a reproduction of the user's live network failure. Execution must first reproduce the
missing retry with a controlled provider response.

Owning requirements:

- [Models and providers](../../prd/runwield-core-prd.md#models-and-providers): preserve **Change models without losing
  Session or workflow context**. Proposed addition: **Recover from temporary model-service failures**, with clear
  failure messages, bounded retries, cancellation, and an actionable notice when automatic attempts stop.
- [Session continuity](../../prd/runwield-core-prd.md#session-continuity): preserve **Continue the same saved work
  across clients**. Failed requests must not discard history or replay completed tools.
- [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): retry
  exhaustion pauses the current attempt; it does not abandon or complete a delivery workflow.

No requirement is removed. Existing Session, Session Transcript, and Execution Backend meanings in
[domain language](../../domain-language.md) remain unchanged.

## Objective

An EOF during a Pi-backed model response triggers the existing retry policy, including after partial output. Temporary
errors already recognized by Pi keep their behavior. API error notices use clear language across shared live and saved
Session output. Authentication, quota, invalid-request, context-overflow, and cancellation handling must not become
indiscriminate retries.

## Approach

Use the public provider-stream boundary already wrapped by `applySessionTemperature`:

```text
buildAgentSession
  existing Pi agent.streamFunction
    normalize an unexpected EOF as a connection error
    preserve the original diagnostic and emitted response data
  existing Pi retry policy
    wait 2s -> retry -> wait 4s -> retry -> wait 8s -> retry
  shared Session events -> TUI / Workspace / ACP
```

Install a narrow stream normalizer before the temperature wrapper, even when no temperature is configured. For the known
standalone, case-insensitive `Unexpected EOF` failure, translate the diagnostic to `Network error: Unexpected EOF`.
Preserve the original diagnostic text in that value. Do not match arbitrary `EOF` substrings in an authentication,
quota, parsing, or tool error. Other provider errors pass through unchanged for Pi to classify. Do not change successful
assistant text containing these words.

The wrapper does not retry. It calls its source once per request and forwards the model, transcript context, options,
and cancellation signal. It handles synchronous throws, rejected stream creation, iterator throws, and assistant error
events. Preserve streamed partial content and usage if the source later supplies an empty EOF failure. Keep the final
error event and stream `.result()` consistent; neither can hang. An aborted request remains aborted.

Pi remains the owner of retry settings, waits, continuation, and omission of failed attempts from subsequent model
context. Its raw transcript keeps failed-attempt evidence. Root, isolated, and noninteractive Pi Sessions all use
`buildAgentSession`. Pi also uses this stream function for summaries; do not add a separate summary retry policy.

Use one shared display formatter for assistant errors, retry notices, exhaustion, compaction failure text, and saved
assistant errors. Keep friendly display separate from the diagnostic used by Pi. Example wording:

| Condition                          | Display                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| EOF / interrupted response         | The model service stopped responding before the reply was complete.                                 |
| Scheduled retry                    | The model service stopped responding before the reply was complete. Retrying in 2 seconds (1 of 3). |
| Temporary server error             | The model service is temporarily unavailable.                                                       |
| Temporary rate limit               | The model service is receiving too many requests.                                                   |
| Authentication failure             | The model service could not verify your access. Check your sign-in or API credentials.              |
| Quota or billing limit             | The model service reports a usage or billing limit. Check your account.                             |
| Invalid request / model / endpoint | The model service rejected this request. Check the selected model and provider settings.            |
| Unrecognized API failure           | The model service could not complete this request.                                                  |

After exhausted transient retries, state the actual completed retry count and that the user can try again. For a final
non-transient failure, use its applicable action rather than suggesting that unchanged retries will help. Do not promise
that every failure is temporary. Keep original errors in existing transcript/debug evidence and diagnostic event fields;
do not put raw HTML, JSON bodies, or internal stack traces in the primary notice.

Preserve existing event types and consumers. An initial error notice describes the interrupted request, not final
Session failure; the following retry status states the next action. Do not add a new notification UI or fabricate
persisted retry counts. Replay shows a neutral historical failure notice from saved assistant evidence, not a live
countdown or an assertion that the Session still failed. Cancellation must not emit an API-error/exhaustion notice.

A dependency fork or another turn-level loop was set aside because both add maintenance and can multiply attempts. The
public stream wrapper follows the existing integration pattern and requires no dependency update or new ADR.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/provider-errors.ts` (proposed) and focused tests — EOF normalization and shared safe display text;
  keep stream adaptation nearby or in a focused companion file if needed.
- `src/shared/session/session.js` — install normalization once in `buildAgentSession`; use the formatter in shared
  subscribers and cancellation-aware retry reporting, including Pi's `summarization_retry_scheduled`,
  `summarization_retry_attempt_start`, and `summarization_retry_finished` events where needed. Retain temperature
  fallback behavior; do not invent a success or failure result from a summary event that does not carry one.
- `src/shared/session/session-transcript-projection.js` and its tests — project saved assistant failure notices once,
  with stable event IDs, without writes or claims about current retry state.
- Session provider/runtime tests, `session-subscribers.test.js`, `session-temperature.test.js`,
  `session-runtime.test.js`, and `deferred-validation-repair.integration.test.js` — prove real retry behavior and keep
  the existing interruption/reload coverage.
- Existing TUI runtime-adapter, Workspace Session, and ACP event-mapper tests — confirm shared friendly text reaches
  clients without changing the event contract. No browser layout or design-system changes are expected.
- `docs/prd/runwield-core-prd.md`, `docs/settings.md` — synchronize provider recovery requirements and scenarios;
  explain existing retry controls without changing defaults or unrelated Workflow Validation policy.

No Pi package edits, settings migration, new retry configuration, CLI-backend recovery redesign, or workflow retry-loop
changes are in scope. The glossary needs no new definition.

## Reuse Opportunities

- Pi `isRetryableAssistantError`, AgentSession retry handling, and `getRetrySettings` — keep the existing owner and
  current exclusions. Installed source under `node_modules/@earendil-works/` is evidence, not an edit target.
- `applySessionTemperature` and `createAssistantMessageEventStream` — reuse the public stream integration pattern, not
  temperature-specific retry logic or its empty-error construction.
- `withRuntimeCommandFixture` in `src/cmd/testing/runtime-command-fixture.ts` and Pi Faux providers — exercise real
  Session creation and persisted transcript behavior at the external provider boundary.
- `attachSessionEventSubscribers`, `createReplayEvents`, and current runtime event types — share display behavior.
- `withProcessGlobalTestLock`, `getHomeDir`, and `getCwd` — retain safe test isolation.

## Implementation Steps

1. **The regression reaches the actual retry owner.** A real RunWield-built Pi Session receives EOF from a controlled
   provider, then a successful answer. Before the fix, the test fails because no retry occurs. Capture requests and
   retry events; manually emitting retry events is not evidence for this step.
2. **EOF activates only the existing retry policy.** The installed stream normalizer reaches root and isolated Pi
   Sessions, with and without temperature settings. EOF failures trigger Pi's configured attempts and backoff. Abort,
   successful output, unrelated errors, request context, and provider options retain their meaning. No private Pi
   override, package patch, extra retry loop, or new injection point for RunWield-owned behavior is introduced.
3. **Failure display is clear and truthful.** Shared live notices use the formatter for known failure categories and a
   safe fallback. Retry counts and waits come from real events. Exhaustion and cancellation are distinguished. Raw
   diagnostics remain available without becoming the primary message. The old HTML cleanup protection survives.
4. **Saved failure evidence remains useful.** `createReplayEvents` emits one stable, neutral notice for each saved
   non-aborted assistant error, including legacy bare EOF entries and empty-content failures. Repeated reads do not
   append data or duplicate the event identity. Recovered history does not claim that work is currently stopped.
5. **Existing recovery coverage survives.** Tests that used one EOF to force a pause explicitly disable retries or
   provide an exhausted sequence. Their assertions for repair context, compaction, cancellation, continuation, worktree
   location, and reload remain. New tests separately prove transient recovery without pausing or replaying tools.
6. **Product documentation matches the delivered behavior.** The owning Models and providers capability includes
   temporary failure recovery, clear messages, cancellation, and exhausted-retry scenarios. Link continuity and workflow
   recovery requirements rather than duplicate them. Settings document three retries after the initial call and the
   2/4/8-second defaults. Keep unmet wider recovery intent labeled target or deferred.

## Approval Confirmation

No Work Record supersession is proposed. The owner confirmed the existing retry defaults. Approval does not authorize a
Pi fork, dependency upgrade, longer default retry window, or automatic abandonment after exhaustion.

## Verification Plan

Run focused tests through the sandboxed runner only; include new provider-error/stream test files in the commands:

```sh
deno run -A scripts/run-tests.js --isolated src/shared/session/provider-errors.test.ts src/shared/session/session-provider-retry.test.js src/shared/session/session-subscribers.test.js src/shared/session/session-transcript-projection.test.js src/shared/session/session-temperature.test.js
deno run -A scripts/run-tests.js --isolated src/shared/session/session-runtime.test.js src/shared/session/deferred-validation-repair.integration.test.js src/ui/tui/runtime-adapter.test.js src/ui/workspace/workspace-session-ux.test.tsx src/acp/server.test.js
deno task check
deno task seams:check
```

Required behavioral evidence:

- **EOF then success:** through real `buildAgentSession`, the second provider request occurs only after backoff and
  produces the successful answer. It retains the original user request, active instructions/tools, and committed tool
  results. A preceding completed side-effecting tool executes once. Failed attempt text is not fed back as a completed
  answer. Raw failed-attempt evidence remains in the file-backed transcript. A display-only fix or pass-through wrapper
  fails this test. Cover an isolated Session as well as the root Session.
- **Bound and timing:** persistent EOF produces four total calls under defaults and exactly three retry schedules at
  2000, 4000, and 8000 ms. Prove no request starts before its wait completes. Use a controlled clock if supported, or
  run the real 14-second default path once; do not replace Pi's retry owner. Also test a small configured delay/count,
  disabled retries, and zero retries. Provider-internal retries are disabled/default for exact call-count assertions.
- **Cancellation:** cancel during backoff and during an active response. No later provider request starts, the pending
  call settles, and no API failure or exhausted-retry notice mislabels cancellation. A later user turn still works.
- **Failure matrix:** Pi-recognized `socket hang up`, `connection error`, `timeout`, HTTP 429 throttling, and 503 errors
  still retry. Use these exact diagnostic forms; bare `ECONNRESET` is not currently recognized and is not an additional
  classification change in this Plan. Explicit 401 authentication, insufficient quota/billing, and invalid-request
  failures do not gain retries. Context overflow still follows compaction, not this EOF normalization. Unrecognized
  errors receive a safe message without forced retries.
- **Stream integrity:** test error events, synchronous throws, rejected creation, and iterator failure after partial
  text/thinking/tool-call output. Assert final event and `.result()` agree, content and usage survive where emitted,
  incomplete tools do not execute, and no duplicate start or terminal events occur. An EOF converted upstream into an
  empty error after emitted content is covered. Successful streams and cancellation remain unchanged. Preserve the
  temperature tests for one exact capability fallback, option forwarding, context, and remembered model support.
- **Summary recovery:** a controlled EOF then success during Pi compaction uses the same normalization and Pi's existing
  summary retry policy. The real scheduled retry event produces a friendly notice with the actual delay/count. Abort
  remains compaction cancellation, not a new provider failure. Do not infer a final result from the fieldless summary
  retry-finished event.
- **Live and reload:** verify friendly text for each display category, final failure, and existing HTML 404 behavior;
  raw diagnostic fields retain the error. A real saved EOF-then-success transcript replays the historical interruption
  and final answer in order without an active retry or current-failure claim. Legacy EOF and empty-content errors work.
  Read twice and confirm stable IDs and unchanged files. Existing TUI, Workspace, and ACP consumers receive the shared
  text and retain their cancellation, usage, and lifecycle assertions.
- **Workflow preservation:** rerun deferred Validation Repair interruption/compaction/reload tests. Exhaustion preserves
  the same Plan, Session, worktree, and repair context. Neither retries nor transcript error notices advance workflow
  state, spend an AI review repair round, or mark delivery abandoned.

Manual: in a disposable project and HOME, use a controlled provider to show EOF recovery and exhaustion in a Session,
then stop during backoff and continue. Inspect the message, delay, final result, and reloaded history. A live Codex run
can supplement this evidence but is not a required outage test; do not use the user's active Session as a fixture.
Review the Core capability and settings changes against observed behavior. Full CI remains required by normal delivery.

## Edge Cases & Considerations

- The provider or Pi may already convert a thrown stream error into an assistant failure. Normalize once and retain the
  latest emitted partial response; do not claim recovery of data that never arrived.
- Retry requests can generate a different answer. Preserve evidence of partial output rather than present it as a
  completed response. Completed tools are not replayed; malformed/incomplete calls from failed responses are not run.
- Configured provider-internal retries and Workflow Validation retries already exist. Do not change their budgets or
  claim that four calls bounds all nested configurations. This Plan preserves the AgentSession retry budget.
- Replay has assistant failure evidence, not durable retry countdown events. Do not invent counts or a current recovery
  state. The projection remains read-only and is never workflow authority.
- Concurrent work changed dependencies and workflow files during planning. Recheck the installed Pi contract and working
  tree before execution; preserve unrelated edits. Do not revert the Pi upgrade or copy earlier 0.85 assumptions.
