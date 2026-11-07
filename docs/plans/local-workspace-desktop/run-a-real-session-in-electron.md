---
planId: "306b72b4-8317-448f-9dcd-0da64ff858d0"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/acp/"
    - "src/cmd/acp/"
    - "src/ui/desktop/"
    - "src/ui/workspace/client/"
    - "src/ui/workspace/react/SessionClientSurface.tsx"
    - "scripts/"
    - ".github/workflows/pr.yml"
    - "src/ui/workspace/components/SessionTimeline.jsx"
    - "src/ui/workspace/components/SessionQuestionForm.tsx"
    - "package.json"
    - "docs/adr/020-electron-workspace-acp-client.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/desktop-workbench-contract.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:32.567Z"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 1
dependencies: []
targetBranch: "epic/local-workspace-desktop"
userVerifiedAt: null
status: "reviewed"
validatedCommit: "3c23d6ccd795755779cb48fd45eddfaa940c619b"
---

# Run a Real Session in Electron

## Context

The Local Workspace Desktop Epic replaces the local browser workbench with an Electron application controlling a
separate `wld` runtime through Agent Client Protocol (ACP). The first boundary must work in a desktop window, not only
in tests or a static shell.

Owning targets are [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access) and [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace). [ADR-020](../../adr/020-electron-workspace-acp-client.md) describes the proposed architecture. This child establishes the boundary; it does not deliver full workbench parity or platform qualification.

