---
planId: "ad8b3586-b7e9-4b1e-b7fa-c132f48a3ad8"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/"
    - "src/attached/"
    - "src/cmd/attached/"
    - "config.schema.json"
    - "docs/adr/013-attached-workflow-coordination-boundary.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/user-documentation/connect-claude-code.md"
    - "docs/user-documentation/connect-codex.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-12"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
validatedCommit: "596f9b08373341fe46a0e49d632d204a535b96ae"
workRecord:
    status: "generated"
    recordId: "04ef5736-a942-4145-8542-b1aa8d7742b9"
    path: "docs/work-records/2026-11-15-ideator-and-guide-conversations-in-connect.md"
    lastAttemptAt: "2026-11-15T03:49:26.491Z"
---

# Ideator and Guide in Connect

## Context

The user wants Ideator and Guide in the Claude Code and Codex Connect plugins. The owner confirmed both normal Router routing and dedicated commands. The owner does not need Connect resume for these roles: the host owns the conversation.

Core already defines both roles:

- **Ideator** explores product intent, tests assumptions, researches, and writes a PRD when asked.
- **Guide** answers questions from project evidence. It can preserve an explanation as ordinary Markdown when asked. It is not Guided Review.

Connect currently exposes neither role. `triageReport` in `src/shared/attached/coordinator.ts` accepts `PLANNED_CHANGE` for planning and returns other Routing Intents to the host as unsupported. `resolveAttachedRoleInstructions` loads current layered Agent Definitions and Skills for the supported roles. The plugins do not carry copies of those role definitions.

Owning requirements:

