---
planId: "0ae18c01-9dd4-44c8-96d5-dcf816f23c47"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/acp/model-options.ts"
    - "src/acp/server.js"
    - "src/acp/event-mapper.js"
    - "src/acp/server.test.js"
    - "src/acp/protocol-smoke.test.ts"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/acp-implementation-details.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
workRecord:
    status: "generated"
    recordId: "943b37ec-5a4d-4a50-a51a-8998620cc916"
    path: "docs/work-records/2026-09-22-delivered-acp-reasoning-and-exact-context-reporting.md"
    lastAttemptAt: "2026-09-22T12:34:44.772Z"
validatedCommit: "bf124162548e223ba193fcf897bf5bb46d5231f6"
archivedAt: "2026-09-24T04:49:44.415Z"
archiveReason: "Publication record reconciled after main history rewrite; archived at user request."
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/acp-reasoning-and-context-reporting.md"
---

# ACP reasoning control and accurate context reporting

## Context

WebStorm 2026.2.1 now shows RunWield's model selector. Its ACP client also supports the standard `thought_level`
configuration category and the standard `usage_update` session update used for context-window indicators.

RunWield currently exposes only one ACP `configOptions` entry: the model selector in `src/acp/model-options.ts`. The
Runtime already owns the selected thinking level and the setter used by TUI and Workspace, but the ACP adapter does not
expose or apply that setting through `session/set_config_option`.

RunWield also maps ACP `usage_update.used` to the latest message's `inputTokens` and falls back to `used` for
`usage_update.size` when the context window is absent. That can make a client display a false full context window. The
Runtime already exposes current context tokens and capacity through `getContextUsage()` and the Session snapshot.

This changes the owning ACP requirements:

