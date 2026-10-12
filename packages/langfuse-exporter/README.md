# RunWield Langfuse exporter

A standalone metrics-exporter package for **Langfuse Cloud's v4 protocol**. It has no runtime dependencies, SDK,
instrumentation, storage access, or automatic retries. It is not a Pi extension.

## Install and authorize

Copy this directory, or its production files (`package.json`, `exporter.ts`, `LICENSE`, and this README), to a stable
local directory. Install from its **absolute directory path**:

```sh
wld install /absolute/path/to/langfuse-exporter
```

RunWield asks for metrics-exporter code approval. Declining approval leaves the package installed but not executable.
Approval alone does not authorize export. The installer can normalize the saved source to a relative identity; use the
installed exporter's resolved source when creating a grant. Core must also hold an owner grant for the selected local
Projects and the Langfuse destination. The grant starts at consent; it does not export prior history. Credentials are
stored by Core, not by this package. Moving the directory or changing its version requires new code approval.

Use the Langfuse region origin as the endpoint, for example `https://cloud.langfuse.com` or
`https://us.cloud.langfuse.com`. The destination's `externalProject` must be the Langfuse **project ID**, not its
display name. Supply project API keys as `credentials.publicKey` and `credentials.secretKey`. No environment variable is
read. HTTP is permitted only for loopback test servers; Core must explicitly authorize that exception.

No public npm publication, hosted Cloud certification, or compatibility with untested self-hosted releases is claimed.
The [RunWield Free Use License](./LICENSE) applies to this package.

## Contract

The manifest declares `wld.metricsExporter: { contract: 1, id: "langfuse", entry: "./exporter.ts" }`. Core's approved
export worker calls these named exports:

- `deliver(observation, context)` returns `accepted`, `not_accepted` with `retryable`, `needs_correction`, or
  `permanent`, or `uncertain`.
- `confirm(observation, context)` returns `present`, `not_found_yet`, or `mismatch`.

Structural contract types are exported locally. The context contains an endpoint, external project ID, string-map
credentials, and an **absolute epoch-millisecond deadline**. The package never imports RunWield source. Tests and
fixtures are excluded from the production `files` list.

## Data sent

Each attempt sends exactly one span as OTLP HTTP JSON to `/api/public/otel/v1/traces`, with Basic `publicKey:secretKey`
authentication and `x-langfuse-ingestion-version: 4`.

Model usage becomes a generation. CLI turn aggregates become one generation named `RunWield backend-turn aggregate`.
Core keeps overlapping alternative measurements in local history but excludes them from all metrics exports, so no
alternative request generations duplicate the aggregate totals. Other facts use fixed names such as `RunWield tool` and
`RunWield validation`. No extra parent observations are sent. SHA-256 domain-separated IDs produce 32-hex-character
trace IDs and 16-hex-character span and parent IDs. All observations for one Core Project share a trace, including
independent operations. Session, Plan, and execution references remain correlation metadata. Project-scoped traces keep
parent links valid across delegated Sessions and Plan changes without parent lookups or delivery-order state. Child
spans point to the deterministic ID of their execution's completion span; nested execution spans point to their parent
execution. This package does not invent a parent total or send a synthetic parent span.

Only approved scalar fields, pseudonymous Core references, counts, and availability flags become metadata. Unknown
fields are ignored even if supplied by a caller. Prompts, input/output content, events, exceptions, response
diagnostics, local paths, and automatic resource attributes are not sent.

Usage rules:

- Known counts use `input`, `output`, `input_cache_read`, **`input_cache_creation`** (cache writes), and
  `output_reasoning`. Reasoning is removed from `output`; no `total` bucket is sent.
- Input that includes cache is reduced only when both cache counts are known and the subtraction is nonnegative.
- Unknown cache basis omits native usage. Approved raw counts remain metadata.
- Missing buckets stay absent, not zero. Metadata records `usage_complete`, `native_usage_available`,
  `reasoning_available`, and individual `missing_*` flags. A partial row's Langfuse total is only the sum of known
  buckets, not a complete measurement.
- Only a finite, nonnegative, supplied USD cost with `reported` or `calculated` evidence is sent as `{total: amount}`.
  Reported zero is retained. The native model name is sent only with that cost. Without cost, the model is metadata
  only. Langfuse may still add its own calculated cost; readback does not treat that as matching RunWield evidence.
- Valid measured start and end use their ISO times. Otherwise the span has zero duration at `occurredAt`, marked
  `timing_measured=false`. CLI measured timing is subprocess timing, not model-server latency.

## Acceptance and readback

