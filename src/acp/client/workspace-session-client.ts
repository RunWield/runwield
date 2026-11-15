import { validateSessionInput, type SessionImageTransfer } from "../../shared/session/session-input-contract.ts";
import type {
    WorkspaceHistoryRequest,
    WorkspaceHistoryResult,
    WorkspaceSnapshotRequest,
    WorkspaceSnapshotResult,
    WorkspaceSessionListRequest,
    WorkspaceSessionListResult,
    WorkspaceConfigureRequest,
    WorkspaceSessionRequest,
    WorkspaceJsonRecord,
    WorkspaceHistoryEvent,
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
    WorkspaceSessionClient,
} from "../../ui/workspace/client/session-client.ts";

export interface AcpWorkspaceSessionOptions {
    connectionId: string;
    project: string;
    workspaceAdmission?: boolean;
    input: ReadableStream<Uint8Array>;
    output: WritableStream<Uint8Array>;
}

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

/** A persistent ACP v1 connection. The host supplies stdio, never Core runtime objects. */
export class AcpWorkspaceSessionClient implements WorkspaceSavedSessionClient, WorkspaceProjectClient {
    private readonly connection: ClientConnection;
    private readonly initialized: Promise<void>;
    private readonly listeners = new Set<(view: SessionClientView) => void>();
    private readonly view: SessionClientView;
    private pending: PendingQuestion | null = null;
    private turn: Promise<void> | null = null;
    private sequence = 0;
    private disposed = false;
    private readonly workspaceAdmission: boolean;
    private context: WorkspaceProjectContext | null = null;
    private selecting = false;
    private polling: ReturnType<typeof setTimeout> | null = null;
    private observationCursor = "";
    private launchConfiguration: import("../workspace-contract.ts").WorkspaceConfigurationSelection = {};
    private committedItems: SessionClientItem[] = [];
    private committedOperationId = "";
    private committedEventIds = new Set<string>();
    private commandItems: SessionClientView["items"] = [];
    private readonly seenEvents = new Set<string>();
    private readonly rejectedQueued = new Set<string>();
    private readonly queuedDrafts: SessionQueuedDraft[] = [];