- [ACP Session access — Select models through the client's native controls](../../prd/runwield-acp-protocol-prd.md#acp-session-access)
  gains native reasoning-level selection while preserving the existing model-selection behavior, same-Session mutation,
  invalid-selection refusal, and selection updates.
- [Protocol negotiation and interactions](../../prd/runwield-acp-protocol-prd.md#protocol-negotiation-and-interactions)
  gains accurate standard context-window reporting. The adapter must not fabricate a capacity or substitute a
  per-message token count for current context usage.
- `docs/acp-implementation-details.md` records these gaps today and must be reconciled with the delivered behavior.

The external registry submission was also checked against the current
[registry contributing rules](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md) and
[RunWield PR 580](https://github.com/agentclientprotocol/registry/pull/580). The open PR has the required fields, a
matching lowercase ID, semantic version, valid binary distributions, pinned SHA-256 values, and a 16x16 monochrome
`currentColor` icon. The current registry schema explicitly accepts `license: "proprietary"`. It is not merged, and its
metadata is for v0.10.0 while the installed RunWield build is v0.10.5; registry metadata and checksums must be refreshed
for the release that contains this change before relying on the registry installation.

## Objective

Make RunWield's ACP adapter provide the same native reasoning-level control and truthful context indicator that WebStorm
provides for other ACP agents, without changing the shared TUI or Workspace interaction model.

Success means:

- WebStorm receives a `thought_level` selector with the current RunWield thinking level and supported values.
- Selecting a reasoning level changes the same Runtime Session, does not invoke the model immediately, and is reflected
  in the next complete config response and update notification.
- Model and Agent changes keep both model and reasoning config state current.
- WebStorm receives `usage_update` only when RunWield has a meaningful exact current context value and positive
  capacity; `used` is current context usage including cached tokens, and `size` is the effective context window.
- Missing or explicitly unknown context usage produces no misleading full-window indicator. No local estimate is sent as
  if it were exact.

## Approach

Extend the existing ACP configuration path rather than adding a RunWield-specific WebStorm integration:

```text
session/new / session/load
  -> buildAcpModelOptions
  -> model + thought_level configOptions

session/set_config_option
  -> applyUserModelSelection or SessionRuntime.setSessionThinkingLevel
  -> complete configOptions response + config_option_update

Runtime usage / Session snapshot
  -> exact current tokens + effective context window
  -> ACP usage_update only when both values are meaningful
```

`thought_level` is the standard ACP category. Reuse the existing RunWield values and labels: `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`. Derive availability from the active model's existing reasoning/backend
capabilities. Keep the option's current value valid across model changes; when the active model cannot provide a
reasoning control, omit the selector rather than inventing unsupported choices.

Use the Runtime context snapshot as the owner of current context usage. Do not use `event.usage.inputTokens` as a
context-window measurement. A `usage_update` requires both exact current usage and a meaningful positive capacity under
ACP; if either is unavailable, suppress that update until a later Runtime event supplies both.

The main alternative set aside is a JetBrains-specific metadata extension or legacy `session/set_model` path. WebStorm
already supports standard `configOptions`, and the legacy model API was removed from current ACP SDKs; adding either
would create compatibility code without addressing the context contract.

## Expected Change Surface

The listed paths are high-signal boundaries, not an allowlist. The Engineer should verify the real footprint and change
incidental helpers or fixtures required by the steps below.

- `src/acp/model-options.ts` — build the ordered complete ACP config list, adding the standard `thought_level` select
  beside the existing model select when the active model supports reasoning.
- `src/acp/server.js` — accept and validate model and thought-level config changes, call the existing Runtime-owned
  selection operations, and return/send the complete config list after a change. Thread exact Runtime context state into
  live and replayed ACP update mapping where the current adapter only has per-message usage.
- `src/acp/event-mapper.js` — map exact context usage to `usage_update` and stop emitting a fabricated size or a
  per-message token count as current context. Preserve cumulative cost behavior when a valid usage update is emitted.
- `src/acp/server.test.js` — extend real ACP wire tests for reasoning options, selection, persistence/reload, invalid or
  unsupported values, model/Agent-dependent option refresh, and exact context updates.
- `src/acp/protocol-smoke.test.ts` — retain schema checks for `thought_level` and `usage_update`, including the
  no-update behavior when the exact context contract is unavailable if a pure mapper test is added there.
- `docs/prd/runwield-acp-protocol-prd.md` — update the owning ACP requirements and acceptance scenarios to describe
  native reasoning selection and truthful context reporting as the delivered target; preserve unrelated deferred ACP
  gaps.
- `docs/acp-implementation-details.md` — remove the delivered reasoning/context gaps, document the exact no-estimate
  rule, and keep remaining ACP gaps clearly separate.

No domain-language file or ADR needs to change: this uses existing terms and the accepted SessionRuntime sibling-adapter
boundary in [ADR-010](../../adr/010-session-runtime-sibling-adapters-and-acp.md).

## Reuse Opportunities

- `src/acp/model-options.ts` — preserve the existing model option builder and complete-list update contract.
- `src/shared/session/user-selection.ts` — reuse the selectable-model catalog and model capability metadata.
- `SessionRuntime.getSessionSnapshot()` and the existing `getContextUsage()` projection — use the authoritative Runtime
  context values instead of recreating context accounting in ACP.
- `SessionRuntime.setSessionThinkingLevel()` — apply reasoning selection through the existing shared setter and event
  path.
- `src/acp/server.test.js` model-config fixtures — extend the existing real ACP session fixture rather than adding a
  shallow mock-only test.
- `docs/acp-implementation-details.md` — retain the existing source-backed audit structure and update only affected
  claims.

## Implementation Steps

- `src/acp/model-options.ts` exports a complete ordered configuration list containing the existing provider-qualified
  model selector and, for reasoning-capable active models, a `thought_level` select with the current value and all
  supported RunWield levels; unsupported models do not receive fabricated reasoning values.
- `src/acp/server.js` accepts `session/set_config_option` for `model` and `thought_level`, validates the value against
  the option currently exposed for that Session, applies the selected value through the existing Runtime/model-selection
  owners, and returns/sends the complete current configuration list without starting a model request.
- Invalid, unavailable, or unsupported reasoning selections fail visibly and leave the active model and thinking level
  unchanged; model changes, Agent changes, shared model commands, and reloads publish a configuration list that matches
  the active Session state.
- `src/acp/event-mapper.js` and its callers emit `usage_update` only when the Runtime supplies exact current context
  tokens and a positive effective context window. The emitted `used` includes cached tokens according to the Runtime
  value, `size` is the effective capacity, cumulative cost remains an ACP cost object, and absent/unknown context emits
  no misleading update.
- Live prompts, `session/new`, `session/load`, provider recovery, model changes, and replayed Sessions all preserve the
  same context-reporting rule; an unknown-after-compaction state remains unavailable until exact Runtime usage returns.
- ACP tests exercise the actual NDJSON request path: `session/new` and `session/load` expose the selector, changing it
  affects the next turn and survives reload, invalid values do not mutate state, and the emitted complete option list
  remains schema-valid.
- ACP tests prove the reasoning objective through the real fixture provider boundary: after selecting `high`, the next
  prompt reaches the provider with the selected thinking setting, while an invalid or unsupported value makes no
  provider request and leaves the previous setting active.
- ACP tests prove the context objective with a live Runtime snapshot whose current usage differs from the latest message
  usage and whose cache counts are nonzero. The test fails if the implementation maps the per-message count, uses `used`
  as a fallback size, reads stale event fields instead of the current snapshot, or emits a usage update when exact
  capacity is unavailable.
- The owning ACP PRD and implementation audit describe the delivered reasoning selector and no-estimate context rule,
  preserve the existing model/session/cancellation requirements, and leave unrelated optional ACP work labeled deferred.
- The external registry follow-up is ready for the release containing this work: update PR 580's `agent.json` version,
  archive URLs, and SHA-256 values; retain the required icon and supported distribution fields; rerun the registry build
  and authentication checks from a fresh registry checkout. This is release/submission work outside the repository code
  surface, not a substitute for ACP wire verification.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

- Automated focused ACP tests: run the repository's isolated test runner for `src/acp/server.test.js` and
  `src/acp/protocol-smoke.test.ts`. Assert standard `thought_level` category/id, complete config responses, next-turn
  model/thinking behavior, reload persistence, visible refusal without mutation, and schema-valid `usage_update` frames.
- Automated reasoning discrimination: through the real ACP fixture provider, select `high`, send a prompt, and assert
  the provider receives the selected thinking setting. Submit an unsupported value and assert zero provider calls plus
  an unchanged active setting.
- Automated context discrimination: set the live Runtime snapshot to
  `contextUsage: { tokens: 48000, contextWindow:
  128000 }` while the latest usage event reports a different input
  count and nonzero cache counts. Assert the wire frame is `used: 48000, size: 128000`; assert missing capacity or
  `tokens: null` emits no `usage_update` frame rather than `used === size`; restore exact usage and assert a later
  update uses the restored values.
- Automated regression: run `deno task check`, `deno task lint`, the focused ACP tests, and the repository-required
  `deno task ci`. Use `deno task test` or `scripts/run-tests.js`; do not invoke `deno test` directly.
- Manual WebStorm flow: with WebStorm 2026.2.1 and RunWield configured as an ACP agent, start a new chat, confirm the
  model and reasoning selectors appear, change the reasoning level, send a prompt, and confirm the next turn uses the
  selected level. Reload or reopen the Session and confirm the selection remains current.
- Manual WebStorm context flow: after a prompt with known Runtime context usage, confirm the client shows the reported
  current used/size values. After a compaction or backend state with unknown exact usage, confirm the client does not
  show a fabricated `used / used` full-window indicator. Confirm later exact usage restores the indicator.
- Manual registry review: on the PR head, run the current contributing checks from a fresh registry clone with URL
  checks enabled when release assets are available: `uv run --with jsonschema .github/workflows/build_registry.py` and
  `python3 .github/workflows/verify_agents.py --auth-check --agent runwield`. Confirm the PR is updated to the shipped
  version, all archive URLs match it, checksums match the archives, the icon is 16x16 and `currentColor`-only, and the
  PR is merged before describing registry installation as available.
- Existing behavior that must remain protected: standard model selection, cumulative cost object shape, Session
  load/replay, model/Agent update notifications, provider-failure recovery, and no model request during configuration
  changes. Behavior intentionally stopped: ACP no longer reports a fabricated context size or presents a per-message
  token count as current context usage.

## Edge Cases & Considerations

- A model can remain selectable while its credentials or current context capacity are unavailable. Preserve the existing
  model fallback option, but do not create a reasoning selector or context indicator with invented values.
- The Runtime may report `tokens: null` after compaction. Treat this as an explicit unknown state, not zero tokens and
  not a reason to use the last message's usage.
- Context usage can change when the active model, Agent, or transcript segment changes. The complete config and usage
  notifications must describe the active Session after each settled change.
- WebStorm may display config options in array order. Keep model first and thought level second so the native controls
  stay predictable.
- PR 580 is open, not merged, and currently describes v0.10.0 while the local installed build is v0.10.5. The registry
  icon and schema fields are compliant based on the current standards, but the release metadata must not be treated as
  current until refreshed and revalidated.
