---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/ui/workspace/client/"
    - "src/ui/workspace/react/"
    - "src/ui/desktop/"
    - "src/acp/"
    - "src/shared/models/"
    - "src/shared/session/model-selection.ts"
    - "src/shared/session/model-readiness.ts"
    - "src/cmd/auth/"
    - "src/ui/tui/model-setup.ts"
    - "docs/desktop-workbench-contract.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/adr/020-electron-workspace-acp-client.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-11-07"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 10
dependencies:
    - "open-projects-and-configure-providers"
    - "continue-saved-sessions-in-desktop"
    - "inspect-usage-and-control-recording-and-export"
planId: "b46f0011-81bf-4cb5-9ee7-9098b29bcb0b"
---

# Configure Model Providers in Desktop Settings

## Context

The owner deferred provider setup from [Project entry](open-projects-and-configure-providers.md). That child requires credentials and a default model configured through `wld`, like the current Workspace. The owner chose a later provider configuration section inside desktop Settings, not a terminal launcher in the entry child.

This child implements the remaining setup part of “Work locally without a Workspace account” in [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace), and “Carry the full workbench through the runtime contract” and “Distinguish authentication domains” in [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access). It restores the clean-install setup journey before packaging and release qualification.

Preserve existing credentials, global/Project settings precedence, ordinary ACP Terminal Auth, TUI setup, and Session configuration. A Workspace account is not a model-provider account. Settings reads and saved local work remain available without provider access.

### Epic Scope Changes

This new child receives provider configuration, authentication, default selection, and post-setup refresh from child 2. It runs after usage/settings and before packaging. Packaging depends on this child. Existing packaging, browser retirement, and qualification move to orders 11–13; their filenames stay stable.

## Objective

A user configures a supported model provider and selects or changes the default model from a provider section in desktop Settings. The running app sees the saved result without a global RunWield CLI, an external terminal, or a second credential store.

## Approach

Reuse Core's real provider login and model-selection logic through the semantic client and negotiated runtime operations. Settings supplies interaction controls; Core owns provider discovery, authentication, credential writes, settings precedence, and readiness. Subscription login can open the provider's browser page, but it is not Workspace sign-in.

Current evidence from child 2 planning:

- `src/cmd/auth/index.ts` has `runLoginCommand`, provider authentication, and API-key input with `persistResult: false`.
- `src/ui/tui/model-setup.ts` has `runSharedModelSetup` and a force-model-selection path. Bare setup can return immediately when a default is already available; Settings must support deliberate reconfiguration too.
- `src/shared/session/model-selection.ts` owns default writes. A new default does not change an existing Session's model.
- `getSettingsManager` and the model runtime cache configuration. Fresh setup results require Core-owned reload/refresh; a new wrapper or a success label is insufficient.
- `RunWieldModelRegistry.refresh()` currently omits the offline option. The underlying runtime supports `refresh({ allowNetwork: false })`.

Move reusable setup orchestration out of TUI/UI-owned modules where ACP needs it. Keep terminal presentation in the TUI adapter. Do not import the TUI into ACP, reproduce OAuth in Electron, or send secrets through ordinary Session questions/transcripts.

A native terminal would reuse presentation with fewer forms, but the owner's selected direction is provider configuration inside Settings. An embedded terminal emulator is not part of this child.

**Planning boundary:** this is a new draft for its later Planner pass. That pass must define supported provider-management controls, credential-input transport, cancellation, and settings scope against the code delivered by earlier children. Do not treat this draft as approval of an unexamined protocol schema or of provider deletion/logout controls.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- Shared Workspace client/React Settings and desktop composition — the provider section, progress, secret entry, cancellation, and default selection using the current design system.
- `src/acp/` — versioned setup interactions, scoped results, and configuration refresh. Advertise only implemented operations; retain ordinary external-client behavior.
- `src/cmd/auth/`, `src/ui/tui/model-setup.ts`, shared model/settings owners — reusable Core setup orchestration with TUI adapters, not a second authentication implementation.
- Existing provider/model/settings tests, new process/native tests, and isolated test inventory — real writes, refresh, and secret handling.
- Workspace/ACP PRDs, ADR-020, and contract inventory — delivered in-app setup and removal of the temporary external-setup prerequisite. Add glossary maintenance only if the later design changes a canonical term; ordinary Terminal Auth remains supported.

## Reuse Opportunities

