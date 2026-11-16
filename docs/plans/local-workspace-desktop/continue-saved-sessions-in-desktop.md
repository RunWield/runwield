---
planId: "0bd5524a-7424-482c-ad59-a7dd0ec851b2"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/acp/"
    - "src/shared/session/"
    - "src/shared/owner-coordination/"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/islands/SessionSurface.jsx"
    - "src/ui/workspace/components/SessionTimeline.jsx"
    - "src/ui/workspace/client/"
    - "src/ui/workspace/react/SessionClientSurface.tsx"
    - "src/ui/workspace/react/ProjectWorkbench.tsx"
    - "src/ui/workspace/static/workspace-styles/"
    - "src/ui/desktop/"
    - "docs/desktop-workbench-contract.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/adr/020-electron-workspace-acp-client.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: "bun run desktop:dev"
devServerUrl: "runwield://app/"
devServerHmr: false
createdAt: "2026-11-06T04:04:33.658Z"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 3
dependencies:
    - "open-projects-and-configure-providers"
userVerifiedAt: null
targetBranch: "epic/local-workspace-desktop"
validatedCommit: "c9b9f87063c024b1ed7dca3a7001c38e865d711b"
status: "verified"
---

# Continue Saved Sessions in Desktop

## Context

Desktop already creates a Session, streams output, answers a form, stops work, and reloads a known saved ID. It does not yet offer Session discovery or full saved-history and conversation parity. The current semantic client accepts text only and rejects sending during a turn.

`WorkspaceSessionContinuationService` still constructs `SessionRuntime` and owns live operations, retained Sessions, listeners, and background work. Moving rendering alone would preserve the wrong ownership boundary. Accepted [ADR-020](../../adr/020-electron-workspace-acp-client.md) requires reusable orchestration in Core and a separate `wld acp` process. It also supersedes the parent Epic's older browser-migration proposal: the old local workbench stays operational but does not migrate to ACP.

### Capability changes

