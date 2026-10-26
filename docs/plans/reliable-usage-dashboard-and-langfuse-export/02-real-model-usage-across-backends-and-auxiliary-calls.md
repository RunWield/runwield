---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/session/session-runtime-events.js"
    - "src/shared/session/session.js"
    - "src/shared/session/backends/"
    - "src/shared/session/agent-handler.ts"
    - "src/tools/see-image.ts"
    - "src/ui/workspace/routes/api/review-agent-handlers.js"
executionAgent: "engineer"
createdAt: "2026-09-21T19:28:54.619Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 2
dependencies:
    - "01-core-measurement-history-and-default-on-recording"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "e09a1c9e-4131-46a6-9807-c34681df5523"
---

# Real Model Usage Across Backends and Auxiliary Calls

## Context

`normalizeRuntimeUsage` (`src/shared/session/session-runtime-events.js:690`) coerces every absent token category and
cost to `0` via `Number(...) || 0`. Claude's stream parser reads `usage.cost` rather than `total_cost_usd`, and the
Antigravity conversion fills cache and cost with zero. A missing value and a measured zero become indistinguishable
downstream.

Meanwhile several RunWield-started model calls never reach measurement at all: `runIsolatedAgentSession`, the AI
Reviewer and review helpers can use in-memory managers, compaction entries can carry usage that current replay totals
omit, and `createSeeImageTool` (`src/tools/see-image.ts:81`) discards usage after taking the returned description.

The parent Epic requires measurements that report what was actually observed, with explicit availability. This child
writes through the collection contract built in `01-core-measurement-history-and-default-on-recording`; it does not
reshape the journal.

Owning PRD: [Models and providers](../../prd/runwield-core-prd.md#models-and-providers) keeps backend selection and
honest visibility limits. The new **Usage measurement and export** capability gains coverage requirements for supported
backends and auxiliary calls.

## Objective

Every supported model call produces one observation whose numeric fields carry an availability label — reported,
estimated, unavailable, or incomplete — and whose granularity matches what the source actually supplies. Nothing
double-counts, and nothing invents a value the upstream did not give.

## Approach

```text
Pi runtime usage event ----+
Claude CLI stream/result --+--> backend adapter states granularity
Antigravity conversion ----+        (per-request | cumulative-turn)
                                        |
isolated session ----------+            v
AI review / review helpers +--> collection contract (child 01)
compaction entry ----------+            |
see-image vision call -----+            v
                                   one observation per operation
```

Rules the adapters enforce:

```text
missing field          -> availability: unavailable   (never 0)
source-supplied 0      -> availability: measured-zero only when the source establishes that meaning
streaming chunk        -> contributes to its operation, not a second observation
cumulative turn total  -> one observation labeled backend-turn aggregate; children not re-added
retry                  -> distinct attempt identity under one operation identity
```

Set aside: collecting through a Pi extension. It would have produced a smaller diff and Pi-only coverage, and the Epic
rejects it.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/shared/session/session-runtime-events.js` — `normalizeRuntimeUsage` stops defaulting absence to zero and returns
  availability alongside values.
- `src/shared/session/backends/` — Pi, Claude CLI, and Antigravity adapters translate their actual usage semantics and
  declare per-request versus cumulative-turn granularity.
- `src/shared/session/session.js` (existing `recordWorkflowMetric` calls near L1167, L2345, L2680) and
  `src/shared/session/agent-handler.ts:237` — route model usage through the collection contract.
- `src/shared/session/` isolated-session and compaction paths — auxiliary and compaction usage becomes observable;
  replay is distinguished from new activity.
- `src/tools/see-image.ts` — the vision call's usage is observed instead of discarded.
- `src/ui/workspace/routes/api/review-agent-handlers.js:306` — AI review model usage is observed.
- `docs/prd/runwield-core-prd.md` — coverage requirements and scenarios under **Usage measurement and export**,
  referencing rather than duplicating backend visibility limits.

## Reuse Opportunities

- The child 01 collection contract, observation and attempt identity, and epoch eligibility — callers supply facts, not
  persistence policy.
- Existing backend adapter boundaries — subprocesses and vendor network calls stay real external boundaries and remain
  legitimate seams.
- `defineGitFixture` and `withProcessGlobalTestLock` for real repositories and sandboxed HOME.
- The historical **Complete Tool-Call Metrics** draft named overlapping tool-coverage goals. Its advertised-tool and
  schema-token denominator is outside this Epic's scope and must not be added.

## Implementation Steps

- `normalizeRuntimeUsage` returns each numeric category with an availability label, and no code path converts an absent
  token or cost value into a numeric zero.
- A supplied zero is recorded as a measured zero only where the source establishes that meaning; otherwise it is
  recorded as unavailable.
- Each backend adapter declares whether a value describes an individual request or a cumulative CLI turn, and that
  declaration is carried on the observation.
- Where only a CLI turn total exists, one observation records that granularity; no per-call observations are fabricated
  beneath it.
- Repeated streaming chunks and a final cumulative total for the same operation contribute once.
- A parent summary never re-adds its children's usage.
- Retries receive distinct attempt identities under one operation identity.
- Delegation, AI review, compaction, vision fallback via `see_image`, and Guided Review each produce an observation when
  they invoke a model, and produce none when they do not.
- A CLI cancellation or error before usage is saved yields an observation with unavailable usage, not a zero-valued one.
- Cost observations carry their source and price basis; provider and CLI estimates stay labeled estimates.
- Incomplete token categories produce a known subtotal with named exclusions rather than a complete total.
- Tool observations retain tool identity, duration, and bounded outcome codes, and never arguments or results.
- Native CLI tool updates count as calls only where stable identity and event meaning are verified; otherwise that
  coverage is marked unavailable.
- `docs/prd/runwield-core-prd.md` names the supported-backends coverage requirement and its scenarios, distinguishing
  delivered coverage from backends whose detail remains unavailable.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/session` plus focused backend adapter tests; then
  `deno task seams:check` and `deno task ci`.
- Fixtures establish field provenance per backend: a payload with the field present, present-and-zero, and absent
  produces three distinguishable observations.
- Claude fixtures cover `usage.cost` and `total_cost_usd` shapes; Antigravity fixtures cover the cache and cost
  zero-fill path.
- A repeated-chunk stream plus a final cumulative total yields one observation's worth of tokens.
- A parent-with-children shape yields the parent total once.
- A cancelled CLI turn exposes missing usage rather than zero.
- `see_image`, an AI review turn, a compaction entry, and a delegated call each contribute exactly one observation.
- Authorized live CLI output confirms the tested versions; source omission alone is not treated as upstream proof. Live
  runs require owner authorization and are recorded as evidence, not assumed.
- Existing protected behavior: current Session runtime event replay and saved-assistant-entry shape still pass. Expected
  to stop existing: the `|| 0` zero-fill in `normalizeRuntimeUsage`.
- The measurement module is not converted into a replaceable test seam; `deno task seams:check` passes without
  re-baselining.

## Edge Cases & Considerations

- Some usage was never retained or is never reported upstream. Neither this child nor any later one can restore it;
  record the gap.
- Subscription-backed CLI usage may have no meaningful cost. Record unavailable with the price basis named, never zero.
- In-memory session managers used by isolated and review paths must not become a way to bypass measurement or a new
  injection seam.
- Transcript replay must be distinguishable from new activity so later reporting cannot double-count historical
  evidence.
- Assume the availability vocabulary is four values (reported, estimated, unavailable, incomplete); Planner fixes field
  spelling.
