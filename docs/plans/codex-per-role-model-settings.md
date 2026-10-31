---
planId: "75555277-e239-41d4-8d26-cc6c1dc2adfe"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached"
    - "src/shared/settings.js"
    - "src/attached/codex"
    - "config.schema.json"
    - "docs/user-documentation/connect-codex.md"
    - "docs/user-documentation/settings.md"
    - "docs/prd/runwield-connect-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-30"
origin: "internal"
targetBranch: "epic/connect-codex"
userVerifiedAt: null
deliveryBranch: "epic/connect-codex"
status: "reviewed"
---

# Persistent Codex Model and Thinking Settings per Role

## Context

The user wants persistent model and thinking-level choices for each RunWield role in the Codex plugin, with inheritance
as the default. Today the plugin supplies role instructions but no role-specific model configuration. Core's existing
`agents` and `modelPresets` settings configure Core execution and must not silently select models for Connect.

The selected execution base is `epic/connect-codex`, whose Codex implementation was inspected at
`/Users/gandazgul/.codex/worktrees/connect-codex-epic/runwield`. As of 2026-10-30, fetched `origin/main` at `0e14bb744`
lacks the adapter and [PR #477](https://github.com/runwield/runwield/pull/477) reports open and unmerged. The selected
branch supplies the required adapter; importing it is outside this feature.

The owning capability is [Connect: Host-owned reasoning](../prd/runwield-connect-prd.md#host-owned-reasoning).
Add a requirement and scenarios for persistent Codex role preferences, inheritance, reset, and host capability errors.
Preserve host-owned model calls, fresh independent review, runtime role instructions, and ordinary host behavior outside
an activated workflow. This Plan describes proposed behavior, not delivered support.

## Objective

Users can save independent model and thinking-level preferences for `router`, `planner`, `engineer`,
`frontend-engineer`, `reviewer`, `reviewer-feedback-engineer`, and `recorder`. Preferences survive new chats and process
restarts. Unconfigured fields inherit Codex's native settings; configured fields reach the corresponding host worker.

## Approach

Reuse personal and project `.wld/settings.json` JSONC files, with a separate `connect.codex.roles` setting. This is the
proposed configuration surface for this change; no new settings page is required. Values use Codex-native model IDs and
thinking levels, not Core's provider-qualified models or narrower thinking-level enum.

```jsonc
{
    "connect": {
        "codex": {
            "roles": {
                "planner": { "model": "inherit", "thinkingLevel": "high" },
                "reviewer": { "model": "inherit", "thinkingLevel": "inherit" },
            },
        },
    },
}
```

Resolve each field independently: project value, then personal value, then `inherit`. An explicit `inherit` stops
that lookup and removes the corresponding host spawn override. Thus a project's thinking-level override preserves a
personal model selection, while a project's `model: "inherit"` resets that personal selection for this project.

```text
settings files → Codex role resolver → current-action dispatch metadata → Codex worker
                                            model         → model
                                            thinkingLevel → reasoning_effort
                                            inherit       → omit argument
```

Inheritance means Codex's native resolution, not copying a guessed model or effort into storage. In particular,
[Codex documents](https://learn.chatgpt.com/docs/agent-configuration/subagents) that an explicit spawn model with no
effort override can use that model's default effort. Available efforts depend on the selected model and client; see the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Expose dispatch metadata with compact actions so the coordinator can choose a worker without reading independent
reviewer instructions. Workers still fetch their own current role instructions. Existing fresh-worker phases always
apply their role preferences. Router and initial Planner use a fresh worker when either field is overridden; with both
fields inherited, their existing coordinating-chat flow can remain. Planning workers return their structured outcome
or Plan identity to the coordinator, which owns lifecycle submissions.

Resolve preferences on the next role dispatch, including after resume. Do not restart an already running worker after
a file edit. Use the current calling host rather than the workflow's origin host, so a Claude-origin workflow resumed in
Codex receives Codex preferences and a Claude caller does not.

Reusing Core presets would couple two distinct model executors. Generating persistent Codex agent files would add a
second settings owner and installation lifecycle; neither is needed for host-native spawn overrides.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/attached/` — a typed Codex role-settings resolver; action and instruction metadata through
  `operations.ts`, `coordinator.ts`, and `presentation.ts`; worker-specific planning handoff guidance in
  `role-instructions.ts`.
- `src/shared/settings.js`, `config.schema.json` — preserve the `connect` key and describe its supported role fields.
- `src/attached/codex/plugin/skills/run/` — consistent inheritance and explicit-override dispatch across planning,
  implementation, review, repair, and Recorder references.
- Attached settings, action-content, cross-host, Codex MCP, and plugin tests — persistence, scope resolution, compact
  metadata, and dispatch-contract coverage.
- `docs/user-documentation/connect-codex.md`, `docs/user-documentation/settings.md` — configuration, precedence, reset,
  supported roles, and host-dependent values.
- `docs/prd/runwield-connect-prd.md#host-owned-reasoning` — the new requirement and acceptance scenarios.

The existing terminology and ADR-014 model-ownership boundary remain valid. No glossary rename or new ADR is needed.

## Reuse Opportunities

- `getCustomSetting`, `setCustomSetting`, and the settings preservation machinery in `src/shared/settings.js` already
  handle JSONC, personal/project locations, and linked-checkout identity. Read scopes separately: the generic merged
  custom getter merges only the top level and cannot implement per-field role inheritance.
- `AttachedHostRole` already names the seven applicable roles. Keep one source for the supported roles.
- `withRoleInstructions`, `presentAttachedHost`, and compact action presentation already expose current role context.
  Extend them without copying settings into lifecycle authority or durable host transcripts.
- `defineGitFixture`, Attached fixtures, and `withProcessGlobalTestLock` provide real filesystem and process isolation.

## Implementation Steps

1. A typed resolver returns the effective Codex model and thinking-level preference for each supported role. Missing
   settings resolve to inheritance. Project fields override personal fields independently; explicit inheritance resets
   the selected field. Invalid types, empty values, and misspelled roles produce actionable diagnostics rather than
   silently selecting another model. Model/effort availability remains Codex-owned; do not bake in a stale model catalog.
2. Settings writes preserve the new key and unrelated settings. The JSON schema accepts native IDs, inheritance, and
   Codex effort strings, and documents all supported roles. Existing Core presets and Claude behavior remain unchanged.
3. Normal action responses, compact status, and `get_instructions` expose consistent dispatch preferences for the
   current host and role. Settings use the existing project-settings authority, including linked execution worktrees.
   A new process and a resumed workflow re-read saved preferences. Preferences never grant permissions or bypass a
   workflow gate, and no Core model session is created.
4. The Codex Skill applies explicit values as host spawn arguments and omits inherited fields. It uses fresh contexts
   for all required worker phases and for overridden Router/initial Planner roles. Planning workers return results for
   coordinator submission instead of advancing the workflow themselves. Independent reviewers retain direct MCP diff
   access, fresh instructions, and coordinator-independent review content.
5. An unavailable override or unsupported host control is reported accurately and leaves the current action resumable.
   The plugin does not silently downgrade, ignore an explicit preference, create another workflow, or claim a model was
   used merely because it appeared in a prompt. Missing metadata from an older compatible Core keeps default inheritance.
6. Focused regression coverage proves persistence, per-field resolution, all seven role mappings, current-host
   selection, and metadata survival across compact/resumed responses. Documentation and the owning PRD describe the
   implemented configuration, acceptance scenarios, and any remaining host limitation in the same change.

## Approval Confirmation

The user selected `epic/connect-codex` as the execution base, recorded in `targetBranch`.
No Work Records are proposed for supersession.
The user's existing no-commit instruction remains in force; an operation that creates a Git commit needs explicit
authorization.

## Verification Plan

- Use Bun 1.4.3 and run `bun run install:locked` before checks. Format and check only changed files.
- Run the new resolver tests through `bun scripts/run-tests.js src/shared/attached/codex-role-settings.test.ts` (adjust
  the filename to the implemented module). Use real personal/project JSONC files and fresh processes to prove persisted
  behavior. Cover missing settings, model-only and effort-only overrides, partial project overrides, explicit reset,
  malformed fields, unknown roles, unrelated settings preservation, and linked-worktree lookup.
- Run `bun scripts/run-tests.js src/shared/attached/action-content.test.ts src/shared/attached/cross-host.test.ts
src/shared/attached/role-instructions.test.ts src/attached/codex/mcp.test.ts src/attached/codex/plugin.test.ts` plus any
  new focused MCP tests. Verify all roles, activation, resumed status, and independent reviewer metadata. A pass-through
  resolver or dropped compact metadata must fail these behavioral tests.
- Preserve existing fresh-worker, reviewer coverage, host-owned execution, compatibility, resume identity, and
  no-transcript tests. No existing behavior is intentionally retired apart from the absence of role overrides.
- In an isolated fixture, exercise the source plugin with one supported explicit model/effort pair, one effort-only
  role, and one inherited role. Observe actual native spawn arguments, including the overridden Router or Planner
  handoff. Start a fresh chat/process to verify persistence; remove/reset the overrides and verify omitted arguments.
  Do not alter the user's personal model choices for this check. Report live-host evidence separately from protocol and
  guidance tests; an unavailable installed source-plugin path is a verification limitation, not a passing live check.
- Inspect docs/schema examples against the resolver and host arguments. Confirm the PRD adds the new scenarios without
  claiming an unobserved live model selection or new host compatibility qualification.

RunWield owns the full project validation after implementation; focused checks above do not replace it.

## Edge Cases & Considerations

- Changing a model while inheriting thinking effort delegates the combination to Codex; it does not promise the same
  numeric effort as the parent. Document that distinction next to the settings example.
- Personal choices apply across repositories; project `inherit` provides an explicit escape from them. Avoid modifying
  `~/.codex/config.toml`, installing generated agent files, or writing into the plugin cache.
- A host may expose different effort levels or reject a stored model later. Preserve the preference, show the reason,
  and let the user change it; do not substitute a model silently.
- The installed plugin used to run this workflow will not acquire edited source guidance automatically. Keep feature
  validation separate from claims about this coordinating chat's current worker configuration.