**Requirement changes:** partly implement “The installed app owns the workbench,” “Carry the full workbench through the
runtime contract,” and “Prefer standard ACP and negotiate the remainder.” Preserve ordinary external ACP access,
[Core Session continuity](../../prd/runwield-core-prd.md#session-continuity), and existing browser/review behavior.
No existing capability is removed in this child.

**Repository evidence:** SDK 1.4.0 already exports `client`, `ndJsonStream`, typed requests, and form elicitation.
`src/acp/sdk-client-background.test.ts` uses them. The server supports new/load/prompt/cancel/close; discovery is
unimplemented. `session/load` emits replay before its response. Existing managed-Session tests run in-process and
cannot prove the new subprocess boundary.

The current checkout's parent/ADR wording predates the owner's confirmed browser-retirement decision. Use the
confirmed handoff: shared UI serves desktop now and future hosted SaaS; no ACP migration of the old local browser
workbench. Standalone review/document/question hosts and the Plan share server survive. Reconcile affected ADR/PRD
wording during implementation; do not change protected parent lifecycle metadata.

### Epic Scope Changes

None. Child 2 owns Project registration/provider setup; child 3 owns discovery and full Session parity; child 4 owns
window/supervisor recovery. Children 5–6 own integrated reviews. Child 10 owns installers/update tooling; child 11 owns
browser cutover and the public Workspace glossary change. This child necessarily pins Electron and provisions its
development binary; that does not choose an installer or move release qualification forward.

## Objective

A minimal Electron application uses existing shared Session and question components to create a Session, reload a known
saved Session, stream text, answer structured questions, cancel, and close through a real `wld acp` subprocess.
The answered question reaches Core and the provider's next request; closing and loading retains committed history.

This is a source-development slice for one explicit Project with an already configured provider. It introduces no
Session list, configuration editor, attachments, review integration, native picker, account setup, or new runtime store.

## Approach

Keep SDK 1.4.0 and reuse its persistent client connection. No SDK upgrade or new workbench extension is needed for
this proof. Implement only the supported Session contract; inventory later capabilities without publishing stubs.
The [SDK 1.4.0 declarations](https://unpkg.com/@agentclientprotocol/sdk@1.4.0/dist/acp.d.ts) support this client.
[Current v1 discovery](https://agentclientprotocol.com/protocol/v1/session-list) requires a list capability that this
server does not advertise. The [v2 migration draft](https://agentclientprotocol.com/protocol/v2/migration) changes turn
completion and update semantics; do not apply those rules to this v1 connection. Sources checked 2026-11-05.

```text
SessionClientSurface (shared React)
  WorkspaceSessionClient (semantic operations and serializable views)
    desktop preload -> validated main handlers
      ACP Session client -> stdio -> source wld acp -> Core
```

Proposed ownership:

- `src/ui/workspace/client/session-client.ts`: named client/view/question types, free of host and ACP imports.
- `src/ui/workspace/react/SessionClientSurface.tsx`: required client, existing timeline/question controls, composer.
- `src/acp/client/workspace-session-client.ts`: SDK negotiation, replay/stream translation, pending elicitation.
- `src/ui/desktop/`: main, sandboxed preload, renderer mount, local asset origin, and process launch.
- `scripts/desktop-*.ts`: explicit development binary setup, Vite build, launch, and checks.

The bridge implements a real process boundary, not an optional test dependency. Main owns the subprocess, but never
constructs `SessionRuntime` or reads/writes canonical stores. The ACP mapper must not import the server-side
`event-mapper.ts`, which imports command/runtime implementation.

**Small shared-form change:** the existing form turns approval choices into booleans and replaces a selected value with
Other text. ACP requires the exact string choice plus optional `otherAnswer`. Preserve raw form fields for the ACP
adapter while retaining the current browser callback/HTTP behavior. Approval interpretation remains Core-owned.

**UI scope:** show Project identity, connection state, New Session, a known Session ID field with Load, the active ID,
timeline, text composer, Send, Stop, and Close Session. Reuse the compact dark design system, not a new dashboard.
Do not create placeholder controls for later children. Render pending forms with their real labels, requirements, and
errors; desktop copy must not say “close this browser tab.”

**Reviewable development assumptions:** launch with `bun run desktop:dev -- --project /absolute/project`; main binds
all requests to that launch context. Use the launcher's explicit Bun executable and checkout `src/cli.ts acp`, never
a PATH-selected global CLI or renderer-supplied command. Load uses a known ID; it does not scan storage. Build the
renderer to a restricted `runwield://app/` origin; `desktop:dev` builds then launches, with no HMR/server in this slice.
Front-matter dev-server fields stay null because this is a native process, not an HTTP dev server.

An embedded `wld workspace serve` window would ship sooner but retain runtime ownership in the UI host. Mounting
`SessionSurface.jsx` would also pull in HTTP/CSRF, browser navigation, configuration, and full workbench behavior.
Reuse its presentation components instead.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/desktop/`, `src/ui/workspace/client/`, and `react/SessionClientSurface.tsx` — the host, semantic contract,
  and small shared composition described above.
- `src/acp/client/` — Node-compatible SDK mapping. Existing server/interaction code changes only for a demonstrated
  first-slice defect, such as pending-question settlement; no broad domain-service extraction here.
- `SessionTimeline.jsx`, `SessionQuestionForm.tsx` — reuse presentation; preserve complete question data and raw answers.
  The runtime import chain is already browser-safe: `tools/registry.ts` contains constants, and
  `interaction-values.ts` and `shared/workflow/delivery-report.ts` contain pure values/functions.
- `package.json`, `bun.lock`, desktop Vite/TypeScript config, scripts, `scripts/run-ci.ts`,
  `scripts/bun-test-files.json`, and `.github/workflows/pr.yml` — explicit binary setup, build, type/import checks,
  isolated tests, and a display-capable Electron gate. `scripts/run-tests.js` and `run-bun-tests.ts` currently strip
  display variables; forward only the required `DISPLAY`/`XAUTHORITY` for graphical tests while retaining private
  HOME/cwd/database isolation and credential filtering.
- `docs/desktop-workbench-contract.md` (new) — capability inventory, protocol baseline, development commands, limits,
  and proof references. This is engineering documentation, not a second PRD.
- Workspace/ACP PRDs and ADR-020 — partial delivery, accepted process/client decision, and confirmed host boundaries.
  Browser retirement and broad glossary redefinition remain later work; no new domain term is introduced here.

Keep existing browser hosting, assets, Plan-store code, provider setup, CLI compilation, and share-server behavior out
of implementation scope except regression verification.

## Reuse Opportunities

- `src/acp/sdk-client-background.test.ts` — SDK client construction and persistent notifications; server-side
  `event-mapper.ts`, `interaction-mapper.js`, and `session-map.ts` define wire evidence, not client runtime imports.
- `SessionTimeline` accepts prepared items; `SessionInteractionCard` uses `item.onAnswer`.
  `SessionQuestionForm.onResponse` already avoids HTTP submission. Supply full question data rather than relying on
  `reduceSessionEvents`, which drops options/defaults/required state.
- `fonts.css`, `tokens.css`, `components.css`, `theme-bridge.ts`, and
  `workspace-styles/session-timeline.css` — browser-safe theme/assets. Do not import `ui/theme/theme.ts` or depend on
  Astro's `/theme.css` endpoints.
- `src/acp/server.test.js` — real source CLI initialization pattern.
  `scripts/check-bun-provider.ts` — isolated HTTP/SSE provider and credentials for a real subprocess.
  `defineGitFixture` and canonical Session readers — real Project/persistence evidence. In-process faux-provider
  registration in `withRuntimeCommandFixture` cannot configure a separately spawned runtime.

## Implementation Steps

1. `docs/desktop-workbench-contract.md` inventories current owner routes, Session API, dashboard streams, review handlers,
   search, usage/settings, and native interactions. Each row names its current authoritative owner, standard method
   or proposed extension, parity scenario, capability/refusal rule, and responsible child. Distinguish SDK support
   from server implementation. Compare pinned v1.4.0 with current ACP v1 and relevant v2 drafts using dated primary
   links; do not claim v2 conformance or implement later rows.

2. The shared Session client exposes semantic create/load/send/answer/cancel/close/observe operations and serializable
   views, not arbitrary RPC or filesystem access. Connection, selected Project locator, protocol Session ID, durable
   Session ID, message/tool IDs, and pending question identity remain distinct. Main rejects mismatched contexts.
   Initialization checks the selected protocol and required supported methods before dependent mutations; advertise
   only supported form elicitation, not filesystem, terminal, or provider authentication callbacks.

3. The ACP client registers notification/request handlers before connecting and uses the SDK's typed
   `client().connect(ndJsonStream(...))`. New/load use an absolute launch-bound cwd and `mcpServers: []`.
   Load accepts the known ID, captures replay arriving before its response, and preserves the requested wire ID plus
   returned durable ID. Text/thought/tool updates reconcile by supplied IDs without duplicate user echoes or merged
   unrelated messages. Keep subscriptions alive beyond a prompt response; `end_turn` is not workflow completion.
   Unknown optional updates cannot become fake successful work.

4. Form elicitation accepts the actual server subset: string text, enumerated string choice/approval, and optional
   Other text. The shared controls retain raw selected value separately from Other text, submit no default silently,
   and do not offer unsupported Other input. Required text rejects empty/whitespace input under RunWield's existing
   interaction rule, even though the current schema has no `minLength`; optional text accepts empty input. Enum choices
   preserve exact values and their required-field rules. Return the answer as the response
   to the pending `elicitation/create` request; there is no invented answer RPC. Core interprets approval values.
   Unsupported schemas fail visibly without hanging or guessing. Answers are bound to one connection/Session/request;
   duplicate, stale, canceled, and wrong-Session answers cannot reach another question.

5. Stop sends the `session/cancel` notification and waits for actual turn settlement, not a nonexistent cancel
   response. Pending forms are dismissed/canceled without accepting late answers. `session/close` releases live
   resources without archiving/deleting history; it is distinct from stopping, unsubscribing, or killing the process.
   Controlled shutdown settles owned work before disposing the connection. Unexpected exit becomes disconnected/
   interrupted, never completed, and never automatically replays input. Full window/supervisor recovery stays in child 4.

6. The desktop host builds Node main and bundled sandbox-compatible preload separately from the browser renderer.
   Sandbox, context isolation, and disabled Node integration stay enabled. Main checks the expected WebContents,
   top-level sender frame/origin, payload shape, size bounds, Session binding, and pending question identity.
   Preload exposes only named product operations and cleaned event payloads, never inter-process communication (IPC)
   objects or sender events. Local asset resolution refuses traversal; Content Security Policy (CSP) blocks
   scripts/remote content from messages. Refuse arbitrary
   navigation, popups, permissions, and unsafe URL schemes. Only deliberate validated HTTP(S) links may open externally;
   nothing auto-opens from generated content. No exposed debug port exists in normal launch.

7. `SessionClientSurface` implements the stated single-Project UI with existing timeline/form/primitives and local
   fonts/styles. Loading, streaming, awaiting answer, cancellation in progress, idle, provider prerequisite, and
   disconnected states are truthful and accessible. Streamed output appears before completion. Shared UI has no
   Electron/ACP/HTTP-owner dependency. Existing standalone form behavior survives the raw-answer/copy changes.

8. New scripts provide `desktop:setup`, `desktop:build`, `desktop:dev`, `desktop:check`, and `desktop:test`.
   Pin a supported stable Electron version and compatible `playwright-core` as dev dependencies; reuse existing Vite/
   React plugins. Setup invokes the pinned package's verified binary installation path explicitly, checking its
   manifest/version and upstream checksums; it does not enable dependency lifecycle scripts or require a new packager.
   Use dedicated Node/Electron and DOM type checks without inherited Bun/Deno ambient types. If a reused component's
   erased type references pull Core into these checks, extract only the needed shared data types, not runtime
   orchestration. Desktop builds/checks enter `PRE_TEST_TASKS`; isolated tests enter the repository inventory.
   Setup/provisioning completes before `runCi` starts its parallel `PRE_TEST_TASKS`; setup is not a parallel peer of
   build/check. Provision a Linux virtual display and preserve `DISPLAY`/`XAUTHORITY` through both isolated runners.
   `test`, `test:all`, and `test:bun` prepare desktop artifacts before their discovered tests; direct focused invocations
   without artifacts fail with the required build command. Missing binary/display prerequisites are failures, not skips.

9. Resolved runtime-import/bundle checks prove that shared UI/renderer contain no Node, Electron, Astro server, or Core
   execution/storage dependency and that host/client contain no Core execution/storage or Bun/Deno dependency.
   Check indirect imports, re-exports, and dynamic imports; do not merely externalize forbidden modules. Distinguish
   erased type-only references from executable imports and allow the inspected pure values above. Negative fixtures
   prove a forbidden dependency hidden behind a barrel fails. Check local emitted fonts/styles too.

10. Workspace/ACP PRDs add the proven development Session scenario and preserve full-workbench targets. Reconcile
    ADR-020's stale browser-adapter wording with the confirmed desktop/future-SaaS boundary and retained standalone
    viewers. Approval of this Plan accepts the process/client architecture it implements; record accepted decisions
    as such, with packaging/remote/service choices still explicitly unresolved. ADR acceptance is not delivery evidence.
    Preserve current browser support until child 11; do not mark the desktop installed/released or redefine Workspace's
    current public glossary yet. Affected references link the capability inventory and acceptance evidence.

## Approval Confirmation

No Work Records are proposed for supersession. Development choices labeled above are reviewable; this Plan does not
select packaging, remote transport, or hosted identity architecture.

## Verification Plan

### Automated

Use Bun 1.4.3 and `bun run install:locked` before checks. The desktop commands and named tests below are new outputs
of this change; they do not exist yet.

```sh
bun run desktop:setup
bun run desktop:check
bun run desktop:build
bun scripts/run-tests.js src/acp/client/workspace-session-client.test.ts src/acp/client/workspace-session-client.process.test.ts src/ui/workspace/session-client-surface.test.tsx scripts/check-desktop.test.ts
bun run desktop:test
bun scripts/run-tests.js scripts/run-tests-sandbox.test.ts scripts/run-bun-tests.test.ts scripts/run-ci.test.ts
bun scripts/run-tests.js src/acp/server.test.js src/acp/managed-session.integration.test.ts src/acp/sdk-client-background.test.ts src/ui/workspace/workspace-session-ux.test.tsx src/ui/workspace/workspace-review.test.js
bun run workspace:check
bun run workspace:build
bun run seams:check
bun run doc-links:check
```

`desktop:test` builds first and runs `src/ui/desktop/desktop-session.integration.test.ts` through
`scripts/run-tests.js`, not a separate test runner. Use Playwright's Electron launcher only as the automation driver,
with CSP and Chromium sandbox enabled. Use the real built main/preload/renderer and source CLI, with an isolated HOME,
temporary real Git Project, provider files, temporary directories, and `MNEMOTECA_DB_PATH`. Set child environment rather
than mutating test-process globals; when mutation is necessary use `withProcessGlobalTestLock`.
Linux CI uses a virtual display. Keep process cleanup bounded and capture stderr on failure. Runner tests prove display
configuration survives without forwarding provider credentials or the real HOME/database paths. Build/setup ordering
checks cover `ci`, `test`, `test:all`, and `test:bun`, not only `desktop:test`.

**Behavior that proves the objective:**

- The controlled HTTP provider emits a first text chunk, then waits. The actual Electron DOM shows it before the
  provider releases the rest. Assert recorded provider input and distinct runtime PID, not canned view text.
- The provider invokes the real `user_interview` tool. Click a choice and then test Other text in Electron; inspect the
  next provider request's actual tool result. It must contain the exact chosen answer once. Cover text, approval,
  decline/cancel, required empty input, unsupported schema, and late/duplicate answers in focused cases.
- Close the Session/process, launch again, load its known ID, and continue. Compare canonical persisted ID/history with
  the replayed DOM and provider context. Replay is captured before the load response; no manifest/JSONL read by desktop.
- Cancel a held provider stream and a pending question. Wait for cancellation settlement, then send another prompt.
  The new turn succeeds; no late answer is delivered and no user/model message is duplicated. Inspect persisted history
  to distinguish Session close from archive/delete.
- An SDK fake-peer fixture is allowed only for incompatible-version/missing-capability and malformed-wire negatives.
  Assert no dependent new/load/prompt frame is sent. Real-process and Electron positive journeys may not mock ACP,
  preload, main handlers, Core stores, locks, or interaction outcomes.
- Attempt malformed/oversized payloads, wrong Session/question IDs, and requests from an untrusted frame. Assert refusal
  before a provider call or canonical mutation. Inject raw HTML/script/unsafe links as model output and verify no
  execution, bridge invocation, privileged navigation, or automatic popup. Node/IPC globals are absent in renderer.
- Kill the runtime during a turn: UI shows interruption, no success or automatic resubmission. The source-boundary
  negative fixtures and Node-target build fail if a hidden Core import is added.

The provider-input, committed-history, and live-DOM assertions fail for a static shell, mocked transcript, or bridge
that never reaches `wld`. Preserve existing browser questions, standalone reviews, no-form ACP questions, background
delivery, writer exclusion, and cancellation/replay tests. No existing behavior is intentionally removed.

### Headed desktop and AI review

Launch `bun run desktop:dev -- --project /absolute/disposable-project` with existing configured provider settings.
The normal origin is `runwield://app/`, not an HTTP dev-server URL. Use a worktree-owned optional loopback
Chrome DevTools Protocol (CDP) port only for development inspection and attach `agent-browser --cdp <port>`;
never substitute a browser-only page.

In the Electron window: New -> send -> see live chunks -> answer a question -> Stop -> send again -> Close Session ->
Load the displayed saved ID -> continue. Repeat a simple turn with a separately configured real provider after the
controlled-provider test. Record screenshots, accessibility snapshot, console errors, process identities, and any
provider prerequisite. Inspect 1440×900 and a narrower desktop window for keyboard/focus access and no clipped controls.
No mobile or installed-platform claim is required.

AI review checks that the rendered components are shared, protocol translation has one owner, runtime authority stays
in `wld`, and inventory rows cover the current workbench without silently committing future schemas. Check PRD/ADR
wording against actual evidence and preserve future scope. No implementation tests were run during planning.

## Edge Cases & Considerations

- Missing provider/default model: show the actual Core prerequisite; do not ask for Workspace sign-in. Setup is child 2.
- Known-ID load is not discovery or full cross-surface history parity. No `session/list` claim is added here.
- Forms are the current server subset, not a general JSON Schema form engine. Preserve exact choice strings and Other
  text; do not turn an approval choice into a guessed boolean before Core sees it.
- A source-development runtime is deliberate. No installer, updater, global CLI dependency, hosted service, or account
  table belongs here. Native lifecycle refinement remains child 4; controlled close is needed for this proof.
- Existing pure shared values may remain in their current directories. Do not force a module split, type migration,
  or folder move simply to satisfy a broad path grep.
- The browser workbench and retained viewers remain operational throughout this child. Later cutover must not be
  implemented by deleting all browser assets.
- Electron provisioning and graphical CI need explicit setup. Do not disable the sandbox, skip the real host test, or
  enable lifecycle hooks to make checks appear successful.
