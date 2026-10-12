---
planId: "29ed7919-7f2c-4d2a-a629-eb8cab2bff5f"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "packages/langfuse-exporter/"
    - "docs/prd/runwield-core-prd.md"
    - "src/shared/session/backends/claude-cli/execution-session.ts"
    - "src/shared/session/backends/agy-cli/execution-session.ts"
    - "src/shared/workflow/execution-metrics.ts"
    - "src/shared/workflow/metrics.js"
    - "src/shared/workflow/metrics-export-record.ts"
    - "src/shared/session/session.js"
    - "src/shared/session/backends/agy-cli/stream-parser.ts"
    - "src/shared/models/model-registry.ts"
planDeviations:
    - id: "call_71763321391f49de8ddca951a56f72ab|fc_0de2069492c92451016acc0bdccc2c8190966f9ddf477363d3"
      supersededRequirement: "Real destination checks require owner authorization and a disposable Langfuse project: confirm actual native metrics and queried observations, that counts and sums match the sent observations, and that an availability label alongside a vendor chart still showing invented zero or full totals is treated as a failure of this contract."
      replacementRequirement: "Real destination checks require owner authorization and a disposable Langfuse project. Native public-API readback is sufficient evidence; vendor chart inspection is not required. Confirm that native usage buckets, known-count subtotals, supplied costs, queried observations, and availability metadata match the sent observations. Documented empty native maps with zero totals and empty native model names may represent absence when the sent native measurements are absent and all required metadata matches. Invented buckets, inferred unavailable costs, incorrect subtotals, and conflicting readback versions remain failures. The authorized disposable self-hosted Langfuse 4.56.0 API validation satisfies this real-destination gate; it does not certify hosted Cloud behavior or exactly-once delivery."
      reason: "The owner accepts API-only evidence. Saved authorized live checks establish native API behavior but do not establish vendor chart presentation."
      approvedAt: "2026-10-11T23:03:21.247Z"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T19:28:55.278Z"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 8
dependencies:
    - "07-core-export-coordination-and-delivery-states"
userVerifiedAt: null
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
status: "reviewed"
validatedCommit: "34f411af3b2b7d1ad31b75b8b96b4fca66a7e68f"
---

# Langfuse Exporter Package

## Context

Child 07 hands an approved exporter one immutable observation and a deadline. This child is the first implementation of
that contract, and the only place destination-specific knowledge lives: Langfuse authentication, mapping, transport, and
acceptance semantics.

The Epic fixes the transport: Langfuse v4's public OpenTelemetry Protocol HTTP endpoint `/api/public/otel/v1/traces`,
project-key Basic authentication, and `x-langfuse-ingestion-version: 4`. Legacy ingestion is not used. One complete
immutable observation is sent per attempt, because Langfuse's data-update policy means repeated observation IDs create
duplicates and inflate totals.

`packages/` does not exist yet. The package is first-party and independently installable, living in this repository with
its own manifest and tests. No npm workspace and no external repository.

Owning PRD: the Core **Usage measurement and export** capability references this destination; the metrics-exporter kind
requirement from child 06 stays authoritative for approval.

### Core measurement corrections come first

Langfuse data is derived from Core rows. Four Core gaps would make the export wrong, so this child fixes them in Core
before the exporter maps anything. Workspace benefits from the same fixes.

**1. Cache basis is mislabeled on both CLI backends.** Both hard-code `inputCacheBasis: "unknown"`. The recorded vendor
output proves the input count excludes cache tokens on both:

| Backend    | Evidence (checked-in fixture)                                                                                 | Why it proves `excludes_cache`                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Claude CLI | `claude-2.1.284-read-tool-stream.jsonl`: `input_tokens: 2`, `cache_read_input_tokens: 1448`                   | An input count that included cache could not be smaller than the cache count. |
| agy-cli    | `agy-1.2.12-tool-stream.jsonl` step 3: `input_tokens: 1691`, `cache_read_tokens: 16511`, `total_tokens: 1695` | Same reason, and the vendor total is input + output only.                     |

This is a RunWield labeling gap, not a CLI limitation. The Pi backend already labels Anthropic-style usage
`excludes_cache` (`execution-metrics.ts` `reconcilePiEntries`).

