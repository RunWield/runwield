import { validateSessionInput, type SessionImageTransfer } from "../../shared/session/session-input-contract.ts";
import type {
    WorkspaceSettlementResult,
    WorkspaceSubmissionMetadata,
    WorkspaceResolveSubmissionRequest,
    WorkspaceSubmissionResolution,
    WorkspaceHistoryRequest,
    WorkspaceHistoryResult,
    WorkspaceSnapshotRequest,
    WorkspaceSnapshotResult,
    WorkspaceSessionListRequest,
    WorkspaceSessionListResult,
    WorkspaceConfigureRequest,
    WorkspaceSessionRequest,
    WorkspaceJsonRecord,
} from "../workspace-contract.ts";
import type { SessionQueuedDraft, WorkspaceSavedSessionClient } from "../../ui/workspace/client/session-client.ts";
import {
    WORKSPACE_EXTENSION,
    type WorkspaceCapability,
    type WorkspaceProjectContext,
    type WorkspaceListProjectsResult,
    type WorkspaceOpenProjectResult,
    type WorkspaceProjectRequest,
    type WorkspaceRegisterProjectRequest,
    type WorkspaceRelinkProjectRequest,
    type WorkspaceSetProjectEnabledRequest,
    type WorkspaceProjectWriteResult,
    type WorkspaceProjectResult,
    type WorkspaceRemoveProjectResult,
    type WorkspaceRescanProjectResult,
} from "../workspace-contract.ts";
import type { WorkspaceProjectClient } from "../../ui/workspace/client/project-client.ts";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import type {
    ClientConnection,
    CreateElicitationRequest,
    CreateElicitationResponse,
    ElicitationSchema,
    LoadSessionResponse,
    NewSessionRequest,
    SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
    SessionClientItem,
    SessionBinding,
    SessionClientQuestion,
    SessionClientView,
    SessionQuestionAnswer,
} from "../../ui/workspace/client/session-client.ts";

export interface AcpWorkspaceSessionOptions {
    connectionId: string;
    project: string;
    workspaceAdmission?: boolean;
    input: ReadableStream<Uint8Array>;
    output: WritableStream<Uint8Array>;
}

interface WorkspaceCloseResponse {
    _meta?: { [WORKSPACE_EXTENSION]: WorkspaceSettlementResult };
}

export interface WorkspaceSubmissionEvent {
    phase: "prepared" | "accepted";
    submission: WorkspaceSubmissionMetadata;
}
export type WorkspaceSubmissionObserver = (event: WorkspaceSubmissionEvent) => Promise<void>;

interface RunWieldMetadata {
    otherOptionValue?: string;
    persistedSessionId?: string;
    operationId?: string;
    history?: WorkspaceHistoryResult;
    interactionId?: string;
    interactionType?: string;
    implementedMethods?: string[];
}

interface PendingQuestion {
    view: SessionClientQuestion;
    resolve: (response: CreateElicitationResponse) => void;
}

const REQUIRED_METHODS = ["session/new", "session/load", "session/prompt", "session/cancel", "session/close"];

function errorText(error: Error | string): string {
    return error instanceof Error ? error.message : String(error);
}

function jsonRecord(value: import("../workspace-contract.ts").WorkspaceJson | undefined): WorkspaceJsonRecord | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Only the server's current primitive form subset is supported, not general JSON Schema. */
function questionView(params: CreateElicitationRequest, requestId: string): SessionClientQuestion {
    if (params.mode !== "form") throw new Error("This question requires an unsupported input mode.");
    const schema = params.requestedSchema as ElicitationSchema | undefined;
    if (!schema || schema.type !== "object" || !schema.properties) {
        throw new Error("This question has an unsupported schema.");
    }
    const fields = Object.keys(schema.properties);
    if (fields.some((name) => name !== "answer" && name !== "otherAnswer")) {
        throw new Error("This question has unsupported fields.");
    }
    if (schema.required?.some((name) => !fields.includes(name))) throw new Error("Invalid required question field.");
    const raw = schema.properties.answer;
    if (!raw || raw.type !== "string") throw new Error("This question requires an unsupported answer type.");
    // The SDK's forward-compatible union includes custom types. Check the supported fields at this boundary.
    const supportedFields = ["type", "title", "description", "default", "enum", "oneOf", "_meta"];
    if (Object.keys(raw).some((key) => !supportedFields.includes(key))) {
        throw new Error("This question has unsupported text constraints.");
    }
    const titled = raw.oneOf;
    const plain = raw.enum;
    if (titled && plain) throw new Error("This question has conflicting choices.");
    if (
        (titled != null && (!Array.isArray(titled) || !titled.length)) ||
        (plain != null && (!Array.isArray(plain) || !plain.length))
    ) {
        throw new Error("This question has unsupported choices.");
    }
    const choices = Array.isArray(titled)
        ? titled.map((choice) => {
              if (!choice || typeof choice.const !== "string" || typeof choice.title !== "string") {
                  throw new Error("This question has unsupported choices.");
              }
              return {
                  value: choice.const,
                  label: choice.title,
                  ...(typeof choice.description === "string" ? { description: choice.description } : {}),
              };
          })
        : Array.isArray(plain)
          ? plain.map((value) => {
                if (typeof value !== "string") throw new Error("This question has unsupported choices.");
                return { value, label: value };
            })
          : [];
    if (new Set(choices.map((choice) => choice.value)).size !== choices.length) {
        throw new Error("This question has duplicate choices.");
    }
    const other = schema.properties.otherAnswer;
    if (
        other &&
        (other.type !== "string" ||
            !choices.length ||
            schema.required?.includes("otherAnswer") ||
            Object.keys(other).some((key) => !["type", "title", "description", "_meta"].includes(key)))
    ) {
        throw new Error("This question has an unsupported Other field.");
    }
    const meta = params._meta?.runwield as RunWieldMetadata | undefined;
    return {
        requestId,
        interactionId: typeof meta?.interactionId === "string" ? meta.interactionId : "",
        prompt: params.message,
        mode: choices.length ? (meta?.interactionType === "approval" ? "approval" : "select") : "text",
        required: schema.required?.includes("answer") === true,
        placeholder: typeof raw.description === "string" ? raw.description : "",
        ...(typeof raw.default === "string" ? { defaultValue: raw.default } : {}),
        choices,
        allowOther: Boolean(other),
        ...(typeof meta?.otherOptionValue === "string" ? { otherOptionValue: meta.otherOptionValue } : {}),
    };
}

