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
    SessionBinding,
    SessionClientQuestion,
    SessionClientView,
    SessionQuestionAnswer,
    WorkspaceSessionClient,
} from "../../ui/workspace/client/session-client.ts";

export interface AcpWorkspaceSessionOptions {
    connectionId: string;
    project: string;
    input: ReadableStream<Uint8Array>;
    output: WritableStream<Uint8Array>;
}

interface RunWieldMetadata {
    persistedSessionId?: string;
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
              return { value: choice.const, label: choice.title };
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
        choices,
        allowOther: Boolean(other),
    };
}

/** A persistent ACP v1 connection. The host supplies stdio, never Core runtime objects. */
export class AcpWorkspaceSessionClient implements WorkspaceSessionClient {
    private readonly connection: ClientConnection;
    private readonly initialized: Promise<void>;
    private readonly listeners = new Set<(view: SessionClientView) => void>();
    private readonly view: SessionClientView;
    private pending: PendingQuestion | null = null;
    private turn: Promise<void> | null = null;
    private sequence = 0;
    private disposed = false;

    constructor(options: AcpWorkspaceSessionOptions) {
        if (!isAbsolute(options.project) || !options.connectionId)
            throw new Error("An absolute Project and connection identity are required.");
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
                clientCapabilities: { elicitation: { form: {} } },
            });
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
            const request: NewSessionRequest = { cwd: this.view.project, mcpServers: [] };
            let result: LoadSessionResponse;
            if (sessionId) {
                result = await this.connection.agent.request("session/load", { ...request, sessionId });
            } else {
                const created = await this.connection.agent.request("session/new", request);
                this.view.sessionId = created.sessionId;
                result = created;
            }
            const meta = result._meta?.runwield as RunWieldMetadata | undefined;
            if (!this.view.sessionId || typeof meta?.persistedSessionId !== "string" || !meta.persistedSessionId) {
                throw new Error("The runtime did not return a durable Session identity.");
            }
            if (this.view.connection !== "ready")
                throw new Error("The runtime disconnected while opening the Session.");
            this.view.durableSessionId = meta.persistedSessionId;
            this.view.phase = "idle";
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

    async send(binding: SessionBinding, text: string): Promise<void> {
        await this.ready();
        this.binding(binding);
        if (this.turn || this.view.phase !== "idle") throw new Error("Wait for the current turn to settle.");
        if (!text.trim() || text.length > 128_000) throw new Error("Enter a message of at most 128,000 characters.");
        this.view.error = "";
        this.view.phase = "streaming";
        this.emit();
        const turn = this.connection.agent
            .request("session/prompt", {
                sessionId: binding.sessionId,
                prompt: [{ type: "text", text }],
            })
            .then(
                () => {
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
        if (!turn) throw new Error("There is no active prompt to stop.");
        this.view.phase = "canceling";
        this.view.question = null;
        this.emit();
        // Send cancellation before releasing the form so it cannot start another provider turn.
        await this.connection.agent.notify("session/cancel", { sessionId: binding.sessionId });
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
            await this.connection.agent.request("session/close", { sessionId: binding.sessionId });
        } catch (error) {
            this.view.phase = this.view.connection === "ready" ? "idle" : "interrupted";
            this.emit();
            throw error;
        }
        this.dismissQuestion();
        this.view.sessionId = "";
        this.view.durableSessionId = "";
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
