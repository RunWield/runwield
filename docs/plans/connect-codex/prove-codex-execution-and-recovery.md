---
classification: PLANNED_CHANGE
workKind: FEATURE
complexity: HIGH
parentPlan: connect-codex
order: 3
targetBranch: epic/connect-codex
affectedPaths:
    - src/attached/codex/acceptance
    - scripts/connect-codex-acceptance.ts
createdAt: "2026-10-29"
status: draft
---

# Prove Codex execution and recovery

## Context

The [Epic](../connect-codex.md) needs evidence beyond manifest and prompt assertions. Claude's acceptance evidence is
host-specific and cannot qualify Codex. This Plan follows [plugin packaging](package-codex-workflow.md).

## Objective

Exercise the actual installed Codex plugin against disposable repositories, distinguish protocol tests from live host
evidence, and catch false independence, wrong checkout, lost recovery, duplicate checks and transcript ingestion.

## Approach

Use a black-box host driver and read-only evidence collector with provenance. Reuse suitable Claude evidence patterns
without importing lifecycle writers or fabricating artifacts. Test external-process boundaries with protocol fixtures;
reserve tested-version claims for real Codex runs. Desktop and CLI evidence remain separately identified.

## Expected Change Surface

- `src/attached/codex/acceptance/` — host runner, read-only collection, verification and focused fixture tests.
- `scripts/connect-codex-acceptance.ts` and Bun test inventory.
- Compatibility evidence and owning Connect acceptance requirements, only where demonstrated.

## Reuse Opportunities

Reuse shared MCP client utilities and real Git/Plan fixtures. Follow the existing no-lifecycle-writer acceptance
boundary and exact source/permissions provenance. Keep test fixtures clearly separate from saved live results.

## Implementation Steps

- A repeatable isolated runner installs the real package, captures actual MCP initialize identity and package/core
  versions, and reports missing prerequisites accurately without changing the user's plugins or credentials.
- Integration coverage exercises activation, Plan submission/review, fresh-process restoration, execution worktree
  isolation, real validation commands, reviewer receipt/freshness guards, repair, publication and Work Records.
- Live-host acceptance drives the packaged skill and its workers; direct parent reads or synthetic outcomes cannot
  count as independent review. The runner observes durable state without writing Core lifecycle evidence itself.
- Slow-check and process-loss coverage detects duplicate checks, loss of cancellation, stale actions and false
  terminal outcomes. Reinstallation preserves Core-owned workflow state.
- Evidence records exact source digest, host surface/version, adapter, permissions, observed steps and limitations.
  Privacy checks detect transcript sentinels in durable artifacts. A failed or blocked run never produces a passing
  result or tested compatibility entry.
- Focused tests test the collector's negative cases and the actual subprocess boundary. Any unavailable desktop or
  authentication evidence is clearly reported as unproven, not silently substituted with fake-host coverage.

## Verification Plan

Run `bun scripts/run-tests.js src/attached/codex/acceptance` and the documented acceptance command against an isolated
world. Inspect the output summary and failure paths. Attempt live CLI and desktop capability checks where available;
keep any remaining qualification gap explicit in the final PR and support guide.

## Edge Cases & Considerations

No authentication secrets or raw model output belong in committed summaries. Clean up disposable processes/configuration
without deleting retained failed-work evidence. Live model costs and real-host limitations must stay visible.
