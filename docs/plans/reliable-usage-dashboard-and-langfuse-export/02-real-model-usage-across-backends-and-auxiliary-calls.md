---
planId: "e09a1c9e-4131-46a6-9807-c34681df5523"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/session-runtime-events.js"
    - "src/shared/session/backends/claude-cli/execution-session.ts"
    - "src/shared/session/backends/agy-cli/execution-session.ts"
    - "src/shared/session/session-transcript-projection.js"
    - "src/shared/session/session.js"
    - "src/tools/see-image.ts"
    - "src/ui/workspace/routes/api/review-agent-handlers.js"
    - "src/cmd/guided-review/"
    - "src/ui/tui/chat-footer.ts"
    - "docs/prd/runwield-core-prd.md"
planDeviations:
    - id: "call_6a50a0d6f1b84a6f99bacd3781bcc0fb|fc_064d3cc08d2d7f42016ac7b94f9f30819588acbefccd3d94d1"
      supersededRequirement: "Record one aggregated turn-level model_usage observation per Guided Review job, including jobs run through wld guided-review."
      replacementRequirement: "Retain model_usage observations already recorded by the runtime for wld guided-review jobs, and record one aggregated turn-level model_usage observation only for external Guided Review commands. Preserve guided_review_generation_result for every settled job and do not duplicate runtime-recorded usage."
      reason: "wld guided-review runs through runtime.promptSession, which already records usage; adding a job-level model_usage observation would double-count the same calls."
      approvedAt: "2026-10-08T15:40:06.023Z"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-08T11:14:09-0400"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 2
dependencies:
    - "01-core-measurement-history-and-default-on-recording"
userVerifiedAt: null
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
status: "validated"
validatedCommit: "e9672012744c7d12c4ec4e7a13a2054b2e95d196"
---

# Real Model Usage Across Backends and Auxiliary Calls

## Context

This draft was written before `complete-tool-call-metrics` (2026-09-29) and child 01 landed. Reconciled against current
source on 2026-10-08, most of its original headline scope is already delivered:

- The v2 `model_usage` record exists (`src/shared/workflow/metrics.js` `V2_EVENTS`) with `measurementAvailability`
  (`complete`/`partial`/`unavailable`), `costSource` (`reported`/`calculated`/`unavailable`), and `aggregationBasis`
  (`turn`/`request`/`alternative`), with dedup by `sourceId`.
- Claude's parser already reads `total_cost_usd` and the cache token aliases
  (`src/shared/session/backends/claude-cli/stream-parser.ts:232`, `readUsage` at :85).
- Isolated and delegated sessions already wire `ExecutionMetricsRecorder` (`src/shared/session/session.js:4848`);
  compaction usage is already recorded (`usageKind: "compaction"`); a canceled CLI turn settles with
  `coverage.usage: unavailable`, not zeros.

### Epic Scope Changes

No scope moved between siblings. This child's own scope narrowed: the claims above were already delivered outside the
Epic by `complete-tool-call-metrics`; what remains is below.

What actually remains — four verified gaps:

1. **`see_image` discards usage.** The vision fallback's response carries full usage (`AssistantMessage.usage` from
   `completeSimple`); the tool takes the text and drops it (`src/tools/see-image.ts:116-135`). No observation.
2. **Guided Review drops the numbers.** The guide job aggregates real tokens/cost in memory
   (`addGuideJobUsage`/`setGuideJobUsage`, `src/ui/workspace/routes/api/review-agent-handlers.js:206-232`) but records
   only `tokensAvailable`/`costAvailable` booleans. No `model_usage` observation.
3. **Zeros are invented at the Runtime/transcript boundary.** `normalizeRuntimeUsage`
   (`src/shared/session/session-runtime-events.js:708`) coerces absence to `0`; the Claude and agy adapters zero-fill
   cache/cost when appending entries and emitting `USAGE` events (`toPiUsage`/`toRuntimeUsage` in both
   `execution-session.ts` files); CLI replay fabricates `zeroUsage()`. Guided Review collects its usage through these
   same `USAGE` events, so gap 3 poisons gap 2's numbers.
4. **Replay totals omit compaction usage** and sum zeros as if measured
   (`src/shared/session/session-transcript-projection.js:1024-1030`).

The owner confirmed three decisions on 2026-10-08: include the runtime-event/replay honesty work in this child; Guided
Review records one aggregated turn-level observation per job; compaction usage appears in replayed session info as a
distinct labeled component.