- [Connect: Explicit per-request activation](../prd/runwield-connect-prd.md#explicit-per-request-activation): extend explicit activation to these roles; preserve ordinary host behavior outside activation and host-native naming.
- [Connect: Host-owned reasoning](../prd/runwield-connect-prd.md#host-owned-reasoning): preserve host model access, current role overrides, and effective Skills. Define dispatch behavior for the new roles.
- [Connect: Compatibility and honest availability](../prd/runwield-connect-prd.md#compatibility-and-honest-availability): document supported entrypoints and actual acceptance evidence.
- [Core: Request routing](../prd/runwield-core-prd.md#request-routing): reuse the meanings of `INQUIRY` and `IDEATION`; do not redefine the roles for Connect.

These are proposed additions, not claims of current support. Existing planning, review, execution, validation, and publication behavior must survive.

## Objective

Users can explore an idea with Ideator or ask Guide a question inside either Connect host. The host keeps the conversation and makes every model call. Neither role starts implementation or requires a Plan just to have a conversation.

## Approach

**Owner decision: support both entry paths.** The normal request command keeps Router and adds `IDEATION → ideator` and `INQUIRY → guide`. Dedicated `ideator` and `guide` commands select the named role without another classification step. Both paths use the same effective role instructions.

```text
normal request → Router → IDEATION → Ideator
                        → INQUIRY  → Guide
dedicated command ─────────────────→ selected role
```

**Owner decision: no Connect conversation resume.** Conversations continue in Claude or Codex. A fresh conversation uses the host's own resume or saved documents; Core does not recreate the discussion. Do not add conversational states, turn storage, a completion tool, or a new Session.

### Shared role entry

Add a stateless `get_role_instructions` operation restricted to `ideator | guide`. It accepts the role and transport-supplied host evidence, not workflow IDs, action IDs, request text, or conversation history. It returns versioned `AttachedRoleInstructions`, including current Codex dispatch preferences when applicable. Use a distinct success result without weakening the existing lifecycle result's required workflow.

The operation reuses `resolveAttachedRoleInstructions`, `loadAgentDef`, and `listVisibleSkillCatalog`. It performs compatibility checks but no workflow lookup, record write, Plan preparation, or review hosting. CLI and MCP expose the same operation. Keep the existing action-bound `get_instructions` contract unchanged.

Both dedicated commands and Router handoffs call this operation. This keeps prompt and Skill resolution in one place. The source entrypoints are `/runwield:ideator`, `/runwield:guide`, `$runwield:ideator`, and `$runwield:guide`; distribution uses its existing `wld` namespace.

### Router handoff

`triageReport` maps `IDEATION` and `INQUIRY` to a new `role_handoff` result. It closes only that routing record, clears its pending action, and records the selected role in the closure. `nextActionFor` and compact presentation expose `kind: role_handoff` and the selected role. The plugin fetches the role instructions and continues the original request in the host.

A handoff is not a completed answer or confirmed publication. No worker completion report is required. Existing operation receipts, revision checks, and locks still protect Triage. Retrying the same operation does not create another record. Instruction text and dispatch preferences are fetched fresh, not saved in the handoff receipt.

This uses the existing closed-record exclusion in `loadLatestAttachedWorkflowRecord`. After handoff, a Guide question cannot displace an older open delivery workflow in ordinary Connect resume. An explicit status read of the closed routing record can explain its handoff; it does not resume the conversation.

The rejected alternative was an open conversational action with Core-owned resume and completion. The owner does not need it, and it would make casual questions participate in delivery resume selection.

### Role behavior and host tools

Use a conversational addendum instead of `ENVELOPE_ADDENDUM`. Preserve research, questioning, citations, requested PRD synthesis, and requested ordinary Markdown preservation. Guide is read-mostly, not universally read-only. Its boundaries are instructions, not a host sandbox.

Host-native file, search, web, delegation, and question tools provide the existing Connect equivalents. Read Work Records as project artifacts when no retrieval tool exists, preserving their status and notices. Use an already available host/MCP Memory or image capability only when it provides the requested function; otherwise state the limit when relevant. No new Memory, image, or artifact-registration bridge is part of this change. A saved PRD is reported with its path; do not claim Core artifact registration or Memory persistence that did not occur.

Override Core-only `/agent` handoffs and `artifact_written` requirements, including those in loaded document formats. Offer the actual Connect entrypoint for a supported role. For an unsupported role, explain that limit rather than invoking a nonexistent command. Do not copy or weaken the shared Agent Definitions to achieve this adaptation.

### Dispatch and planning handoff

**Reviewable assumption from the existing settings contract:** add Ideator and Guide to the existing Codex per-role preferences. With both fields inherited, converse in the current host context. With an explicit model or thinking level, use the established fresh-worker dispatch. Give it the current user request, working directory, and relevant artifact references; it fetches its own `get_role_instructions`. Relay subsequent questions and answers to that worker without saving them in Core. Do not restart it for every reply. Missing host controls stop the dispatch with a clear diagnostic, not silent substitution. No Core worker-resume record is introduced.

Only an explicit user request starts planning. Use a new normal Connect request with the agreed task and relevant artifact references, then retain Router, `start_planning`, Plan review, and execution gates. Do not pass an `INQUIRY` or `IDEATION` outcome directly to `plan_written`, and do not copy the host transcript into activation.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/attached/role-instructions.ts` — resolve the two roles with conversation-specific instructions, not delivery instructions.
- `src/shared/attached/operations.ts`, `coordinator.ts`, and `presentation.ts` — define the stateless operation, typed results, and closed Router handoff; keep lifecycle authority in Core.
- `src/shared/attached/codex-role-settings.ts`, `hosts.ts`, and `config.schema.json` — extend existing role preferences and host-native handoff names. Preserve field-level inheritance.
- `src/attached/mcp.ts` and `src/cmd/attached/` — carry the new shared operation without requiring workflow fields or adding transport policy.
- `src/attached/claude/plugin/commands/` — add `ideator.md` and `guide.md`; make `request.md` handle the Router handoff.
- `src/attached/codex/plugin/skills/` — add explicit `ideator` and `guide` entry Skills; teach `run` to handle the same handoff. Keep `allow_implicit_invocation: false` for the new Skills.
- Attached role, coordinator, status, presentation, Codex settings, CLI, MCP, and package tests — prove both entries and unchanged delivery behavior. Add new test files to the explicit runner inventory where required.
- `docs/prd/runwield-connect-prd.md` and both Connect user guides — add the role journeys, settings, no-resume boundary, tool limits, and acceptance evidence.
- `docs/adr/013-attached-workflow-coordination-boundary.md` — extend the accepted boundary to stateless role instructions and distinguish a closed routing handoff from delivery completion.
- `docs/domain-language.md` — let Attached Role Instructions describe either a pending workflow action or explicit conversational entry. Preserve existing Guide and Ideator meanings and distinguish them from Guided Review.

No new host, browser UI, model provider, or general-purpose Agent switcher is requested. Source plugins use the `runwield` namespace; the Connect PRD describes distributed `wld` packages. Preserve that distinction and check packaging rather than renaming unrelated commands.

## Reuse Opportunities

- `loadAgentDef` and `listVisibleSkillCatalog`, already used in `role-instructions.ts` — retain project, home, and bundled resolution without static prompt copies.
- `ATTACHED_OPERATIONS` and `runAttachedOperation` — keep the CLI and MCP contracts aligned.
- `src/attached/mcp.ts` — keep transport-owned host evidence and compatibility checks.
- Existing role instruction and MCP fixtures — exercise real temporary project and home files without new injection seams.
- Existing Core Ideator and Guide definitions — preserve product behavior instead of making reduced Connect variants.

## Implementation Steps

1. `operations.ts` defines a strict `get_role_instructions` schema and parser accepting only `ideator | guide` and host evidence. `runAttachedOperation` returns a separate typed role-read result through CLI and MCP, with current instructions and no workflow identity. Bad roles, extra request/history fields, and incompatible evidence fail before writes. Existing action-bound reads retain their identity checks.
2. `triageReport` closes `IDEATION` and `INQUIRY` routing records with `role_handoff` and the correct role. `nextActionFor` and `compactAction` preserve that supported handoff. `PLANNED_CHANGE` still reaches Planner; other unsupported intents retain their existing behavior. Handoff receipts contain no prompt text, transcript, or frozen dispatch settings. Replay and stale-operation checks remain effective.
3. `resolveAttachedRoleInstructions` resolves both roles through real Agent and Skill loaders. A conversational addendum replaces delivery instructions and adapts unavailable tools, document registration, and `/agent` commands as specified above. Guide preserves requested ordinary Markdown and evidence rules; Ideator preserves its interview and requested PRD behavior. Neither role submits a Plan or starts execution automatically.
4. Both host packages expose dedicated commands and consume Router `role_handoff` by calling the same stateless operation. They retain the user's current request in host context, continue questions across turns, and use a fresh normal planning request only after the user asks. Commands remain explicit-only and carry no copied role definitions. Package descriptions expose the new capabilities rather than claiming FEATURE-only scope. Unknown tools or role contracts produce actionable Core/plugin update guidance.
5. `ATTACHED_HOST_ROLES`, `config.schema.json`, and existing settings resolution accept Ideator and Guide preferences. Both entry paths receive current Codex model/effort values with existing per-field inheritance. Claude receives no Codex dispatch metadata. Codex guidance applies explicit controls through a fresh worker, relays subsequent turns to that worker, and never silently ignores an invalid or unsupported preference.
6. Behavioral tests through real coordinator storage and both MCP adapters prove routing, direct entry, fresh overrides, compatibility, privacy, replay, and preservation of open delivery work. Existing coverage of delivery and action-bound reads remains. Register new test files in `scripts/bun-test-files.json` if the runner requires it.
7. The Connect PRD adds named requirements and scenarios for both entry paths and host-owned continuation. Its host-reasoning and Codex-preference requirements cover the new roles without claiming unavailable tool parity. Both user guides, ADR-013, and the Attached Role Instructions glossary relationship match the implementation. Update affected references in the same change; do not rewrite unrelated documents or expand historical acceptance claims.

## Approval Confirmation

No Work Records are proposed for supersession.

## Verification Plan

### Automated

Use Bun 1.4.3 and run `bun run install:locked` before checks. Extend the existing behavioral test homes; use the isolated runner, not `bun test`:

```sh
bun scripts/run-tests.ts src/shared/attached/role-instructions.test.ts src/shared/attached/coordinator.test.ts src/shared/attached/status-restore.test.ts src/shared/attached/presentation.test.ts src/shared/attached/action-content.test.ts src/shared/attached/codex-role-settings.test.ts src/shared/attached/codex-dispatch.test.ts
bun scripts/run-tests.ts src/cmd/attached/index.test.ts src/attached/claude/mcp.test.ts src/attached/claude/execution-plugin.test.ts src/attached/codex/mcp.test.ts src/attached/codex/plugin.test.ts
```

Run any new test files through `bun scripts/run-tests.ts <new-test-paths>` as well. Use temporary projects and disposable home directories with real internal collaborators. Respect the process-global lock for HOME/cwd changes; add no test-only injection seam.

- **Correct role, both entries:** through each real MCP adapter, activate Router and submit each outcome. Assert a closed `role_handoff` with the correct role, not an unsupported return. Call `get_role_instructions` as the host must, then repeat direct entry without activation. Assert role identity, versioned contract, and substantive role policy in all four role/host combinations.
- **Live resolution:** use project/home Agent and Skill fixtures with distinctive content. Change the override between reads and assert the next response contains the replacement. Check shared practice and actual bundled role content as well. Static copied prompts, swapped roles, placeholders, and generic handbacks must fail these checks.
- **No conversation authority:** direct reads create no record or repository setup. An unbound routed request leaves only its existing Triage record, now closed with no pending action or Plan. For an explicitly bound existing Plan, preserve its reference and prove that its document and lifecycle are unchanged. Compare stored bytes to confirm no role prompt, dispatch metadata, or later conversation was saved. A repeated accepted Triage call keeps the same revision and record identity.
- **Open delivery survives:** prepare an older open planning/delivery workflow, then exercise a newer routed conversation and both direct entries. Repository-scoped `status` still selects the older open workflow with unchanged Plan, revision, and action. An explicit read of the closed routing record reports the handoff, not delivery or conversational resume.
- **Rejected calls stay inert:** reject arbitrary roles, unsupported host evidence, malformed arguments, and transcript/request fields. Assert no new record/setup and no mutation of existing work. Preserve stale revision/action rejection and `get_instructions` action checks.
- **Settings:** each new role resolves personal/project fields and explicit `inherit` correctly through the stateless operation. Changed settings affect the next read. Invalid settings yield dispatch diagnostics; Claude responses omit Codex preferences. Neither reads nor replay save preferences into workflow records.
- **Existing contracts:** retain tests for `PLANNED_CHANGE`, remaining unsupported routes, planning preparation, review feedback, execution, validation, privacy, and recovery. Only the old assertion that `INQUIRY` and `IDEATION` are unsupported should stop existing. Package checks prove entrypoint discovery, explicit-only invocation, and both action handlers; text checks alone do not prove conversation behavior.

### Host acceptance and semantic review

- In **each host**, invoke the normal request command with an inquiry and with an idea. Confirm Router selects Guide and Ideator. Repeat through each dedicated command and confirm it does not run Router or create a delivery workflow. For all eight host × role × entry-path combinations, require an actual answer or interview question and a relevant response to the next user reply. An “instructions loaded” acknowledgement does not pass.
- Guide answers a known repository question with accurate artifact citations. Ask a follow-up, then request an ordinary Markdown explanation. Confirm no unsolicited files, Plan, commit, or implementation. If image capability is absent, a request receives an honest limitation rather than a false file claim.
- Ideator explores a vague idea across at least two user replies. It writes a PRD only when asked, follows the loaded document format, and reports the file without claiming unavailable artifact registration or Memory writes. Saving the PRD does not start planning. An explicit request to plan then uses normal Router/Planner preparation and review.
- In Codex, exercise both inherited dispatch and an explicit model/effort preference. Observe native spawn arguments, worker question → user answer → continuation in the same worker. An unavailable control must stop with a clear message. Do not claim sustained worker dialogue from a spawn-only probe.
- Keep another delivery workflow open while asking Guide a question. Connect resume must still restore delivery; use host resume for the conversation. No conversation completion operation or Core Session should exist.
- Inspect effective prompts for contradictory lifecycle/registration instructions, incorrect role write boundaries, and invented host commands. Check the PRD, glossary, ADR, and guides against implemented behavior and actual command namespaces.
- Record live host/version evidence and any unavailable acceptance lane honestly. Existing historical evidence does not prove these new journeys; blocked live acceptance remains an explicit verification gap.

## Edge Cases & Considerations

- **No resume means no recovery promise for discussion:** a lost host chat is restored by the host, not Core. A failed stateless instruction read can be retried; a routed handoff receipt is not conversation storage.
- **Compatibility:** retain the existing compatibility checks and versioned role contracts. New commands require an updated Core and plugin. Updated guidance stops on a missing operation or unknown role contract with an update message; it does not fall back to implementation. Do not advertise the new roles for older plugin packages. Preserve existing delivery contracts, saved records, and historical acceptance evidence.
- **Prompt boundaries are not permissions:** the host retains its tool permissions. Do not advertise Guide as a sandbox or add hooks that restrict ordinary host work.
- **Bound Plan:** a routing request already tied to a Plan can hand off conversationally without editing or advancing that Plan. Dedicated role reads do not accept an existing Plan selection.
- **Publication is unchanged:** closing the routing record means only that reasoning was handed to the host. It is not delivery completion, validation, or a Work Record event. Requested PRD/Markdown writes use the host's normal permissions and do not authorize an automatic commit.
- **Scope:** only Claude Code and Codex are included. No new host, settings UI, general Agent switcher, conversational persistence, or Core tool bridge is introduced. Distributed marketplace publication remains the existing release process, not a second repository task in this Plan.