`200 {}` is OTLP full success. Partial success with zero rejected spans is accepted, including warnings; one rejected
span proves rejection of this single-span request and is permanent. The queue-job acknowledgement observed in
self-hosted Langfuse 4.56.0 is accepted only with its verified job envelope, OTEL queue identity, v4 ingestion marker,
and matching project, public key, and upload path. It proves queuing, not completed storage. Other success bodies remain
uncertain. `401`, `403`, and `404` require configuration correction; `400` is permanent invalid-payload rejection.

Timeouts, response loss, redirects, and generic server/proxy failures are uncertain. In particular, `429`, `500`, `502`,
`503`, and `504` do **not** prove no upstream acceptance. OTLP permits retry for some failures, but that permission is
not proof for RunWield's duplicate policy. No source-proven transient nonacceptance response is assumed. Only a deadline
that expires before sending permits a local retry. Core owns all retry and confirmation scheduling.

`confirm` queries `/api/public/v2/observations` with an ID filter, a two-second start-time window, and only
`core,basic,usage,model,metadata` field groups. It follows at most three pages of at most 100 rows, rejects cursor
cycles, and bounds each response to 1 MiB. It checks ID, trace and parent correlation, project ID, type, fixed name,
timing, metadata, native usage and cost, totals, and model. A readback-only derived usage `total` is permitted only if
it exactly equals the sum of the sent known buckets. Missing required fields cannot establish presence. The v4 converter
represents absent native usage as an empty usage map with a zero total, and an absent model as an empty string. These
representations confirm absence only when all supplied availability metadata and the empty native maps still match; they
do not create measured usage or cost. A vendor-added zero bucket or inferred cost remains a mismatch.

Native cost comparisons permit at most two machine epsilons of relative floating-point roundoff. Zero, null, missing
values, token counts, and metadata remain distinct and strict. Langfuse's ReplacingMergeTree storage can expose unmerged
versions of one span in v2 readback. Identical rows within the bounded lookup can confirm the same immutable fact; every
returned field, including extra metadata, must agree across those rows. Conflicting versions remain a mismatch. This is
presence confirmation, not an exactly-once delivery guarantee; the exporter still never retries ingestion.

Asynchronous absence or failed readback returns `not_found_yet`, never rejection. Deadlines cover headers **and
bodies**; redirects are disabled to prevent credential leakage. No remote body text enters result diagnostics.

## Protocol evidence and verification

Target: Langfuse v4 OTLP ingestion and observations v2 wire shapes. Authorized synthetic validation used self-hosted
4.56.0 with the pinned web image below. Hosted Cloud compatibility is not certified. Reference sources:

- [Langfuse OTLP endpoint and attributes](https://langfuse.com/integrations/native/opentelemetry)
- [Langfuse public API](https://langfuse.com/docs/api-and-data-platform/features/public-api)
- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
- [Pinned model price catalog](https://github.com/langfuse/langfuse/blob/cb2cebae9f8e7d53e8e514780fce8493d680ecfb/worker/src/constants/default-model-prices.json)
- [Pinned observations v2 schema](https://github.com/langfuse/langfuse/blob/cb2cebae9f8e7d53e8e514780fce8493d680ecfb/web/src/features/public-api/types/observations.ts)
- [Pinned readback converter](https://github.com/langfuse/langfuse/blob/cb2cebae9f8e7d53e8e514780fce8493d680ecfb/packages/shared/src/server/repositories/observations_converters.ts)

The source-pinned small fixture in `fixtures/protocol.json` records the catalog keys and public API groups. The catalog
uses `input_cache_creation`, not the Plan's provisional `input_cache_write`; it also confirms `input_cache_read` and
`output_reasoning`. These are transport bucket names, not an additional pricing calculation.

From the repository, run the isolated test runner:

```sh
deno run -A scripts/run-tests.js packages/langfuse-exporter
```

Tests capture local `Deno.serve` requests through `deliver` and `confirm`. The integration test copies only production
files, runs the real local installer and approval path, records real journal rows, grants consent, and runs Core's
export cycle. A separate no-config subprocess proves the copied module needs no repository imports.

The synthetic `otlpQueued` fixture records the redacted self-hosted 4.56.0 acknowledgement shape observed through the
pinned ARM64 web image `sha256:274ea1ae6c5d042aebea0712ca5709f3d1339f559e4b03824913bfa85ab8e164`. The compatibility
regressions cover that acknowledgement, empty native fields, cost roundoff, and replay conflicts. Authorized validation
on 2026-10-11 used a disposable local 4.56.0 project. All nine synthetic cases were queued and confirmed through native
API readback; an all-measurements-unavailable case also confirmed absent native maps and cost. Identical replay
confirmed presence, and changed usage under the same ID returned mismatch, both before and after a forced storage merge.
This does not establish natural merge timing or exactly-once ingestion. Vendor charts were not checked. The disposable
instance and temporary keys were removed. No live credentialed destination is contacted by the automated tests.