- `runLoginCommand`, `RunWieldModelRegistry.loginProvider`, and `RunWieldCredentialStore` — provider authentication and canonical credentials.
- `runSharedModelSetup`, `setDefaultModelSelection`, and layered settings — selection policy and actual persistence.
- Existing semantic client, Project admission, sandboxed bridge, Settings composition, and design-system controls from prior children.
- `terminal-auth-setup.test.ts`, `cmd/auth/index.test.ts`, model-registry tests, and real-process/native fixtures — preserve existing behavior while adding the Settings path.

## Implementation Steps

1. Settings has a functional provider section showing available configuration and effective default without returning secrets. Missing configuration has an actionable setup route; existing valid configuration can be changed deliberately.
2. Core owns the supported provider authentication and default-selection flow behind the negotiated runtime boundary. Shared orchestration has no TUI/Workspace-server dependency; existing terminal and ordinary ACP behavior remain intact.
3. Credential entry is write-only at the product boundary. Secrets are not stored in renderer preferences, logs, Session history, generic interaction transcripts, or read responses. Subscription/browser callback flows retain provider identity and setup-attempt binding.
4. Cancel, decline, failed authentication, and unavailable providers settle truthfully. Canceling model selection after credentials are saved does not claim that nothing was saved or that a usable default exists. Setup creates no coding Session.
5. The already-running ACP process reloads canonical settings/model state after setup. Readiness distinguishes configured state from verified provider health; passive reads do not require a network request. Existing Session model choices and Project overrides stay intact.
6. A clean source app with no provider can configure one in Settings and complete a real Session through its managed runtime, without shell-installed `wld`. Existing users reuse the same canonical credentials without importing them.
7. Owning requirements, scenarios, ADR references, and contract rows match delivered behavior. The temporary external `wld` setup prerequisite is removed from current desktop guidance; installer/platform qualification remains with later children.

## Approval Confirmation

No Work Records are proposed for supersession. The in-app Settings direction comes from the owner's child 2 review. Remaining protocol, control-scope, and verification details are for this child's Planner before approval.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Preserve `bun scripts/run-tests.js src/ui/tui/terminal-auth-setup.test.ts src/cmd/auth/index.test.ts src/shared/models/model-registry.test.ts src/shared/models/model-login.test.ts src/shared/settings.test.ts` and the existing desktop check/test gates. The later Planner must name exact new setup process/native tests.
- Start the real ACP process before setup. Through Settings, save a provider and select a default. Inspect canonical state and the next controlled-provider request; the same process must use the new choice. Repeat when a valid default already exists and with a Project override/linked worktree. A stubbed success, unchanged model, or runtime restart must fail.
- Exercise API-key and supported subscription setup, cancellation before and after credential persistence, authentication failure, expired/stale setup replies, provider outage, and duplicate submission. Prove that setup does not create a Session or overwrite unrelated configuration.
- Use sentinel secrets and inspect read responses, logs, renderer persistence, and canonical Session transcripts. Preserve credential secrecy and actual settings/credential writes through real Core owners, not replacement callbacks.
- Headed native verification uses `bun run desktop:dev` at `runwield://app/`, with no HTTP dev server. Open Settings, configure a provider, choose/change the default, cancel/retry, and complete a model turn. Record a separately configured real-provider check without capturing secrets. Confirm Project/settings/history browsing remains usable without provider or Workspace cloud connectivity.
- Preserve existing TUI setup, ordinary ACP Terminal Auth, global/Project precedence, active Session model selection, and child 1 interaction/streaming behavior after extraction.
- Run `bun run seams:check` and `bun run doc-links:check`; inspect resolved dependencies and synchronized requirements. Passing source checks do not qualify an installed platform.

## Edge Cases & Considerations

- External CLI providers can need their own installation/sign-in. No separate RunWield CLI is required; this does not promise that all third-party tools are bundled.
- Core currently serializes credential mutations in-process and writes a whole credential file. Investigate concurrent login/token-refresh writers before adding setup mutations; preserve unrelated credentials through the authoritative owner.
- Provider credentials, future Workspace identity, and remote-host trust remain separate. No mock account controls or new cloud service belongs here.
- A Settings label or cached model list is not readiness authority. Core must reload canonical facts after setup.
- Test home/cwd isolation and the zero-seam baseline remain mandatory. UI transport adapters are real product boundaries, not permission to replace Core writes or authentication policy in tests.
