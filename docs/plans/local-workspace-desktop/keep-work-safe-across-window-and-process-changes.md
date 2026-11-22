---
planId: "9a64116e-8711-4de1-a192-8fba319d23c8"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/ui/desktop/"
    - "src/acp/"
    - "src/shared/session/"
    - "src/shared/owner-coordination/"
    - "src/ui/workspace/client/"
    - "src/ui/workspace/react/ProjectWorkbench.tsx"
    - "src/ui/workspace/react/SessionClientSurface.tsx"
    - "docs/desktop-workbench-contract.md"
    - "docs/adr/020-electron-workspace-acp-client.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
devServerCommand: "bun run desktop:dev"
devServerUrl: "runwield://app/"
devServerHmr: false
createdAt: "2026-11-06T04:04:34.474Z"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 4
dependencies:
    - "continue-saved-sessions-in-desktop"
targetBranch: "epic/local-workspace-desktop"
userVerifiedAt: null
status: "reviewed"
validatedCommit: "e860acbc72ca0c41e50949494c5e0775b344cbf3"
---

# Keep Work Safe Across Window and Process Changes

## Context

The desktop Session journey must survive presentation changes without changing runtime ownership. Window close is not Quit; a crashed view is not failed or completed Agent work.

The completed saved-Session child supplies passive history, receipts, bounded snapshots, cross-client continuation, and retained Background Tasks. This child extends those owners rather than rebuilding them.

Current source has three limits:

- `src/ui/desktop/main.ts` ties one `BrowserWindow`, one `AcpWorkspaceSessionClient`, and the runtime subprocess together. Window close calls `closeApplication()`, disposes the client, and quits. There is no single-instance admission or window recreation.
- `AcpWorkspaceSessionClient` holds one selected context, pending question, turn, and observation cursor. `ProjectWorkbench.navigate()` requires Close before switching Sessions. Core already represents multiple bound Sessions; desktop selection is the narrower part.
- `SessionClientSurface` keeps unsent text/images in React state. Sidebar collapse is saved in local storage, but selected navigation and window bounds are not restored by main. Process loss marks the client disconnected; it has no restart path.

### Owning requirements

