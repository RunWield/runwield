---
planId: "29ed7919-7f2c-4d2a-a629-eb8cab2bff5f"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "packages/langfuse-exporter/"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T19:28:55.278Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 8
dependencies:
    - "07-core-export-coordination-and-delivery-states"
userVerifiedAt: null
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
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
partial tokens or partial cost            -> known components + missing-field flags in metadata,
                                             no native complete total, pricing inference suppressed
complete CLI aggregate                    -> one labeled aggregate observation, no child events,
                                             no second parent total, missing timing stays unavailable
```

Omitted without exception: input, output, prompts, span events, exceptions, automatic resource fields, local paths, and
arbitrary text. Where a native field would create false precision, the value stays in approved metadata with an
availability flag instead.

Set aside: the Langfuse SDK with its automatic retries and global instrumentation. It would have been less code and
would have taken delivery policy and payload contents away from Core.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `packages/langfuse-exporter/` — new directory: manifest declaring the child 06 `metrics-exporter` kind with identity
  and entry point, the mapping and transport implementation, and its own tests.
- Package installation fixtures proving a clean install from a supported local package source.
- `docs/prd/runwield-core-prd.md` — destination-specific reference under **Usage measurement and export**, without
  restating the kind or approval requirements.
- Repository packaging and release references as needed; a public package release uses existing release policy and is
  not claimed before publication.

## Reuse Opportunities

- The child 06 `metrics-exporter` declaration shape, approval record, and resolved package identity.
- The child 07 dispatch contract, deadline, and result classification vocabulary — the plugin implements it and adds no
  competing retry policy.
- Availability labels already carried on observations from child 02 — mapped through rather than recomputed.
- Existing package manager distribution and local-source install paths.

## Implementation Steps

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
- Usage categories are explicit and non-overlapping; incomplete totals that cannot retain meaning in native fields stay
  in structured metadata with availability flags.
- Cost is sent with its evidence label; omitted cost never gains a price through a model-pricing attribute, and where
  inference must be suppressed the payload suppresses it.
- Model identity stays in approved metadata rather than recognized pricing attributes where native pricing would invent
  spend.
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
- A partial-token observation produces no native complete total and carries its missing-field flags.
- An unavailable-cost observation carries no model-pricing attribute that could create inferred spend.
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
