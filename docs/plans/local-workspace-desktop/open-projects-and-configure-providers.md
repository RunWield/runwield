---
planId: "99e4b90d-f981-4033-b7eb-7761e7a50116"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/ui/desktop/"
    - "src/acp/"
    - "src/shared/owner-coordination/"
    - "src/ui/workspace/client/"
    - "src/ui/workspace/react/"
    - "src/ui/workspace/server/owner-projects.ts"
    - "src/ui/workspace/islands/ProjectRootForm.tsx"
    - "docs/desktop-workbench-contract.md"
    - "docs/adr/020-electron-workspace-acp-client.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:33.113Z"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 2
dependencies:
    - "run-a-real-session-in-electron"
targetBranch: "epic/local-workspace-desktop"
userVerifiedAt: null
validatedCommit: "f7a2a68405365ce7613762032cb35131920f6e10"
status: "verified"
---

# Open Projects and Reuse Provider Configuration

## Context

The first desktop child delivered a real Session through a separate runtime. It still requires an absolute `--project` argument and an already configured provider. This child adds Project entry and management. Per the owner's review decision, model work continues to require provider credentials and a default model configured through `wld`, as with the current Workspace. In-app provider configuration belongs to a later child.

**Requirement changes:** partly implement “Work locally without a Workspace account” and “The installed app owns the workbench” in [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace). Implement Project admission and reuse of existing provider settings under “Carry the full workbench through the runtime contract,” “Prefer standard ACP and negotiate the remainder,” and “Distinguish authentication domains” in [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access).