- [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace): deliver the Session portion of **Work locally without a Workspace account**, **The installed app owns the workbench**, and **Preserve work across desktop and existing surfaces**. This remains source-development evidence, not installation or release qualification.
- [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access): extend **Carry the full workbench through the runtime contract**, **Prefer standard ACP and negotiate the remainder**, and **Distinguish authentication domains** with discovery, passive history, conversation controls, and provider-independent reads. Deliver in-process observation reconciliation here; process reconnect remains with the next child.
- [Browser Sessions](../../prd/runwield-workspace-prd.md#browser-sessions): preserve **A complete conversation timeline**, **Drafts and images survive**, **A compact composer**, **Session context in a sidebar**, **Commands match the TUI**, **Session lists are readable**, and **Archive conversations from history** in the shared desktop conversation. Preserve existing browser behavior during extraction; do not claim integrated Plan/Code Review here.
- [Project access and navigation](../../prd/runwield-workspace-prd.md#project-access-and-navigation): implement desktop **Restore archived Sessions from Project settings** and the Project/Session portion of **Navigate without repeated startup work** and **Consistent headers and menus**. The left sidebar includes Projects, recent Sessions, New Session, and Project settings access; dashboard, Plan, usage, and search destinations stay with their owning siblings.
- [Core Session continuity](../../prd/runwield-core-prd.md#session-continuity): preserve **Continue the same saved work across clients**, canonical history, current saved configuration, and one writer per operation. [ACP Session access](../../prd/runwield-acp-protocol-prd.md#acp-session-access) keeps ordinary client compatibility and reversible `session/delete` archive semantics.

No existing product requirement is removed. Provider authentication, integrated review/workflow controls, supervisor recovery, native notifications, and browser retirement stay with their named siblings.

### Epic Scope Changes

- **Owner decision during review:** include the left navigation sidebar with Projects, Session lists, and New Session in this child. This is separate from the Session context sidebar.
- Updated [Find and Act on Work That Needs Attention](find-and-act-on-work-that-needs-attention.md): move the shared sidebar shell, Project/Session navigation, list expansion/paging, and sidebar collapse/resize behavior here. That child extends this shell with dashboard/attention and Plan navigation, Plan-associated grouping, and native notifications. Its existing dependency on this child remains correct.

Child 2 assigns this child the Archived Sessions tab in Project settings: paged names, open without implicit Unarchive, and explicit Unarchive retaining the same Session ID, transcript, and Plan Associations. This keeps archive UI with this child's existing Session discovery and archive authority work. Child 2 delivers General settings and full Session rescan.

This child also proves saved-history browsing without provider credentials or a runnable default model. Child 2 keeps Project listing/settings independent of provider access; provider configuration belongs to the later [Settings child](configure-model-providers-in-desktop-settings.md). Current `session/load` can require model access, so disabling the composer alone does not meet the saved-history requirement.

## Objective

Desktop users have a persistent left sidebar with Projects, recent Session lists, New Session, and Project settings access. They discover and continue the same saved Sessions used by TUI, with current history/configuration, supported interactions, attachments, and background results. Desktop main and shared UI do not host Core execution.

## Approach

Separate **read saved work** from **continue model work**. Selecting a Session reads canonical history and current committed configuration without `session/load`, Agent activation, MCP initialization, or provider readiness. A deliberate send or execution-dependent control enters the existing Runtime path. Missing provider setup leaves the history and draft available and gives the current external `wld login`/restart guidance.

```text
ProjectWorkbench → persistent left sidebar + Session / Projects / Settings content
  → WorkspaceSessionClient → preload → AcpWorkspaceSessionClient
  → wld ACP handlers
      → shared Session history reader → canonical manifests and transcript segments
      → shared continuation service → SessionRuntime → existing writer/receipt owners
```

### Shared owners

Extract history naming, visible-list paging, and committed timeline projection into proposed `src/shared/session/session-history.ts`. Reuse `projectAggregateTranscript` and file-store reads. Existing `timeline()` can call model-independent `ensureInitialSessionGeneration` before projection. Preserve that Core bootstrap/recovery policy where required; it must not call `session/load`, activate an Agent, or make raw unverified transcript bytes look committed. Initialized reads must remain non-mutating.

Extract reusable admission, receipt hashing, configuration staging, retained Sessions, background operations, and cross-process command routing into proposed `src/shared/session/session-continuation-service.ts`. Keep writer policy in managed operations and receipts in the existing owner-coordination store. Consume Runtime operations through `session-runtime.ts`, not private `runtime/` imports, as required by [ADR-010](../../adr/010-session-runtime-sibling-adapters-and-acp.md). The existing `session-continuation.ts` is a locator resolver and remains separate.

The negotiated Workspace ACP path and old HTTP workbench call the same Core implementation. ACP retains wire schemas, event/interaction mapping, and v1 response ordering. HTTP adapters retain authorization, CSRF, URLs, and browser notifications. Review-specific formatting and launch behavior remain with their existing adapters; move shared operation bookkeeping only where these callers need it. ACP must not construct a second Runtime for the same negotiated Session. Ordinary ACP remains usable without Workspace registration or a Workspace database dependency for intact local history.

Moving the complete browser service behind an import alias would be smaller in lines but would retain UI ownership and duplicate ACP operation rules. The extraction puts each continuation rule in one Core owner instead.

### Protocol mapping

Keep SDK 1.4.0 and ACP v1. The pinned SDK already supports `session/list`; this is a server gap, not an SDK upgrade.

| Behavior                                                                           | Contract                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active Session discovery                                                           | Standard `session/list`, advertised through its standard capability; stable IDs, current names, newest-first order, and opaque paging cursor. Ordinary clients keep cwd-based scope and exclude archived/remote Sessions.                                                                                        |
| Archived discovery                                                                 | The same list method with a negotiated archive filter in Workspace metadata, not a second private list. Filters apply before paging.                                                                                                                                                                             |
| Creation/activation, prompts, cancellation, close, model/thinking                  | Existing standard new/load/prompt/cancel/close/config methods. Workspace mutation metadata carries stable request identity and expected committed generation where applicable; JSON-RPC correlation IDs are not receipts.                                                                                        |
| Archive                                                                            | Standard `session/delete` retains reversible archive semantics. Negotiated requests can resolve a saved ID with admitted Project context without first activating it. For Workspace, busy archive requires explicit stop confirmation and waits for settlement; ordinary ACP keeps its existing delete behavior. |
| Steering                                                                           | Existing negotiated `_session/steering`, routed through the shared owner, including another process's active Session.                                                                                                                                                                                            |
| Passive history, live observation, Agent selection/staged configuration, Unarchive | A versioned Session capability under `dev.runwield/workspace`; named `_dev.runwield/workspace/sessions/…` methods only for semantics not covered by standard ACP.                                                                                                                                                |

Define exact named TypeScript request/result schemas in `src/acp/workspace-contract.ts` and publish them in `docs/desktop-workbench-contract.md` with implementation. Each saved-Session request includes the Core-issued Project context and durable Session ID; new-Session requests carry Project context and request identity before a saved ID exists. Keep wire Session IDs distinct from durable IDs. Receipt identity remains stable across connections, while each retry must pass current Project admission. A history page carries committed generation, stable item IDs, bounded items and older-page cursor, archive state, and committed configuration. A live snapshot also carries operation identity/state, current interaction identity, and observation cursor. Responses expose no credentials or arbitrary filesystem access.

Observation subscribes to the selected Session even while idle, using existing live Session connections for another owner. Bound page sizes, notification queues, and retained snapshots. Subscribe/snapshot ordering must detect a gap; refresh from canonical history rather than append duplicates. A changed generation invalidates stale history cursors. An ended v1 prompt is not proof that background work has ended. Process restart/reconnect UX stays with child 4.

Preserve the existing distinction between an **unsent follow-up queue** and accepted Core work. Explicit Queue keeps editable/removable intent in shared client state and submits once when the Session becomes available. Send during an eligible running turn steers; while a question is pending it follows existing queue/refusal behavior. A local queue does not claim durable acceptance or survival after app exit. Preserve standard ACP's existing cross-writer queued-prompt behavior; do not add a new durable queue store or a queue-management protocol solely for UI drafts.

### Shared UI

Extend `react/SessionClientSurface.tsx`, not a desktop-only conversation fork. Extract browser-safe composer/list presentation from `islands/SessionSurface.jsx` and `components/SessionList.jsx`; keep HTTP behavior in their browser adapters. Reuse `SessionTimeline`, `SessionQuestionForm`, timeline reducers, image previews, and `docs/design-system.md` tokens and primitives.

The left sidebar is part of this slice, not a later dashboard shell. Keep it mounted beside Session, Projects, and Project settings content. Reuse the existing Workspace brand rail, compact rows, header alignment, panel toggle, resize handle, and semantic styles from `layouts/WorkspaceLayout.astro`, `static/workspace-shell.ts`, and `static/workspace-styles/`; extract React presentation, not Astro/HTTP execution.

```text
Left sidebar                     Main content
RunWield / collapse               Session conversation
+ New Session                    or Projects / Project settings
Projects
  Project A / settings
    Recent Session
    Recent Session
    Show more…
  Project B / settings
```

Registered Projects appear first. Each accessible Project loads its five most recent non-archived Sessions independently; Show more adds the next five without duplicates. All active Sessions remain discoverable, including Plan-associated Sessions. Plan nesting and exclusion of already nested rows arrive with the dashboard child. Keep per-Project loading/error/retry states; a slow or unavailable Project must not block another Project or New Session. Disabled/missing roots retain settings access without granting history access.

Session rows use saved names and stable IDs, and show the selected destination. New Session opens the composer for the selected admitted Project, or the Project chooser when none is selected. It does not submit a prompt or create saved history merely by opening. Existing Project management and Archive actions remain reachable. No nonfunctional Dashboard, Plan, usage, or search links are added early.

Keep expanded Projects and sidebar scroll position during navigation, plus the existing collapse/restore and width preference behavior. Long names stay within the sidebar; scrolling and keyboard access remain available without visible scrollbars, as in the owning PRD. The logo returns to the last visited Session when one exists; otherwise it opens Projects. At narrow widths, reuse the existing overlay and focus behavior rather than squeezing the conversation.

Sidebar queries resolve explicit per-Project read contexts without changing the bound Session or the client's selected execution context. This requires extending the current single-context client: listing another Project must not call the state-changing `openProject` path that retargets the view. Reuse Core's existing Project admission operation; do not add a second authorization owner.

Project history lists saved names with Archive and opens a Session by ID. Project settings uses General / Archived Sessions underline tabs with paged rows, open, and Unarchive. Opening an archived Session leaves it archived. Preserve the existing single open Session binding and explicit Close-before-switch guard when a sidebar action would replace it; concurrent Session execution and window/process restoration remain with child 4. Sidebar browsing itself never closes or retargets work. Drafts and pending answers cannot move to another Session.

Image selection, paste, and drop transfer bytes, never local path authority. Reuse PNG/JPEG/GIF/WebP support, 7 MiB per-file and 10 MiB aggregate base64 limits, image-only messages, previews, removal, and Core vision prerequisites. Put shared numeric limits in one browser-safe contract and validate at UI, privileged bridge, and Runtime entry. Keep the existing desktop 65,536-character text limit consistently across its layers; ordinary ACP limits remain unchanged.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/session-history.ts`, `session-continuation-service.ts` (proposed), existing file-store/managed-operation/live-connection modules, and `src/shared/owner-coordination/` — shared history, continuation, receipts, writer admission, and background ownership.
- `src/acp/server.js`, `workspace-contract.ts`, `workspace-projects.ts`, event/interaction mapping, and `client/workspace-session-client.ts` — standard discovery plus negotiated history, observations, mutations, and image/configuration support.
- `src/ui/workspace/server/session-continuation.js`, `routes/owner-session-api.js` — delegate shared rules to Core while retaining HTTP and browser compatibility. No browser ACP migration.
- `src/ui/workspace/client/session-client.ts`, `react/SessionClientSurface.tsx`, `react/ProjectWorkbench.tsx`, `islands/SessionSurface.jsx`, `islands/ArchivedSessions.tsx`, and `components/SessionList.jsx` / `SessionTimeline.jsx` — reusable composer/list presentation, history and configuration, Archived Sessions, and semantic subscriptions.
- `src/ui/workspace/react/ProjectWorkbench.tsx`, a shared React sidebar, `client/project-client.ts`, and Session list contracts — persistent Project/Session navigation, independent per-Project reads, New Session, settings access, and retained navigation state.
- `layouts/WorkspaceLayout.astro`, `static/workspace-shell.ts`, and `static/workspace-styles/` — reuse sidebar presentation and preferences without importing browser route/refresh logic into desktop; preserve the current browser host.
- `src/ui/desktop/{bridge,preload,main}.ts`, renderer wiring, and native tests — named validated operations, explicit per-Project sidebar queries, and bounded image transfer; no Runtime/store imports.
- Existing Session, background, interaction, archive, and UI suites; new real-process history/parity/cross-surface tests; `scripts/bun-test-files.json` and desktop check/test scripts — behavioral and import-boundary proof.
- `docs/desktop-workbench-contract.md`, Core/Workspace/ACP owning PRD sections, ADR-020, and its stale proposed-status reference in ADR-010 — exact delivered contract and scoped evidence. Preserve accepted architecture and refresh stale implementation descriptions/references; no new architecture decision is proposed.

The public Workspace glossary transition remains with browser cutover. This child introduces no new domain term. Provider setup, standalone review hosts, distribution, and unrelated workflow algorithms do not change.

## Reuse Opportunities

- `file-session-store.ts`, `file-session-control.ts`, `runtime/managed-operations.ts`, `runtime/managed-sync.ts`, and `live-session-connection.ts` — existing canonical storage, writer settlement, fresh hydration, and cross-process observation/answer/cancel/steer.
- `WorkspaceSessionContinuationService.listSessions`, `timeline`, `configureSession`, `startContinuation`, and retained/background methods — extract their rules, not duplicate them in ACP. Keep generation bootstrap/recovery in its existing Core owner, separate from model activation.
- `reduceSessionEvents` and `mergeSessionTimelineItems` in `SessionTimeline.jsx`, exported `SessionComposer`, shared question forms, and `RunWieldPrimitives.tsx` — chronology, Activity disclosure, composer, tabs, and confirmations.
- `src/acp/client/testing/session-process-fixture.ts`, `src/ui/desktop/testing/desktop-fixture.ts`, `makeManagedSessionFixture`, and `defineGitFixture` — real subprocess, provider, native-window, and canonical-store tests without Core injection seams.

## Implementation Steps

1. **Core owns shared history and continuation.**

    The proposed history and continuation modules contain the real rules extracted from
    `WorkspaceSessionContinuationService`, not wrappers that import the UI server. Browser and negotiated ACP adapters
    call those owners.

    Runtime construction, operation maps/listeners, retained Sessions, and background lifecycle for negotiated Sessions
    live below the ACP boundary. No duplicate receipt, lock, or background-operation policy remains in the two adapters.

    Ordinary ACP still uses canonical file authority without requiring Project registration.

2. **Saved reads are bounded and provider-independent.**

    Standard `session/list` advertises support and returns stable saved IDs with transcript-derived names,
    title/first-message fallback, existing visible-empty filtering, newest-first ordering, and paging. Negotiated archive
    filters apply before paging.

    The history extension reads ordered committed segments and current committed configuration without Agent/MCP
    activation or provider requests. Initialized history reads do not take writer control or change saved evidence;
    uninitialized/recovery cases use existing model-independent Core admission and evidence checks rather than a new
    reader policy.

    Default list pages remain 30 with maximum 100; choose bounded transcript/observation limits from the existing readers
    and record them in the contract. Opening history does not change archive state or transcript evidence.

3. **Admission and mutation identity survive the transport change.**

    Workspace contracts validate connection, registration, canonical root, saved-Session membership, method capability,
    request identity, and applicable expected generation at the Core owner. Repeated identical requests return the
    recorded result without a second effect; a reused ID with different content is refused.

    Stale generation and foreign/disabled/relinked Project requests cannot mutate. Stop/close can settle owned work after
    access withdrawal.

    Preflight failures do not consume accepted-operation receipts. Preserve existing interruption/receipt outcomes; do
    not invent success for an uncertain result or automatically replay it.

4. **Conversation controls use the same Core rules.**

    Desktop creates/continues, selects supported Agent/model/thinking options, uses supported Session commands, answers
    exact choice/Other/approval values, queues unsent follow-ups, steers eligible work, and cancels through semantic
    methods. Committed configuration hydrates before each operation so an idle client cannot overwrite newer choices;
    staged changes retain existing timing rules.

    Queue dispatch keeps its request ID, retains rejected drafts/images, and runs once when available. Questions retain
    full schema and request/interaction identity; declined, cancelled, expired, and late answers settle or refuse
    correctly.

    Integrated review surfaces remain sibling work.

5. **Live observations remain correct after foreground return.**

    Bounded history plus operation snapshots reconcile by Session, generation, event/item identity, and cursor. The
    client observes idle Sessions and another process's active operation through existing live connections.

    Repeated snapshots, pre-response replay, and overlapping live events yield one chronological timeline. Late
    background results remain visible and can start their real continuation; Stop works while retained background work
    exists even without a pending prompt Promise.

    Subscriptions and retained Runtime resources release when their existing owners drain, not merely when a view hides.

6. **Archive is reversible and Project-scoped.**

    `session/delete` resolves an admitted saved ID without model activation. In Workspace, idle archive applies directly;
    busy archive asks once to stop and waits for durable settlement before hiding the row.

    Ordinary ACP deletion retains its current cancellation/archive contract. Rejected/failed archive retains the open
    link and a retry action.

    Project settings has General and Archived Sessions tabs with paging, direct open, and explicit Unarchive. Opening or
    continuing an archived Session does not unarchive it.

    Unarchive preserves Session ID, transcript, and Plan Associations; foreign-Project and unavailable Project mutations
    are refused.

7. **Images cross only bounded byte transfers.**

    Selection, paste with accompanying text, and drop support the existing formats and limits, preview/removal, and
    image-only prompts. Main and Runtime reject malformed or oversized payloads before acceptance; repeated UI handlers
    do not send the same image twice.

    Core persists scoped attachment references before committed transcript use and supplies bounded history previews.
    Model vision prerequisites stay Core-owned.

    Shared desktop text and image limits agree across composer, bridge, and client; no arbitrary path or filesystem
    operation enters preload.

8. **Shared composition carries the full conversation.**

    `SessionClientSurface` consumes semantic client state and reuses extracted composer/list components,
    `SessionTimeline`, and question forms without importing HTTP routes, Astro loaders, or Core execution. History paging
    preserves position; scrolling follows only at the live edge.

    Activity/Thinking disclosure, tool results, Agent transitions, saved images, supported command choices,
    configuration, and Session context remain visible. Project navigation preserves the bound Session, unsent drafts,
    pending answers, and queued intent.

    `ProjectWorkbench` keeps one shared left sidebar mounted across Session, Projects, and settings views. It provides
    Projects, five recent Sessions per accessible Project, Show more in batches of five, New Session, and settings
    access. All active Sessions remain discoverable before later Plan grouping. Queries use explicit per-Project read
    contexts without changing the active Session binding; loading or failure in one Project cannot block the others.

    New Session targets the selected admitted Project or opens Project selection. Opening it does not submit or save a
    conversation. A selected Session uses its stable ID, not its title. The existing Close-before-switch guard protects
    bound work; browsing or expanding another Project cannot retarget pending answers, images, or queued intent.

    The sidebar preserves expansion and scroll during navigation, restores collapse/width preferences, and uses the
    existing narrow-width overlay behavior. Logo/last-Session navigation, selected-row state, keyboard focus, long-name
    containment, and Project-local loading/error/retry states work without Dashboard data. Accessible list actions,
    tabs, status/error text, and confirmations use existing design-system patterns.

9. **Behavioral evidence covers both adapters and real processes.**

    New history/parity/cross-process suites named below run through the isolated runner and are registered where
    required. Existing continuation, background, question, timeline, archive, and ordinary ACP tests retain their
    behavior assertions after extraction.

    Extend the resolved dependency checks in `scripts/check-desktop.ts` / its tests so an alias, barrel, or dynamic
    import cannot route ACP/Core back into Workspace server code or route desktop into Core execution.

10. **Current documents match only proven delivery.**

    Update the capability requirements/scenarios named in Context, the contract inventory and exact extension schemas,
    and ADR-020's current implementation descriptions/references. Split the contract inventory's combined sidebar /
    dashboard row so Project/Session navigation is owned by this child and dashboard/Plan/attention additions remain
    with the dashboard child. Correct ADR-010's link label to accepted ADR-020 while
    preserving its public Runtime interface and sibling-adapter decision.

    Keep provider setup, integrated reviews, reconnect/supervisor lifetime, browser retirement, hosted identity, remote
    runtime, and installed-platform qualification explicitly targeted by their siblings. The existing glossary meaning
    of Session, Archived Session, and Plan Association remains unchanged.

## Approval Confirmation

No Work Record is proposed for replacement.

## Verification Plan

### Automated behavior

Use Bun 1.4.3, then `bun run install:locked` and `bun run desktop:setup`. Tests use disposable HOME, real Git Projects, file stores, native writer locks, and a controlled HTTP provider. Extend the provider fixture with vision support for positive image tests and a real background helper for delayed results. Use `withProcessGlobalTestLock` wherever a test changes HOME/cwd. No fake Core write/admission seams.

- **New `src/acp/workspace-session-history.process.test.ts`:**

    Launch the real source `wld acp`. Seed active and archived Sessions with multiple transcript segments, duplicate display names, an unnamed empty entry, and a generation-less saved entry.

    Remove credentials/defaults. List and page history; compare exact IDs, order, names, saved config, images, and entries to canonical evidence.

    Assert no provider call or transcript/archive mutation. Initialized reads must also leave manifest/generation unchanged and take no writer claim.

    A generation-less entry follows existing Core bootstrap checks without model activation; a live conflicting writer remains protected. Exercise page boundaries, foreign cursor/Session refusal, and generation changes between pages.

    A model-dependent load or empty placeholder reader fails this test.

- **History/archive cases:**

    Open an archived conversation without changing archive state; explicitly Unarchive, restart the process, and confirm unchanged ID/transcript/Plan Associations. Test idle Archive and busy Archive with decline/confirm, settlement, disabled/foreign Project refusal, and failed-action retry.

    Ensure filters run before paging and later empty pages keep Previous available. Continue an archived Session and confirm it remains archived.

- **New `src/acp/workspace-session-parity.process.test.ts`:**

    Send real standard and negotiated messages to the subprocess. Repeat an accepted request with the same ID/content, including after connection disposal and process restart, and assert one provider turn and one committed user message; conflicting content with that ID fails.

    Assert stale generation, wrong Project, unknown capability, oversized/malformed image, and held-writer refusal leave no effects. Test configured choices, staged configuration, exact answers, stale/duplicate answers, steering, and cancel during a question.

    Drive queue dispatch/removal through the real semantic client, not an invented Runtime queue-removal method. Inspect receipts and canonical entries, not only UI status.

- **Background and observations:**

    Use a real helper that completes after the initial prompt response. Assert the result and follow-up turn appear once, the operation is not falsely idle/completed, Stop settles retained work, and resources drain.

    Force repeated snapshots and a bounded observation gap; reload current evidence with no repeated prompt or duplicate timeline items. These cases fail if the implementation only wraps ordinary prompt/response or drops post-response events.

- **New `src/shared/session/session-continuation-cross-process.integration.test.ts`:**

    Run the ACP subprocess beside a separate TUI-owned Runtime process. With TUI idle, continue through desktop's semantic client; with desktop idle, change Agent/model/thinking and continue through the TUI owner.

    Verify exact durable identity, ordered committed text/configuration, idle-view updates, preserved draft, and no stale-config overwrite. Hold a real writer and assert exclusion, then release and continue.

    Answer/steer/cancel the other owner's live operation through the existing live connection. Two stores in one process are not sufficient evidence.

- **Native/shared UI:**

    Extend `desktop-session.integration.test.ts`, `desktop-entry.integration.test.ts`, `desktop-security.integration.test.ts`, and `session-client-surface.test.tsx`. Drive the built main/preload/renderer with real subprocess/provider evidence for discovery, provider-free history, Archived Sessions tabs, page navigation, configuration, image selection/paste/drop, image-only submission, rejection with retained draft, questions, queue/steer, and background Stop.

    Reject forged bindings, extra keys, oversized transfers, and untrusted frames before effects. Preserve the sandbox, context isolation, and distinct runtime PID assertions.

- **Left sidebar:** add `src/ui/workspace/project-sidebar.test.tsx` and extend the native entry/Session suites. Use two registered Projects, one delayed or failed list, more than ten Sessions, duplicate/long titles, and a disabled or missing root. Verify five initial rows and five-row Show more increments without duplicates, independent retry, selected IDs, settings access, and Archive/Unarchive list refresh. No provider is needed.

    Through the real semantic client, read Project B's sidebar while Project A owns an open Session and pending answer. Assert that the binding, draft/images, queued intent, and answer destination remain Project A. Test New Session with and without a selected Project, no saved Session before submission, and the existing Close-before-switch guard. A decorative sidebar or a list that changes the execution context fails these checks.

    Check mounted expansion/scroll across Session and settings navigation, collapse/restore, resize preference, narrow overlay focus return, logo/last-Session navigation, and keyboard reachability of long lists. Existing Project management and browser-sidebar tests remain protected.

### Focused commands

New test paths below are implementation outputs, not tests claimed to exist or pass during planning.

```sh
bun scripts/run-tests.js src/acp/workspace-session-history.process.test.ts src/acp/workspace-session-parity.process.test.ts src/shared/session/session-continuation-cross-process.integration.test.ts
bun scripts/run-tests.js src/acp/server.test.js src/acp/managed-session.integration.test.ts src/acp/background-task-wire.test.ts src/acp/sdk-client-background.test.ts src/acp/sdk-client-settlement.test.ts src/acp/workspace-entry.process.test.ts src/acp/client/workspace-session-client.test.ts src/acp/client/workspace-session-client.process.test.ts
bun scripts/run-tests.js src/ui/workspace/session-continuation.integration.test.ts src/ui/workspace/background-continuation.integration.test.ts src/ui/workspace/background-create.integration.test.ts src/ui/workspace/background-stop.integration.test.ts src/ui/workspace/owner-session-http.test.ts src/ui/workspace/workspace-session-ux.test.tsx src/ui/workspace/session-client-surface.test.tsx src/ui/workspace/session-question-form.test.tsx
bun scripts/run-tests.js src/shared/session/file-session-store.test.ts src/shared/session/managed-read-non-mutation.test.ts src/shared/session/managed-queue-lifecycle.test.ts src/shared/session/live-session-connection.test.ts src/shared/session/browser-question.test.ts scripts/check-desktop.test.ts
bun scripts/run-tests.js src/ui/workspace/project-sidebar.test.tsx
bun run desktop:check
bun run desktop:test
bun run workspace:check
bun run seams:check
bun run doc-links:check
```

### Coverage and architecture review

Preserve exact history/Agent/configuration hydration, named-invocation continuity, cross-owner interaction identity, writer exclusion, archive identity/associations, background continuation/disposal, image rejection before receipt, replay ordering, timeline tool/Activity chronology, and retained browser-question behavior. Run additional affected tests found through actual imports, including review/workflow callers of extracted operation bookkeeping.

The old text-only desktop restriction and ownership assertions that require the browser class to construct its own Runtime stop applying. Replace them with new behavioral and dependency-boundary assertions; do not delete the behaviors they protected. The old HTTP workbench remains operational. AI review must trace browser and negotiated ACP calls to the same Core rule implementations and verify that ordinary ACP history remains independent of Workspace registration/SQLite. Check documented capability claims against real process tests and keep unmet sibling scope marked target.

### Headed acceptance

Start `bun run desktop:dev -- --project /absolute/disposable-project --cdp-port 9222` on an available loopback port. Origin is `runwield://app/`; this is a build-and-launch command, not an HTTP or HMR server. Attach `agent-browser --cdp 9222` to this worktree's native window. Record origin, viewport, screenshots, console errors, and the actual provider/fixture used.

1. With provider settings absent, open Project history and Archived Sessions. Page names and a long segmented conversation; open a saved image. Read current saved configuration. Try a send: history and draft remain while setup guidance explains the actual prerequisite. Opening history never silently unarchives.
2. With a configured provider, create/continue a Session. Select Agent/model/thinking; use a supported slash choice; submit selected, pasted, and dropped images with previews and an image-only prompt. Reject an oversized image without losing valid draft content.
3. Answer choice/Other and approval, steer a running turn, queue then remove one unsent follow-up, dispatch another once, and Stop. Wait for a background result after the original prompt returns, then Stop background work. Confirm activity/status follows Core evidence.
4. In the left sidebar, expand two Projects, load more than ten Session names, and retry one failed Project list while the other remains usable. Open a Session by name and use New Session with and without a selected Project. Confirm opening the composer creates no saved history. Check the Close-before-switch guard while work is bound. Collapse/restore and resize the sidebar; navigate to Project settings and back with expansion, scroll, and draft intact. Check long names, keyboard access, selected-row state, and narrow-window overlay/focus return.
5. Use keyboard-only list/tab navigation and archive confirmation, including cancel/focus return. Archive idle and busy Sessions, open an archived conversation, and Unarchive it; verify sidebar rows refresh. Read older history without forced scrolling; Activity/Thinking disclosure stays open as new events arrive. Project settings navigation retains the bound Session and draft.
6. Keep a real idle TUI open on the same saved Session. Continue in desktop, return to TUI and continue with a changed configuration, then return to desktop. Confirm the same ID, current configuration, once-only content, and preserved unsent draft.

This child proves the source-development desktop journey. Window close/reopen survival, process-kill recovery, and three-platform installed qualification remain with their existing siblings.

## Edge Cases & Considerations

- One runtime serves explicit multiple Project contexts; cwd/home cannot become module-cached authority.
- Cancel/decline/expired interactions must settle under Core rules, not make uncertain work look complete.
- Slow consumers require bounds/backpressure and snapshot recovery rather than unlimited event retention. `createLiveOperation`'s current unbounded `undelivered` array is not the new observation store.
- A saved Session with no generation still needs verified evidence. Reuse model-independent Core bootstrap/recovery and its refusal rules; do not require provider setup just to establish readable history or bypass a live writer.
- History/list failures remain errors, not successful empty pages. A saved title wins over a stale catalog label; identical titles still select distinct IDs.
- Archive and Close remain different: Archive changes durable visibility; Close releases live resources. Neither deletes transcript history or concludes an associated Plan.
- Reviewable implementation assumption: exact new module names and bounded history/observation sizes may follow nearby conventions; preserve the owners, contracts, and behavioral proofs above.
- No new lock/lease or injection seam replaces Core-owned machinery. Do not use the obsolete owner-coordination heartbeat implementation in place of file-store writer control.