    constructor(options: AcpWorkspaceSessionOptions) {
        if ((!options.workspaceAdmission && !isAbsolute(options.project)) || !options.connectionId)
            throw new Error("An absolute Project and connection identity are required.");
        this.workspaceAdmission = options.workspaceAdmission === true;
        this.view = {
            connectionId: options.connectionId,
            project: options.project,
            connection: "connecting",
            phase: "empty",
            sessionId: "",
            durableSessionId: "",
            items: [],
            question: null,
            error: "",
        };
        const app = client({ name: "RunWield Workspace" });
        app.onNotification("session/update", ({ params }) => this.update(params));
        app.onRequest("elicitation/create", ({ params, requestId, signal }) => {
            if (
                this.disposed ||
                signal.aborted ||
                !("sessionId" in params) ||
                params.sessionId !== this.view.sessionId ||
                this.pending ||
                this.view.phase === "canceling"
            )
                return { action: "cancel" };
            try {
                const question = questionView(params, `${typeof requestId}:${requestId}:${++this.sequence}`);
                return new Promise<CreateElicitationResponse>((resolve) => {
                    const abort = () => this.dismissQuestion();
                    this.pending = {
                        view: question,
                        resolve: (response) => {
                            signal.removeEventListener("abort", abort);
                            resolve(response);
                        },
                    };
                    signal.addEventListener("abort", abort, { once: true });
                    this.view.question = question;
                    this.view.phase = "awaiting_answer";
                    this.emit();
                });
            } catch (error) {
                this.view.error = error instanceof Error ? error.message : "Unsupported question.";
                this.emit();
                return { action: "cancel" };
            }
        });
        this.connection = app.connect(ndJsonStream(options.output, options.input));
        this.initialized = this.initialize();
        void this.connection.closed.then(() => {
            this.dismissQuestion();
            this.view.connection = "disconnected";
            if (this.view.phase !== "empty") this.view.phase = "interrupted";
            if (!this.disposed) this.view.error = "The runtime disconnected. Input was not sent again.";
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

    private metadata(requestId?: string, expectedGeneration = this.view.generation ?? 0) {
        return this.workspaceAdmission
            ? {
                  _meta: {
                      [WORKSPACE_EXTENSION]: {
                          ...this.context!,
                          ...(requestId
                              ? {
                                    requestId,
                                    expectedGeneration,
                                    ...(!this.view.durableSessionId ? { configuration: this.launchConfiguration } : {}),
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
        this.binding(binding);
        if (!this.context) throw new Error("Open a registered Project first.");
        if (this.view.durableSessionId) {
            await this.configure({
                context: this.context,
                sessionId: this.view.durableSessionId,
                requestId: crypto.randomUUID(),
                expectedGeneration: this.view.generation ?? 0,
                ...selection,
            });
        } else {
            const options = await this.sessionOptions(this.context);
            if (selection.agentName && !options.agents.some((agent) => agent.name === selection.agentName))
                throw new Error("Unsupported Agent.");
            if (
                selection.model &&
                !options.models.some((model) => model.id === selection.model && model.provider === selection.provider)
            )
                throw new Error("Unsupported model.");
            if (selection.thinkingLevel && !options.thinkingLevels.includes(selection.thinkingLevel))
                throw new Error("Unsupported thinking level.");
            this.launchConfiguration = { ...this.launchConfiguration, ...selection };
            this.view.configuration = {
                agentName: selection.agentName || this.view.configuration?.agentName || options.defaults.agentName,
                model: selection.model || this.view.configuration?.model || options.defaults.model,
                provider: selection.provider || this.view.configuration?.provider || options.defaults.provider,
                thinkingLevel:
                    selection.thinkingLevel || this.view.configuration?.thinkingLevel || options.defaults.thinkingLevel,
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
        this.binding(binding);
        await this.ready();
        if (!this.context || this.view.phase !== "idle")
            throw new Error("Wait for the Session to finish before using commands.");
        const result = await this.connection.agent.request<
            import("../../shared/session/session-input-contract.ts").SessionCommandResult
        >("_dev.runwield/workspace/sessions/command", {
            context: this.context,
            wireSessionId: binding.sessionId,
            text,
        });
        this.binding(binding);
        if (result.action === "new") {
            await this.close(binding);
            await this.create();
        } else if (result.action === "configure" && result.selection)
            await this.stageConfiguration(binding, result.selection);
        else if (result.message) {
            const item = { id: `command:${crypto.randomUUID()}`, kind: "system" as const, text: result.message };
            this.commandItems.push(item);
            this.view.items.push(item);
            this.committedItems = structuredClone(this.view.items);
            this.emit();
        }
        return result;
    }
    async configure(request: WorkspaceConfigureRequest): Promise<void> {
        await this.ready();
        await this.connection.agent.request("_dev.runwield/workspace/sessions/configure", request);
        await this.refreshHistory();
    }
    async unarchive(request: WorkspaceSessionRequest): Promise<void> {
        await this.ready();
        await this.connection.agent.request("_dev.runwield/workspace/sessions/unarchive", request);
        await this.refreshHistory();
    }
    async archive(request: WorkspaceSessionRequest, confirmed = false): Promise<void> {
        await this.ready();
        await this.connection.agent.request("session/delete", {
            sessionId: request.sessionId,
            _meta: { [WORKSPACE_EXTENSION]: { ...request.context, confirmed } },
        });
        await this.refreshHistory();
    }
    queue(binding: SessionBinding, draft: SessionQueuedDraft): void {
        this.binding(binding);
        validateSessionInput(draft.text, draft.images);
        if (!draft.requestId) throw new Error("A stable request ID is required.");
        this.rejectedQueued.delete(draft.requestId);
        const existing = this.queuedDrafts.findIndex((item) => item.requestId === draft.requestId);
        if (existing >= 0) this.queuedDrafts[existing] = structuredClone(draft);
        else this.queuedDrafts.push(structuredClone(draft));
        this.view.queued = structuredClone(this.queuedDrafts);
        this.emit();
    }
    removeQueued(binding: SessionBinding, requestId: string): void {
        this.binding(binding);
        this.rejectedQueued.delete(requestId);
        const index = this.queuedDrafts.findIndex((draft) => draft.requestId === requestId);
        if (index >= 0) this.queuedDrafts.splice(index, 1);
        this.view.queued = structuredClone(this.queuedDrafts);
        this.emit();
    }
    private async refreshHistory(): Promise<void> {
        if (!this.context || !this.view.durableSessionId) return;
        const history = await this.history({ context: this.context, sessionId: this.view.durableSessionId });
        this.view.generation = history.generation;
        this.view.archivedAt = history.archivedAt;
        this.view.configuration = history.configuration;
        this.view.items = [];
        this.seenEvents.clear();
        this.applyEvents(history.events);
        this.view.items.push(...structuredClone(this.commandItems));
        this.committedItems = structuredClone(this.view.items);
        this.committedEventIds = new Set(this.seenEvents);
        this.emit();
    }
    private applyEvents(events: WorkspaceJsonRecord[]): void {
        for (let index = 0; index < events.length; index++) {
            const event = events[index];
            const identity = String(event.eventId || `${this.view.operationId}:${index}`);
            if (this.seenEvents.has(identity)) continue;
            this.seenEvents.add(identity);
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
                const item = this.view.items.find((item) => item.id === id);
                if (item) item.text += text;
                else
                    this.view.items.push({
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
                let item = this.view.items.find((item) => item.id === id);
                if (!item) {
                    item = { id, kind: "tool", text: "" };
                    this.view.items.push(item);
                }
                item.title = String(event.title || "Tool");
                item.status = type === "tool_end" ? (event.isError ? "failed" : "completed") : "in_progress";
                if (event.content) item.text = JSON.stringify(event.content);
            } else if (type === "system_status" || type === "agent_changed" || type === "terminal_error") {
                this.view.items.push({
                    id: identity,
                    kind: "system",
                    text: String(event.message || event.agentName || ""),
                });
            }
        }
    }
    private startObservation(): void {
        if (!this.workspaceAdmission || !this.context || this.polling) return;
        const sessionId = this.view.sessionId;
        const poll = async () => {
            this.polling = null;
            if (this.disposed || this.view.sessionId !== sessionId || !this.context) return;
            try {
                const snapshot = await this.snapshot({
                    context: this.context,
                    sessionId: this.view.durableSessionId,
                    wireSessionId: sessionId,
                    cursor: this.observationCursor || undefined,
                });
                if (this.view.sessionId !== sessionId) return;
                if (
                    this.view.generation != null &&
                    (snapshot.generation === null || snapshot.generation < this.view.generation)
                ) {
                    this.polling = setTimeout(poll, 250);
                    return;
                }
                const changed = snapshot.generation !== null && snapshot.generation !== this.view.generation;
                this.observationCursor = snapshot.cursor;
                const operation = snapshot.operation;
                if (snapshot.sessionId) this.view.durableSessionId = snapshot.sessionId;
                if (typeof operation?.runwieldSessionId === "string")
                    this.view.durableSessionId = operation.runwieldSessionId;
                if (changed || snapshot.gap) {
                    await this.refreshHistory();
                }
                if (snapshot.generation !== null) this.view.generation = snapshot.generation;
                if (operation) {
                    this.view.operationId = String(operation.operationId || "");
                    if (this.committedOperationId !== this.view.operationId && Array.isArray(operation.events)) {
                        this.view.items = structuredClone(this.committedItems);
                        this.seenEvents.clear();
                        for (const identity of this.committedEventIds) this.seenEvents.add(identity);
                        this.applyEvents(
                            operation.events.filter((event): event is WorkspaceJsonRecord =>
                                Boolean(event && typeof event === "object" && !Array.isArray(event)),
                            ),
                        );
                    }
                    const interaction = operation.liveInteraction as WorkspaceJsonRecord | null;
                    const request = interaction?.request as WorkspaceJsonRecord | null;
                    if (interaction && request && !this.pending) {
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
                        this.view.question = {
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
                        this.view.phase = "awaiting_answer";
                    } else if (!this.pending) {
                        this.view.question = null;
                        if (snapshot.state === "active") this.view.phase = "streaming";
                    }
                } else {
                    // Missing live transport while active is not settlement evidence.
                    if (snapshot.state === "idle") this.view.operationId = undefined;
                    this.view.question = null;
                    if (!this.turn && snapshot.state !== "active") this.view.phase = "idle";
                }
                this.emit();
                if (
                    !this.turn &&
                    this.view.phase === "idle" &&
                    this.queuedDrafts.length &&
                    !this.rejectedQueued.has(this.queuedDrafts[0].requestId)
                ) {
                    const draft = this.queuedDrafts[0];
                    try {
                        await this.sendImages(
                            { connectionId: this.view.connectionId, project: this.view.project, sessionId },
                            draft.text,
                            draft.images,
                            draft.requestId,
                        );
                    } catch (error) {
                        this.rejectedQueued.add(draft.requestId);
                        throw error;
                    }
                    this.removeQueued(
                        { connectionId: this.view.connectionId, project: this.view.project, sessionId },
                        draft.requestId,
                    );
                }
            } catch (error) {
                this.view.error = error instanceof Error ? error.message : "Observation failed.";
                this.emit();
            }
            if (!this.disposed && this.view.sessionId === sessionId) this.polling = setTimeout(poll, 250);
        };
        this.polling = setTimeout(poll, 0);
    }
    async listProjects(): Promise<WorkspaceListProjectsResult> {
        await this.ready();
        return this.connection.agent.request<WorkspaceListProjectsResult>("_dev.runwield/workspace/projects/list", {});
    }
    async openProject(request: WorkspaceProjectRequest): Promise<WorkspaceOpenProjectResult> {
        await this.ready();
        if (this.view.sessionId || this.view.phase === "loading" || this.selecting)
            throw new Error("Close the current Session before selecting another Project.");
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
            this.view.project = result.context.canonicalRoot;
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
        listener(structuredClone(this.view));
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of this.listeners) listener(structuredClone(this.view));
    }

    private async ready(): Promise<void> {
        await this.initialized;
        if (this.disposed || this.view.connection !== "ready")
            throw new Error(this.view.error || "Runtime disconnected.");
    }

    private binding(binding: SessionBinding): void {
        if (
            !this.view.sessionId ||
            binding.connectionId !== this.view.connectionId ||
            binding.project !== this.view.project ||
            binding.sessionId !== this.view.sessionId
        ) {
            throw new Error("This request does not belong to the active Project and Session.");
        }
    }

    private async open(sessionId?: string): Promise<void> {
        await this.ready();
        if (this.selecting) throw new Error("Wait for Project selection to settle.");
        if (this.workspaceAdmission && !this.context) throw new Error("Open a registered Project first.");
        if (this.view.sessionId || this.view.phase === "loading") throw new Error("Close the current Session first.");
        if (sessionId !== undefined && (!sessionId.trim() || sessionId.length > 512))
            throw new Error("Enter a saved Session ID.");
        this.view.phase = "loading";
        this.view.error = "";
        this.view.items = [];
        // Replay can arrive before the load response. Bind its requested wire ID now.
        this.view.sessionId = sessionId || "";
        this.emit();
        try {
            const request: NewSessionRequest = { cwd: this.view.project, mcpServers: [], ...this.metadata() };
            let result: LoadSessionResponse;
            if (sessionId) {
                result = await this.connection.agent.request("session/load", { ...request, sessionId });
                if (this.workspaceAdmission && "sessionId" in result && typeof result.sessionId === "string")
                    this.view.sessionId = result.sessionId;
            } else {
                const created = await this.connection.agent.request("session/new", request);
                this.view.sessionId = created.sessionId;
                result = created;
            }
            const meta = result._meta?.runwield as RunWieldMetadata | undefined;
            if (
                !this.view.sessionId ||
                typeof meta?.persistedSessionId !== "string" ||
                (!this.workspaceAdmission && !meta.persistedSessionId)
            ) {
                throw new Error("The runtime did not return a durable Session identity.");
            }
            if (this.view.connection !== "ready")
                throw new Error("The runtime disconnected while opening the Session.");
            this.view.durableSessionId = meta.persistedSessionId;
            if (meta.history) {
                this.view.generation = meta.history.generation;
                this.view.configuration = meta.history.configuration;
                this.view.archivedAt = meta.history.archivedAt;
                this.applyEvents(meta.history.events);
                this.committedItems = structuredClone(this.view.items);
                this.committedEventIds = new Set(this.seenEvents);
            }
            this.view.phase = "idle";
            this.startObservation();
        } catch (error) {
            this.view.phase = this.view.connection === "ready" ? "empty" : "interrupted";
            this.view.sessionId = "";
            this.view.durableSessionId = "";
            this.view.items = [];
            this.view.error = error instanceof Error ? error.message : "Could not open Session.";
            throw error;
        } finally {
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
    async sendImages(
        binding: SessionBinding,
        text: string,
        images: SessionImageTransfer[],
        requestId: string = crypto.randomUUID(),
        expectedGeneration?: number,
    ): Promise<void> {
        await this.ready();
        this.binding(binding);
        if (this.workspaceAdmission) {
            validateSessionInput(text, images);
            if (!this.turn && this.view.phase === "streaming" && this.context && this.view.durableSessionId) {
                const live = await this.snapshot({ context: this.context, sessionId: this.view.durableSessionId });
                if (live.state === "idle" && !live.operation) this.view.phase = "idle";
            }
            if (!this.turn && this.view.phase === "idle" && expectedGeneration === undefined)
                await this.refreshHistory();
        } else if (!text.trim() || text.length > 128_000)
            throw new Error("Enter a message of at most 128,000 characters.");
        if (this.turn || this.view.phase !== "idle") {
            if (this.workspaceAdmission && this.view.phase === "streaming") {
                await this.connection.agent.request("_session/steering", {
                    sessionId: binding.sessionId,
                    ...this.metadata(requestId),
                    prompt: [
                        ...(text ? [{ type: "text" as const, text }] : []),
                        ...images.map((image) => ({
                            type: "image" as const,
                            data: image.base64,
                            mimeType: image.mimeType,
                        })),
                    ],
                });
                return;
            }
            throw new Error("Wait for the current turn to settle.");
        }
        this.view.error = "";
        this.view.phase = "streaming";
        this.emit();
        const turn = this.connection.agent
            .request<import("@agentclientprotocol/sdk").PromptResponse>("session/prompt", {
                ...this.metadata(requestId, expectedGeneration ?? this.view.generation ?? 0),
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
                    if (meta?.persistedSessionId) this.view.durableSessionId = meta.persistedSessionId;
                    if (this.workspaceAdmission) {
                        await this.refreshHistory();
                        this.committedOperationId = meta?.operationId || "";
                    }
                    if (this.view.connection === "ready") this.view.phase = "idle";
                },
                (error: Error) => {
                    this.view.error = errorText(error);
                    this.view.phase = this.view.connection === "ready" ? "idle" : "interrupted";
                    throw error;
                },
            )
            .finally(() => {
                this.dismissQuestion();
                this.turn = null;
                this.emit();
            });
        this.turn = turn;
        await turn;
    }

    async answer(binding: SessionBinding, response: SessionQuestionAnswer): Promise<void> {
        await this.ready();
        this.binding(binding);
        if (this.workspaceAdmission && !this.pending) {
            const question = this.view.question;
            if (!question || question.requestId !== response.requestId || !this.context)
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
                context: this.context,
                sessionId: this.view.durableSessionId,
                operationId: this.view.operationId,
                interactionId: question.interactionId,
                requestId: crypto.randomUUID(),
                response: {
                    action: response.action,
                    ...(response.answer !== undefined ? { answer: response.answer } : {}),
                    ...(response.otherAnswer !== undefined ? { otherAnswer: response.otherAnswer } : {}),
                },
            });
            this.view.question = null;
            this.view.phase = "streaming";
            this.emit();
            return;
        }
        const pending = this.pending;
        if (!pending || response.requestId !== pending.view.requestId || this.view.phase !== "awaiting_answer") {
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
            this.pending = null;
            this.view.question = null;
            this.view.phase = "streaming";
            pending.resolve({
                action: "accept",
                content: {
                    answer,
                    ...(response.otherAnswer !== undefined ? { otherAnswer: response.otherAnswer } : {}),
                },
            });
        } else {
            this.dismissQuestion(response.action);
            this.view.phase = "streaming";
        }
        this.emit();
    }

    private dismissQuestion(action: "cancel" | "decline" = "cancel"): void {
        const pending = this.pending;
        this.pending = null;
        this.view.question = null;
        pending?.resolve({ action });
    }

    async cancel(binding: SessionBinding): Promise<void> {
        await this.ready();
        this.binding(binding);
        const turn = this.turn;
        if (!turn && !this.workspaceAdmission) throw new Error("There is no active prompt to stop.");
        this.view.phase = "canceling";
        this.view.question = null;
        this.emit();
        // Send cancellation before releasing the form so it cannot start another provider turn.
        await this.connection.agent.notify("session/cancel", { sessionId: binding.sessionId, ...this.metadata() });
        this.dismissQuestion();
        await turn;
    }

    async close(binding: SessionBinding): Promise<void> {
        await this.ready();
        this.binding(binding);
        if (this.view.phase === "loading") throw new Error("Wait for the Session operation to settle.");
        if (this.turn) await this.cancel(binding);
        this.view.phase = "loading";
        this.emit();
        try {
            await this.connection.agent.request("session/close", { sessionId: binding.sessionId, ...this.metadata() });
        } catch (error) {
            this.view.phase = this.view.connection === "ready" ? "idle" : "interrupted";
            this.emit();
            throw error;
        }
        this.dismissQuestion();
        if (this.polling) clearTimeout(this.polling);
        this.polling = null;
        this.observationCursor = "";
        this.seenEvents.clear();
        this.committedEventIds.clear();
        this.committedItems = [];
        this.commandItems = [];
        this.launchConfiguration = {};
        this.committedOperationId = "";
        this.queuedDrafts.splice(0);
        this.view.queued = [];
        this.view.sessionId = "";
        this.view.durableSessionId = "";
        this.view.generation = null;
        this.view.archivedAt = null;
        this.view.configuration = undefined;
        this.view.operationId = undefined;
        this.rejectedQueued.clear();
        this.view.phase = "empty";
        this.emit();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.initialized;
        if (this.view.sessionId && this.view.connection === "ready") {
            await this.close({
                connectionId: this.view.connectionId,
                project: this.view.project,
                sessionId: this.view.sessionId,
            });
        }
        this.disposed = true;
        this.dismissQuestion();
        this.connection.close();
        await this.connection.closed;
    }

    private update(notification: SessionNotification): void {
        if (!this.view.sessionId || notification.sessionId !== this.view.sessionId) return;
        const update = notification.update;
        const kind = update.sessionUpdate;
        if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
            if (update.content.type !== "text") return;
            const itemKind =
                kind === "user_message_chunk" ? "user" : kind === "agent_thought_chunk" ? "thinking" : "assistant";
            const id = `${itemKind}:${update.messageId || `unidentified-${++this.sequence}`}`;
            const item = this.view.items.find((item) => item.id === id);
            if (item) item.text += update.content.text;
            else this.view.items.push({ id, kind: itemKind, text: update.content.text });
        } else if (kind === "tool_call" || kind === "tool_call_update") {
            const id = `tool:${update.toolCallId}`;
            let item = this.view.items.find((item) => item.id === id);
            if (!item) {
                item = { id, kind: "tool", text: "" };
                this.view.items.push(item);
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