The correction applies to new rows only (user decision). The journal is append-only, and the fixtures prove the format
for one version of each CLI. Rows already stored keep `unknown`.

**2. Reasoning tokens are reported but dropped.** agy reports `thinking_tokens`, which are already inside
`output_tokens` (fixture 2 step 3: `output_tokens: 52`, `thinking_tokens: 51`, response `"\n"`). pi-ai's
`Usage.reasoning` has the same meaning ("a subset of `output`"), and `reconcilePiEntries` drops it too. Claude CLI does
not report a separate count.

`model_usage` rows get `reasoningTokens`: the reasoning part of `outputTokens`, or `null` when the backend does not
report it (user decision). `outputTokens` keeps its current meaning, so Workspace totals do not change.

**3. agy cost is never calculated.** agy reports no cost, so every agy row is `costSource: "unavailable"`. The Pi
backend calculates cost with pi-ai's `calculateCost(model, usage)` from the model's catalog price and labels it
`calculated`. agy rows now do the same when a catalog price exists (user decision).

The agy model descriptor (`createExternalCliModelDescriptor`) carries zero prices, so it cannot be the price source. The
price comes from pi-ai's built-in `google` catalog entry with the same model ID. In the installed pi-ai 1.0.0:

| agy model          | Built-in `google` entry                | Price per million (input / output / cache read / cache write) |
| ------------------ | -------------------------------------- | ------------------------------------------------------------- |
| `gemini-3.8-flash` | yes                                    | 0.75 / 3.75 / 0.075 / 0                                       |
| `gemini-3.1-pro`   | **no** (only `gemini-3.1-pro-preview`) | none — cost stays `unavailable`                               |

`gemini-3.1-pro` is not matched to the `-preview` entry. That would be a guessed price. Its rows stay `unavailable`
until the catalog has an exact entry.

The missing agy cache-write count does not make the calculated cost incomplete: the catalog's cache-write price for
these models is 0.

The relabel does not make agy rows complete. agy never reports a cache-write count, so its rows stay
`measurementAvailability: "partial"`. That is the correct label. The exporter still sends the counts agy does report as
native Langfuse usage buckets and leaves the cache-write bucket out (user decision). See the partial-token rule in
Approach.

**4. Model usage rows have no measured duration.** A `model_usage` row has one timestamp, `occurredAt`, which is the
write time. For Pi rows that write happens in `reconcilePiEntries` at settlement, so even the end time is wrong.
Langfuse copies a missing edge, so every generation would show 0 ms. The recorder already observes the turn start on all
three backends (`recordResponseLatency("turn_start")` in both CLI sessions and `session.js` for Pi).

```text
row kind                              startedAt                 endedAt
CLI turn row (claude-cli, agy-cli)    recorder turn start       time the result usage was observed
Pi assistant entry                    turn start of its turn    time that assistant message finished
Claude CLI per-request rows           null (not observed)       null
Pi toolResult / standalone / summary  null unless observed      null unless observed
```

A field is set only from a time the recorder observed for that same row. It is never derived from a neighboring event.

## Objective

A Langfuse exporter that maps Core observations to generations and safe named spans with explicit non-overlapping usage
categories and evidence-labeled USD cost, omits all content, and returns acceptance semantics Core can act on — verified
in real Langfuse metrics, not just HTTP success.

## Approach

```text
Core dispatch(observation, deadline)
  -> map: model request            -> generation
          CLI turn aggregate       -> one generation labeled backend-turn aggregate
          workflow / tool fact     -> fixed-name span with structured metadata
  -> deterministic trace and parent IDs group related operations
  -> build OTLP payload: usage categories + cost + availability metadata only
  -> POST /api/public/otel/v1/traces  (Basic auth, ingestion-version: 4)
  -> classify: accepted | proven non-acceptance | uncertain
```

The five evidence rows the Epic names, as payload rules:

```text
complete tokens + supported cost estimate -> native usage + supplied cost, metadata names source and basis
explicit reported zero cost               -> zero only where evidence establishes zero
complete tokens, unavailable cost         -> native usage, no pricing attribute, no inferred spend
partial tokens                            -> native buckets for known counts only, missing buckets stay absent,
                                             usage_complete=false + missing-field flags in metadata
partial cost                              -> no cost_details, no model name, missing-field flags in metadata
complete CLI aggregate                    -> one labeled aggregate observation, no child events,
                                             no second parent total, missing timing stays unavailable
```