**Preserve:** [Project access and navigation](../../prd/runwield-workspace-prd.md#project-access-and-navigation), including home/system-root confirmation, missing-root management, reversible disable, removal without data deletion, and request-failure recovery. Preserve layered settings, ordinary external ACP clients, and child 1's streaming, questions, Stop, close, and known-ID reload behavior. No existing capability is removed.

This remains a source-development slice. Installers and clean-machine release qualification belong to the [packaging](install-and-update-the-bundled-application.md) and [qualification](qualify-and-release-desktop-on-three-platforms.md) children. Accepted [ADR-020](../../adr/020-electron-workspace-acp-client.md), not the parent's older browser-adapter proposal, owns the process boundary. The old browser workbench stays operational and is not migrated to ACP.

### Epic Scope Changes

- [Continue Saved Sessions in Desktop](continue-saved-sessions-in-desktop.md) owns the Archived Sessions settings tab, paged listing, open, and Unarchive together with its existing archive/continuation scope. This removes the duplicate archived-Session work from this child. Project registration, full Session rescan, and reuse of existing provider configuration stay here.
- The same Session child owns provider-independent saved-history reading. Its read path must not require `session/load` to succeed with a runnable model. This child keeps Project listing/settings available without credentials; it does not add a temporary private history API ahead of child 3.
- New draft [Configure Model Providers in Desktop Settings](configure-model-providers-in-desktop-settings.md) owns the provider configuration section, authentication, default selection, and fresh readiness after setup. It runs after usage/settings and before packaging. Packaging now depends on it; packaging, retirement, and qualification move to orders 11–13 without filename changes.
- No feature work moves into packaging or supervisor recovery. This child needs explicit Project selection on one runtime connection; concurrent Session views and window lifetime remain later work.

## Objective

The app opens without a Project argument. The user selects an existing directory with a native picker, completes Core's registration checks, manages registered Projects, and reuses provider credentials/defaults already configured through `wld`. No Workspace account is required. Desktop still launches its explicit managed runtime, not a PATH-selected `wld`.

Missing provider configuration does not gate Project listing or settings. Saved-history reading without provider access belongs to child 3 with Session discovery; Plan and knowledge browsing remain children 5 and 8. The Epic retains the full saved-work browsing requirement.

## Approach

Keep Project and provider decisions in Core. Extend the existing persistent ACP connection rather than adding a second runtime or importing the browser server into Electron.

```text
Shared Project/settings UI
  semantic Workspace client -> validated preload/main
    persistent ACP connection
      shared Project registration + directory policy
      existing Session readiness + provider configuration
Native picker -> candidate directory only
```

### Project entry and admission

The app opens on Projects, with **Open Project** as the main action. The native picker returns one directory. Show that path and an optional display name before **Link Project**; cancellation changes nothing. Reuse the compact dark design system, root form, and confirmation dialog. Do not add a new onboarding wizard.

Project rows show name, root label, enabled state, and health. Each has Open and Settings. Settings remains available for missing or disabled roots and offers Relink, Enable/Disable, Full Session rescan, and Remove. Removal states that files and saved Sessions stay intact. Pending/error feedback stays beside the action, preserves inputs, and permits explicit retry. Do not add inactive tabs for later children.

Add version 1 Project capability metadata under `dev.runwield/workspace`. Proposed methods use `_dev.runwield/workspace/projects/{list,open,register,relink,setEnabled,remove,rescan}`. Document exact schemas in the contract inventory before implementation. Use named DTOs, bounds, and structured error codes; do not expose a generic action or arbitrary RPC bridge.

Desktop opts into Workspace admission during initialization. Core returns a connection identity. Workspace Session requests carry that identity plus registration ID and canonical root in `_meta`; new/load also retain standard ACP `cwd`. Core checks their agreement and enabled-root health before effects. A negotiated Workspace connection cannot omit metadata to fall back to unrestricted ordinary ACP. Session records retain their admitted Project binding for later requests. Stop/close can still settle owned work after access is withdrawn; access changes do not strand a running turn.

Ordinary ACP clients keep existing cwd-based access without a Workspace registration. The extension is not a new remote authentication scheme. Management uses registration identity, so missing-root settings do not accidentally require content admission. `projects/open` checks enabled-root health and returns the admitted registration/root context used by the client; it neither starts a Session nor trusts a cached path from the Project list. `ensureRuntimeProject` is not a substitute for registered-Project admission.

The optional development `--project` argument becomes a candidate to open through the same checks, not authorization. One runtime can address multiple registrations. Preserve the current single open Session view: selecting another Project must not silently close, move, or replay it. Settings can open without changing its binding; the user explicitly closes it before opening another Session.

### Provider setup decision

**Owner decision:** keep provider setup as an external `wld` prerequisite for now, like the current Workspace. A later child adds provider configuration inside desktop Settings. This child adds no terminal launcher, credential form, authentication RPC, default-model editor, or setup completion state.

Existing Core settings and credentials are read in place. Preserve global/Project precedence and linked-worktree settings. If Session creation cannot use the selected default, show Core's specific prerequisite and explain that the user must configure it with `wld` before model work. The supported first-run command is `wld login`; restarting desktop after external configuration is acceptable in this slice. Do not implement refresh/reconnect machinery just for this temporary journey.

A stored credential is not proof of provider health. Invalid credentials, network outages, or missing optional provider CLIs retain their actual error. None means the user needs a Workspace account. Project management stays available without provider access or Workspace cloud services.

Keep credentials in Core's canonical store. No credentials enter renderer views, IPC, browser storage, or app logs. The later Settings child restores the Epic's clean-install setup journey without a separately installed CLI.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/desktop/`, `scripts/desktop-dev.ts`, and desktop tests — no-argument entry, native picker, and validated Project operations. Existing sandbox, sender/origin checks, and CSP stay intact.
- `src/ui/workspace/client/`, `react/`, and `islands/ProjectRootForm.tsx` — shared Project/settings presentation and semantic operations. Keep HTTP/CSRF/navigation in the browser adapter, not in reusable controls.
- `src/acp/server.js`, `client/workspace-session-client.ts`, and new typed Workspace contract/handler files — one negotiated connection, Project admission on standard Session methods and structured refusals, including useful existing provider-prerequisite errors.
- `src/shared/owner-coordination/` and `src/ui/workspace/server/owner-projects.ts` — move shared Project view/membership policy to Core and preserve browser callers. Existing registration transactions remain the owner; no new registration database.
- `docs/desktop-workbench-contract.md`, Workspace/ACP PRDs, and ADR-020 — exact Project contracts, source-development evidence, and the deferred Settings setup owner. ADR-020's runtime boundary stays intact. No new domain term or glossary definition is needed.
- `scripts/bun-test-files.json` and desktop check/test scripts — include new process/native tests and retain resolved dependency checks.

Provider setup/default editing, Session discovery, archived-history UI, Plan stores, browser retirement, installer tooling, remote access, and hosted identity remain with their assigned children.

## Reuse Opportunities

- `projects.ts`: `registerProject`, `relinkProject`, `setProjectEnabled`, `removeProject`, and `requireEnabledProjectRoot`; `project-directory.ts`: canonical inspection and bound confirmation tokens.
- `openOwnerCoordinationStore` and `catalogProjectSessions(..., { fullRescan: true })` — existing registration and Session catalog, not renderer scans.
- `serializeOwnerProject` and `sessionBelongsToOwnerProject` — move their actual policy to a shared owner. A temporary browser re-export may preserve callers; a re-export from Core back into UI is not extraction.
- `ProjectRootForm`, `RunWieldConfirmationDialog`, shared primitives, and design-system tokens — preserve form behavior and accessible Continue/Quit confirmation.
- `createInitializeResponse`, `getSelectedDefaultModelAvailability`, and existing Session errors — negotiate Project access and explain missing provider/default prerequisites without adding a setup protocol.
- `makeSessionProcessFixture`, `launchDesktop`, real Git fixtures, and canonical stores — real subprocess/native tests without substituting RunWield-owned decisions.

## Implementation Steps

1. Shared Core Project view/access code owns the current serialization, health redaction, membership checks, and registration access rules. Browser adapters use that owner and preserve authentication, CSRF, HTTP status/header behavior, and confirmation responses. ACP and desktop have no executable import path to Workspace server modules. Registration, relink, and removal still use the existing store transactions.

2. The runtime implements and advertises the version 1 Project group and handles the listed operations with validated payloads and structured results. Project list works with no registered Project or model. Open returns a checked Project context without Session creation. Register/relink return bound confirmation-required results before writes; retries re-inspect the root. Disabled/missing roots remain manageable. Rescan requires enabled, healthy access and returns sanitized diagnostics. Repeated register resolves canonical aliases; removal leaves files and saved Sessions intact.

3. Workspace negotiation fixes admission policy for the connection. New/load and subsequent Session mutations reject absent, stale, foreign, disabled, or mismatched connection/Project/root bindings before effects. Load checks saved Session membership, not just request cwd. Stop/close retain safe settlement access to the connection's own Session. Non-Workspace ACP clients retain existing behavior. Unsupported extension versions fail visibly before dependent mutations, without a legacy fallback.

4. The semantic client and preload expose only named Project and selection operations. One persistent connection serves them and existing Session calls. Main validates sender, frame/origin, payload bounds, and context on every operation. The no-argument launcher opens Projects; `--project` only supplies a candidate. Picker cancellation makes no runtime registration request. Project changes cannot retarget an open Session or its pending question.

5. Shared UI implements the entry/settings layout in Approach, including health, missing/disabled management, optional name, native pick/relink, confirmation, pending/failure/retry, rescan diagnostics, and removal confirmation. Core's home/system warning uses the existing dialog: initial Quit focus, focus containment, Escape cancellation, and focus return. The browser root form keeps its current HTTP behavior through its adapter. No placeholder Archive, cloud, remote, or subscription controls appear.

6. Existing provider credentials and layered defaults are reused directly. Missing configuration produces a specific Core prerequisite and guidance to configure `wld` outside the app, then restart desktop. No login launcher, credential input, provider-settings page, readiness-refresh API, or default mutation is introduced. Project management stays available with no provider or Workspace connectivity. Provider outages remain real provider errors, not account-sign-in prompts.

7. Focused process and native tests prove the behavior below and enter the isolated inventory. Child 1 tests use registered fixtures where desktop now requires them; they retain streaming, exact form answers, cancellation, committed history, and security assertions. Tests for ordinary external ACP remain registration-free. No Core-owned injection seam replaces admission or persistence.

8. Owning Workspace/ACP capabilities and the contract inventory distinguish delivered Project entry/configuration reuse from deferred provider Settings, saved-history, full-workbench, and release targets. Update the inventory delivery map for the new Settings child and shifted packaging/retirement/qualification order. ADR-020 retains the full clean-install target and accepted Project-context boundary; do not replace that target with the temporary external-setup prerequisite. No new domain term or public Workspace redefinition is introduced.

## Approval Confirmation

No Work Records are proposed for supersession. The owner chose existing `wld` provider setup as this child's prerequisite and deferred in-app provider configuration to a later Settings child. The existing design system and Project management behavior remain the visual and interaction baseline.

## Verification Plan

### Automated

Use Bun 1.4.3 and `bun run install:locked` before checks. The two entry test files below are planned outputs; the other commands and paths exist.

```sh
bun run desktop:setup
bun run desktop:check
bun run desktop:build
bun scripts/run-tests.js src/acp/workspace-entry.process.test.ts src/ui/desktop/desktop-entry.integration.test.ts
bun run desktop:test
bun scripts/run-tests.js src/shared/owner-coordination/projects.test.ts src/shared/project-directory.test.ts src/shared/owner-coordination/file-session-bridge.test.ts
bun scripts/run-tests.js src/ui/workspace/owner-workspace.test.js src/ui/workspace/owner-session-http.test.ts src/ui/workspace/project-root-form.test.tsx src/ui/workspace/project-page-requests.test.ts src/ui/workspace/project-request-headers.test.ts
bun scripts/run-tests.js src/acp/server.test.js src/acp/client/workspace-session-client.test.ts src/acp/client/workspace-session-client.process.test.ts src/ui/workspace/session-client-surface.test.tsx
bun run seams:check
bun run doc-links:check
```

Add these discriminating checks:

1. **Runtime admission, not client-only validation.** Send raw ACP requests to a real source subprocess. An opted-in Workspace connection refuses unregistered roots, missing metadata, wrong connection IDs, wrong registration/root pairs, foreign saved Sessions, and disabled/removed/relinked roots before Session creation or provider requests. Inspect canonical stores and controlled-provider request counts. Removing the server check must fail these tests even if main still validates. A separate ordinary ACP connection still creates/loads without registration.
2. **Canonical Project effects.** Through the real extension, register a directory and symlink alias once; exercise confirmation with zero writes before consent, changed-path/stale-token refusal, relink conflicts, missing-root settings, disable/enable, rescan, and removal. Assert actual store rows/root evidence. Snapshot repository files and saved Session IDs/content before removal and compare afterwards; re-add yields a new registration, not lost history. Preserve health and error redaction.
3. **Existing provider configuration.** Start with canonical credentials/defaults and prove a controlled-provider Session request uses them without imports or rewritten settings. Repeat with a Project override and linked worktree. Start a fresh app with no usable default: New Session reports the real prerequisite, makes no provider request or false Session success, and leaves Project settings usable. After external fixture configuration and app restart, model work succeeds. A constant-ready response or second desktop credential store must fail.
4. **Host boundary.** Put a failing/trap `wld` on PATH and prove desktop's runtime still comes from its trusted explicit launcher descriptor. Test canceled picker, repeated clicks, malformed/stale renderer payloads, and candidate paths with spaces/metacharacters. Picker cancellation makes no registration write. Do not add any terminal-launch or credential-writing channel.
5. **Native entry.** Launch the built Electron app with no Project argument and a private empty HOME. Native UI controls reach a real ACP runtime/store for register, settings, relink, disable, remove, and rescan. Test retry after request failure without lost inputs or automatic navigation. Inspect DOM, local/session storage, IPC views, and captured app logs for sentinel credentials. Retain child 1 security tests and test each new privileged channel with invalid callers/payloads. A mocked list or disconnected button cannot satisfy the store assertions.
6. **Module ownership.** Extend resolved dependency checks so ACP/shared Core cannot import Workspace server code through direct imports, barrels, or dynamic imports. Keep renderer/main dependency prohibitions and negative fixtures. Inspection must show the shared Project policies actually moved, not a Core re-export of UI code.

Existing tests may change imports and desktop fixture admission. They must retain registration transactions, confirmation binding, browser auth/CSRF/header handling, no-data-deletion, Session replay/streaming, exact answers, Stop/close settlement, and renderer isolation. The only behavior intentionally removed is desktop's launch-path bypass of Workspace registration; ordinary external ACP access does not change.

### Headed desktop checks

Development command: `bun run desktop:dev` after this change; `bun run desktop:dev -- --project /absolute/project` remains optional. Origin: `runwield://app/`. This is a native app with no HTTP dev server or HMR. Use the existing explicit `--cdp-port 9222` option only for inspection. Missing native prerequisites are reported failures, not browser-only substitutes.

- At 1440×900 and 900×900, open with a disposable empty home. Cancel the native picker, then choose an ordinary directory and link it. Confirm keyboard access, pending/error feedback, no horizontal overflow, and clear Project identity. Check the home/system warning: Quit first, Tab containment, Escape, preserved path, and focus return.
- Make a registered directory unavailable. Open its settings, relink, disable/re-enable, rescan, remove, and re-add. Inspect canonical files to confirm that management did not delete work. While a Session is open, visit settings and attempt Project switching; no request or pending answer changes Project silently.
- With a provider already configured through Core, open a registered Project and complete a real model turn. Confirm the same credentials/defaults are used without an import step. With an empty configuration, attempt New Session and check the external `wld` setup guidance; no in-app login or placeholder provider section appears. Configure the disposable home externally, restart desktop, and verify a successful turn.
- Test invalid provider access and a provider outage. Projects and their settings remain usable with Workspace cloud endpoints unavailable. Provider errors do not request Workspace sign-in or claim successful authentication.
- Inspect native screenshots, accessibility/focus behavior, and renderer console errors in one bounded pass; fix findings and confirm once. Pair checkpoints: Project entry/management first, then configured-provider reuse and missing-provider feedback.

Record the OS and source-build evidence in the contract inventory. Installed three-platform qualification remains with the qualification child. Do not claim Windows/Linux success from macOS evidence.

### Document and AI review

Confirm the owning named requirements and acceptance scenarios match delivered Project entry and provider reuse. Check that provider configuration remains explicit in the new Settings child, saved-history browsing without providers remains explicit in child 3, and no PRD claims an installed/released app. Verify ADR-020, extension schemas, and current references agree; glossary meanings remain unchanged. Inspect that UI/main hold projections and preferences only; Core still owns registration, settings, and credentials.

## Edge Cases & Considerations

- **Settings are not provider health.** A configured key can be invalid; optional Claude/Agy CLIs can be absent. Report the actual failure without treating it as a Workspace account problem. Free local use does not mean free inference.
- **Provider configuration is shared.** This child reads it through Core and does not edit it. Do not overwrite credentials or Project overrides, or introduce a desktop credential cache.
- **Registration is not runtime entry.** Existing registered roots retain access policy. Project listing must not initialize repository runtime state. Explicit Session actions continue through Core's normal runtime-entry checks.
- **Connection and path changes invalidate context.** Discard stale confirmation tokens and request bindings after disconnect or relink. Do not retry uncertain mutations automatically. Re-read canonical state and let the user retry.
- **Provider setup is deliberately external in this slice.** A later Settings child owns the clean-install provider journey. This temporary prerequisite is not a released-product restriction.
- **Test isolation remains mandatory.** Resolve home/cwd through `getHomeDir()` and `getCwd()` in Core, never module-cached environment values. Use `withProcessGlobalTestLock` for process-global test mutations. Native Node host code retains its existing host boundary.
- **Plan storage stays out of scope.** Use current Core owners when needed; do not hard-code checkout Plan paths or take work from the separate Plan-store Epic.