Owning PRD: [Local workflow metrics](../../prd/runwield-core-prd.md#usage-measurement-and-export) already requires
"missing measurements remain unavailable, not zero." This child makes that true on the remaining surfaces and adds the
supported-backend and auxiliary-call coverage requirements with acceptance scenarios.

## Objective

Every RunWield-started model call on a supported backend produces one honest `model_usage` observation, and no
RunWield-visible surface — runtime event, persisted entry, replay total, TUI footer, Guided Review frame — presents an
invented zero as a measured value.

## Approach

```text
                     ┌─ USAGE runtime event ──> TUI footer, guided-review frames
model call result ───┤
                     └─ appended entry ───────> replay totals (transcript projection)

absent field  -> null on every surface above; never 0
supplied 0    -> 0 (measured) — only when the source supplied it
see_image     ──> onModelUsage observer ──> one model_usage record (request basis)
guide job     ──> aggregated frames ─────> one model_usage record (turn basis)
```

The recording layer is untouched: `ExecutionMetricsRecorder.recordModelUsage` and the v2 `model_usage` event already
carry availability, cost source, and granularity. This child fixes the producers that destroy or invent the values, and
wires the two auxiliary callers that never recorded.

Set aside: recording usage for `createBoundedRemoteModelSession` (the one-turn `--remote-model-proof` verification path,
`src/shared/remote/model-proof.ts`) — it is an explicit verification mechanism, not usage work. The remote `see_image`
wiring inside it is in scope; the proof session itself is not.

> [!NOTE]
> **Pi's internal `Usage` type requires numeric fields**
>
> Where Pi's own session machinery needs a numeric `Usage`, the adapter may keep Pi's internal shape, but every
> RunWield-visible surface (runtime events, appended entries read by replay, metrics) must carry absence as
> `null`/omitted, never as `0`. Document any cast that satisfies the vendor type.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation and change whatever the
steps need.

- `src/shared/session/session-runtime-events.js` — `RuntimeUsage` fields become `number | null`; `normalizeRuntimeUsage`
  preserves absence; `USAGE` event validation accepts null fields.
- `src/shared/session/backends/claude-cli/execution-session.ts` — `toRuntimeUsage`, `toPiUsage`, `makeAssistantMessage`,
  and `readMessages` stop zero-filling absent cache/cost; absent usage is omitted, not fabricated.
- `src/shared/session/backends/agy-cli/execution-session.ts` — same for `toPiUsage`/`toRuntimeUsage`/
  `zeroUsage()`/replay; native tool-call assistant entries stop carrying fabricated usage.
- `src/shared/session/session-transcript-projection.js` — replay `USAGE` events carry nulls; `buildProjectedSessionInfo`
  sums only present values, exposes availability, and adds compaction usage as a distinct labeled component.
- `src/shared/session/session.js` — `see_image` construction (~L2210) passes an `onModelUsage` observer; the USAGE
  emission at ~L3494 forwards the normalized (nullable) shape unchanged.
- `src/tools/see-image.ts` — `createSeeImageTool` accepts an observer and reports the response's usage; both the local
  and remote completion paths call it.
- `src/shared/remote/bounded-model-session.ts` — its `see_image` construction passes the same observer, if the remote
  result carries usage.
- `src/ui/workspace/routes/api/review-agent-handlers.js` — job settle records one aggregated `model_usage` observation;
  the existing `guided_review_generation_result` outcome event stays.
- `src/cmd/guided-review/` (`index.ts`, `protocol.ts`) — usage frames carry null for absent categories; frame
  aggregation handles nulls.
- `src/ui/tui/chat-footer.ts` — footer sums skip nulls; categories with no observed data render as unavailable, not `0`.
- `docs/prd/runwield-core-prd.md` — backend and auxiliary-call coverage requirements and scenarios under **Local
  workflow metrics**; `docs/settings.md` event-coverage wording updated if it names these sources.

## Reuse Opportunities

- `ExecutionMetricsRecorder.recordModelUsage` and the v2 `model_usage` event — availability, cost source, granularity,
  and dedup already exist; producers only need to stop lying and start calling.
- `executionMetricsForSession` WeakMap (`src/shared/session/session.js:4013`) — linking an auxiliary observation to the
  active execution's `requestId`/`turnId` when one exists.
- Existing backend fixtures (`src/shared/session/backends/agy-cli/fixtures/`, claude stream-parser tests) — extend with
  the three-way provenance payloads rather than building new harnesses.
- `withWorkflowMetricsFixture` (`src/testing/workflow-metrics-fixture.ts`) for observation-level tests.

## Implementation Steps

- `RuntimeUsage` fields are `number | null`; `normalizeRuntimeUsage` returns `null` for an absent category and `0` only
  for a source-supplied zero; `contextWindow` stays optional. The `USAGE` runtime event validation accepts null fields.
- The Claude adapter emits and appends only what the CLI supplied: absent cache or cost appears as `null` in the `USAGE`
  event and is omitted from the appended entry's usage; `readMessages` omits usage entirely when the CLI reported none,
  instead of fabricating `zeroUsage()`.
- The agy adapter does the same, and native tool-call assistant entries no longer carry `toPiUsage(zeroUsage())` — they
  carry no usage. agy cost stays `null` with `costSource: "unavailable"` everywhere; no surface renders it as `0`.
- `buildProjectedSessionInfo` sums only present values, exposes a usage-availability signal (per-category or overall —
  engineer fixes the spelling), and reports compaction entry usage as a distinct labeled component that is never added
  into the assistant-message totals.
- The TUI footer skips null values when summing and renders a category with no observed data as unavailable (for example
  `—`), never as `0`; a measured `0` still renders as `0`.
- Guided Review usage frames distinguish absent from measured zero (nullable fields; bump the frame version so the
  parser rejects stale shapes), `addGuideJobUsage`/`setGuideJobUsage` aggregate only present values and track
  availability, and each settled guide job records exactly one `model_usage` observation with the aggregated numbers,
  `usageKind: "turn"`, `aggregationBasis: "turn"`, provider/model from the job meta, and `measurementAvailability`
  derived from the frames. The existing `guided_review_generation_result` outcome event is unchanged.
- `createSeeImageTool` accepts an `onModelUsage` observer option and calls it once per completed vision call with the
  response's usage and the fallback model's provider/model; both the local (`session.js` ~L2210) and remote
  (`bounded-model-session.ts`) wiring pass an observer. The observer records one `model_usage` observation
  (`usageKind: "request"`, `aggregationBasis: "request"`) linked to the active execution via
  `executionMetricsForSession` when one exists, and to the session otherwise. A response with absent usage yields an
  `unavailable` observation, not a zero-valued one.
- `docs/prd/runwield-core-prd.md` **Local workflow metrics** names the supported-backend coverage requirement — Pi
  per-request and per-turn, Claude per-request plus turn aggregate plus per-model breakdown, agy turn-cumulative with
  cost unavailable upstream — and the auxiliary-call coverage requirement (vision fallback, Guided Review), each with
  acceptance scenarios that distinguish delivered detail from upstream-unavailable values.
- No new injection seam exists; the metrics recording contract, journal, and epoch machinery from child 01 are
  unchanged; `deno task seams:check` passes without re-baselining.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/session src/shared/workflow/metrics.test.js` plus the
  guided-review and see-image test files; then `deno task seams:check`, `deno task ci`, `deno task doc-links:check`.
  Never `deno test` directly.
- Three-way provenance per surface: a payload with a field present, present-and-zero, and absent produces three
  distinguishable results in `normalizeRuntimeUsage`, the Claude `readUsage`/result path, the agy `readUsage` path, the
  appended entry shape, the replay info totals, the footer sums, and the guided-review frames.
- Claude fixtures: `total_cost_usd` present, `cost` fallback, and absent cost yield value / fallback / `null`; a
  per-message (`alternative`) observation plus the turn total (`turn`) are both recorded once each and never summed into
  one number by any consumer in this repo.
- agy fixtures: absent cache yields `null` in the event and omitted in the entry; cost is never a number on any surface.
- Replay: a session bundle whose assistant entries lack usage shows unavailable, not `0`; a compaction entry with usage
  appears as the distinct component and the assistant totals exclude it.
- `see_image`: a fixture response with usage produces exactly one `model_usage` record with those numbers; a response
  without usage produces an `unavailable` observation; an errored call produces no fabricated numbers.
- Guided Review: a job with usage frames produces exactly one aggregated `model_usage` record; frames with nulls produce
  `partial`/`unavailable`; the outcome event still records.
- Existing protected behavior: metrics redaction and worktree mapping (`metrics.test.js`), replay event identity
  (`eventId`/`messageId` shapes), and saved-assistant-entry parsing still pass. Expected to stop existing: the `|| 0`
  zero-fill expectations in `session-runtime-events.test.js` ("Runtime normalizes provider usage once"), the footer's
  zero display for absent data, and the CLI `zeroUsage()` fabrication on replay.
- Authorized live CLI output (Claude and agy) may confirm the tested field names as evidence; source omission alone is
  not treated as upstream proof. Live runs require owner authorization.

## Edge Cases & Considerations

- Session bundles persisted before this change carry zero-filled CLI usage; replay cannot distinguish those historical
  zeros from measured zeros. Record this as a known limit — no reconstruction.
- Guided Review frame version bump: producer and consumer ship together, but the parser must reject stale frame shapes
  rather than misread them.
- Remote `see_image`: verify the remote `streamSimple` result actually carries usage before wiring the observer; if it
  does not, record `unavailable` rather than skipping the observation.
- Subscription-backed CLI cost has no meaningful USD value; it stays `costSource: "unavailable"`, never `0`.
- The `--remote-model-proof` bounded session stays unrecorded by design (verification mechanism, not usage work).
- Assumption: the footer and replay availability spelling (per-category flags vs one overall signal) is an engineer
  choice; both must distinguish absent from measured zero.