Omitted without exception: input, output, prompts, span events, exceptions, automatic resource fields, local paths, and
arbitrary text. Where a native field would create false precision, the value stays in approved metadata with an
availability flag instead.

Concrete attribute rules, against the Langfuse v4 OpenTelemetry attribute mapping:

```text
usage_details (langfuse.observation.usage_details, JSON)
  inputCacheBasis = excludes_cache -> {input, output, input_cache_read, input_cache_write} as recorded
  inputCacheBasis = includes_cache -> input = input - cacheRead - cacheWrite, only when both cache counts are known
  inputCacheBasis = unknown        -> no usage_details; counts go to metadata only
  reasoningTokens is a number      -> output = outputTokens - reasoningTokens, output_reasoning = reasoningTokens
  never send a "total" key; never send a bucket whose count is null
  measurementAvailability = partial -> send the known buckets; metadata usage_complete=false and names each missing bucket
  measurementAvailability = complete -> metadata usage_complete=true

cost_details (langfuse.observation.cost_details, JSON)
  costSource = reported | calculated -> {total: costAmount}, including a reported 0
  costSource = unavailable           -> no cost_details

model name (langfuse.observation.model.name)
  sent only when cost_details is sent
  otherwise the model stays in langfuse.observation.metadata.model

timing
  startedAt and endedAt both present -> span start = startedAt, end = endedAt
  otherwise                           -> zero-length span at occurredAt, metadata timing_measured=false
```

> [!NOTE]
> **Langfuse can still add its own numbers**
>
> Langfuse adds the cost it is given and any cost it calculates into one `totalCost`, with no estimate label. RunWield
> sends only what it measured and never sends a model name without a cost. Any cost Langfuse calculates beyond that is a
> Langfuse behavior, and the PRD reference says so as a disclaimer.

> [!WARNING]
> **Langfuse totals for partial rows cover only the sent buckets**
>
> Langfuse adds up whatever buckets it receives. For a partial row, its token total is the sum of the known counts, not
> the true total. `usage_complete=false` in metadata is how a reader tells the two apart. For agy on Gemini, the only
> missing bucket is cache writes, which have a price of 0.

Usage bucket key names (`input_cache_read`, `input_cache_write`, `output_reasoning`) are a reviewable assumption. Check
them against Langfuse's `default-model-prices.json` usage keys; any spelling works for cost because RunWield always
supplies the cost when it sends a model name.

Set aside: the Langfuse SDK with its automatic retries and global instrumentation. It would have been less code and
would have taken delivery policy and payload contents away from Core.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `packages/langfuse-exporter/` — new directory: manifest declaring the child 06 `metrics-exporter` kind with identity
  and entry point, the mapping and transport implementation, and its own tests.
- Package installation fixtures proving a clean install from a supported local package source.
- `docs/prd/runwield-core-prd.md` — destination-specific reference under **Usage measurement and export**, without
  restating the kind or approval requirements. It includes the disclaimer that Langfuse may add its own calculated cost.
- `src/shared/session/backends/claude-cli/` and `agy-cli/` `execution-session.ts` — correct cache basis; stamp turn
  timing on usage rows. agy also records reasoning tokens and calculated cost.
- `src/shared/session/backends/agy-cli/stream-parser.ts` — `AgyCliUsage` carries `thinking_tokens`.
- `src/shared/models/model-registry.ts` — the agy provider definition names its price catalog (`google`) once, and one
  function returns the catalog price model for an external CLI model, or nothing.
- `src/shared/workflow/execution-metrics.ts`, `metrics.js`, `metrics-export-record.ts` — `startedAt`, `endedAt`, and
  `reasoningTokens` on `model_usage` rows and in the export record; Pi reconciliation records `usage.reasoning`.
- `src/shared/session/session.js` — capture Pi turn start and assistant-message end for the recorder.
- Repository packaging and release references as needed; a public package release uses existing release policy and is
  not claimed before publication.