- [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace), **Preserve work across desktop and existing surfaces**: implement window-close survival, deliberate Quit, and truthful interruption. Native preferences contribute to **The installed app owns the workbench**, without claiming installation.
- [Core Session continuity](../../prd/runwield-core-prd.md#session-continuity), **Continue the same saved work across clients**: preserve durable identity, committed configuration, drafts across view changes, and one writer per operation.
- [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve **RunWield repairs its own machinery automatically**, **Treat an unknown state as live**, and **Preserve work and report uncertainty**. Cancellation or process loss does not conclude a delivery workflow.
- [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access), **Recover observations without repeating effects**: implement reconnection using current snapshots and generations. Preserve **Prefer standard ACP and negotiate the remainder** and existing ordinary external-client behavior.

These are target-to-implemented changes, not new completion rules. [Accepted ADR-020](../../adr/020-electron-workspace-acp-client.md) already selects one per-user desktop supervisor, a separate runtime, close-not-Quit, and no automatic replay. The old browser workbench remains supported until its cutover child.

## Objective

One desktop supervisor keeps local work alive across window close/reopen and renderer failure. Any number of Sessions run in parallel across and within Projects. Unsent drafts, images, and queued follow-ups survive every window and process change. Explicit Quit settles owned cancellation before disposal. Main/runtime failure offers truthful recovery without automatically repeating uncertain actions.

## Approach

Main owns application/process lifetime; Core owns operation lifetime and durable truth. Reopening a renderer loads a fresh snapshot and generation before applying observations.

```text
window close -> detach view; keep supervisor/runtime and Session bindings
reopen -> attach view; reconcile current evidence; do not send saved input
Quit with work -> Stay open OR Stop and quit -> Core settlement -> dispose
unexpected exit -> reconnect and inspect Core evidence -> user chooses continuation
```

Keep process lifetime, Session binding, and selected view separate. A desktop supervisor module should own instance admission, runtime start/exit, window recreation, and one shared shutdown operation. Native menus and the later updater use that same stop boundary. It must not own canonical Session or Plan writes.

### Settlement and observation gaps found in Core integration

`RuntimeLifecycle.closeSessionWhenIdle()` already waits for turn and managed-operation settlement. `SessionContinuationService.close()` drains owned Sessions and Background Tasks. However, negotiated `WorkspaceSessionConnection.closeSession()` currently calls `stop()` and removes its binding without waiting for that durable boundary. `session/cancel` is a notification, not a settlement acknowledgement.

Make negotiated close await shared Core settlement. Supply an acknowledged connection-level drain for application shutdown before closing stdio. It stops work owned by this runtime, not unrelated TUI/browser writers that desktop merely observes. Verify canonical outcome evidence; a fulfilled cancellation request, empty snapshot, or dead connection is not proof of settlement. Keep a single in-flight shutdown operation across slow responses and retries; the current ten-second timeout must not allow overlapping disposal attempts.

Reuse automatic file-Session recovery through history loading after process loss. A repaired idle Session does not prove an uncertain accepted action completed. Preserve unknown receipt outcomes and require deliberate continuation rather than reusing saved in-flight payloads.

Fix observation races in `refreshHistory()` and `startObservation()`: capture connection/binding identity around asynchronous reads, reject stale results, and never overwrite a newer history generation with an older snapshot generation. Reconcile current questions, configuration, and queue evidence without turning uncertain/reconciliation states into idle. Distinguish Core queued messages from unsent client drafts. Gap detection must cover event eviction, not only generation changes or truncation of the returned payload.

### Decision: every Session runs in parallel

The owner chose full parallelism; this is the reason desktop uses ACP. Any number of Sessions can run at the same time, in different Projects or in the same Project. Opening another Session or Project never requires Close, and switching views never stops, pauses, or retargets work. The old Close-before-switch guard and its test stop applying.

```text
supervisor (main)
  one runtime connection
    binding A1  Project A  running   question pending
    binding A2  Project A  idle      draft + 2 images
    binding B1  Project B  running   queue: 1 unsent
  window -> selected view = one binding, others keep running
```

Each binding owns its Project context, observation cursor, pending question, configuration, queue, and draft. The client keeps a map of these bindings instead of one module-wide view. The sidebar shows which Sessions are running or waiting for an answer, so background work stays visible.

Reviewable assumption: one window per supervisor, with sidebar navigation. A second native window would be a view of the same bindings and needs no change to runtime ownership, but it is outside this child.

### Decision: unsent drafts and images survive restart

The owner chose to keep unsent drafts, including images, across window close, renderer crash, Quit, and main-process failure. Queued follow-ups that were not yet dispatched are unsent intent too and use the same store.

Main owns a private desktop draft store in Electron's per-user data directory. It is client intent, never Core authority:

- one entry per binding, keyed by Project registration ID plus durable Session ID, or by Project plus a composer key before the first accepted message;
- each entry holds the text, image transfers within existing `validateSessionInput` limits, queued follow-ups, and their request identities;
- writes are atomic and owner-only; the renderer reaches the store only through validated preload operations;
- an entry is removed after Core accepts that input, after explicit discard, or when its Project registration is removed.

```text
restore after restart
  load draft entries -> show as unsent in their Sessions
  never dispatch automatically
  user presses Send -> reuse saved request identity
    Core receipt exists -> recorded outcome, no second effect
    no receipt -> normal submission
```

Restored queued items need a deliberate Send. Before a crash, a queued item may have been in flight; reusing its request identity lets Core's receipt rules decide whether it already ran.

An always-on service after explicit Quit would need different requirements and is excluded. Packaging, updater installation, integrated Plan/Code Review, and platform qualification stay with their existing siblings.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/desktop/main.ts`, new supervisor implementation, `bridge.ts`, `saved-session-bridge.ts`, and `preload.ts` — separate window attachment from runtime lifetime; validate replacement views and per-binding requests; route native Quit/reopen through one owner.
- New desktop draft store under `src/ui/desktop/` — main-owned persistence of unsent text, images, and queued follow-ups.
- `src/acp/client/workspace-session-client.ts` and its process tests — replace the single view with per-binding state, separate connection lifetime from retained Sessions, reconcile observations, and avoid action replay after loss.
- `src/acp/workspace-sessions.ts`, `server.js`, and `src/shared/session/session-continuation-service.ts` — use authoritative owned-work settlement and existing recovery. Change shared owners only where the actual contract is missing; do not replace locks or receipts.
- `src/ui/workspace/client/`, `react/ProjectWorkbench.tsx`, `react/ProjectSidebar.tsx`, and `react/SessionClientSurface.tsx` — parallel bindings, running/waiting indicators, restoration, persisted drafts, and recovery actions. Reuse shared controls and semantic status styling.
- `src/ui/desktop/testing/desktop-fixture.ts`, native integration suites, and a new `desktop-lifecycle.integration.test.ts` — actual window/renderer/main/runtime loss, process cleanup, and canonical-effect assertions.
- `package.json` and `scripts/bun-test-files.json` — include the new native suite in both focused and full checks.
- `docs/desktop-workbench-contract.md`, Core/Workspace/ACP owning scenarios, and ADR-020 — exact source-development lifetime and recovery evidence, with later capabilities still marked target.

`src/ui/workspace/static/workspace-shell.ts` is a preference reference, not a desktop dependency. The old HTTP workbench and its browser lifecycle code stay in place. No glossary meaning changes are proposed; Session Control and the Session Writer Lock retain their current definitions.

## Reuse Opportunities

- `WorkspaceSessionConnection` bindings and `SessionContinuationService` — Core-owned Sessions, cancellation, receipts, background draining, and committed history hydration.
- `AcpWorkspaceSessionClient.startObservation()` — generation checks, bounded snapshots, and history refresh on gaps; no second transcript store.
- Existing sidebar preferences, `RunWieldConfirmationDialog`, shared buttons/status text, and `docs/design-system.md` — preserve current density and keyboard behavior, not a visual redesign.
- `launchDesktop()` and `makeSessionProcessFixture()` — built Electron, a separate real runtime, isolated HOME, real Git Projects, and a controlled HTTP provider with observable request counts.

## Implementation Steps

1. A desktop supervisor module under `src/ui/desktop/` owns single-instance admission (`requestSingleInstanceLock`, `second-instance`, `activate`), the runtime subprocess, the ACP client, window creation, and one shutdown operation. `main.ts` no longer couples these to one `BrowserWindow`. A second launch focuses or recreates the existing window and starts no second runtime.
2. Closing the last window detaches the view only. Runtime, bindings, operations, questions, and drafts remain. Reopening creates a window whose IPC sender checks accept the new `webContents` and refuse the destroyed one. The new view loads a fresh snapshot and history for every binding before applying live updates.
3. `AcpWorkspaceSessionClient` holds any number of bindings, keyed by wire Session ID, each with its own Project context, observation cursor and epoch, pending question, configuration, queue, and generation. Create, load, send, answer, cancel, close, and observation act on the named binding only. `openProject()` no longer refuses while another Session is open. Bridge validation in `bridge.ts` and `saved-session-bridge.ts` checks the named binding rather than the single current view.
4. `ProjectWorkbench` and the sidebar open, create, and switch Sessions without Close. Switching preserves every other binding's work, question destination, draft, and queue. The sidebar marks running and waiting-for-answer Sessions. The Close-before-switch guard and its entry test are removed; its protection against retargeting answers and drafts stays and is tested across parallel bindings.
5. The desktop draft store persists unsent text, images, and queued follow-ups per binding, as described in Approach. Restored entries appear unsent after window close, renderer crash, Quit, and main-process failure, and are never dispatched automatically. A deliberate Send reuses the saved request identity. Entries are removed after Core acceptance, explicit discard, or Project removal. A corrupt store file is set aside with a visible notice, not silently erased.
6. Negotiated `WorkspaceSessionConnection.closeSession()` awaits shared Core settlement for its binding. A new acknowledged connection-level drain stops and settles all work this runtime owns, including retained Background Tasks, before the client closes stdio. It does not cancel work owned by another TUI or browser process. The result reports settled or unsettled from canonical evidence.
7. Quit with any owned running work shows a confirmation with **Stay open** and **Stop and quit**, using `RunWieldConfirmationDialog` or the native dialog. Stay open changes nothing. Stop and quit blocks new dispatch, persists drafts, runs the drain, and exits only after settlement. Unsettled or failed drain keeps the app open with a retry; it never reports success. Concurrent Quit requests share one in-flight shutdown. The same supervisor operation is exported for the later updater.
8. Renderer loss (`render-process-gone`) leaves runtime and bindings running; main reloads the renderer, which restores the selected binding and drafts. Runtime loss marks every binding interrupted and offers **Restart runtime**. Restart, or relaunch after main loss, reloads Projects and Sessions from Core evidence. Sessions with an unknown receipt outcome show that the outcome is uncertain and wait for the user. No prompt, answer, workflow decision, review decision, or publication is resubmitted automatically.
9. `refreshHistory()` and `startObservation()` reject results from a stale connection, binding, or epoch, and never apply an older generation over a newer one. Snapshot reconciliation applies current questions, pending configuration, Session info, and Core queued messages. Uncertain or reconciliation states are not shown as idle. Event eviction between polls is detected as a gap and refreshes canonical history.
10. Window bounds, sidebar state, the selected Project/Session, and expanded Projects persist across restart in desktop-owned preferences. Native menus supply New Session, Close window, Quit, and standard edit/window commands with platform shortcuts. Preferences are projections; a missing or disabled Project or Session falls back to Projects without granting access.
11. `docs/desktop-workbench-contract.md`, ADR-020, and the owning Workspace, Core, and ACP PRD capabilities describe the delivered parallel Sessions, window-close survival, Quit settlement, persisted drafts, and recovery. The Workspace PRD sentence "One Session view remains open at a time" and the ADR-020 statement that supervisor recovery is not selected are corrected. Installed qualification, updater install, unattended service, and remote runtimes stay target or future.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`, then run:

    ```sh
    bun run desktop:check
    bun run desktop:test
    bun scripts/run-tests.js src/acp/client/workspace-session-client.process.test.ts src/acp/workspace-session-parity.process.test.ts src/acp/sdk-client-settlement.test.ts src/acp/managed-session.integration.test.ts src/shared/session/session-continuation-cross-process.integration.test.ts
    bun scripts/run-tests.js src/ui/workspace/session-client-surface.test.tsx src/ui/workspace/project-sidebar.test.tsx src/ui/workspace/workspace-renderer-lifecycle.test.ts src/ui/workspace/workspace-operation-memory.test.ts
    bun run seams:check
    bun run doc-links:check
    ```

- Negotiated close and drain: through a real ACP process, close a binding whose operation and Background Task are held; the response arrives only after canonical settlement. The drain leaves a separate continuation owner's operation running. These fail against the current `closeSession()`, which returns before settlement.
- Observation races: deliver a delayed history response after a newer generation and after a binding switch; the view keeps the newer state. Evict events between polls; the client refreshes history with once-only content.
- Add `src/ui/desktop/desktop-lifecycle.integration.test.ts` to `desktop:test` and the isolated test inventory. Close the actual `BrowserWindow` during a held provider stream; main/runtime PIDs and operation identity stay unchanged. Emit output while no view exists; reopen through activation or a second launch and assert one provider request and once-only content.
- Kill the renderer PID from `webContents.getOSProcessId()`; main/runtime survive and a replacement view shows current progress or the same pending question without answering it. Kill main and runtime separately; restart with the same isolated HOME/profile and inspect canonical history and provider/effect counts before deliberate continuation. Track known child PIDs across reparenting so test cleanup cannot leave orphan work.
- Exercise native Quit choices. Staying open preserves both held work and queued intent. Stopping and quitting prevents new dispatch and waits for all owned work. On POSIX, suspend the real runtime during settlement, verify main does not exit or claim success, then resume it and verify settlement before exit. Other platforms need equivalent process-boundary evidence during qualification.
- Run held work in two disposable Projects and a second Session in one of them, all through one runtime, without closing any. Answer a question in one while the others stream; each provider request counts once. Switching views must not retarget answers or drafts; stopping one must not stop the others. This fails if the client keeps one module-wide binding.
- Draft persistence: type text and attach images in two Sessions, queue a follow-up in a running one, then close the window, kill the renderer, Quit, and SIGKILL main in separate cases. After each, the exact text, image bytes, and queue reappear unsent, and the provider receives no request until Send. Send after a main kill that interrupted dispatch: Core's receipt prevents a second effect. Accepted input removes its entry; discard and Project removal remove theirs. A corrupt store file yields a notice and a preserved copy. Overflow the real observation bound while a consumer falls behind, then recover from current snapshot/history and assert bounded payloads, once-only transcript, current configuration, and pending-interaction identity.
- Assert uncertain accepted actions are not resubmitted on restart. Inspect canonical records and effect counts, not only labels. Verify cancellation settles before owned process exit and ordinary idle TUI continuation still works.
- Use `bun run desktop:setup`, then `bun run desktop:dev -- --project /absolute/disposable-project --cdp-port 9222` on an available worktree-owned port. Origin is `runwield://app/`; this builds and launches Electron, not an HTTP/HMR server. Attach `agent-browser --cdp 9222` for headed close/reopen, native Quit choices, restored navigation, shortcuts, and interrupted-state recovery. Record screenshots, current process identities, viewport, provider, and console errors. Use the native app for dialogs and OS activation, not a browser-only substitute.
- Headed journey: start work in two Projects, switch between them, close the window, reopen from the Dock/launcher, answer the waiting question, then Quit and test both choices. Restart and confirm drafts with images, selected Session, window bounds, and sidebar state return.
- Protected behavior: sender/payload isolation, Project admission, receipts, writer exclusion, retained Background Task Stop, and idle-TUI continuation tests keep passing against the new per-binding shape. Rewrite existing single-binding desktop tests against named bindings; do not delete their assertions. Expected to stop: the Close-before-switch refusal and window close as application exit. The old HTTP workbench is not removed. Platform-specific lifetime evidence is collected during final three-platform qualification.

## Edge Cases & Considerations

- OS shutdown or forced termination may prevent graceful settlement; report interruption from evidence rather than inventing cancellation completion.
- Client preferences and the draft store are projections and client intent, never execution authority. Draft writes are debounced; a renderer crash can lose only edits newer than the last write.
- Draft entries contain private prompt text and images. Keep them owner-only in the per-user data directory, never in the Project checkout, Core Session files, or logs.
- Many parallel Sessions multiply observation polling. Keep each binding bounded and poll only active or watched bindings at full rate.
- A Session can be bound in desktop while a TUI owns its current operation. Parallel bindings do not add writer authority; Core still rejects a second writer.
- No global Session lease or replacement cross-process lock is introduced.
- Update installation and migration compatibility belong to packaging; this child supplies the safe stop boundary.