class SessionState {
    historyRead: Promise<void> | null = null;
    epoch = 0;
    readVersion = 0;
    pending: PendingQuestion | null = null;
    turn: Promise<void> | null = null;
    polling: ReturnType<typeof setTimeout> | null = null;
    observationCursor = "";
    launchConfiguration: import("../workspace-contract.ts").WorkspaceConfigurationSelection = {};
    committedItems: SessionClientItem[] = [];
    committedGeneration: number | null = null;
    committedEventIds = new Set<string>();
    commandItems: SessionClientView["items"] = [];
    readonly seenEvents = new Set<string>();
    readonly rejectedQueued = new Set<string>();
    dispatchingQueued = false;
    readonly queuedDrafts: SessionQueuedDraft[] = [];
    constructor(
        readonly view: SessionClientView,
        readonly context: WorkspaceProjectContext | null,
    ) {}
}

/** A persistent ACP v1 connection. The host supplies stdio, never Core runtime objects. */
export class AcpWorkspaceSessionClient implements WorkspaceSavedSessionClient, WorkspaceProjectClient {
    private draining = false;
    private drainingPromise: Promise<WorkspaceSettlementResult> | null = null;
    private readonly submissionObservers = new Set<WorkspaceSubmissionObserver>();
    /** Host persistence boundary. Prepared observers finish before input crosses the wire. */
    onSubmission(observer: WorkspaceSubmissionObserver): () => void {
        this.submissionObservers.add(observer);
        return () => this.submissionObservers.delete(observer);
    }
    private async submissionEvent(phase: WorkspaceSubmissionEvent["phase"], submission: WorkspaceSubmissionMetadata) {
        for (const observer of this.submissionObservers) await observer({ phase, submission });
    }
    async resolveSubmission(request: WorkspaceResolveSubmissionRequest): Promise<WorkspaceSubmissionResolution> {
        await this.ready();
        if (!this.workspaceAdmission) throw new Error("Workspace admission is required.");
        return await this.connection.agent.request("_dev.runwield/workspace/sessions/resolveSubmission", request);
    }
    drain(): Promise<WorkspaceSettlementResult> {
        if (this.drainingPromise) return this.drainingPromise;
        this.draining = true;
        const drain = (async (): Promise<WorkspaceSettlementResult> => {
            await this.ready();
            if (!this.workspaceAdmission) throw new Error("Workspace admission is required for acknowledged drain.");
            return await this.connection.agent.request("_dev.runwield/workspace/sessions/drain", {});
        })();
        this.drainingPromise = drain;
        void drain
            .finally(() => {
                this.drainingPromise = null;
            })
            .catch(() => {});
        return drain;
    }
    private readonly connection: ClientConnection;
    private readonly initialized: Promise<void>;
    private readonly listeners = new Set<(view: SessionClientView) => void>();
    private readonly emptyView: SessionClientView;
    private readonly bindings = new Map<string, SessionState>();
    private selected: SessionState | null = null;
    private sequence = 0;
    private disposed = false;
    private readonly workspaceAdmission: boolean;
    private context: WorkspaceProjectContext | null = null;
    private selecting = false;
    private opening = false;
    private attaching = 0;
    private reattachment: Promise<void> | null = null;

    private get view(): SessionClientView {
        return this.selected?.view || this.emptyView;
    }

    constructor(options: AcpWorkspaceSessionOptions) {
        if ((!options.workspaceAdmission && !isAbsolute(options.project)) || !options.connectionId)
            throw new Error("An absolute Project and connection identity are required.");
        this.workspaceAdmission = options.workspaceAdmission === true;
        this.emptyView = {
            connectionId: options.connectionId,
            project: options.project,
            connection: "connecting",
            phase: "empty",
            sessionId: "",
            durableSessionId: "",
            items: [],
            question: null,
            error: "",
            generation: null,
            archivedAt: null,
        };
        const app = client({ name: "RunWield Workspace" });
        app.onNotification("session/update", ({ params }) => this.update(params));
        app.onRequest("elicitation/create", ({ params, requestId, signal }) => {
            const state = "sessionId" in params ? this.bindings.get(String(params.sessionId)) : undefined;
            if (
                this.disposed ||
                signal.aborted ||
                !("sessionId" in params) ||
                !state ||
                state.pending ||
                state.view.phase === "canceling"
            )
                return { action: "cancel" };
            try {
                const question = questionView(params, `${typeof requestId}:${requestId}:${++this.sequence}`);
                return new Promise<CreateElicitationResponse>((resolve) => {
                    const abort = () => this.dismissQuestion(state);
                    state.pending = {
                        view: question,
                        resolve: (response) => {
                            signal.removeEventListener("abort", abort);
                            resolve(response);
                        },
                    };
                    signal.addEventListener("abort", abort, { once: true });
                    state.view.question = question;
                    state.view.phase = "awaiting_answer";
                    this.emit();
                });
            } catch (error) {
                state.view.error = error instanceof Error ? error.message : "Unsupported question.";
                this.emit();
                return { action: "cancel" };
            }
        });
        this.connection = app.connect(ndJsonStream(options.output, options.input));
        this.initialized = this.initialize();
        void this.connection.closed.then(() => {
            this.emptyView.connection = "disconnected";
            for (const state of this.bindings.values()) {
                state.epoch++;
                if (state.polling) clearTimeout(state.polling);
                state.polling = null;
                this.dismissQuestion(state);
                state.view.connection = "disconnected";
                state.view.phase = "interrupted";
                if (!this.disposed) state.view.error = "The runtime disconnected. Input was not sent again.";
            }
            this.emit();
        });
    }