## Reuse Opportunities

- The child 06 `metrics-exporter` declaration shape, approval record, and resolved package identity.
- The child 07 dispatch contract, deadline, and result classification vocabulary — the plugin implements it and adds no
  competing retry policy.
- Availability labels already carried on observations from child 02 — mapped through rather than recomputed.
- Existing package manager distribution and local-source install paths.

## Implementation Steps

Core measurement corrections (land before the exporter mapping depends on them):

- `src/shared/session/backends/claude-cli/execution-session.ts` records `inputCacheBasis: "excludes_cache"` on every
  `model_usage` row. A parser-to-recorder test built from `claude-2.1.284-read-tool-stream.jsonl` asserts the stored
  row's basis and token counts.
- `src/shared/session/backends/agy-cli/execution-session.ts` records `inputCacheBasis: "excludes_cache"`. A test built
  from `agy-1.2.12-tool-stream.jsonl` asserts the stored row's basis, `inputTokens: 19529`, and
  `cacheReadTokens:
  16511`.
- `model_usage` rows carry `startedAt` and `endedAt` (ISO time or `null`) in `ModelUsageObservation`, the `model_usage`
  field list in `metrics.js`, and the `model_usage` export fields in `metrics-export-record.ts`.
- CLI turn rows on both CLI backends get `startedAt` from the recorder's turn start and `endedAt` from the time the
  result usage was observed. Claude CLI per-request (`alternative`) rows keep both `null`.
- Pi assistant-entry rows get `startedAt` from the start of the turn that produced the entry and `endedAt` from the time
  that assistant message finished, both captured while the turn runs. Neither comes from the settlement write time.
  Other Pi rows keep `null` unless the recorder observed their own start and end.
- No row derives a time from a neighboring event, and old rows without the fields read as `null`.
- `model_usage` rows carry `reasoningTokens` (number or `null`) in `ModelUsageObservation`, the `metrics.js` field list,
  and the export fields. It is the reasoning part of `outputTokens`; `outputTokens` is unchanged. Old rows read as
  `null`.
- `AgyCliUsage` has `thinkingTokens` parsed from `thinking_tokens`, and agy rows record it as `reasoningTokens`.
- `reconcilePiEntries` records `usage.reasoning` as `reasoningTokens` when it is a number, else `null`.
- The agy-cli entry in `EXTERNAL_CLI_PROVIDER_DEFINITIONS` names `google` as its price catalog. One exported function in
  `model-registry.ts` returns the built-in catalog model with the exact same ID for an external CLI model, or
  `undefined`. It never matches a different ID such as a `-preview` variant.
- agy rows with a catalog price record `costAmount` from pi-ai `calculateCost` over the recorded counts (a `null` count
  counts as 0) and `costSource: "calculated"`. agy rows without a catalog price keep `costSource: "unavailable"` and
  `costAmount: null`.

Exporter package:

- `packages/langfuse-exporter/` exists with its own manifest and tests, declares the versioned `metrics-exporter` kind
  with exporter identity and entry point, and installs cleanly from a supported local package source.
- The exporter is loadable only through the child 06/07 approval and dispatch path, never through
  `DefaultResourceLoader` or `buildAgentSession`.
- Requests target `/api/public/otel/v1/traces` with project-key Basic authentication and
  `x-langfuse-ingestion-version: 4`; legacy ingestion is not used.
- One complete immutable observation is sent per attempt; no request relies on repeated observation IDs to update a
  prior one.
- Trace and parent IDs are deterministic, group related operations, and a parent is never resent to add children.
- A model request maps to a generation; a CLI turn with a complete aggregate maps to one generation explicitly labeled
  as a backend-turn aggregate, with no invented individual generations beneath it.
- An aggregate's start and end are the observed subprocess timing, not model-server latency; vendor timestamp defaults
  never imply measured latency.
- Workflow and tool observations use fixed names and structured metadata only.
- Usage categories are explicit and non-overlapping. A partial-token row sends a native bucket for each known count,
  sends no bucket for a missing count, and carries metadata `usage_complete=false` with the name of each missing bucket.
  A complete row carries `usage_complete=true`.
