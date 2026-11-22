# Desktop Workbench Contract

This inventory maps the local workbench to its runtime owners. It guides the
[desktop Epic](plans/local-workspace-desktop.md) and its
[first Session client](plans/local-workspace-desktop/run-a-real-session-in-electron.md).
It records source-development Project entry, provider configuration reuse, parallel Sessions, local process recovery,
and later parity targets. It defines the implemented Project and Session extension schemas, not future extensions or
an installed/released app. Product requirements remain in
[Workspace](prd/runwield-workspace-prd.md#desktop-workspace) and
[ACP](prd/runwield-acp-protocol-prd.md#workspace-client-access).

## Host and authority boundary

Shared React components serve desktop and future hosted SaaS. There is no ACP migration of the old local browser
workbench. The current browser remains operational until child 12 retires that workbench. Standalone review, document,
and question hosts and the Plan share server remain supported.

Electron main owns the single-instance supervisor, connection, and subprocess, not Sessions or canonical stores.
The renderer receives semantic operations and serializable views through a validated preload bridge. `wld` owns execution, writer admission,
questions, committed history, and workflow decisions. Neither client caches nor displayed state authorize mutations.

The development app opens Projects without an argument. A native picker or optional `--project` supplies a candidate,
not authorization. Core registers and admits Projects on one persistent connection. Model work reuses existing Core
credentials and defaults. Any number of Sessions can run in parallel within one Project or across Projects. The window
selects one view; selection never stops or retargets another binding. The runtime uses the launcher's explicit Bun
executable and this checkout's `src/cli.ts acp`, not a PATH-selected global command.
Connection identity, Project locator, wire Session ID, durable Session ID, message/tool IDs, and question request
identity are separate values. Discovery uses standard `session/list`; passive history does not activate model work.

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

| Topic                  | Pinned SDK 1.4.0 and current server                                                                                                                                                    | Current v1 / v2 comparison                                                                         | Client rule                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection             | Root SDK exports `client`, `ndJsonStream`, and typed requests. `src/acp/sdk-client-background.test.ts` proves persistent notifications.                                                | SDK experimental v2 is a separate export.                                                          | Keep root SDK 1.4.0 and negotiate v1. Register handlers before connecting. No v2 conformance claim.                                                                                              |
| Initialization         | `createInitializeResponse` in `src/acp/server.js` advertises load, image prompts, close/delete, configuration and private steering in implementation metadata.                         | Current v1 discovery has its own optional capability; v2 reorganizes capability fields.            | Check selected version, load/close support and the required implemented-method set before new/load/prompt. Advertise form elicitation only, not filesystem, terminal or provider-auth callbacks. |
| Session methods        | SDK types include new/load/prompt/cancel/close, list, fork/resume and configuration. Server implements list/new/load/prompt/cancel/close/delete/configuration and `_session/steering`. | Current v1 requires `sessionCapabilities.list` before list. Server advertises and implements list. | Use standard discovery; no SDK upgrade is required. Known-ID load remains available.                                                                                                             |
| Replay                 | Ordinary load sends `session/update` replay before its response; negotiated load supplies passive history metadata.                                                                    | v2 removes load in favor of resume with replay selection.                                          | Capture replay during the pending load. Preserve the requested wire ID and returned durable ID. Do not apply v2 resume semantics.                                                                |
| Turn completion        | v1 prompt returns a stop reason. Existing server can send background output after `end_turn`.                                                                                          | v2 prompt response acknowledges acceptance; foreground completion moves to `state_update`.         | A v1 prompt response settles that prompt, not the workflow or subscription. Keep handlers attached. Unknown optional updates cannot imply success.                                               |
| Updates                | Server mapper supplies message/tool identity in wire updates and metadata.                                                                                                             | v2 makes ID-based upserts uniform and changes tool/plan update variants.                           | Reconcile the actual v1 wire data by supplied IDs. Do not merge unrelated messages or duplicate user echoes. Do not assume v2 patch semantics.                                                   |
| Questions              | SDK supports `elicitation/create`. `src/acp/interaction-mapper.js` emits string text, enum strings and optional `otherAnswer`.                                                         | v2 adds foreground-state and request/session-scoping rules.                                        | Reply to the pending form; negotiated cross-owner answers use the versioned Session extension. Preserve exact strings; Core interprets approval. Reject unsupported schemas visibly.             |
| Cancellation and close | Server accepts cancel as a notification and close as a request. Close releases live resources.                                                                                         | v2 changes settlement reporting and makes close a baseline method.                                 | Wait for actual v1 settlement, not a cancel response. Close is not archive/delete, unsubscribe or process termination.                                                                           |

The server also registers authenticate/logout/provider management, fork/resume/mode and NES methods as
unimplemented. SDK declarations are not proof of server support. Later capabilities below require explicit negotiation;
future inventory entries publish no callable stubs. The implemented Project and Session groups are specified below.

## Workspace Project protocol version 1

The source runtime accepts `clientCapabilities._meta["dev.runwield/workspace"] = {"version":1}`
on `initialize`. Unsupported versions and repeated Workspace negotiation fail before mutation. The response
`_meta["dev.runwield/workspace"]` is `WorkspaceCapability`, including `projects:{version:1}` and
`sessions:{version:1,historyPageLimit:200,observationEventLimit:500}`.
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

Every Workspace new/load request retains standard `cwd` and supplies the admitted context in
`_meta["dev.runwield/workspace"]`. Standard mutations use `WorkspaceSessionMutationMetadata` below.
Core retains the binding per wire Session. `cwd` must equal the admitted canonical root. Load checks canonical
saved-Session membership; a private `sessionPath` override is refused. Cancel/close can settle only the connection's
own binding, including after disable, removal, relink, or filesystem loss.

Project/admission failures use JSON-RPC `-32602` for `invalid_params`, otherwise `-32002`, with
`data:{code:string}`. Codes are `workspace_version_unsupported`, `workspace_not_negotiated`,
`workspace_already_initialized`, `project_not_found`, `project_unavailable`, `project_conflict`,
`project_directory_invalid`, `workspace_binding_invalid`, and `session_project_mismatch`.
Messages redact local filesystem errors. Provider prerequisite refusals retain `-32000`, with
`data:{cwd,code,prerequisite,guidance}`. Codes are `default_model_required` or `provider_prerequisite`;
guidance directs the user to external `wld login`, then desktop restart. This adds no setup/refresh API.

## Workspace Session protocol version 1

The same opt-in advertises `WorkspaceSessionCapability`. The following named TypeScript schemas are based on
[`src/acp/workspace-contract.ts`](../src/acp/workspace-contract.ts). `WorkspaceProjectContext` is defined above; `WorkspaceProjectCapability` is `{version:1}`;
`WorkspaceJsonRecord` maps string keys to JSON values or `undefined`. No schema grants filesystem access or exposes
credentials. Extension requests reject unsupported top-level keys. Settlement and receipt-resolution shapes below
expand the aliases from the shared Core submission contract; they do not create a second authority.

```ts
export type WorkspaceJson = string | number | boolean | null | WorkspaceJson[] | WorkspaceJsonRecord;
export interface WorkspaceJsonRecord {
    [key: string]: WorkspaceJson | undefined;
}
export interface WorkspaceCapability {
    version: 1;
    connectionId: string;
    projects: WorkspaceProjectCapability;
    sessions?: WorkspaceSessionCapability;
}
export const WORKSPACE_SESSION_PREFIX = "_dev.runwield/workspace/sessions/";
export const WORKSPACE_SESSION_OPERATIONS = [
    "history",
    "snapshot",
    "options",
    "command",
    "configure",
    "answer",
    "unarchive",
    "drain",
    "resolveSubmission",
] as const;
export type WorkspaceSessionOperation = (typeof WORKSPACE_SESSION_OPERATIONS)[number];
export const WORKSPACE_HISTORY_PAGE_LIMIT = 200;
export const WORKSPACE_OBSERVATION_EVENT_LIMIT = 500;
export const WORKSPACE_OBSERVATION_BYTE_LIMIT = 2 * 1024 * 1024;
export interface WorkspaceSessionCapability {
    version: 1;
    historyPageLimit: number;
    observationEventLimit: number;
}
export interface WorkspaceSessionRequest {
    context: WorkspaceProjectContext;
    sessionId: string;
}
export interface WorkspaceMutationIdentity {
    requestId: string;
    expectedGeneration: number;
}
export interface WorkspaceHistoryRequest extends WorkspaceSessionRequest {
    cursor?: string;
    limit?: number;
}
export interface WorkspaceConfiguration {
    agentName: string;
    model: string;
    provider: string;
    thinkingLevel: string;
}
export interface WorkspaceHistoryEvent extends WorkspaceJsonRecord {
    type: string;
    eventId: string;
}
export interface WorkspaceHistoryResult {
    sessionId: string;
    generation: number;
    archivedAt: string | null;
    events: WorkspaceHistoryEvent[];
    configuration: WorkspaceConfiguration;
    previousCursor: string | null;
    complete: boolean;
}
export interface WorkspaceSnapshotRequest extends WorkspaceSessionRequest {
    /** Required only while the new composer has no durable Session ID. */
    wireSessionId?: string;
    cursor?: string;
}
export interface WorkspaceSnapshotResult {
    sessionId: string;
    generation: number | null;
    state: string;
    cursor: string;
    gap: boolean;
    operation: WorkspaceJsonRecord | null;
}
export interface WorkspaceCommandRequest {
    context: WorkspaceProjectContext;
    wireSessionId: string;
    text: string;
}
export interface WorkspaceConfigureRequest extends WorkspaceSessionRequest, WorkspaceMutationIdentity {
    agentName?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
}
export interface WorkspaceAnswerRequest extends WorkspaceSessionRequest {
    operationId: string;
    interactionId: string;
    requestId: string;
    response: WorkspaceAnswerFields;
}
export interface WorkspaceUnarchiveRequest extends WorkspaceSessionRequest {}
export interface WorkspaceSessionListRequest {
    context: WorkspaceProjectContext;
    archiveState?: "active" | "archived" | "all";
    cursor?: string;
    limit?: number;
}
export interface WorkspaceSavedSession {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: string;
    archivedAt: string | null;
    generation: number | null;
}
export interface WorkspaceSessionListResult {
    sessions: WorkspaceSavedSession[];
    nextCursor: string | null;
}

/** Metadata on standard negotiated mutation methods. Correlation IDs are not receipt IDs. */
export interface WorkspaceSessionMutationMetadata extends WorkspaceProjectContext, WorkspaceMutationIdentity {
    confirmed?: boolean;
    configuration?: WorkspaceConfigurationSelection;
}
export interface WorkspaceOptionsRequest {
    context: WorkspaceProjectContext;
}
export interface WorkspaceAgentOption {
    name: string;
    displayName: string;
    description: string;
    defaults: WorkspaceModelConfiguration;
}
export interface WorkspaceModelConfiguration {
    model: string;
    provider: string;
    thinkingLevel: string;
}
export interface WorkspaceModelOption {
    id: string;
    name: string;
    provider: string;
    providerName: string;
    executionBackend: string;
    reasoning: boolean;
    contextWindow: number;
}
export interface WorkspaceCommandOption {
    name: string;
    description: string;
    kind: string;
}
export interface WorkspaceOptionsResult {
    mascot: boolean;
    defaults: WorkspaceConfiguration;
    agents: WorkspaceAgentOption[];
    models: WorkspaceModelOption[];
    commands: WorkspaceCommandOption[];
    thinkingLevels: string[];
}
export interface WorkspaceConfigureResult {
    ok: boolean;
    status: string;
    generation: number;
    operationId?: string;
    pendingConfiguration?: WorkspacePendingConfiguration | null;
}
export interface WorkspaceConfigurationSelection extends WorkspacePendingConfiguration {
    thinkingLevel?: string;
}
export interface WorkspacePendingConfiguration {
    agentName?: string;
    model?: string;
    provider?: string;
}
export interface WorkspaceAnswerFields {
    action: "accept" | "decline" | "cancel";
    answer?: string;
    otherAnswer?: string;
}
export interface WorkspaceAnswerResult {
    status: string;
}
export interface WorkspaceArchiveResult {
    runwieldSessionId: string;
    archivedAt: string | null;
}

export interface WorkspaceSettlementResult {
    status: "settled" | "unsettled";
    sessions: WorkspaceSessionSettlement[];
}
export interface WorkspaceSessionSettlement {
    sessionId: string;
    state: string;
    generation: number | null;
}
export type WorkspaceSubmissionKind = "prompt" | "bootstrap" | "steering";
export interface WorkspaceResolveSubmissionRequest {
    context: WorkspaceProjectContext;
    sessionId?: string;
    requestId: string;
    kind: WorkspaceSubmissionKind;
    expectedGeneration: number;
}
export interface SubmissionRecordedResult {
    ok: boolean;
    queued?: boolean;
}
export interface WorkspaceSubmissionResolution {
    result: SubmissionRecordedResult | null;
    status: "no_receipt" | "accepted" | "unknown";
    sessionId: string | null;
    operationId: string | null;
    outcome: string | null;
    generation: number | null;
}

export interface WorkspaceSessionListMetadata extends WorkspaceProjectContext {
    archiveState?: "active" | "archived" | "all";
    limit?: number;
}
```

| Extension suffix    | Request                             | Result                          |
| ------------------- | ----------------------------------- | ------------------------------- |
| `history`           | `WorkspaceHistoryRequest`           | `WorkspaceHistoryResult`        |
| `snapshot`          | `WorkspaceSnapshotRequest`          | `WorkspaceSnapshotResult`       |
| `options`           | `WorkspaceOptionsRequest`           | `WorkspaceOptionsResult`        |
| `command`           | `WorkspaceCommandRequest`           | `SessionCommandResult`          |
| `configure`         | `WorkspaceConfigureRequest`         | `WorkspaceConfigureResult`      |
| `answer`            | `WorkspaceAnswerRequest`            | `WorkspaceAnswerResult`         |
| `unarchive`         | `WorkspaceUnarchiveRequest`         | `WorkspaceArchiveResult`        |
| `drain`             | `{}`                                | `WorkspaceSettlementResult`     |
| `resolveSubmission` | `WorkspaceResolveSubmissionRequest` | `WorkspaceSubmissionResolution` |

`command` returns Core's named shapes from
[`session-input-contract.ts`](../src/shared/session/session-input-contract.ts):

```ts
export interface SessionCommandSelection {
    agentName?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
}
export interface SessionCommandResult {
    action: "message" | "new" | "agent" | "model" | "configure";
    message?: string;
    selection?: SessionCommandSelection;
}
```

The request uses the bound wire ID and admitted context, not a durable receipt identity. Core's
[`session-commands.ts`](../src/shared/session/session-commands.ts) selects Workspace registry entries with
`sessionAction`: `/agent`, `/model`, `/new`, `/context`, and `/help`. Use one slash-command line. Agent/model without
arguments return a picker action; one Agent name or `provider/model` returns a configuration selection. `/new` accepts
no name. Help/context return plain system text, not model input. Commands require idle work; action commands cannot
be sent as ordinary prompts or steering. Configuration selections use the existing configure path, not a new command
receipt mechanism.

`WorkspaceSessionListRequest` and `WorkspaceSessionListResult` are semantic client shapes, not a private list RPC.
Standard `session/list` uses `cwd`, `cursor`, and `WorkspaceSessionListMetadata` under the Workspace metadata key.
It returns saved IDs, titles, current generation/archive metadata, and `nextCursor`. Pages default to 30, maximum 100;
Results are newest-first; archive filtering and visible-empty filtering precede paging. Saved names take priority over first-message fallback.
Ordinary clients use cwd-based file authority without Workspace registration or SQLite, excluding archived and remote
Sessions. Workspace can request active, archived, or all Sessions.

History returns the latest page by default, at most 200 events, stable `eventId` values, current committed
configuration, generation, archive state, and an older-page `previousCursor`. Treat all cursors as opaque. History
cursors bind Project, Session, and generation; a newer generation requires a fresh history read. List cursors bind the
Project, filter, and page size, not a frozen list snapshot. Invalid or foreign cursors fail; read errors are not empty
successful pages.

History is provider-independent. Initialized reads do not activate an Agent/MCP, claim a writer, or change committed
evidence. Generation bootstrap and recovery use Core's existing model-independent evidence checks and respect a live
writer. Negotiated `session/load` is also passive: it binds a wire ID and returns history in response metadata without
model activation. Opening or continuing archived history does not Unarchive it. Standard `session/delete` archives;
Workspace busy archive requires explicit stop confirmation and durable settlement. Explicit Unarchive preserves ID,
transcript, and Plan Associations. Close releases live resources, not archive state.

Snapshots carry current operation state, events, and live interaction identity in `operation`. Observation retains at
most 500 operation events and trims oldest events against a 2 MiB serialized-operation budget. If the first retained
event has an oversized coalesced `delta`, it keeps its last 32,768 characters before further trimming. This preserves
new output while canonical history supplies the full text after settlement. With a supplied prior cursor, generation
changes, payload truncation, or event eviction since that cursor report `gap:true`. Core supplies monotonic
`eventSequence` and `eventEvictedThrough` values; a stable retained event count does not prove continuity. The semantic
client polls while idle and active, reconciles stable identities, and refreshes canonical history on generation change or gap instead of replaying work or appending duplicate
messages. Results from an old connection, binding, or read epoch cannot overwrite newer evidence. Reconciliation keeps
current questions, staged configuration, Session information, and Core queued messages separate from client drafts.
`operation.eventsAfterGeneration` marks the committed-generation boundary for its live event buffer. Once loaded
history advances beyond that boundary, history replaces the buffer instead of appending the same text again.
Another process's work uses the existing Core live connection. A v1 prompt response ends its foreground wait,
not retained Background Tasks or the observation. Local restart and supervisor lifetime follow the contract below.

Standard new/load/prompt/cancel/close/delete/config methods remain the mapping for their existing semantics;
`_session/steering` handles eligible active work. Standard mutation metadata separates durable `requestId` and
`expectedGeneration` from JSON-RPC correlation IDs. New work has Project context and request identity before a durable
Session ID exists; wire IDs remain separate. Receipt-backed create/continue/configure/steer/answer operations use Core
hashes and recorded outcomes. Identical retries do not repeat effects; changed input with the same receipt identity is
refused. Each retry must pass current Project admission. Preflight failures do not consume acceptance receipts.
Uncertain outcomes require refresh, never automatic replay. Archive/Unarchive/close are not new receipt-backed jobs.

Options expose supported Agents, models, thinking levels, and commands, not provider setup. Before the first send,
configuration selection stays client-side; opening New Session alone creates no saved history. Configure requires the
current committed generation. Idle changes apply through Runtime; active local Agent/model changes are staged until
settlement. Thinking can apply during that operation. `pendingConfiguration` excludes thinking; selecting a new Agent
replaces earlier pending selections. Another owner's busy configuration is refused. Each managed operation hydrates
current saved configuration before applying deliberate choices. Answers bind Session, operation, interaction, and
request identity; exact choice/Other/approval values reach Core. Stale or duplicate answers are refused.
The shared semantic interface preserves `SessionClientQuestion.defaultValue?:string` and
`SessionQuestionChoice.description?:string` from forms and observed interactions. Text schema `description` maps to
`placeholder`; schema `default` maps to `defaultValue`. These fields do not authorize an automatic answer.

`readProject` uses Core's existing Project open admission to obtain an independent read context. It does not change the
semantic client's selected execution context or bound Session. Sidebar reads for Project B cannot redirect Project A's
draft, images, queue, or pending answer.

Explicit Queue stores editable/removable **unsent** intent. Desktop persists it privately with drafts and images;
this is not accepted Core work. While the view remains attached, eligible queued input can dispatch once when work
settles. Window detachment or recovery holds remaining queued input as unsent until deliberate Send. Dispatch retains
its request ID; rejection retains the draft and images. Send during eligible work steers; a pending question does not
become implicit steering. Ordinary ACP keeps
its existing cross-writer queued-prompt behavior; there is no new queue-management RPC.

Desktop text is limited to 65,536 characters. Image selection, paste, and drop send bytes only: PNG/JPEG/GIF/WebP,
7 MiB decoded per file and 10 MiB aggregate base64. Image-only messages, previews, and removal are supported. Shared
limits live in `session-input-contract.ts` and are checked by UI, privileged bridge, and Core entry. Core validates
vision prerequisites before acceptance and saves scoped attachment references. History previews share the 10 MiB
base64 budget and report omitted images. Ordinary ACP input limits are unchanged.

Core owns history naming/paging/projection in `session-history.ts`, and Runtime construction, admission, receipt hashing,
configuration staging, operation listeners, retained Sessions, background work, and cross-process routing in
`session-continuation-service.ts`. Both negotiated ACP and the HTTP workbench call these owners through the public
`session-runtime.ts` interface. The HTTP adapter retains URLs, authorization, CSRF, browser notifications, and
review-specific presentation/launch behavior. The old HTTP workbench remains operational and does not migrate to ACP.

## Window lifetime, Quit, and recovery

One main-process supervisor admits one desktop instance per user. A second launch focuses or recreates its window;
it does not start a second runtime. Closing the last window detaches presentation only, on all target operating
systems. The supervisor, runtime, Session bindings, operations, and questions remain. Each binding keeps its own
Project, observation cursor, question, configuration, and queue. Sidebar indicators show running work and questions.
Opening another Project or Session never requires Close. Explicit Session Close is separate from closing the window.

A replacement view must pass sender validation and refresh every binding's snapshot and history before live updates.
A renderer crash creates a replacement window without stopping runtime work. Main owns private navigation preferences:
window bounds, sidebar collapse, expanded Projects, and selected Project/Session. These are projections, not access
grants. Missing or disabled destinations fall back to Projects. Native menus provide New Session, Close window, Quit,
and standard edit/window commands with platform shortcuts.

### Acknowledged settlement

Negotiated `session/close` waits for Core to settle that binding's owned work. Its response carries
`WorkspaceSettlementResult` under `_meta["dev.runwield/workspace"]`; only `settled` removes the binding.
`_dev.runwield/workspace/sessions/drain` takes exactly `{}` and settles all work owned by this connection's Core
continuation owner, including retained Background Tasks. Neither path forwards cancellation to another TUI or browser
owner that desktop only observes. An explicit Stop can still target cross-owner work under existing Core rules.

Drain blocks new dispatch and shares one in-flight request. Core waits for operations, pending admission, and retained
resources, then checks canonical generation and activation evidence. `settled` means this owner's work is settled,
not that all Sessions in other processes are idle. Unknown or missing evidence returns `unsettled`. A cancel
notification, idle display, empty snapshot, or closed pipe is not settlement proof.

Native Quit checks Core evidence, including background work. With running or uncertain work it offers **Stay open**
(default) and **Stop and quit**. Stay open changes nothing. Stop and quit blocks new input, flushes drafts and
preferences, awaits drain, then disposes the client and runtime. A failed or unsettled drain keeps the app open with
an error and permits retry. Concurrent Quit requests cannot start overlapping disposal. The supervisor exposes this
same stop boundary for a later updater; update installation is not implemented here.

### Private drafts and receipt recovery

Main stores unsent text, image bytes, queued follow-ups, and submission identities in Electron's per-user data
directory, not the Project, transcript, or logs. Validated preload operations are the renderer's only access. Writes
are atomic and owner-only. Entries use Project registration plus durable Session ID, or a composer key before Core
accepts the first message. They retain request identity, submission kind, and expected generation when dispatch starts.
Existing text/image limits still apply. Accepted input, explicit discard/removal, and Project removal retire only the
corresponding intent. A corrupt file is preserved privately with a visible recovery notice.

Persisted drafts and queues survive window close, renderer replacement, deliberate Quit, and main/runtime restart.
Edits not yet written when a process is forcibly killed can be lost. Restored input is unsent; recovery never dispatches
it automatically. Core queued messages remain separate accepted evidence, not restored client drafts.

Runtime loss interrupts all bindings and offers **Restart runtime**. Restart or relaunch after main loss re-admits
Projects, resolves saved submissions, and loads current Sessions from Core evidence. The read-only
`_dev.runwield/workspace/sessions/resolveSubmission` accepts admitted context, original request ID, kind, expected
generation, and a durable Session ID except for `bootstrap`. It accepts no prompt or image payload and cannot create
or continue work. Results mean:

- `accepted`: Core has a terminal receipt; inspect `result` and `outcome`, not the label alone, for success.
- `no_receipt`: Core found no acceptance receipt. Only a deliberate Send can submit the saved input with its original
  identity, kind, and generation under current admission.
- `unknown`: acceptance or outcome is unresolved. Keep uncertainty visible; do not resend that input. The user can
  inspect saved history and use new input for deliberate continuation.

An accepted receipt without a proven result also stays uncertain. Recovery does not replay prompts, answers, workflow
or review decisions, or publication. Core repairs its own saved Session state; an idle repaired Session is not proof
that an interrupted action succeeded. Application exit is not an always-on service. Forced OS termination can prevent
graceful settlement and must not be reported as successful cancellation.

## Capability inventory

Source paths below are relative to `src/ui/workspace/` unless they start with `src/`. Child numbers refer to the
[delivery map](#delivery-map), not the parent document's older sequence. “Proposed extension” identifies an unresolved
mapping owned by that child, not a callable endpoint.

| Current surface or entry                                                 | Current authoritative owner / adapter                                                                                            | Standard method or proposed extension                                                              | Parity scenario and capability/refusal rule                                                                                                                                                                                                 | Child                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `/projects`, Project settings, `/api/owner/projects` and Project actions | `src/shared/owner-coordination/{projects,owner-projects}.ts`; browser `routes/owner-api.js`; ACP `src/acp/workspace-projects.ts` | Implemented version 1 Project group above                                                          | Register, confirm, relink, enable/disable, rescan and remove. A picker supplies a candidate, not trust. Reject a wrong root; removal does not delete the repository.                                                                        | 2                                         |
| Provider readiness and Session options                                   | Core provider/settings owners through `src/acp/server.js` and `routes/owner-session-api.js`                                      | Existing readiness refusal and configuration reuse; provider setup extension deferred to child 10. | Show the actual missing provider/default-model prerequisite, not Workspace sign-in. Use external `wld login` then restart in child 2; in-app setup belongs to child 10. Never expose credentials.                                           | 2                                         |
| Session create, known-ID load, prompt and output                         | Core `SessionContinuationService` through negotiated ACP and HTTP; ordinary ACP uses Runtime                                     | `session/new`, `session/load`, `session/prompt`, `session/update`                                  | A separate runtime streams into the live DOM; closing and loading retains committed history. Bind cwd to Core-admitted Project context on Workspace connections; ordinary ACP remains cwd-based. Refuse incompatible peers before mutation. | 1                                         |
| Session list, history and live snapshots                                 | Core `session-history.ts` and `session-continuation-service.ts`; ACP and HTTP adapters                                           | Standard `session/list`; version 1 `history`/`snapshot`                                            | Discover and read saved history without provider readiness; Archived Sessions settings, paging, open and Unarchive belong here. Desktop reads through the contract, never by scanning storage.                                              | 3                                         |
| Agent/model/thinking selection                                           | Core Session configuration; `routes/owner-session-api.js`, `src/acp/server.js`                                                   | Standard `session/set_config_option`; version 1 `options`/`configure`                              | Preserve committed settings rather than UI cache. Reject invalid options and wrong Sessions; do not substitute unimplemented `session/set_mode`.                                                                                            | 3                                         |
| Questions and approvals; HTTP answer route                               | Core interaction owner through `src/acp/interaction-mapper.js`; `routes/owner-session-api.js`                                    | `elicitation/create` response                                                                      | Required text rejects whitespace; optional text permits empty input. Preserve choice plus optional Other text. No silent defaults. Reject stale, duplicate, canceled or wrong-Session answers. Retain no-form external-client fallback.     | 1 basic; 3 parity                         |
| Attachments, images and resources                                        | Core prompt validation; `routes/owner-session-api.js`, `islands/SessionSurface.jsx`                                              | Standard image/resource prompt blocks where supported; bounded host transfers                      | Select/paste/drop only supported content. Refuse size/type/access violations. No renderer filesystem access. No attachment control in child 1.                                                                                              | 3                                         |
| Queued input, steering and background output                             | Core continuation/live operations; ACP and HTTP adapters                                                                         | `_session/steering`, version 1 snapshots; client-only unsent queue                                 | Preserve queued intent and delayed results after a prompt ends. Negotiate support; an unknown update is not completed work.                                                                                                                 | 3                                         |
| Stop, close, archive/unarchive                                           | Core Session lifecycle; `routes/owner-session-api.js`, `src/acp/server.js`                                                       | Standard cancel notification and close request; `session/delete` archive and version 1 `unarchive` | Stop a held stream/question, await settlement, then send again. Close retains history. Delete is reversible archive, never close or transcript deletion. Dismiss forms and refuse late answers.                                             | 1 Stop/close; 3 archive                   |
| Receipts, writer admission, force recovery and reconnect                 | Core Session/owner-coordination and continuation owners                                                                          | Implemented receipts, read-only resolution, snapshots, close settlement and drain                  | Preserve locks, generations and durable evidence. Refuse stale/conflicting writers. Connection loss interrupts work; never resubmit uncertain input automatically.                                                                          | 3 services; 4 recovery                    |
| Project/Session sidebar shell                                            | Core Project admission and Session history; `react/ProjectWorkbench.tsx`, `react/ProjectSidebar.tsx`                             | Project group, standard list, version 1 history                                                    | Five recent Sessions per Project, five-row Show more, independent retry, New Session and settings. Read contexts do not retarget bound work. Preserve expansion/scroll, collapse/resize and narrow overlay.                                 | 3                                         |
| `/`, dashboard APIs, Plan navigation and dashboard stream                | Plan/Session/registry owners aggregated by `server/owner-dashboard.ts`; `routes/owner-api.js`                                    | Proposed dashboard read/observe extension                                                          | Preserve incremental attention sections, Project progress and partial failures. Projection is not authority. An unavailable section is not an empty successful result.                                                                      | 7                                         |
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
relink, enable/disable, full Session rescan, and removal without deleting files or saved Sessions. Open Sessions keep
their bindings while another Project or Session is selected; their work continues independently.

For model work, configure Core credentials and a default model externally with `wld login`, then restart desktop.
Existing global, Project, and linked-worktree settings are read in place. Missing setup leaves Project management
available and shows the actual Core prerequisite, not Workspace sign-in. No provider editor or credential import
exists here; in-app setup belongs to child 10. Provider-independent saved-history browsing and Archived Sessions are available in the source client. Local use needs no Workspace account.
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

`desktop:test` builds first, then runs six native integration files and the private draft-store suite (seven files).
Direct focused native runs require
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
define the boundary assertions. ADR acceptance records a decision, not delivery evidence. The earlier Session/Project checks below record their original slice. Saved-Session evidence follows separately;
full repository CI remains pending.

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

### Window and process source evidence

The current `bun run desktop:test` run passed all seven files on the current macOS development environment
(99.7 seconds). It includes the existing entry, Session, and security suites plus:

- [Lifetime tests](../src/ui/desktop/desktop-lifecycle.integration.test.ts): close/reopen and second-instance admission,
  parallel bindings, restored drafts/images/queues, private preferences, and no dispatch from detached views.
- [Quit tests](../src/ui/desktop/desktop-quit.integration.test.ts): Stay open, shared Stop and quit, and no exit while
  the real runtime is suspended before settlement.
- [Recovery tests](../src/ui/desktop/desktop-recovery.integration.test.ts): runtime Restart, renderer replacement,
  main relaunch, receipt reconciliation, and no automatic resubmission of uncertain input.
- [Draft-store tests](../src/ui/desktop/draft-store.test.ts): atomic private intent, acceptance/discard identity,
  Project removal, and preserved corruption notices.

These automated assertions protect the source-development contract with a controlled provider. They do not establish
installation, Windows/Linux qualification, updater installation, or an unattended service. The separate
[headed window/process record](#window-and-process-headed-checks-macos-arm64-source-build) below records the checks,
the repaired history-read error, and the successful native OS retry after permission was granted. Earlier headed
evidence covers its named slices only. Protocol schemas and behavior above are derived from current source; this run does not claim that every
focused protocol suite or full CI was executed.

### Window and process headed checks: macOS arm64 source build

These checks used Bun 1.4.3, Electron 45.2.3, the built `runwield://app/` origin, two disposable Git Projects,
and the controlled HTTP provider from `makeSessionProcessFixture`. They are partial source-build acceptance evidence,
not an installed-platform pass. `bun run install:locked` and `bun run desktop:setup` passed before launch.

The normal command ran successfully with isolated `HOME`, `USERPROFILE`, `CFFIXED_USER_HOME`, temporary/database
paths, and Project roots:

```sh
PATH=/tmp/runwield-bun-1.4.3/bun-darwin-aarch64:$PATH
bun run desktop:dev -- --project /absolute/disposable-project --cdp-port 9337
```

The command built and opened the native app, not an HTTP/HMR substitute. Main PID was 23134; its source ACP child was 23302. `lsof` confirmed that Electron's application-support files were inside the private HOME. Screenshot:
`/tmp/keep-safe-normal-launch.png`. Further checks used a temporary `/tmp/keep-safe-headed.ts` Playwright `_electron`
harness with a visible native window, an explicit private profile, the same source CLI, and the same controlled
provider. No product configuration or dialog replacement was added. Inspection used the worktree session
`keep-safe-ad76732e32f7`, socket directory `/tmp/ks-ab`, and `agent-browser --cdp 9337`.

The content viewport was 1440×900 CSS pixels at device scale 2. The native minimum was also checked at 700×550
content pixels. Both had no horizontal document overflow. The checks established:

- Three Sessions stayed bound at once: A1 waited for a question, A2 streamed in Project A, and B1 streamed in Project B.
  Their durable IDs were `47e7fc23-0758-4d13-84c2-80910ea6eaa4`,
  `1d3d97f8-a994-46e1-ab41-0eec32beab60`, and `88f0a16b-2d78-47b8-b7c0-5363146429a7`.
  Sidebar labels distinguished **Answer needed** and **Running**. Switching retained separate image/text drafts in A1
  and B1 and a queued follow-up in A1. Screenshot: `/tmp/keep-safe-three-parallel-1440.png`.
- Closing the real `BrowserWindow` left main 32833 and ACP child 32858 alive. Output was emitted while no window
  existed. A second native launch recreated the window, changing renderer PID 32859 to 53409 without another
  provider request. A1's unanswered question, text/image draft, and unsent queue returned. A later B1 history check
  found the detached output once. Screenshots: `/tmp/keep-safe-question-reopened.png` and
  `/tmp/keep-safe-project-b-uncertain-draft.png`.
- Only a deliberate Submit answer advanced A1. A2 and B1 remained running. The queued follow-up remained unsent and
  the ordinary draft/image stayed intact. Screenshot: `/tmp/keep-safe-answer-with-other-work.png`.
- Renderer SIGKILL replaced renderer 53409 with 57381 while main 32833 and ACP child 32858 survived. The selected A1
  draft, image, and queue returned. Runtime SIGKILL then labelled all bindings **Interrupted** and exposed
  **Restart runtime**. Deliberate restart created ACP child 59599, restored A1 as idle from evidence, and retained A2
  and B1 as interrupted. No input was replayed. Screenshots: `/tmp/keep-safe-renderer-restored.png`,
  `/tmp/keep-safe-runtime-interrupted.png`, and `/tmp/keep-safe-runtime-restarted.png`.
- Main SIGKILL and relaunch changed main 32833 to 63891 and ACP child to 63914. Selected A1, both expanded Projects,
  collapsed navigation, 1440×900 content bounds, and exact A1 draft/image/queue returned. Later B1 selection showed
  **The previous input outcome is uncertain. It was not sent again.** Its separate draft/image also returned.
  Screenshots: `/tmp/keep-safe-main-restored-preferences.png` and `/tmp/keep-safe-project-b-uncertain-draft.png`.
- A deliberate idle Quit exited main 75466; relaunch as main 76251 restored selected B1 and its draft/image without
  provider traffic. Screenshot: `/tmp/keep-safe-idle-quit-restored.png`. Minimum-size screenshot:
  `/tmp/keep-safe-native-minimum.png`.

The provider count was 3 for the three initial operations, remained 3 through window replacement, became 4 only after
Submit answer, and stayed 4 through renderer/runtime/main recovery. A separate held operation for the real native Quit
attempt made request 5. There were no provider failures, renderer console/page errors, or failed renderer asset
requests in the captured records. Build output included the existing `quikdown` CommonJS-in-ESM warning; normal native
launch also printed a macOS sandbox-extension warning but loaded the sandboxed app. Temporary records are
`/tmp/keep-safe-summary.jsonl`, `/tmp/keep-safe-final-acceptance-status.json`, and `/tmp/keep-safe-cleanup.json`.

**History acceptance defect repaired:** The earlier three-parallel screenshot contains a
`desktop:saved:history` error during a new Session's first held response. The surface now waits for a committed
generation, not just a durable ID, before reading history. The native parallel regression checks all emitted views
and rendered alerts, once-only content, and canonical history after settlement. DOM tests cover the first held turn
and delayed-history switch isolation; a process test proves bootstrap writer protection and fresh provider-free
history after settlement. A separate macOS arm64 headed follow-up at 1440×900 used two parallel Projects, a private
profile, CDP 9346, and named browser session `ksh-d51c682f`. It found no history alerts or renderer errors during the
held turns or settlement; both canonical histories contained each prompt and response once, with two provider
requests. Screenshots: `/tmp/keep-safe-history-held-parallel-fixed.png` and `/tmp/keep-safe-history-settled-fixed.png`.
The follow-up fixture and browser session were removed. This was a focused history rerun, not a repeat of the full
lifecycle acceptance or the native OS checks below.

**Native OS retry after permission grant:** The earlier run was blocked by macOS accessibility and screen-capture
permissions. The retry returned `AXIsProcessTrusted=true` and `CGPreflightScreenCaptureAccess=true`. It used a new
private HOME/profile, two disposable Projects, Bun 1.4.3, the same built source app at `runwield://app/`, a 1440×900
content viewport, CDP 9347, and named browser session `ksn-d51c682f` in `/tmp/ks-native-ab`. The temporary harness was
`/tmp/keep-safe-native-retry.ts`; no native dialog or product operation was replaced.

- OS Command-N created separate bindings: two idle composers in Project A, then a held Session in A and a held Session
  in B. Targeted CGEvent Command-N changed the binding list. Foreground System Events Command-N also created B's
  binding. The held durable IDs were `c00e7651-35f2-4ec4-bf50-991113893ae8` and
  `dfc9607b-42bb-4cf7-820d-bf13d4af4d1d`; their provider requests counted once each.
- Foreground System Events Command-W reduced the native window count to zero while main 62391 and ACP processes
  62404/62406 stayed alive. A targeted background CGEvent Command-W did not close the window; dispatched events alone
  were not counted as success. Output was emitted with no window. With only one Electron app running, clicking its
  actual Dock item recreated the window: renderer 62405 became 62975, main/runtime and A's operation identity stayed
  unchanged, and the provider count stayed 1. Text, image, queue identity, and detached output returned.
- Foreground System Events Command-Q opened the real native sheet. Its AX tree exposed **Stay open** and **Stop and
  quit**. Window-only `screencapture -x -o -l` captured the sheet without unrelated desktop content:
  `/tmp/keep-safe-native-quit-sheet.png` and `/tmp/keep-safe-native-quit-window.png`. AX clicked **Stay open** by name;
  both streams accepted further output, A's operation ID stayed `2e47a323-5f46-4627-a8cf-74efcc976b55`, the queue stayed
  unsent, and provider count stayed 2. Screenshot: `/tmp/keep-safe-native-after-stay.png`.
- Command-Q opened the native sheet again. Both real ACP processes were suspended with SIGSTOP before AX clicked
  **Stop and quit**. After 11 seconds, main remained alive, both ACP processes had state `T`, and both canonical
  activations were still active with no committed generation. A new create request was refused with **RunWield is
  stopping or recovering. Try again after it settles.** Screenshot: `/tmp/keep-safe-native-stop-waits.png`.
  SIGCONT allowed settlement; main and both ACP processes then exited. Canonical activations were idle at generation
  0; receipts for operations `2e47a323-5f46-4627-a8cf-74efcc976b55` and
  `f5856fe1-7ddc-4f99-b09a-3a221196aefd` were completed at generation 0. Each transcript contained one user input,
  one held response, and one post-Stay-open output, with assistant stop reason `aborted`. A completed submission
  receipt here does not mean a delivery workflow was successfully published.
- Relaunch as main 64862 restored A's selected Session, exact draft text, byte-identical image, and unsent queue
  request `dd1e2806-7d13-4737-ae8e-aa805447b3b6`, with provider count still 2. Screenshot:
  `/tmp/keep-safe-native-stop-relaunch-restored.png`. A further Command-W and actual second executable launch recreated
  the window under main 64862 and the same ACP processes 64865/64867, with renderer 65550 and no new provider request.
  Final idle Command-Q exited normally.

The retry had no provider failures, renderer/page errors, or failed renderer requests. Records include
`/tmp/keep-safe-native-os-summary.json`, `/tmp/keep-safe-native-canonical-receipts.json`,
`/tmp/keep-safe-native-suspended-processes.txt`, and `/tmp/keep-safe-native-os-final-status.json`. All known retry
processes exited, CDP 9347 was released, private HOME and Project roots were removed, and its browser session was
closed. The prior native-permission blocker is resolved for this macOS source run; this is not installed-app or
Windows/Linux qualification.

All known fixture processes exited or were stopped, port 9337 was released, the private HOME and both Project roots
were removed, and the named browser session was closed. Screenshot and record paths are temporary local evidence.
Full CI and Windows/Linux qualification were not run by this headed check.

### Saved-Session source evidence

Dedicated process and native suites passed in this change. Their assertions cover these boundaries, not installers or
manual headed acceptance:

| Evidence                                                                                                                                   | Assertions                                                                                                                                                                                                                             | Limit                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [History process tests](../src/acp/workspace-session-history.process.test.ts)                                                              | Provider-free segmented history, names, images/configuration, archive filters, stable IDs, cursor refusal, non-mutating initialized reads, generation bootstrap and writer protection; ordinary cwd listing without Workspace database | Source subprocess                                               |
| [Parity process tests](../src/acp/workspace-session-parity.process.test.ts)                                                                | Receipt replay/restart, stale generation and image refusals, independent Project reads during a question, unsent queue dispatch, retained background Stop, busy archive, bounded gaps and repeated snapshots                           | Controlled provider                                             |
| [Cross-process continuity](../src/shared/session/session-continuation-cross-process.integration.test.ts)                                   | Separate Runtime and ACP processes share durable identity/history/configuration and enforce writer exclusion; answer/steer/cancel cross-owner work                                                                                     | Runtime harness using TUI ownership, not a real interactive TUI |
| [Sidebar DOM tests](../src/ui/workspace/project-sidebar.test.tsx)                                                                          | Independent five-row paging/retry, stable selection, navigation/draft preservation, archived paging/open/Unarchive, confirmation focus                                                                                                 | DOM, not headed layout proof                                    |
| [Native Session tests](../src/ui/desktop/desktop-session.integration.test.ts)                                                              | Built bridge and real subprocess: images via selection/paste/drop, retained rejected drafts, queue edit/remove/dispatch, pre-create configuration and background Stop                                                                  | Controlled provider, source build                               |
| [Native entry](../src/ui/desktop/desktop-entry.integration.test.ts) and [security](../src/ui/desktop/desktop-security.integration.test.ts) | Project management without provider setup and fixed Session binding; malformed/oversized/foreign requests refused before effects                                                                                                       | No installed-platform qualification                             |

The saved-Session Plan's [headed acceptance](plans/local-workspace-desktop/continue-saved-sessions-in-desktop.md#headed-acceptance)
is recorded below. Automated assertions and headed checks provide separate evidence. The earlier Project-entry
evidence remains separate.

### Saved-Session headed checks: macOS arm64 source build

The parent Agent ran the built native app at `runwield://app/`, CDP port 9328, with a 1440×868 content viewport.
Without a provider, saved history and configuration were readable; a refused send retained its draft. Two Projects
showed five recent Sessions each and five more through Show more. Archived duplicate rows were checked; opening a
row left it archived, and explicit Unarchive refreshed the list. A valid image-only submission was accepted and saved.
Screenshots: `/tmp/ss9b-provider-free-draft.png`, `/tmp/ss9b-provider-free-archived.png`, and
`/tmp/ss9b-image-only-accepted.png`.

A real full TUI ran under a PTY on the same durable Session ID, `e8a14975-87a3-4ad3-bfc4-c55a85df24a2`.
Desktop continued while TUI was idle. After the Core synchronization fix, TUI changed the Agent to Engineer and
continued. The idle desktop view then showed Engineer and the new content once, while retaining its unsent draft.
Screenshot: `/tmp/ss9b-real-tui-continuity-fixed.png`.

Further headed checks established:

- Upload, paste-plus-text, drop, and saved image rendering. An oversized image showed `Image exceeds 7 MiB.` without
  losing the draft. Structured Other and approval responses reached Core without consuming the ordinary draft/image.
- Foreground steering, queued-intent removal and once-only dispatch, background continuation after the foreground
  returned, and retained background Stop.
- A 232-message, two-segment saved conversation opened without provider setup. Loading older history changed the
  loaded count from 120 to 200 while preserving the reading position. An open tool disclosure remained open through
  a peer process's next committed generation; the ordinary draft remained intact.
- Busy archive displayed `Stop and archive` and `Cancel`. Cancel retained the Session and returned focus; confirmation
  stopped and archived it. Unarchive restored its row without changing the saved identity.
- At 600×850, the sidebar used an overlay. Escape closed it and returned focus to Show sidebar. The draft remained,
  and neither that viewport nor 1440×868 had horizontal document overflow. Keyboard resize changed the sidebar from
  280 to 300 pixels; that width survived settings navigation. Enter opened settings, ArrowRight selected Archived
  Sessions, and Tab reached its saved row and Unarchive button. Enter opened the archived row and restored it through
  Unarchive. Each tab owns its content panel; hidden panels retain form state without entering the tab order.
- A missing second Project showed Retry after refresh while the first Project's loaded rows remained available.
  Restoring the root and Retry recovered the second Project. Settings navigation preserved the open binding and draft.
- Saved configuration stayed visible when its model was absent from available options. With a configured reasoning
  model, native Agent, model, and thinking selections produced a successful continuation and retained the selected
  `engineer`, `fixture/fixture-alt`, and `medium` configuration. `/help` used no provider turn.

Screenshots include `/tmp/ss9b-question-draft-isolation.png`, `/tmp/ss9b-queue-steer.png`,
`/tmp/ss9b-older-history-position.png`, `/tmp/ss9b-final-expanded-disclosure.png`,
`/tmp/ss9b-busy-archive-labels.png`, `/tmp/ss9b-final-narrow-overlay.png`,
`/tmp/ss9b-final-independent-retry.png`, `/tmp/ss9b-provider-free-model-fixed.png`,
`/tmp/ss9b-final-configuration-accepted.png`, and `/tmp/ss9b-final-keyboard-archived.png`.
Final renderer errors were empty; local asset requests succeeded.
The controlled provider recorded 38 requests and no provider failures.

These checks used the controlled local HTTP provider from `makeSessionProcessFixture`, not a real external provider.
They establish the recorded journeys on a macOS arm64 source build, not installed qualification. Screenshot paths are
temporary local evidence, not durable fixtures. The final focused run passed 383 tests across 35 files, with one
Windows-only test skipped. Desktop and Workspace checks, source type checks, the dependency boundary gate, injection
seam checks, and documentation link checks passed. Full CI remains pending through RunWield.

### Saved-Session regression compatibility

No test declaration was removed. This change adds 30 source test-case declarations; two negotiation table rows add
further generated executions. Existing assertions were rewritten for these contracts:

| Existing check                  | Current assertion and retained protection                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unsupported ACP method          | Uses unsupported `session/fork`; `session/list` is implemented.                                                        |
| Optional text default           | Shows the supplied default; explicit empty submission remains covered.                                                 |
| Choice default                  | Shows the supplied default without submitting it; a no-default case retains empty native/embedded submission coverage. |
| Native missing provider         | Refuses deliberate Send, not passive New Session; no provider request occurs.                                          |
| Native security evidence        | Seeds one legitimate provider turn before attacks; refused requests cannot add turns.                                  |
| Saved identity lookup           | Uses the durable Session ID, not the Pi locator, in security and Workspace-entry checks.                               |
| Untrusted IPC                   | Allows the legitimate sidebar registration; untrusted requests cannot add registrations.                               |
| Lazy saved identity             | New Session has no saved ID until Send; Close/reopen retains the resulting ID.                                         |
| Empty running composer          | Checks disabled Steer rather than disabled Send.                                                                       |
| Transcript uniqueness           | Counts the reopened prompt within Conversation, excluding sidebar labels.                                              |
| Workspace prompt completion     | Reads durable metadata after completion and closes the returned wire binding.                                          |
| Workspace provider prerequisite | Negotiated `session/new` is passive; deliberate `session/prompt` requires provider setup.                              |
| Stale browser Plan review       | Checks the shared snapshot's explicit `null` for a cleared interaction.                                                |

The live-review fixture uses a distinct request ID for each new logical turn. Reusing its old fixed ID would correctly
replay the earlier durable receipt instead of starting a new provider turn. Provider entry is bounded and reports the
actual operation on failure. Command surface checks wait for the enabled Send control after configuration settles.

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

This earlier Project-entry check predates parallel bindings; its switch refusal is not current behavior.
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
