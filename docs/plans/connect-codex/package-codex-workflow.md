---
classification: PLANNED_CHANGE
workKind: FEATURE
complexity: HIGH
parentPlan: connect-codex
order: 2
targetBranch: epic/connect-codex
affectedPaths:
    - src/attached/codex/plugin
    - .agents/plugins/marketplace.json
createdAt: "2026-10-29"
status: draft
---

# Package the Codex workflow

## Context

The [Epic](../connect-codex.md) requires the Claude FEATURE journey through native Codex plugin surfaces. The shared
carrier is established by [host-aware coordination](share-host-aware-coordination.md). The owner selects the invocation
shape before this Plan's entrypoint implementation.

## Objective

An installable repository plugin exposes explicit start and resume in Codex desktop and CLI and guides every existing
Core action through the appropriate Codex-owned worker without copied role prompts or implicit activation.

## Approach

Use current official plugin manifests, native skills and `agents/openai.yaml` explicit-invocation policy. Package only
orchestration guidance and fetch role instructions at runtime. Reuse the shared MCP adapter and Core action contracts.

## Expected Change Surface

- `src/attached/codex/plugin/` — manifest, MCP config, adapter contract and workflow skill resources.
- `.agents/plugins/marketplace.json` — repository-local package discovery.
- Codex plugin contract/integration tests and explicit Bun test inventory.
- Connect PRD activation requirements and scenarios for the delivered entrypoint.

## Reuse Opportunities

Mirror Claude request/review/implementation/validation guidance and all its rejection/recovery rules. Do not copy Core
roles, create custom lifecycle policy, install hooks, or introduce a second worktree manager.

## Implementation Steps

- Codex installs the package from the repository marketplace in an isolated configuration; manifests resolve all
  resources inside the package and launch Core from the user's project directory with the installed plugin root.
- Native explicit-only skills implement the owner-selected start/resume entrypoint. New work needs explicit activation;
  resume reads durable status and never creates a new workflow merely because conversation context was lost.
- Planning handles triage, setup disclosure, Plan submission, browser feedback/chat, cancellation, Approve & Run and
  Approve for Later with the existing Core contracts.
- Implementation and repair dispatch fresh Codex subagents in Core's supplied execution directory, preserving the
  invoking checkout. Workers return truthful reports and do not commit, publish or perform lifecycle transitions.
- Reviewers fetch their own complete instructions and bounded artifacts, call MCP `review_diff` directly for all
  required bytes, and return structured results unchanged. Missing independent MCP capability stays recoverable.
- Validation handles Core decisions, long-running checks, review/chat, correction, repair, recorder and publication.
  Only Core's delivered result is reported as successful delivery. Recorders receive canonical artifacts only.
- Native Codex timeouts and prerequisites are explicit and tested; no Claude-only timeout field or shell variable is
  assumed to work. Ordinary host use and the user's permission settings stay unchanged.
- Contract tests cover workflow completeness and installed package resolution; real MCP subprocess tests exercise the
  selected adapter. Connect PRD activation scenarios describe the implemented behavior accurately.

## Verification Plan

Run `bun scripts/run-tests.js src/attached/codex` for new package/carrier tests and the existing Claude plugin tests.
Use an isolated Codex home to install/list/remove the package; never modify the user's installed plugins for tests.
Keep automatic activation disabled and test that package loading itself creates no workflow state.

## Edge Cases & Considerations

Unavailable Core, absent worker capabilities, stale workflow/action IDs, interrupted tools, bounded artifact pagination,
wrong cwd and user cancellation need clear recoverable outcomes without fabricated completion.