- `usage_details`, `cost_details`, model name, and timing follow the attribute rules in Approach exactly. An `unknown`
  cache basis produces no `usage_details`; an `unavailable` cost produces no `cost_details` and no
  `langfuse.observation.model.name`.
- A generation without both `startedAt` and `endedAt` is a zero-length span at `occurredAt` with metadata
  `timing_measured=false`; with both, its start and end are those values.
- Payloads, metadata, and diagnostics contain no input, output, prompts, span events, exceptions, automatic resource
  fields, local paths, or arbitrary text.
- Results distinguish accepted, proven non-acceptance, and uncertain acceptance; transient and permanent classification
  is asserted only where the Langfuse contract supports it.
- The entry implements child 07's exporter contract 1: a required `deliver(observation, context)` that returns
  `accepted`, `not_accepted` (`retryable`, `needs_correction`, or `permanent`), or `uncertain`, and an optional
  `confirm(observation, context)` that returns `present`, `not_found_yet`, or `mismatch`. Input is child 07's
  `MetricsExportObservation`; the package never reads journals or settings.
- `confirm` reads back by `observationId` and the relevant usage and cost fields through a bounded Langfuse public API
  query. Asynchronous absence returns `not_found_yet`, never a rejection.
- The exporter performs no automatic retries of its own and installs no global instrumentation.
- Target Langfuse Cloud or a pinned, tested self-hosted v4 release, with version compatibility and incomplete-value
  handling covered by explicit fixtures.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js packages/langfuse-exporter`; then `deno task ci` and
  `deno task seams:check`.
- A clean installation from a supported local package source proves the package boundary; confirm the actual local
  source syntax rather than trusting current CLI help.
- Mapping fixtures cover all five evidence rows and assert the resulting payload shape, including which fields are
  absent.
- Core: the Claude CLI and agy-cli fixture tests above fail if either backend still records `"unknown"`.
- Core: the agy fixture test asserts `reasoningTokens` equals the summed `thinking_tokens` and `outputTokens` is
  unchanged. A Pi test with `usage.reasoning` set asserts the row's `reasoningTokens`.
- Core: an agy `gemini-3.8-flash` row records `costSource: "calculated"` and a `costAmount` equal to the catalog price
  times the recorded counts. A `gemini-3.1-pro` row records `costSource: "unavailable"` and `costAmount: null`; this
  test fails if the lookup falls back to `gemini-3.1-pro-preview`.
- Exporter: a row with `reasoningTokens` sends `output` and `output_reasoning` whose sum equals `outputTokens`.
- Core: a Pi execution test asserts an assistant-entry row's `startedAt` and `endedAt` fall inside that turn and that
  `endedAt` is earlier than the settlement write. It fails if the fields are copied from `occurredAt`.
- Core: Workspace usage reporting counts Claude CLI and agy-cli rows that it excluded before for an `unknown` basis
  (extend `usage-reporting.test.ts`).
- A partial-token observation built from the agy fixture row sends `input`, `output`, `output_reasoning`, and
  `input_cache_read`, sends no `input_cache_write` key, and carries `usage_complete=false` naming the missing bucket.
  The test fails if the missing bucket is sent as 0 or if the known buckets are dropped to metadata only.
- An unavailable-cost observation carries no `langfuse.observation.model.name` and no `cost_details`; a reported-zero
  observation carries `cost_details: {total: 0}`.
- A measured generation's span start and end equal `startedAt` and `endedAt`; an unmeasured one is zero-length with
  `timing_measured=false`.
- A CLI aggregate produces exactly one labeled generation and no child events.
- Omission tests assert that prompts, content, local paths, span events, exceptions, and automatic resource fields never
  appear in a captured body or metadata.
- Return-classification tests cover acceptance, proven non-acceptance, ambiguous response, timeout past the deadline,
  and transport failure.
- Real destination checks require owner authorization and a disposable Langfuse project: confirm actual native metrics
  and queried observations, that counts and sums match the sent observations, and that an availability label alongside a
  vendor chart still showing invented zero or full totals is treated as a failure of this contract.
- Version-compatibility fixtures run against the pinned v4 shape.
- Existing protected behavior: child 06 approval and child 07 dispatch and state machine still pass unchanged. Expected
  to stop existing: nothing.
- No public package release is claimed before publication.

## Edge Cases & Considerations

- Langfuse's immutable v4 model means no late overwriting of costs or outcomes. Later corrections are new related
  events, never silent replacements.
- The destination can show fewer native charts than Workspace for incomplete observations. That is preferable to false
  precision and must not be “fixed” by inventing values.
- Stable IDs plus local receipts prevent routine resends; they do not provide lossless exactly-once delivery. The owner
  accepts this.
- Unknown model values must not silently gain prices from Langfuse cost inference.
- External destination outage, quotas, and authentication errors are normal observable states returned to Core, not
  plugin-level retries.
- Assume the OTLP mapping and metadata vocabulary are this child's to fix; Planner spells out attribute names against
  current Langfuse v4 documentation.

## Verification Results — 2026-10-11

Recorded at the owner's request. Implementation Steps and approval state are unchanged. The approved Plan Deviation at
2026-10-11T23:03:21.247Z replaces the chart-specific verification requirement with native public-API evidence.

- The authorized repair recognizes the verified 4.56.0 queue acknowledgement as acceptance of queuing, not storage
  completion. Empty native usage maps with zero totals and empty model names can represent absence; supplied
  availability metadata must still match. Missing buckets and unavailable cost are not inferred. Native cost permits
  only two machine epsilons of relative roundoff. Identical complete readback versions can confirm presence; conflicting
  versions cannot.
- Review found no production defect or documented standards violation in the incremental repair. Two test gaps were
  closed with four added cases: the exact cost tolerance boundary and changed values under existing extra-field and
  metadata keys. Both deliberately weakened implementations failed these checks; production code was restored.
- Fresh focused check:
  `deno run -A scripts/run-tests.js packages/langfuse-exporter
  src/shared/workflow/metrics-export-record.test.ts`
  passed 195 tests. The repair and follow-up add 33 tests. No tests were deleted. The duplicate-pages test was rewritten
  to cover identical immutable readback versions; the unavailable-usage test was rewritten to distinguish an empty
  native representation from a vendor-invented bucket. Their protected behaviors remain covered, including conflicting
  versions and invented zero buckets.
- Fresh type check of `live-compatibility.test.ts` passed. Formatting checks of the five repaired TS/JSON files and
  `git diff --check` passed. Before follow-up edits, all 2,196 saved final file hashes matched this checkout.
- Saved full CI evidence: the exact isolated source copy passed `deno task ci`, all ten prerequisite gates, and
  `test:all`: 644 test files, 5,153 tests, zero failures, errors, or skips. This run preceded the four extra tests and
  this documentation update. RunWield's current-checkout validation remains pending.
- Authorized real destination: disposable self-hosted Langfuse 4.56.0, web ARM64 image
  `sha256:274ea1ae6c5d042aebea0712ca5709f3d1339f559e4b03824913bfa85ab8e164`, project `runwield-synthetic-20261011`. All
  nine synthetic cases were queued and confirmed present through public API readback. Recorded native buckets, known
  subtotals, costs, and availability metadata matched. An additional unavailable case retained empty maps and null cost.
  Identical replay confirmed presence; conflicting usage returned mismatch, before and after a forced merge. Forced
  convergence does not establish natural merge timing or exactly-once delivery.
- The Plan permits this pinned self-hosted target; hosted Cloud certification is not required or claimed. The owner
  accepted API-only evidence through the recorded Plan Deviation. The authorized 4.56.0 native API validation satisfies
  the real-destination gate. Vendor charts were not inspected and are not required under the replacement requirement.
- Cleanup evidence records removal of the disposable containers, network, validation images, tunnel, and secret file;
  existing images, volumes, and Workspace were preserved. No approval, grant, publication, or delivery gate was
  advanced.
- Local evidence directory: `/Users/gandazgul/Documents/web/Codex/2026-10-11/task-2/langfuse-repair/`. Primary
  artifacts: `final-report.json`, `final-ci-complete-result.json`, `final-ci-complete.log`,
  `live/final/validation-results.json`, `live/final/readback.json`, `live/replay-probes.json`, `live/after-merge.json`,
  and `cleanup-verification.json`.