    private async initialize(): Promise<void> {
        try {
            const result = await this.connection.agent.request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                clientInfo: { name: "RunWield Workspace", version: "1" },
                clientCapabilities: {
                    elicitation: { form: {} },
                    ...(this.workspaceAdmission ? { _meta: { [WORKSPACE_EXTENSION]: { version: 1 } } } : {}),
                },
            });
            if (this.workspaceAdmission) {
                const workspace = result._meta?.[WORKSPACE_EXTENSION] as WorkspaceCapability | undefined;
                if (
                    workspace?.version !== 1 ||
                    workspace.projects?.version !== 1 ||
                    workspace.sessions?.version !== 1 ||
                    typeof workspace.connectionId !== "string" ||
                    !workspace.connectionId ||
                    workspace.connectionId.length > 128
                )
                    throw new Error("The runtime does not support Workspace Project admission version 1.");
                this.view.connectionId = workspace.connectionId;
            }
            const capabilities = result.agentCapabilities;
            const meta = capabilities?.sessionCapabilities?._meta?.runwield as RunWieldMetadata | undefined;
            if (
                result.protocolVersion !== PROTOCOL_VERSION ||
                !capabilities?.loadSession ||
                !capabilities.sessionCapabilities?.close ||
                !Array.isArray(meta?.implementedMethods) ||
                !REQUIRED_METHODS.every((method) => meta.implementedMethods?.includes(method))
            ) {
                throw new Error("The runtime does not support the required Workspace Session protocol.");
            }
            if (this.view.connection === "connecting") this.view.connection = "ready";
        } catch (error) {
            if (this.view.connection !== "disconnected") this.view.connection = "incompatible";
            this.view.error = error instanceof Error ? error.message : "Runtime initialization failed.";
        }
        this.emit();
    }

    private metadata(state: SessionState, requestId?: string, expectedGeneration = state.view.generation ?? 0) {
        return this.workspaceAdmission
            ? {
                  _meta: {
                      [WORKSPACE_EXTENSION]: {
                          ...state.context!,
                          ...(requestId
                              ? {
                                    requestId,
                                    expectedGeneration,
                                    ...(!state.view.durableSessionId
                                        ? { configuration: state.launchConfiguration }
                                        : {}),
                                }
                              : {}),
                      },
                  },
              }
            : {};
    }
    async readProject(request: WorkspaceProjectRequest): Promise<WorkspaceOpenProjectResult> {
        await this.ready();
        const result = await this.connection.agent.request<WorkspaceOpenProjectResult>(
            "_dev.runwield/workspace/projects/open",
            request,
        );
        if (
            result.context.connectionId !== this.view.connectionId ||
            result.context.projectId !== request.projectId ||
            !isAbsolute(result.context.canonicalRoot)
        )
            throw new Error("Stale Project context.");
        return result;
    }
    async listSessions(request: WorkspaceSessionListRequest): Promise<WorkspaceSessionListResult> {
        await this.ready();
        const result = await this.connection.agent.request<WorkspaceSessionListResult>("session/list", {
            cwd: request.context.canonicalRoot,
            cursor: request.cursor,
            _meta: {
                [WORKSPACE_EXTENSION]: { ...request.context, archiveState: request.archiveState, limit: request.limit },
            },
        });
        return { sessions: result.sessions, nextCursor: result.nextCursor || null };
    }
    async history(request: WorkspaceHistoryRequest): Promise<WorkspaceHistoryResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceHistoryResult>(
            "_dev.runwield/workspace/sessions/history",
            request,
        );
    }
    async snapshot(request: WorkspaceSnapshotRequest): Promise<WorkspaceSnapshotResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceSnapshotResult>(
            "_dev.runwield/workspace/sessions/snapshot",
            request,
        );
    }
    async stageConfiguration(
        binding: SessionBinding,
        selection: import("../workspace-contract.ts").WorkspaceConfigurationSelection,
    ): Promise<void> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        const state = this.binding(binding);
        if (!state.context) throw new Error("Open a registered Project first.");
        if (state.view.durableSessionId) {
            await this.configure({
                context: state.context,
                sessionId: state.view.durableSessionId,
                requestId: crypto.randomUUID(),
                expectedGeneration: state.view.generation ?? 0,
                ...selection,
            });
        } else {
            const options = await this.sessionOptions(state.context);
            this.binding(binding);
            if (selection.agentName && !options.agents.some((agent) => agent.name === selection.agentName))
                throw new Error("Unsupported Agent.");
            if (
                selection.model &&
                !options.models.some((model) => model.id === selection.model && model.provider === selection.provider)
            )
                throw new Error("Unsupported model.");
            if (selection.thinkingLevel && !options.thinkingLevels.includes(selection.thinkingLevel))
                throw new Error("Unsupported thinking level.");
            state.launchConfiguration = { ...state.launchConfiguration, ...selection };
            state.view.configuration = {
                agentName: selection.agentName || state.view.configuration?.agentName || options.defaults.agentName,
                model: selection.model || state.view.configuration?.model || options.defaults.model,
                provider: selection.provider || state.view.configuration?.provider || options.defaults.provider,
                thinkingLevel:
                    selection.thinkingLevel ||
                    state.view.configuration?.thinkingLevel ||
                    options.defaults.thinkingLevel,
            };
            this.emit();
        }
    }
    async sessionOptions(
        context: WorkspaceProjectContext,
    ): Promise<import("../workspace-contract.ts").WorkspaceOptionsResult> {
        await this.ready();
        return this.connection.agent.request("_dev.runwield/workspace/sessions/options", { context });
    }
    async command(
        binding: SessionBinding,
        text: string,
    ): Promise<import("../../shared/session/session-input-contract.ts").SessionCommandResult> {
        const state = this.binding(binding);
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        if (!state.context || state.view.phase !== "idle")
            throw new Error("Wait for the Session to finish before using commands.");
        const result = await this.connection.agent.request<
            import("../../shared/session/session-input-contract.ts").SessionCommandResult
        >("_dev.runwield/workspace/sessions/command", {
            context: state.context,
            wireSessionId: binding.sessionId,
            text,
        });
        this.binding(binding);
        if (result.action === "new") {
            await this.close(binding);
            await this.open(undefined, state.context);
        } else if (result.action === "configure" && result.selection)
            await this.stageConfiguration(binding, result.selection);
        else if (result.message) {
            const item = { id: `command:${crypto.randomUUID()}`, kind: "system" as const, text: result.message };
            state.commandItems.push(item);
            state.view.items.push(item);
            state.committedItems = structuredClone(state.view.items);
            this.emit();
        }
        return result;
    }
    async configure(request: WorkspaceConfigureRequest): Promise<void> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        await this.connection.agent.request("_dev.runwield/workspace/sessions/configure", request);
        await this.refreshRequest(request);
    }
    async unarchive(request: WorkspaceSessionRequest): Promise<void> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        await this.connection.agent.request("_dev.runwield/workspace/sessions/unarchive", request);
        await this.refreshRequest(request);
    }
    async archive(request: WorkspaceSessionRequest, confirmed = false): Promise<void> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        await this.connection.agent.request("session/delete", {
            sessionId: request.sessionId,
            _meta: { [WORKSPACE_EXTENSION]: { ...request.context, confirmed } },
        });
        await this.refreshRequest(request);
    }
    queue(binding: SessionBinding, draft: SessionQueuedDraft): void {
        const state = this.binding(binding);
        validateSessionInput(draft.text, draft.images);
        if (!draft.requestId) throw new Error("A stable request ID is required.");
        state.rejectedQueued.delete(draft.requestId);
        const existing = state.queuedDrafts.findIndex((item) => item.requestId === draft.requestId);
        if (existing >= 0) state.queuedDrafts[existing] = structuredClone(draft);
        else state.queuedDrafts.push(structuredClone(draft));
        state.view.queued = structuredClone(state.queuedDrafts);
        this.emit();
    }
    removeQueued(binding: SessionBinding, requestId: string): void {
        const state = this.binding(binding);
        state.rejectedQueued.delete(requestId);
        const index = state.queuedDrafts.findIndex((draft) => draft.requestId === requestId);
        if (index >= 0) state.queuedDrafts.splice(index, 1);
        state.view.queued = structuredClone(state.queuedDrafts);
        this.emit();
    }
    private async refreshHistory(state: SessionState): Promise<void> {
        const read = this.readHistory(state);
        state.historyRead = read;
        await read;
        // A newer read can supersede this one. Callers that are about to prepare
        // input still need its admitted generation before choosing metadata.
        if (state.historyRead !== read) await state.historyRead;
    }
    private async readHistory(state: SessionState): Promise<void> {
        if (!state.context || !state.view.durableSessionId) return;
        const epoch = state.epoch;
        const version = ++state.readVersion;
        const durableId = state.view.durableSessionId;
        const history = await this.history({ context: state.context, sessionId: durableId });
        if (
            !this.current(state, epoch) ||
            version !== state.readVersion ||
            durableId !== state.view.durableSessionId ||
            history.generation < (state.view.generation ?? 0)
        )
            return;
        state.view.generation = history.generation;
        state.view.archivedAt = history.archivedAt;
        state.view.configuration = history.configuration;
        state.view.items = [];
        state.seenEvents.clear();
        this.applyEvents(state, history.events);
        state.view.items.push(...structuredClone(state.commandItems));
        state.committedItems = structuredClone(state.view.items);
        state.committedGeneration = history.generation;
        state.committedEventIds = new Set(state.seenEvents);
        this.emit();
    }
    private applyEvents(state: SessionState, events: WorkspaceJsonRecord[]): void {
        for (let index = 0; index < events.length; index++) {
            const event = events[index];
            const identity = String(event.eventId || `${state.view.operationId}:${index}`);
            if (state.seenEvents.has(identity)) continue;
            state.seenEvents.add(identity);
            const type = event.type;
            const kind =
                type === "user_message"
                    ? "user"
                    : type === "assistant_text_delta"
                      ? "assistant"
                      : type === "assistant_thinking_delta"
                        ? "thinking"
                        : "system";
            if (kind !== "system") {
                const id = `${kind}:${event.messageId || identity}`;
                const text = String(kind === "user" ? event.text || "" : event.delta || "");
                const item = state.view.items.find((item) => item.id === id);
                if (item) item.text += text;
                else
                    state.view.items.push({
                        id,
                        kind,
                        text,
                        ...(kind === "user" && Array.isArray(event.images)
                            ? {
                                  images: event.images.flatMap((image) =>
                                      image &&
                                      typeof image === "object" &&
                                      !Array.isArray(image) &&
                                      typeof image.base64 === "string" &&
                                      typeof image.mimeType === "string"
                                          ? [{ base64: image.base64, mimeType: image.mimeType }]
                                          : [],
                                  ),
                              }
                            : {}),
                    });
            } else if (type === "tool_start" || type === "tool_update" || type === "tool_end") {
                const id = `tool:${event.toolCallId}`;
                let item = state.view.items.find((item) => item.id === id);
                if (!item) {
                    item = { id, kind: "tool", text: "" };
                    state.view.items.push(item);
                }
                item.title = String(event.title || "Tool");
                item.status = type === "tool_end" ? (event.isError ? "failed" : "completed") : "in_progress";
                if (event.content) item.text = JSON.stringify(event.content);
            } else if (type === "system_status" || type === "agent_changed" || type === "terminal_error") {
                state.view.items.push({
                    id: identity,
                    kind: "system",
                    text: String(event.message || event.agentName || ""),
                });
            }
        }
    }
    private async reconcile(state: SessionState, forceHistory = false, attempt = 0): Promise<void> {
        if (!this.workspaceAdmission || !state.context) return;
        const epoch = state.epoch;
        const sessionId = state.view.sessionId;
        const historyVersion = state.readVersion;
        const snapshot = await this.snapshot({
            context: state.context,
            sessionId: state.view.durableSessionId,
            wireSessionId: sessionId,
            cursor: state.observationCursor || undefined,
        });
        if (!this.current(state, epoch)) return;
        if (
            historyVersion !== state.readVersion ||
            (state.view.generation != null &&
                (snapshot.generation === null || snapshot.generation < state.view.generation))
        ) {
            if (forceHistory) {
                if (attempt >= 3) throw new Error("Session evidence changed during refresh. Refresh again.");
                await this.reconcile(state, true, attempt + 1);
            }
            return;
        }
        const changed = snapshot.generation !== null && snapshot.generation !== state.view.generation;
        const operation = snapshot.operation;
        if (snapshot.sessionId) state.view.durableSessionId = snapshot.sessionId;
        if (typeof operation?.runwieldSessionId === "string") state.view.durableSessionId = operation.runwieldSessionId;
        if ((forceHistory || changed || snapshot.gap) && snapshot.generation !== null) {
            await this.refreshHistory(state);
        }
        // History can advance while this snapshot is in flight. Never move evidence backward.
        if (!this.current(state, epoch)) return;
        if (
            state.view.generation != null &&
            (snapshot.generation === null || snapshot.generation < state.view.generation)
        ) {
            if (forceHistory) {
                if (attempt >= 3) throw new Error("Session evidence changed during refresh. Refresh again.");
                await this.reconcile(state, true, attempt + 1);
            }
            return;
        }
        state.observationCursor = snapshot.cursor;
        if (snapshot.generation !== null) state.view.generation = snapshot.generation;
        if (operation) {
            state.view.operationId = String(operation.operationId || "");
            state.view.sessionInfo = jsonRecord(operation.sessionInfo);
            state.view.pendingConfiguration = jsonRecord(operation.pendingConfiguration);
            state.view.coreQueuedMessages = Array.isArray(operation.queuedMessages)
                ? operation.queuedMessages.flatMap((entry) => {
                      const record = jsonRecord(entry);
                      return record ? [record] : [];
                  })
                : [];
            // Canonical history owns the whole event buffer once its generation crosses
            // the Core-owned admission boundary, even if the prompt response is delayed.
            const eventsCommitted =
                typeof operation.eventsAfterGeneration === "number" &&
                state.committedGeneration !== null &&
                state.committedGeneration > operation.eventsAfterGeneration;
            if (Array.isArray(operation.events)) {
                state.view.items = structuredClone(state.committedItems);
                state.seenEvents.clear();
                for (const identity of state.committedEventIds) state.seenEvents.add(identity);
                if (!eventsCommitted)
                    this.applyEvents(
                        state,
                        operation.events.filter((event): event is WorkspaceJsonRecord =>
                            Boolean(event && typeof event === "object" && !Array.isArray(event)),
                        ),
                    );
            }
            const interaction = operation.liveInteraction as WorkspaceJsonRecord | null;
            const request = interaction?.request as WorkspaceJsonRecord | null;
            if (interaction && request && !state.pending && state.view.phase !== "canceling") {
                const options = Array.isArray(request.options) ? request.options : [];
                const choices = options.flatMap((option) =>
                    option &&
                    typeof option === "object" &&
                    !Array.isArray(option) &&
                    typeof option.value === "string" &&
                    typeof option.label === "string"
                        ? [
                              {
                                  value: option.value,
                                  label: option.label,
                                  ...(typeof option.description === "string"
                                      ? { description: option.description }
                                      : {}),
                              },
                          ]
                        : [],
                );
                state.view.question = {
                    requestId: String(interaction.interactionId),
                    interactionId: String(interaction.interactionId),
                    prompt: String(request.prompt || ""),
                    mode: request.type === "approval" ? "approval" : choices.length ? "select" : "text",
                    required: request.allowEmpty !== true,
                    placeholder: String(request.placeholder || ""),
                    ...(typeof request.defaultValue === "string" ? { defaultValue: request.defaultValue } : {}),
                    choices,
                    allowOther: Boolean(request.otherOptionValue),
                    ...(typeof request.otherOptionValue === "string"
                        ? { otherOptionValue: request.otherOptionValue }
                        : {}),
                };
                state.view.phase = "awaiting_answer";
            } else if (!state.pending) {
                state.view.question = null;
                if (snapshot.state === "active" && state.view.phase !== "canceling") state.view.phase = "streaming";
                else if (snapshot.state === "idle" && !state.turn) state.view.phase = "idle";
            }
        } else {
            // Missing live transport while active is not settlement evidence.
            if (snapshot.state === "idle") state.view.operationId = undefined;
            if (!state.pending) state.view.question = null;
            state.view.sessionInfo = null;
            state.view.pendingConfiguration = null;
            state.view.coreQueuedMessages = [];
            if (!state.turn && !state.pending && snapshot.state === "idle") state.view.phase = "idle";
            else if (snapshot.state === "active" && state.view.phase !== "canceling") state.view.phase = "streaming";
        }
        if (state.pending && state.view.phase !== "canceling") state.view.phase = "awaiting_answer";
        if (!state.pending && snapshot.state !== "idle" && snapshot.state !== "active") {
            state.view.phase = "interrupted";
            state.view.error = "Session state requires reconciliation. Input was not sent again.";
        }
    }

    private startObservation(state: SessionState): void {
        if (!this.workspaceAdmission || !state.context || state.polling || this.attaching) return;
        const epoch = state.epoch;
        const sessionId = state.view.sessionId;
        const poll = async () => {
            state.polling = null;
            if (!this.current(state, epoch)) return;
            try {
                await this.reconcile(state);
                if (!this.current(state, epoch)) return;
                this.emit();
                if (
                    !this.draining &&
                    !state.turn &&
                    !state.dispatchingQueued &&
                    state.view.phase === "idle" &&
                    state.queuedDrafts.length &&
                    !state.queuedDrafts[0].restored &&
                    !this.attaching &&
                    !state.rejectedQueued.has(state.queuedDrafts[0].requestId)
                ) {
                    const draft = state.queuedDrafts[0];
                    state.dispatchingQueued = true;
                    void this.sendImages(
                        { connectionId: state.view.connectionId, project: state.view.project, sessionId },
                        draft.text,
                        draft.images,
                        draft.requestId,
                    )
                        .then(
                            () => {
                                if (this.bindings.get(sessionId) !== state) return;
                                this.removeQueued(
                                    { connectionId: state.view.connectionId, project: state.view.project, sessionId },
                                    draft.requestId,
                                );
                            },
                            (error: Error) => {
                                if (this.bindings.get(sessionId) !== state) return;
                                state.rejectedQueued.add(draft.requestId);
                                state.view.error = error.message;
                                this.emit();
                            },
                        )
                        .finally(() => {
                            state.dispatchingQueued = false;
                        });
                }
            } catch (error) {
                if (!this.current(state, epoch)) return;
                state.view.error = error instanceof Error ? error.message : "Observation failed.";
                state.view.phase = "interrupted";
                this.emit();
            }
            if (this.current(state, epoch)) state.polling = setTimeout(poll, 250);
        };
        state.polling = setTimeout(poll, 0);
    }

    /** Refresh all retained views before a replacement renderer receives observations. Never replay input. */
    reattachViews(): Promise<void> {
        if (this.reattachment) return this.reattachment;
        this.attaching++;
        const operation = (async () => {
            await this.ready();
            const states = [...this.bindings.values()];
            for (const state of states) {
                state.epoch++;
                if (state.polling) clearTimeout(state.polling);
                state.polling = null;
                state.observationCursor = "";
            }
            const errors = await Promise.all(
                states.map(async (state) => {
                    try {
                        await this.reconcile(state, true);
                        return null;
                    } catch (error) {
                        state.view.phase = "interrupted";
                        state.view.error = error instanceof Error ? error.message : "Observation failed.";
                        return new Error(state.view.error);
                    }
                }),
            );
            const failure = errors.find((error) => error !== null);
            if (failure) throw failure;
        })().finally(() => {
            this.attaching--;
            this.reattachment = null;
            this.emit();
            for (const state of this.bindings.values()) this.startObservation(state);
        });
        this.reattachment = operation;
        return operation;
    }
    async listProjects(): Promise<WorkspaceListProjectsResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceListProjectsResult>("_dev.runwield/workspace/projects/list", {});
    }
    async openProject(request: WorkspaceProjectRequest): Promise<WorkspaceOpenProjectResult> {
        await this.ready();
        if (this.selecting) throw new Error("Wait for Project selection to settle.");
        this.selecting = true;
        try {
            const result = await this.connection.agent.request<WorkspaceOpenProjectResult>(
                "_dev.runwield/workspace/projects/open",
                request,
            );
            if (
                result.context.connectionId !== this.view.connectionId ||
                result.context.projectId !== request.projectId ||
                !isAbsolute(result.context.canonicalRoot)
            )
                throw new Error("Stale Project context.");
            this.context = result.context;
            this.emptyView.project = result.context.canonicalRoot;
            this.selected = null;
            this.emit();
            return result;
        } finally {
            this.selecting = false;
        }
    }
    async registerProject(request: WorkspaceRegisterProjectRequest): Promise<WorkspaceProjectWriteResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceProjectWriteResult>(
            "_dev.runwield/workspace/projects/register",
            request,
        );
    }
    async relinkProject(request: WorkspaceRelinkProjectRequest): Promise<WorkspaceProjectWriteResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceProjectWriteResult>(
            "_dev.runwield/workspace/projects/relink",
            request,
        );
    }
    async setProjectEnabled(request: WorkspaceSetProjectEnabledRequest): Promise<WorkspaceProjectResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceProjectResult>(
            "_dev.runwield/workspace/projects/setEnabled",
            request,
        );
    }
    async removeProject(request: WorkspaceProjectRequest): Promise<WorkspaceRemoveProjectResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceRemoveProjectResult>(
            "_dev.runwield/workspace/projects/remove",
            request,
        );
    }
    async rescanProject(request: WorkspaceProjectRequest): Promise<WorkspaceRescanProjectResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceRescanProjectResult>(
            "_dev.runwield/workspace/projects/rescan",
            request,
        );
    }

    observe(listener: (view: SessionClientView) => void): () => void {
        this.listeners.add(listener);
        if (!this.attaching) listener(this.selectedView());
        return () => this.listeners.delete(listener);
    }

    getBindingView(sessionId: string): SessionClientView | undefined {
        const state = this.bindings.get(sessionId);
        return state ? structuredClone(state.view) : undefined;
    }

    getBindingViews(): SessionClientView[] {
        return [...this.bindings.values()].map((state) => structuredClone(state.view));
    }

    private selectedView(): SessionClientView {
        return {
            ...structuredClone(this.view),
            bindings: [...this.bindings.values()].map((state) => ({
                sessionId: state.view.sessionId,
                durableSessionId: state.view.durableSessionId,
                projectId: state.context?.projectId || "",
                project: state.view.project,
                phase: state.view.phase,
                hasQuestion: Boolean(state.view.question),
            })),
        };
    }

    private emit(): void {
        if (this.attaching) return;
        for (const listener of this.listeners) listener(this.selectedView());
    }

    private async ready(): Promise<void> {
        await this.initialized;
        if (this.disposed || this.emptyView.connection !== "ready")
            throw new Error(this.emptyView.error || "Runtime disconnected.");
    }

    private binding(binding: SessionBinding): SessionState {
        const state = this.bindings.get(binding.sessionId);
        if (!state || binding.connectionId !== state.view.connectionId || binding.project !== state.view.project) {
            throw new Error("This request does not belong to the active Project and Session.");
        }
        return state;
    }

    private current(state: SessionState, epoch: number): boolean {
        return (
            !this.disposed &&
            this.emptyView.connection === "ready" &&
            this.bindings.get(state.view.sessionId) === state &&
            state.epoch === epoch
        );
    }

    private async refreshRequest(request: WorkspaceSessionRequest): Promise<void> {
        await Promise.all(
            [...this.bindings.values()]
                .filter(
                    (state) =>
                        state.context?.projectId === request.context.projectId &&
                        state.view.durableSessionId === request.sessionId &&
                        state.view.generation != null,
                )
                .map((state) => this.refreshHistory(state)),
        );
    }

    private async open(sessionId?: string, context = this.context): Promise<void> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        if (this.selecting) throw new Error("Wait for Project selection to settle.");
        if (this.workspaceAdmission && !context) throw new Error("Open a registered Project first.");
        if (!this.workspaceAdmission && this.bindings.size) throw new Error("Close the current Session first.");
        if (this.opening) throw new Error("Wait for the Session operation to settle.");
        const existing = sessionId
            ? [...this.bindings.values()].find(
                  (state) =>
                      state.context?.projectId === context?.projectId &&
                      (state.view.durableSessionId === sessionId || state.view.sessionId === sessionId),
              )
            : undefined;
        if (existing) {
            this.selected = existing;
            this.emit();
            return;
        }
        if (sessionId !== undefined && (!sessionId.trim() || sessionId.length > 512))
            throw new Error("Enter a saved Session ID.");
        const state = new SessionState(
            {
                ...structuredClone(this.emptyView),
                project: context?.canonicalRoot || this.emptyView.project,
                items: [],
                question: null,
                sessionId: "",
                durableSessionId: "",
            },
            context ? { ...context } : null,
        );
        this.opening = true;
        this.selected = state;
        state.view.phase = "loading";
        state.view.error = "";
        state.view.items = [];
        // Replay can arrive before the load response. Bind its requested wire ID now.
        state.view.sessionId = sessionId || "";
        if (sessionId) this.bindings.set(sessionId, state);
        this.emit();
        try {
            const request: NewSessionRequest = { cwd: state.view.project, mcpServers: [], ...this.metadata(state) };
            let result: LoadSessionResponse;
            if (sessionId) {
                result = await this.connection.agent.request("session/load", { ...request, sessionId });
                if (this.workspaceAdmission && "sessionId" in result && typeof result.sessionId === "string")
                    state.view.sessionId = result.sessionId;
            } else {
                const created = await this.connection.agent.request("session/new", request);
                state.view.sessionId = created.sessionId;
                result = created;
            }
            if (sessionId && state.view.sessionId !== sessionId) this.bindings.delete(sessionId);
            this.bindings.set(state.view.sessionId, state);
            const meta = result._meta?.runwield as RunWieldMetadata | undefined;
            if (
                !state.view.sessionId ||
                typeof meta?.persistedSessionId !== "string" ||
                (!this.workspaceAdmission && !meta.persistedSessionId)
            ) {
                throw new Error("The runtime did not return a durable Session identity.");
            }
            if (this.emptyView.connection !== "ready")
                throw new Error("The runtime disconnected while opening the Session.");
            state.view.durableSessionId = meta.persistedSessionId;
            if (meta.history) {
                state.view.generation = meta.history.generation;
                state.view.configuration = meta.history.configuration;
                state.view.archivedAt = meta.history.archivedAt;
                this.applyEvents(state, meta.history.events);
                state.committedItems = structuredClone(state.view.items);
                state.committedGeneration = meta.history.generation;
                state.committedEventIds = new Set(state.seenEvents);
            }
            state.view.phase = "idle";
            this.startObservation(state);
        } catch (error) {
            this.bindings.delete(state.view.sessionId);
            state.view.connection = this.emptyView.connection;
            state.view.phase = state.view.connection === "ready" ? "empty" : "interrupted";
            state.view.sessionId = "";
            state.view.durableSessionId = "";
            state.view.items = [];
            state.view.error = error instanceof Error ? error.message : "Could not open Session.";
            throw error;
        } finally {
            this.opening = false;
            this.emit();
        }
    }

    create(): Promise<void> {
        return this.open();
    }
    load(sessionId: string): Promise<void> {
        return this.open(sessionId);
    }

    send(binding: SessionBinding, text: string): Promise<void> {
        return this.sendImages(binding, text, []);
    }
    /** The client alone chooses the original send kind and committed generation. No wire mutation. */
    async prepareSubmission(
        binding: SessionBinding,
        text: string,
        images: SessionImageTransfer[],
        requestId: string,
        expectedGeneration?: number,
    ): Promise<WorkspaceSubmissionMetadata> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        const state = this.binding(binding);
        if (!this.workspaceAdmission || !state.context) throw new Error("Workspace admission is required.");
        validateSessionInput(text, images);
        if (
            !requestId.trim() ||
            requestId.length > 512 ||
            (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 0))
        )
            throw new Error("Invalid submission identity.");
        if (!state.turn && state.view.phase === "streaming") await this.reconcile(state);
        if (!state.turn && state.view.phase === "idle" && expectedGeneration === undefined)
            await this.refreshHistory(state);
        this.binding(binding);
        const kind =
            state.view.phase === "streaming" ? "steering" : !state.view.durableSessionId ? "bootstrap" : "prompt";
        if (state.view.phase !== "idle" && kind !== "steering") throw new Error("Wait for the current turn to settle.");
        return {
            context: { ...state.context },
            wireSessionId: binding.sessionId,
            sessionId: state.view.durableSessionId,
            kind,
            requestId,
            expectedGeneration: expectedGeneration ?? state.view.generation ?? 0,
            text,
            images: images.map((image) => ({ ...image })),
        };
    }

    /** Send an explicitly prepared original kind. Never convert an interrupted steering into a prompt. */
    async submitPrepared(submission: WorkspaceSubmissionMetadata): Promise<void> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        const binding = {
            connectionId: this.emptyView.connectionId,
            project: submission.context.canonicalRoot,
            sessionId: submission.wireSessionId,
        };
        const state = this.binding(binding);
        if (!state.context || JSON.stringify(state.context) !== JSON.stringify(submission.context))
            throw new Error("Submission Project context changed.");
        validateSessionInput(submission.text, submission.images);
        if (
            (submission.kind === "bootstrap" && state.view.durableSessionId) ||
            (submission.kind !== "bootstrap" &&
                (!submission.sessionId || submission.sessionId !== state.view.durableSessionId))
        )
            throw new Error("Resolve the original submission before using a different Session identity.");
        await this.submissionEvent("prepared", submission);
        if (this.draining) throw new Error("Session connection is draining.");
        this.binding(binding);
        if (submission.kind === "steering") {
            await this.connection.agent.request("_session/steering", {
                sessionId: binding.sessionId,
                ...this.metadata(state, submission.requestId, submission.expectedGeneration),
                prompt: this.submissionPrompt(submission),
            });
            await this.submissionEvent("accepted", submission);
            return;
        }
        if (state.turn || state.view.phase !== "idle") throw new Error("Wait for the current turn to settle.");
        state.view.error = "";
        state.view.phase = "streaming";
        this.emit();
        const turn = this.connection.agent
            .request<import("@agentclientprotocol/sdk").PromptResponse>("session/prompt", {
                ...this.metadata(state, submission.requestId, submission.expectedGeneration),
                sessionId: binding.sessionId,
                prompt: this.submissionPrompt(submission),
            })
            .then(
                async (result) => {
                    const meta = result._meta?.runwield as RunWieldMetadata | undefined;
                    if (meta?.persistedSessionId) state.view.durableSessionId = meta.persistedSessionId;
                    await this.submissionEvent("accepted", { ...submission, sessionId: state.view.durableSessionId });
                    await this.refreshHistory(state);
                    if (state.view.connection === "ready") state.view.phase = "idle";
                },
                (error: Error) => {
                    state.view.error = errorText(error);
                    // A refused or lost response is not evidence that input had no effect.
                    state.view.phase = "interrupted";
                    throw error;
                },
            )
            .finally(() => {
                this.dismissQuestion(state);
                state.turn = null;
                this.emit();
            });
        state.turn = turn;
        await turn;
    }
    private submissionPrompt(submission: WorkspaceSubmissionMetadata) {
        return [
            ...(submission.text ? [{ type: "text" as const, text: submission.text }] : []),
            ...submission.images.map((image) => ({
                type: "image" as const,
                data: image.base64,
                mimeType: image.mimeType,
            })),
        ];
    }

    async sendImages(
        binding: SessionBinding,
        text: string,
        images: SessionImageTransfer[],
        requestId: string = crypto.randomUUID(),
        expectedGeneration?: number,
    ): Promise<void> {
        if (this.workspaceAdmission) {
            const submission = await this.prepareSubmission(binding, text, images, requestId, expectedGeneration);
            return await this.submitPrepared(submission);
        }
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        const state = this.binding(binding);
        if (!text.trim() || text.length > 128_000) throw new Error("Enter a message of at most 128,000 characters.");
        if (state.turn || state.view.phase !== "idle") throw new Error("Wait for the current turn to settle.");
        state.view.error = "";
        state.view.phase = "streaming";
        this.emit();
        const turn = this.connection.agent
            .request<import("@agentclientprotocol/sdk").PromptResponse>("session/prompt", {
                ...this.metadata(state, requestId, expectedGeneration ?? state.view.generation ?? 0),
                sessionId: binding.sessionId,
                prompt: [
                    ...(text ? [{ type: "text" as const, text }] : []),
                    ...images.map((image) => ({
                        type: "image" as const,
                        data: image.base64,
                        mimeType: image.mimeType,
                    })),
                ],
            })
            .then(
                async (result) => {
                    const meta = result._meta?.runwield as RunWieldMetadata | undefined;
                    if (meta?.persistedSessionId) state.view.durableSessionId = meta.persistedSessionId;
                    if (this.workspaceAdmission) {
                        await this.refreshHistory(state);
                    }
                    if (state.view.connection === "ready") state.view.phase = "idle";
                },
                (error: Error) => {
                    state.view.error = errorText(error);
                    state.view.phase = state.view.connection === "ready" ? "idle" : "interrupted";
                    throw error;
                },
            )
            .finally(() => {
                this.dismissQuestion(state);
                state.turn = null;
                this.emit();
            });
        state.turn = turn;
        await turn;
    }

    async answer(binding: SessionBinding, response: SessionQuestionAnswer): Promise<void> {
        await this.ready();
        if (this.draining) throw new Error("Session connection is draining.");
        const state = this.binding(binding);
        if (this.workspaceAdmission && !state.pending) {
            const question = state.view.question;
            if (!question || question.requestId !== response.requestId || !state.context)
                throw new Error("This question is no longer waiting for an answer.");
            if (
                response.action === "accept" &&
                question.choices.length &&
                !question.choices.some((choice) => choice.value === response.answer)
            )
                throw new Error("Choose one of the listed answers.");
            if (response.action === "accept" && question.required && !response.answer?.trim())
                throw new Error("An answer is required.");
            await this.connection.agent.request("_dev.runwield/workspace/sessions/answer", {
                context: state.context,
                sessionId: state.view.durableSessionId,
                operationId: state.view.operationId,
                interactionId: question.interactionId,
                requestId: crypto.randomUUID(),
                response: {
                    action: response.action,
                    ...(response.answer !== undefined ? { answer: response.answer } : {}),
                    ...(response.otherAnswer !== undefined ? { otherAnswer: response.otherAnswer } : {}),
                },
            });
            state.view.question = null;
            state.view.phase = "streaming";
            this.emit();
            return;
        }
        const pending = state.pending;
        if (!pending || response.requestId !== pending.view.requestId || state.view.phase !== "awaiting_answer") {
            throw new Error("This question is no longer waiting for an answer.");
        }
        if (response.action === "accept") {
            const answer = response.answer ?? "";
            if (pending.view.required && !answer.trim()) throw new Error("An answer is required.");
            if (pending.view.choices.length && !pending.view.choices.some((choice) => choice.value === answer)) {
                throw new Error("Choose one of the listed answers.");
            }
            if (response.otherAnswer !== undefined && !pending.view.allowOther)
                throw new Error("Other text is not supported.");
            state.pending = null;
            state.view.question = null;
            state.view.phase = "streaming";
            pending.resolve({
                action: "accept",
                content: {
                    answer,
                    ...(response.otherAnswer !== undefined ? { otherAnswer: response.otherAnswer } : {}),
                },
            });
        } else {
            this.dismissQuestion(state, response.action);
            state.view.phase = "streaming";
        }
        this.emit();
    }

    private dismissQuestion(state: SessionState, action: "cancel" | "decline" = "cancel"): void {
        const pending = state.pending;
        state.pending = null;
        state.view.question = null;
        pending?.resolve({ action });
    }

    async cancel(binding: SessionBinding): Promise<void> {
        await this.ready();
        const state = this.binding(binding);
        const turn = state.turn;
        if (!turn && !this.workspaceAdmission) throw new Error("There is no active prompt to stop.");
        state.view.phase = "canceling";
        state.view.question = null;
        this.emit();
        // Send cancellation before releasing the form so it cannot start another provider turn.
        await this.connection.agent.notify("session/cancel", { sessionId: binding.sessionId, ...this.metadata(state) });
        this.dismissQuestion(state);
        await turn;
    }

    async close(binding: SessionBinding): Promise<void> {
        await this.ready();
        const state = this.binding(binding);
        if (state.view.phase === "loading") throw new Error("Wait for the Session operation to settle.");
        if (state.turn && !this.workspaceAdmission) await this.cancel(binding);
        state.epoch++;
        if (state.polling) clearTimeout(state.polling);
        state.polling = null;
        state.view.phase = "loading";
        this.emit();
        try {
            const result = await this.connection.agent.request<WorkspaceCloseResponse>("session/close", {
                sessionId: binding.sessionId,
                ...this.metadata(state),
            });
            if (this.workspaceAdmission && result._meta?.[WORKSPACE_EXTENSION]?.status !== "settled")
                throw new Error("Session work is not settled. Keep the connection open and retry.");
        } catch (error) {
            state.view.phase = "interrupted";
            this.startObservation(state);
            this.emit();
            throw error;
        }
        state.epoch++;
        this.dismissQuestion(state);
        if (state.polling) clearTimeout(state.polling);
        this.bindings.delete(binding.sessionId);
        if (this.selected === state) this.selected = null;
        this.emit();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.initialized;
        if (this.emptyView.connection !== "ready")
            throw new Error("Cannot confirm settlement on a disconnected runtime.");
        if (this.workspaceAdmission) {
            const result = await this.drain();
            if (result.status !== "settled")
                throw new Error("Runtime work is not settled. Keep the connection open and retry.");
        } else {
            await Promise.all(
                [...this.bindings.values()].map((state) =>
                    this.close({
                        connectionId: state.view.connectionId,
                        project: state.view.project,
                        sessionId: state.view.sessionId,
                    }),
                ),
            );
        }
        await Promise.allSettled([...this.bindings.values()].flatMap((state) => (state.turn ? [state.turn] : [])));
        this.disposed = true;
        for (const state of this.bindings.values()) {
            state.epoch++;
            if (state.polling) clearTimeout(state.polling);
        }
        this.connection.close();
        await this.connection.closed;
    }

    private update(notification: SessionNotification): void {
        const state = this.bindings.get(notification.sessionId);
        if (!state || !state.view.sessionId || notification.sessionId !== state.view.sessionId) return;
        const update = notification.update;
        const kind = update.sessionUpdate;
        if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
            if (update.content.type !== "text") return;
            const itemKind =
                kind === "user_message_chunk" ? "user" : kind === "agent_thought_chunk" ? "thinking" : "assistant";
            const id = `${itemKind}:${update.messageId || `unidentified-${++this.sequence}`}`;
            const item = state.view.items.find((item) => item.id === id);
            if (item) item.text += update.content.text;
            else state.view.items.push({ id, kind: itemKind, text: update.content.text });
        } else if (kind === "tool_call" || kind === "tool_call_update") {
            const id = `tool:${update.toolCallId}`;
            let item = state.view.items.find((item) => item.id === id);
            if (!item) {
                item = { id, kind: "tool", text: "" };
                state.view.items.push(item);
            }
            if (update.title) item.title = update.title;
            if (update.status === "completed" || update.status === "failed" || update.status === "in_progress")
                item.status = update.status;
            if (update.content)
                item.text = update.content
                    .flatMap((entry) =>
                        entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : [],
                    )
                    .join("\n");
        } else {
            // Usage/configuration/commands are optional observations, not completion signals.
            return;
        }
        this.emit();
    }
}
