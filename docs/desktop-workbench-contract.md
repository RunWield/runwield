# Desktop Workbench Contract

This inventory maps the local workbench to its runtime owners. It guides the
[desktop Epic](plans/local-workspace-desktop.md) and its
[first Session client](plans/local-workspace-desktop/run-a-real-session-in-electron.md).
It records source-development Project entry, provider configuration reuse, the Session boundary, and later parity
targets. It defines the implemented Project extension schemas, not future extensions or an installed/released app. Product requirements remain in
[Workspace](prd/runwield-workspace-prd.md#desktop-workspace) and
[ACP](prd/runwield-acp-protocol-prd.md#workspace-client-access).

## Host and authority boundary

Shared React components serve desktop and future hosted SaaS. There is no ACP migration of the old local browser
workbench. The current browser remains operational until child 12 retires that workbench. Standalone review, document,
and question hosts and the Plan share server remain supported.

Electron main owns the connection and subprocess, not Sessions or canonical stores. The renderer receives semantic
operations and serializable views through a validated preload bridge. `wld` owns execution, writer admission,
questions, committed history, and workflow decisions. Neither client caches nor displayed state authorize mutations.

The development app opens Projects without an argument. A native picker or optional `--project` supplies a candidate,
not authorization. Core registers and admits Projects on one persistent connection. Model work reuses existing Core
credentials and defaults; one Session view remains open at a time. The runtime uses the launcher's explicit Bun executable and this checkout's `src/cli.ts acp`, not a PATH-selected global command.
Connection identity, Project locator, wire Session ID, durable Session ID, message/tool IDs, and question request
identity are separate values. A known-ID load is not discovery.

Main validates the owning WebContents, top-level frame, exact origin, payload shape and size, and connection/Project/
Session binding before dispatch. The ACP client owns pending question identity and rejects stale or duplicate answers.
Core owns answer interpretation, cancellation settlement, writer admission, and durable state. Preload exposes only
named operations and cloned views, not IPC objects. The renderer has no Node integration; sandbox and context isolation
remain enabled. Main refuses navigation, popups, permissions, and asset traversal. External HTTP(S) links require
deliberate user activation and validation; generated content cannot open them automatically.

## Protocol baseline

Primary sources checked **2026-11-05**:

- [SDK 1.4.0 declarations](https://unpkg.com/@agentclientprotocol/sdk@1.4.0/dist/acp.d.ts).
- [ACP v1 Session discovery](https://agentclientprotocol.com/protocol/v1/session-list).
- [ACP v2 migration draft](https://agentclientprotocol.com/protocol/v2/migration).

| Topic                  | Pinned SDK 1.4.0 and current server                                                                                                                                               | Current v1 / v2 comparison                                                                                                         | Client rule                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection             | Root SDK exports `client`, `ndJsonStream`, and typed requests. `src/acp/sdk-client-background.test.ts` proves persistent notifications.                                           | SDK experimental v2 is a separate export.                                                                                          | Keep root SDK 1.4.0 and negotiate v1. Register handlers before connecting. No v2 conformance claim.                                                                                              |
| Initialization         | `createInitializeResponse` in `src/acp/server.js` advertises load, image prompts, close/delete, configuration and private steering in implementation metadata.                    | Current v1 discovery has its own optional capability; v2 reorganizes capability fields.                                            | Check selected version, load/close support and the required implemented-method set before new/load/prompt. Advertise form elicitation only, not filesystem, terminal or provider-auth callbacks. |
| Session methods        | SDK types include new/load/prompt/cancel/close, list, fork/resume and configuration. Server implements new/load/prompt/cancel/close/delete/configuration and `_session/steering`. | Current v1 requires `sessionCapabilities.list` before list. Server does not advertise list and registers an unimplemented handler. | Discovery is a server gap, not an SDK gap. No SDK upgrade or discovery call is needed for known-ID load.                                                                                         |
| Replay                 | Server sends `session/update` replay before the load response; response metadata supplies the durable ID.                                                                         | v2 removes load in favor of resume with replay selection.                                                                          | Capture replay during the pending load. Preserve the requested wire ID and returned durable ID. Do not apply v2 resume semantics.                                                                |
| Turn completion        | v1 prompt returns a stop reason. Existing server can send background output after `end_turn`.                                                                                     | v2 prompt response acknowledges acceptance; foreground completion moves to `state_update`.                                         | A v1 prompt response settles that prompt, not the workflow or subscription. Keep handlers attached. Unknown optional updates cannot imply success.                                               |
| Updates                | Server mapper supplies message/tool identity in wire updates and metadata.                                                                                                        | v2 makes ID-based upserts uniform and changes tool/plan update variants.                                                           | Reconcile the actual v1 wire data by supplied IDs. Do not merge unrelated messages or duplicate user echoes. Do not assume v2 patch semantics.                                                   |
| Questions              | SDK supports `elicitation/create`. `src/acp/interaction-mapper.js` emits string text, enum strings and optional `otherAnswer`.                                                    | v2 adds foreground-state and request/session-scoping rules.                                                                        | Reply to the pending request, never an invented answer RPC. Preserve exact strings; Core interprets approval. Reject unsupported schemas visibly.                                                |
| Cancellation and close | Server accepts cancel as a notification and close as a request. Close releases live resources.                                                                                    | v2 changes settlement reporting and makes close a baseline method.                                                                 | Wait for actual v1 settlement, not a cancel response. Close is not archive/delete, unsubscribe or process termination.                                                                           |

The server also registers authenticate/logout/provider management, list/fork/resume/mode and NES methods as
unimplemented. SDK declarations are not proof of server support. Later capabilities below require explicit negotiation;
future inventory entries publish no callable stubs. The implemented Project group is specified below.

## Workspace Project protocol version 1

The source runtime accepts `clientCapabilities._meta["dev.runwield/workspace"] = {"version":1}`
on `initialize`. Unsupported versions and repeated Workspace negotiation fail before mutation. The response
`_meta["dev.runwield/workspace"]` is `{version:1, connectionId:string, projects:{version:1}}`.
Admission remains fixed for that connection. No opt-in means ordinary cwd-based ACP behavior.

All Project methods use prefix `_dev.runwield/workspace/projects/`. They require negotiation.
Payloads are exact objects (no extra keys). Strings contain no NUL; IDs are 1–128 characters,
absolute paths 1–4096, display names 1–200, confirmation tokens 1–128.

| Method       | Request                                                   | Result                                    |
| ------------ | --------------------------------------------------------- | ----------------------------------------- |
| `list`       | `{}`                                                      | `{projects:WorkspaceProjectView[]}`       |
| `open`       | `{projectId}`                                             | `{context:WorkspaceProjectContext}`       |
| `register`   | `{root,displayName?,directoryConfirmation?}`              | `WorkspaceProjectWriteResult`             |
| `relink`     | `{projectId,newRoot,displayName?,directoryConfirmation?}` | `WorkspaceProjectWriteResult`             |
| `setEnabled` | `{projectId,enabled:boolean}`                             | `{project:WorkspaceProjectView}`          |
| `remove`     | `{projectId}`                                             | `{removed:true}`                          |
| `rescan`     | `{projectId}`                                             | `{cataloged:number,diagnostics:string[]}` |

`WorkspaceProjectView` contains `projectId`, optional `displayName`, `rootLabel`, optional `lifecycle`,
`healthStatus`, `healthEvidence:string[]`, and `enabled:boolean`. It contains no absolute root or raw health error.
`WorkspaceProjectContext` is `{connectionId,projectId,canonicalRoot}`. Only `open` supplies admitted roots.
`WorkspaceProjectWriteResult` is `{status:"ok",project:WorkspaceProjectView}` or
`{status:"confirmation_required",confirmation:string,message:string}`. Confirmation is bound to the entered and
canonical root and the runtime process; retry re-inspects the directory. No write precedes consent.

Every Workspace new/load request retains standard `cwd` and supplies
`_meta["dev.runwield/workspace"] = WorkspaceProjectContext`. All later Session mutations (including
steering, config, delete, cancel and close) supply the same metadata. Core retains the binding per wire Session.
`cwd` must equal the admitted canonical root. Load also checks canonical saved-Session membership; a private
`sessionPath` override is refused on Workspace connections. Cancel/close may settle only that connection's own
Session with its original binding, even after disable, removal, relink, or filesystem loss.

Project/admission failures use JSON-RPC `-32602` for `invalid_params`, otherwise `-32002`, with
`data:{code:string}`. Codes are `workspace_version_unsupported`, `workspace_not_negotiated`,
`workspace_already_initialized`, `project_not_found`, `project_unavailable`, `project_conflict`,
`project_directory_invalid`, `workspace_binding_invalid`, and `session_project_mismatch`.
Messages redact local filesystem errors. Provider prerequisite refusals retain `-32000`, with
`data:{cwd,code,prerequisite,guidance}`. Codes are `default_model_required` or `provider_prerequisite`;
guidance directs the user to external `wld login`, then desktop restart. This adds no setup/refresh API.

## Capability inventory

Source paths below are relative to `src/ui/workspace/` unless they start with `src/`. Child numbers refer to the
[delivery map](#delivery-map), not the parent document's older sequence. “Proposed extension” identifies an unresolved
mapping owned by that child, not a callable endpoint.

| Current surface or entry                                                 | Current authoritative owner / adapter                                                                                            | Standard method or proposed extension                                                              | Parity scenario and capability/refusal rule                                                                                                                                                                                                 | Child                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `/projects`, Project settings, `/api/owner/projects` and Project actions | `src/shared/owner-coordination/{projects,owner-projects}.ts`; browser `routes/owner-api.js`; ACP `src/acp/workspace-projects.ts` | Implemented version 1 Project group above                                                          | Register, confirm, relink, enable/disable, rescan and remove. A picker supplies a candidate, not trust. Reject a wrong root; removal does not delete the repository.                                                                        | 2                                         |
| Provider readiness and Session options                                   | Core provider/settings owners through `src/acp/server.js` and `routes/owner-session-api.js`                                      | Existing readiness refusal and configuration reuse; provider setup extension deferred to child 10. | Show the actual missing provider/default-model prerequisite, not Workspace sign-in. Use external `wld login` then restart in child 2; in-app setup belongs to child 10. Never expose credentials.                                           | 2                                         |
| Session create, known-ID load, prompt and output                         | Core Session runtime through `src/acp/server.js`; current HTTP owner is `server/session-continuation.js`                         | `session/new`, `session/load`, `session/prompt`, `session/update`                                  | A separate runtime streams into the live DOM; closing and loading retains committed history. Bind cwd to Core-admitted Project context on Workspace connections; ordinary ACP remains cwd-based. Refuse incompatible peers before mutation. | 1                                         |
| Session list, history and live snapshots                                 | Canonical Session owners through `server/session-continuation.js`; `routes/owner-session-api.js`                                 | Standard `session/list`; proposed bounded history/observation extension                            | Discover and read saved history without provider readiness; Archived Sessions settings, paging, open and Unarchive belong here. List is currently absent; do not call it or scan storage from desktop.                                      | 3                                         |
| Agent/model/thinking selection                                           | Core Session configuration; `routes/owner-session-api.js`, `src/acp/server.js`                                                   | Existing `session/set_config_option`; proposed mapping for remaining options                       | Preserve committed settings rather than UI cache. Reject invalid options and wrong Sessions; do not substitute unimplemented `session/set_mode`.                                                                                            | 3                                         |
| Questions and approvals; HTTP answer route                               | Core interaction owner through `src/acp/interaction-mapper.js`; `routes/owner-session-api.js`                                    | `elicitation/create` response                                                                      | Required text rejects whitespace; optional text permits empty input. Preserve choice plus optional Other text. No silent defaults. Reject stale, duplicate, canceled or wrong-Session answers. Retain no-form external-client fallback.     | 1 basic; 3 parity                         |
| Attachments, images and resources                                        | Core prompt validation; `routes/owner-session-api.js`, `islands/SessionSurface.jsx`                                              | Standard image/resource prompt blocks where supported; bounded host transfers                      | Select/paste/drop only supported content. Refuse size/type/access violations. No renderer filesystem access. No attachment control in child 1.                                                                                              | 3                                         |
| Queued input, steering and background output                             | Core live operations; `src/acp/server.js`, current `server/session-continuation.js`                                              | Existing `_session/steering`; proposed queue/observation mapping                                   | Preserve queued intent and delayed results after a prompt ends. Negotiate support; an unknown update is not completed work.                                                                                                                 | 3                                         |
| Stop, close, archive/unarchive                                           | Core Session lifecycle; `routes/owner-session-api.js`, `src/acp/server.js`                                                       | Standard cancel notification and close request; archive mapping remains proposed                   | Stop a held stream/question, await settlement, then send again. Close retains history. Never substitute delete for archive or close. Dismiss forms and refuse late answers.                                                                 | 1 Stop/close; 3 archive                   |
| Receipts, writer admission, force recovery and reconnect                 | Core Session/owner-coordination owners; current `server/session-continuation.js`                                                 | Proposed bounded recovery/observation extension                                                    | Preserve locks, generations and durable evidence. Refuse stale/conflicting writers. Connection loss interrupts work; never resubmit uncertain input automatically.                                                                          | 3 services; 4 recovery                    |
| `/`, sidebar, dashboard APIs and dashboard stream                        | Plan/Session/registry owners aggregated by `server/owner-dashboard.ts`; `routes/owner-api.js`                                    | Proposed dashboard read/observe extension                                                          | Preserve incremental attention sections, Project progress and partial failures. Projection is not authority. An unavailable section is not an empty successful result.                                                                      | 7                                         |
| Attention notifications and navigation                                   | Runtime attention evidence; `browser/workspace-notifications.ts`, `browser/session-tab-notifications.ts`                         | Proposed attention observation plus native host adapter                                            | Preserve notification policy and deliberate navigation. Permission denial does not block work. No fabricated completion or automatic external navigation.                                                                                   | 7; 4 lifetime                             |
| Plan boards, details, closed/on-hold views and progress                  | `src/plan-store.js`, workflow controller and worktree registry; `server/plan-adapter.js`, `server/owner-plan-progress.ts`        | Proposed Plan reads/progress extension                                                             | Show canonical state and evidence-based actions. Refuse unavailable resources and stale references; retain Plan-store abstraction.                                                                                                          | 5 boards; 6 progress                      |
| Plan actions, edits and workflow launch                                  | `src/shared/workflow/plan-actions.ts`; `server/owner-plan-actions.ts`, `routes/owner-plan-continuation.ts`                       | Proposed revision/generation-bound mutation extension                                              | Preserve request hashes, durable receipts, writer admission and refresh/recovery outcomes. Duplicate requests cannot repeat effects.                                                                                                        | 5 editing; 6 execution                    |
| Integrated Plan Review and questions                                     | `src/shared/workflow/plan-review-actions.ts`; `react/PlanReviewSurface.tsx`, `server/session-continuation.js`                    | Proposed review-resource/decision extension                                                        | Retain revision-bound answers and review decisions. Reject stale decisions. Basic form elicitation is not integrated Plan Review parity.                                                                                                    | 5                                         |
| Code Review, conversation, AI review and guide jobs                      | Core review/workflow owners through `src/shared/browser-host/{review-handlers,review-agent-handlers,review-widget-handlers}.ts`  | Proposed review-resource, decision and job-observation extensions                                  | Preserve candidate identity, discussion, progress, cancellation and receipts. A plain approval boolean cannot replace a durable review decision.                                                                                            | 6                                         |
| Artifact/document routes and search APIs                                 | Plan store, Work Records and Session manifests; `server/project-artifacts.ts`, `server/workspace-search.ts`                      | Proposed artifact/search extensions                                                                | Preserve Project/type filters and pagination. Search SQLite is rebuildable projection. Refuse traversal, wrong Project and unavailable sources.                                                                                             | 8                                         |
| `/usage`, report APIs and command metrics                                | `src/shared/workflow/usage-reporting.ts`; `server/owner-usage.ts`, `routes/owner-session-api.js`                                 | Proposed report/metrics operations                                                                 | Preserve filters, evidence links and deduplication. Standard per-Session usage updates do not supply portfolio-report parity.                                                                                                               | 9                                         |
| `/usage/settings`, recording, exports, grants, credentials and clearing  | Existing settings/metrics owners; `server/owner-usage-settings.ts`                                                               | Proposed settings operations                                                                       | Preserve scoped approvals, confirmations and remote restrictions. Never send exporter credentials into renderer views/storage.                                                                                                              | 9                                         |
| Review file content, images, uploads and UI preferences                  | `src/shared/browser-host/{review-file-handlers,review-image-handlers}.ts`                                                        | Proposed scoped resource transfer; local host preferences                                          | Preserve lexical and real-path containment. No general filesystem RPC. Current open-in-apps response is unavailable; config acknowledges cookie-owned preferences, not native editor launch.                                                | 5–6 resources; 8 documents                |
| Pairing, devices, standalone question/document/review hosts and sharing  | Existing browser auth, `src/shared/browser-host/{standalone,review-host}.ts` and Plan share server                               | Retained browser hosting, not desktop/cloud authentication                                         | Keep standalone viewers and share links operational. Do not port the retired local browser workbench to ACP or redefine the public glossary in child 1.                                                                                     | 12                                        |
| Native links, windows, menus, shortcuts and application preferences      | Host responsibility; existing browser behavior in `static/workspace-shell.ts` is reference only                                  | Named host operations, not runtime storage authority                                               | Sandbox/context isolation/no Node in renderer. Refuse navigation, popups, permissions and unsafe schemes. Only deliberate validated HTTP(S) links open externally. Window close and Quit remain distinct.                                   | 1 secure boundary; 4 lifetime; 11 updates |

## Delivery map

1. [Real Session boundary](plans/local-workspace-desktop/run-a-real-session-in-electron.md).
2. [Project entry and existing provider configuration reuse](plans/local-workspace-desktop/open-projects-and-configure-providers.md).
3. [Provider-independent saved history, Archived Sessions, and full Session parity](plans/local-workspace-desktop/continue-saved-sessions-in-desktop.md).
4. [Window and process lifetime](plans/local-workspace-desktop/keep-work-safe-across-window-and-process-changes.md).
5. [Plan editing and review](plans/local-workspace-desktop/review-and-edit-plans-inside-desktop.md).
6. [Workflow execution and Code Review](plans/local-workspace-desktop/run-plans-through-integrated-code-review.md).
7. [Attention and dashboard](plans/local-workspace-desktop/find-and-act-on-work-that-needs-attention.md).
8. [Knowledge reading and search](plans/local-workspace-desktop/read-and-search-project-knowledge.md).
9. [Usage and export controls](plans/local-workspace-desktop/inspect-usage-and-control-recording-and-export.md).
10. [Configure model providers in desktop Settings](plans/local-workspace-desktop/configure-model-providers-in-desktop-settings.md).
11. [Install and update](plans/local-workspace-desktop/install-and-update-the-bundled-application.md).
12. [Local browser cutover](plans/local-workspace-desktop/retire-only-the-local-browser-workbench.md).
13. [Platform qualification](plans/local-workspace-desktop/qualify-and-release-desktop-on-three-platforms.md).

## Development setup and checks

Use Bun **1.4.3**, Git, and a graphical desktop session. Root dependencies pin Electron **45.2.3** and
`playwright-core` **1.64.1**. Dependency installation disables lifecycle scripts; provision Electron explicitly.
Setup needs network access to the Electron release checksums and binary download. It checks the package version,
compares its archive checksum with upstream, invokes that package's installer, and verifies the installed identity.
It does not select release packaging or enable dependency lifecycle scripts.

From the checkout root:

```sh
bun run install:locked
bun run desktop:setup
bun run desktop:check
bun run desktop:build
bun run desktop:dev
```

Open Project selects an existing directory; review its path and optional name, then Link Project. Cancel changes
nothing. The optional `--project /absolute/project` follows the same registration/admission checks. Settings supports
relink, enable/disable, full Session rescan, and removal without deleting files or saved Sessions. An open Session
keeps its binding; close it explicitly before selecting another Project for Session work.

For model work, configure Core credentials and a default model externally with `wld login`, then restart desktop.
Existing global, Project, and linked-worktree settings are read in place. Missing setup leaves Project management
available and shows the actual Core prerequisite, not Workspace sign-in. No provider editor or credential import
exists here; in-app setup belongs to child 10. Provider-independent saved-history browsing and Archived Sessions
belong to child 3. Local use needs no Workspace account.
`desktop:dev` builds and launches the native app at `runwield://app/`, not an HTTP/HMR server. Main uses the launcher's
Bun executable and this checkout's source CLI. No global `wld` installation is used. Build output is `dist/desktop/`.

Optional development inspection is explicit:

```sh
bun run desktop:dev -- --project /absolute/project --cdp-port 9222
```

The port must be 1024–65535 and binds to loopback. Normal launch exposes no debug port. Do not use a browser-only page
as evidence of native behavior.

Run the native tests and focused protocol/shared-UI checks through the isolated runner:

```sh
bun run desktop:test
bun scripts/run-tests.js src/acp/client/workspace-session-client.test.ts src/acp/client/workspace-session-client.process.test.ts src/acp/sdk-client-settlement.test.ts src/ui/workspace/session-client-surface.test.tsx src/ui/workspace/session-question-form.test.tsx scripts/check-desktop.test.ts
```

`desktop:test` builds first, then runs all three native integration files. Direct focused native runs require
`desktop:setup` and `desktop:build` first. Missing binaries, artifacts, or a Linux display fail; they are not skips.
Native tests use private HOME, a disposable Git Project, isolated database paths, and a controlled HTTP provider.
They do not need the owner's provider credentials.

Linux also needs Electron system libraries, a working Chromium sandbox, and a display. The PR workflow installs
`xvfb`, `xauth`, `libgtk-3-0`, `libnss3`, `libgbm1`, and `libasound2t64`. For a headless Linux environment with these
prerequisites:

```sh
xvfb-run -a bun run desktop:test
```

Do not disable the sandbox to pass a test. The [PR workflow](../.github/workflows/pr.yml) runs source CI under Xvfb.
The [CI runner](../scripts/run-ci.ts) completes setup before parallel pre-test checks, including desktop build/check.
`test`, `test:all`, and `test:bun` also prepare desktop artifacts. Both isolated runners preserve `DISPLAY` and
`XAUTHORITY` while retaining private HOME/database paths and credential filtering. This wiring is not proof of a
successful Linux run.

## Acceptance evidence

The [Session verification plan](plans/local-workspace-desktop/run-a-real-session-in-electron.md#verification-plan)
and [Project entry verification plan](plans/local-workspace-desktop/open-projects-and-configure-providers.md#verification-plan)
define the boundary assertions. ADR acceptance records a decision, not delivery evidence. The following focused
checks passed in this development change; full repository CI remains pending.

| Evidence                                                                                      | What it proves                                                                                                                                                                                                                                                                               | Limit                                                          |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Native Session tests](../src/ui/desktop/desktop-session.integration.test.ts), 7 cases        | Built main/preload/renderer, distinct real source-runtime PID, visible held output, exact choice/Other in the next provider request, Stop then send, controlled shutdown, known-ID replay and continuation checked against canonical history, interrupted draft with no resubmission         | Controlled provider; source build, not installer qualification |
| [Native security tests](../src/ui/desktop/desktop-security.integration.test.ts), 4 cases      | Main refuses invalid payloads and untrusted callers; hostile content cannot gain bridge, navigation, popup, or script privileges                                                                                                                                                             | Tested native boundary, not a general security certification   |
| [Shared Session DOM tests](../src/ui/workspace/session-client-surface.test.tsx), 5 cases      | Shared React composition reaches a real source subprocess for streaming, Stop, question answers, provider prerequisites, replay, and disconnected drafts                                                                                                                                     | DOM environment, not a substitute for native tests             |
| [Runtime boundary tests](../scripts/check-desktop.test.ts), 29 cases                          | Real resolved runtime graphs and local fonts/styles pass; forbidden dependencies hidden behind barrels, dynamic imports, or re-exports fail; erased types do not create runtime coupling. Nine additional cases reject Core-to-Workspace server paths, including retained browser-host paths | Dependency boundary checks, not runtime feature parity         |
| [Persistent client process tests](../src/acp/client/workspace-session-client.process.test.ts) | Real subprocess/provider-input checks for streaming, exact answers, cancellation, replay, and interrupted connections                                                                                                                                                                        | No native window                                               |
| [SDK settlement tests](../src/acp/sdk-client-settlement.test.ts), 2 cases                     | Stop and Close settle a pending non-turn command form, cancel its client request, and deliver cancellation text before prompt settlement                                                                                                                                                     | No expansion of request-context cancellation semantics         |
| [Shared question form tests](../src/ui/workspace/session-question-form.test.tsx)              | Raw choice/Other fields retain existing browser callbacks and HTTP submission behavior                                                                                                                                                                                                       | Not full browser-workbench regression proof                    |

Project entry adds these focused checks; child 1 and shared question-form coverage above remain in place:

- [Native entry tests](../src/ui/desktop/desktop-entry.integration.test.ts), 10 cases: no-argument entry, real Project
  operations, picker cancellation, confirmation retry/focus, provider prerequisites/reuse and failures, relink names,
  and privileged boundary validation.
- [Project process tests](../src/acp/workspace-entry.process.test.ts), 9 cases: real registration/admission effects,
  canonical history preservation on refusal, accepted-answer access checks, safe settlement after access changes,
  ordinary ACP compatibility, existing defaults, and Project/linked-worktree overrides without rewritten settings.
- [ACP server tests](../src/acp/server.test.js), 73 cases, and shared Session DOM tests, 5 cases, passed again after
  extraction. The resolved ACP/shared runtime graph has no executable Workspace server dependency. Project policy
  lives in `src/shared/owner-coordination/owner-projects.ts`; standalone browser hosting and review handlers live in
  `src/shared/browser-host/`. Browser adapters retain their HTTP and authentication responsibilities.

The dedicated desktop type checks and runtime graph gate also passed. Existing in-process SDK coverage establishes
wire behavior but cannot alone establish the subprocess or Electron boundary. Retained browser Artifact Review,
review routes, no-form questions, and background-delivery regression checks pass after building Workspace assets.

### Manual native checks: macOS arm64 only

The Project-entry source build opened without a Project argument under a disposable HOME. The native picker opened
and canceled with zero registration writes; an optional candidate was linked separately. Settings disable/removal
and the confirmation dialog's initial Quit focus, Escape cancellation, and focus return were inspected. Screenshots:
`/tmp/de-9b3-projects-wide.png` (1440×900) and `/tmp/de-9b3-settings-narrow.png` (900×900). macOS blocked automated
native selection with permission code 1002. The owner then selected a directory through Open Project, linked it,
and confirmed that it worked.

An isolated HOME showed the actual missing-default error. After relaunch with normal HOME, the app reused existing
`openai-codex/gpt-6-sol` configuration without credential import or copy. A real Session in disposable Project
`/tmp/wld-entry-SSbnWc/project` returned “2 + 2 is 4.” Saved ID: `01a1ce56-0d3e-76be-a8de-cb8fb8d991bc`.
The UI returned to Ready; renderer errors and console were empty, renderer storage was `{}`, and the 1440×868 content
viewport had no horizontal overflow. Screenshot: `/tmp/de-9b3-existing-provider.png`.

A final headed pass checked home-warning Tab containment, invalid-root retry with retained inputs, missing-root
settings, relink, disable/enable, and full rescan at 900×900. Removal retained a Project marker file and unchanged
SHA-256 hashes for all saved Session files; re-add created a different registration ID. Attempting another Project
with an open Session was refused, and the Session retained its original root. Screenshots:
`/tmp/de-9b3-final-management.png`, `/tmp/de-9b3-switch-refused.png`, and `/tmp/de-9b3-readded-project.png`.

A disposable HOME first showed the missing-default guidance. External fixture configuration and desktop restart
then produced a controlled-provider turn. Invalid credentials and a stopped provider listener showed their actual
access/outage errors, not Workspace sign-in prompts; Project settings and disable/enable remained usable. Screenshots:
`/tmp/de-9b3-external-setup-before.png`, `/tmp/de-9b3-external-setup-after.png`,
`/tmp/de-9b3-invalid-provider.png`, and `/tmp/de-9b3-provider-outage.png`. The final renderer checks found no console
errors or horizontal overflow, empty renderer storage, and only successful local asset requests. Provider traffic
stayed in Core; these checks used no Workspace account or cloud service.

These local artifacts are temporary evidence, not durable fixtures. These are macOS arm64 source-build checks, not
installed-platform qualification or Windows/Linux evidence. The final focused run passed 17 files with no failures
or skips. Full CI remains pending through RunWield.

Installers, updates, remote transport/trust, always-on service lifetime, hosted identity, and platform qualification
remain separate targets or unresolved choices with the owners in the delivery map.
