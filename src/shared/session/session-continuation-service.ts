/**
 * Core continuation ownership for managed Sessions.
 * Adapters provide interaction presentation and attention delivery, not writer or receipt policy.
 */
import type { OwnerCoordinationStore } from "../owner-coordination/index.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import type {
    SessionRuntimeEvent,
    RuntimeAttentionRequestedEvent,
    RuntimeQueuedMessage,
} from "./session-runtime-events.js";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
    RuntimeInteractionAdapter,
} from "./session-runtime-interactions.ts";
import type { LiveSessionInfo } from "./live-session-connection.ts";
import type { ImageAttachment } from "./types.js";
import type { SessionListOptions } from "./session-history.ts";
import { validateSessionInput } from "./session-input-contract.ts";
import { normalizeInteractionResponse } from "./session-runtime-interactions.ts";

export interface ContinuationServiceOptions {
    store: OwnerCoordinationStore;
    ownerProcessKind?: NonNullable<Parameters<typeof createSessionRuntime>[0]>["ownerProcessKind"];
    inputSurface?: import("./session-runtime-events.js").NotificationSurface;
}
export type ContinuationThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface PendingConfiguration {
    agentName?: string;
    model?: string;
    provider?: string;
}
export interface InteractionAnswer {
    resolve: (value: RuntimeInteractionResponse) => void | Promise<void>;
    reject: (error: Error) => void;
}
export interface ContinuationInteraction<Request extends RuntimeInteractionRequest> {
    interactionId: string;
    request: Request;
}
export interface ContinuationOperationRecord<Request extends RuntimeInteractionRequest = RuntimeInteractionRequest> {
    status: string;
    projectId: string;
    events: SessionRuntimeEvent[];
    remote?: boolean;
    sessionInfo?: LiveSessionInfo | null;
    queuedMessages?: RuntimeQueuedMessage[];
    error?: string;
    generation?: number | null;
    runwieldSessionId?: string | null;
    runtimeSessionId?: string;
    planId?: string;
    expectedGeneration?: number;
    pendingConfiguration?: PendingConfiguration;
    createReceipt?: { requestId: string; requestHash: string; deviceId: string | null };
    liveInteraction?: ContinuationInteraction<Request>;
    answer?: InteractionAnswer | null;
}
export interface ContinuationOperationSnapshot<Request extends RuntimeInteractionRequest = RuntimeInteractionRequest> {
    operationId: string;
    status: string;
    projectId?: string;
    events: SessionRuntimeEvent[];
    runwieldSessionId?: string | null;
    generation?: number | null;
    error?: string | null;
    sessionInfo?: LiveSessionInfo | null;
    queuedMessages?: RuntimeQueuedMessage[];
    liveInteraction?: ContinuationInteraction<Request> | null;
    pendingConfiguration?: PendingConfiguration | null;
}
interface CreateSessionResult {
    operationId: string;
    status: string;
    runwieldSessionId: string | null;
    generation: number | null;
}
interface CreateRequest {
    requestHash: string;
    operationId: string;
}
interface PendingCreateRequest {
    requestHash: string;
    settled: Promise<void>;
}
type OperationListener<Request extends RuntimeInteractionRequest> = (
    snapshot: ContinuationOperationSnapshot<Request>,
) => void;
type OperationChangeListener = (status: string) => void;
type VoidResolver = (value?: void | PromiseLike<void>) => void;
interface RetainedSession {
    sessionId: string;
    unsubscribe: () => void;
}
interface AdoptedSession {
    sessionId: string;
}
export interface SessionArchiveRequest {
    projectId: string;
    runwieldSessionId: string;
    confirmed?: boolean;
}
export interface SteeringRequest {
    projectId: string;
    operationId: string;
    requestId: string;
    text: string;
    images: ImageAttachment[];
}
export interface InteractionAnswerRequest {
    deviceId?: string | null;
    projectId: string;
    operationId: string;
    interactionId: string;
    runwieldSessionId?: string | null;
    requestId: string;
    response: RuntimeInteractionResponse | NonNullable<RuntimeInteractionResponse["_meta"]>;
}
export interface InteractionRecoveryResult {
    status: string;
    message: string;
    entryIds: string[];
}
import { createHash } from "node:crypto";
import { listSavedSessions } from "./session-history.ts";
import { appendLiveSessionEvent } from "./live-session-events.ts";
import {
    projectLiveSessionInfo,
    readLiveSessionConnection,
    waitForSessionActivationSettlement,
} from "./live-session-connection.ts";
import { clearMascotEnabledCache, getSettingsManager, isMascotEnabled } from "../settings.js";
import {
    applyUserAgentSelection,
    applyUserModelSelection,
    getDefaultUserAgentOption,
    listUserAgentOptions,
    listUserModelOptions,
    requireUserAgentOption,
    requireUserModelOption,
} from "./user-selection.ts";
import {
    createSessionRuntime,
    deriveManagedSessionContinuationDecision,
    listPromptTemplates,
    listSkills,
} from "./session-runtime.ts";
import { getRunWieldSessionDir } from "./root-session.js";
import { projectAggregateTranscript } from "./session-transcript-manifest.ts";
import {
    captureTranscriptEvidence,
    getCommittedTranscriptAuthorityFacts,
    validateExpiredControlTranscriptEvidence,
} from "./session-transcript-projection.js";
import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "../owner-coordination/owner-projects.ts";

export class ImageSubmissionValidationError extends Error {
    constructor(message: string = "Cannot attach image.") {
        super(message);
        this.name = "ImageSubmissionValidationError";
    }
}

export type SessionArchiveRefusalCode =
    "session_busy_confirmation_required" | "session_archive_changed" | "session_stop_unavailable";

/** Expected archive refusals have safe public messages and stable protocol codes. */
export class SessionArchiveRefusal extends Error {
    constructor(
        public readonly code: SessionArchiveRefusalCode,
        message: string,
    ) {
        super(message);
        this.name = "SessionArchiveRefusal";
    }
}

export function stableHash<T>(value: T) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function codeFromError<T>(error: T) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not enabled")) return "rollout_disabled";
    if (message.includes("reconcile")) return "reconcile_required";
    if (message.includes("activation")) return "activation_unavailable";
    return "invalid_state";
}

export function requireReceipt<T>(receipt: T | null): T {
    if (!receipt) throw new Error("Operation receipt was not created.");
    return receipt;
}

export class SessionContinuationService<Request extends RuntimeInteractionRequest = RuntimeInteractionRequest> {
    constructor(options: ContinuationServiceOptions) {
        this.store = options.store;
        this.ownerProcessKind = options.ownerProcessKind || "workspace";
        this.inputSurface = options.inputSurface || "workspace";
        this.ownerInstanceId = crypto.randomUUID();
        this.runtime = createSessionRuntime({
            sessionStore: this.store,
            ownerProcessKind: this.ownerProcessKind,
            ownerInstanceId: this.ownerInstanceId,
        });
    }
    store: OwnerCoordinationStore;
    ownerProcessKind: NonNullable<ContinuationServiceOptions["ownerProcessKind"]>;
    inputSurface: NonNullable<ContinuationServiceOptions["inputSurface"]>;
    ownerInstanceId: string;
    runtime: SessionRuntime;
    operations = new Map<string, ContinuationOperationRecord<Request>>();
    operationListeners = new Map<string, Set<OperationListener<Request>>>();
    operationChanges = new Map<string, Set<OperationChangeListener>>();
    createRequests = new Map<string, CreateRequest>();
    pendingCreateRequests = new Map<string, PendingCreateRequest>();
    retainedSessions = new Map<string, RetainedSession>();
    closingRetainedSessions = new Map<string, ReturnType<SessionRuntime["closeSessionWhenIdle"]>>();
    openingContinuations = new Map<string, number>();
    backgroundOperations = new Set<Promise<void>>();
    closed = false;
    closing: Promise<void> | null = null;
    /** Adapter resource cleanup. Core has already settled Runtime work. */
    closeAdapter() {}
    operationSettled(operationId: string) {}
    notifyAttention(record: ContinuationOperationRecord<Request>, event: SessionRuntimeEvent) {}
    async watchRemoteNotifications(operationId: string, operation: ContinuationOperationRecord<Request> | undefined) {}
    async prepareInteraction(operationId: string, request: RuntimeInteractionRequest) {}
    interactionAnswered(operationId: string, interactionId: string) {}
    /** Presentation adapters can validate review decisions before Core settles the receipt. */
    async resolveInteractionResponse(
        options: InteractionAnswerRequest,
        operation: ContinuationOperationRecord<Request>,
    ): Promise<RuntimeInteractionResponse | InteractionRecoveryResult> {
        return normalizeInteractionResponse(options.response);
    }
    registerInteraction(operationId: string, request: RuntimeInteractionRequest, answer: InteractionAnswer) {
        const current = this.operations.get(operationId);
        if (!current) throw new Error("The running turn is no longer available.");
        this.setOperation(operationId, {
            ...current,
            liveInteraction: { interactionId: String(request.id), request: request as Request },
            answer,
        });
    }

    runBackgroundOperation(work: () => Promise<void>) {
        const operation = Promise.resolve().then(work);
        this.backgroundOperations.add(operation);
        // Attach both handlers now so a failure cannot become an unhandled rejection
        // while shutdown waits for all in-flight operations to settle.
        void operation.then(
            () => this.backgroundOperations.delete(operation),
            (error) => {
                this.backgroundOperations.delete(operation);
                console.error("[Session] Background operation failed:", error);
            },
        );
    }

    close() {
        if (this.closing) return this.closing;
        this.closing = (async () => {
            // Accepted operations can wait for a model or a browser answer. Cancel
            // those waits before draining them, while their store is still open.
            for (const session of this.runtime.listSessions()) this.runtime.cancelSession(session.id);
            while (this.backgroundOperations.size) await Promise.all(this.backgroundOperations);
            await Promise.all(this.closingRetainedSessions.values());
            await this.runtime.closeAllSessionsWhenIdle();
            this.closed = true;
            for (const retained of this.retainedSessions.values()) retained.unsubscribe();
            this.retainedSessions.clear();
            this.operationListeners.clear();
            this.operationChanges.clear();
            this.closeAdapter();
            this.operations.clear();
            this.createRequests.clear();
            this.pendingCreateRequests.clear();
            this.openingContinuations.clear();
        })();
        return this.closing;
    }

    notifyOperation(operationId: string) {
        const status = this.operations.get(operationId)?.status || "unknown";
        for (const listener of [...(this.operationChanges.get(operationId) || [])]) listener(status);
        const listeners = this.operationListeners.get(operationId);
        if (!listeners?.size) return;
        const snapshot = this.getOperation(operationId);
        for (const listener of [...listeners]) listener(snapshot);
    }

    setOperation(operationId: string, record: ContinuationOperationRecord<Request>) {
        if (this.closed) return;
        const previous = this.operations.get(operationId);
        if (previous?.status !== "running" && previous) return;
        if (record.status !== "running" && previous?.createReceipt && this.store.getOperationReceipt(operationId)) {
            this.store.updateOperationReceipt(operationId, {
                status: record.status === "completed" ? "completed" : "failed",
                resultGeneration: record.generation ?? null,
                errorMessage: record.error || null,
            });
        }
        if (record.status === "running") {
            this.operations.set(operationId, record);
        } else {
            const stopped = record.events.findLast(
                (event) =>
                    event.type === "attention_requested" &&
                    event.reason === "agentStopped" &&
                    !event.eventId &&
                    !event.notificationSurface,
            ) as RuntimeAttentionRequestedEvent | undefined;
            this.operations.set(operationId, {
                status: record.status,
                projectId: record.projectId,
                runwieldSessionId: record.runwieldSessionId || null,
                generation: record.generation ?? null,
                error: record.error,
                events: stopped
                    ? [
                          {
                              type: stopped.type,
                              reason: stopped.reason,
                              agentName: stopped.agentName,
                              sessionName: stopped.sessionName,
                              sessionId: stopped.sessionId,
                              timestamp: stopped.timestamp,
                          },
                      ]
                    : [],
            });
            this.operationSettled(operationId);
        }
        this.notifyOperation(operationId);
        const settled = [...this.operations.entries()].filter(([, operation]) => operation.status !== "running");
        for (const [expiredId] of settled.slice(0, Math.max(0, settled.length - 128))) {
            if (this.operationListeners.get(expiredId)?.size) continue;
            this.operations.delete(expiredId);
            this.operationChanges.delete(expiredId);
            for (const [key, request] of this.createRequests)
                if (request.operationId === expiredId) this.createRequests.delete(key);
        }
    }

    async releaseRetainedIfDrained(runwieldSessionId: string) {
        const retained = this.retainedSessions.get(runwieldSessionId);
        if (!retained || this.openingContinuations.has(runwieldSessionId)) return;
        if (
            [...this.operations.values()].some(
                (operation) => operation.runwieldSessionId === runwieldSessionId && operation.status === "running",
            )
        )
            return;
        const tasks = this.runtime.getSessionBackgroundTaskState(retained.sessionId);
        if (tasks && (tasks.active > 0 || tasks.pending > 0)) return;
        // Remove ownership synchronously before awaiting disposal; a new submission
        // waits on this promise rather than adopting a duplicate live owner.
        this.retainedSessions.delete(runwieldSessionId);
        retained.unsubscribe();
        const closing = this.runtime.closeSessionWhenIdle(retained.sessionId);
        this.closingRetainedSessions.set(runwieldSessionId, closing);
        try {
            await closing;
        } finally {
            if (this.closingRetainedSessions.get(runwieldSessionId) === closing) {
                this.closingRetainedSessions.delete(runwieldSessionId);
            }
        }
    }

    preserveTaskOwnerOrClose(sessionId: string, operationId: string) {
        const snapshot = this.runtime.getSessionSnapshot(sessionId);
        const runwieldSessionId = snapshot?.managed?.runwieldSessionId;
        const tasks = this.runtime.getSessionBackgroundTaskState(sessionId);
        if (runwieldSessionId && (snapshot?.busy || tasks?.active || tasks?.pending)) {
            this.retainContinuationSession(runwieldSessionId, sessionId, operationId);
        } else {
            void this.runtime.closeSessionWhenIdle(sessionId);
        }
    }

    retainContinuationSession(runwieldSessionId: string, sessionId: string, operationId: string) {
        const previous = this.retainedSessions.get(runwieldSessionId);
        if (previous) previous.unsubscribe();
        let currentOperationId: string = operationId;
        let unsubscribe: () => void = () => {};

        const receive = (event: import("./session-runtime-events.js").SessionRuntimeEvent) => {
            // Transcript replay describes saved work; it must not reopen background operations.
            if (event.eventId) return;
            if (event.type === "session_replaced" && event.reason === "prompt_template") {
                const nextId = event.newSessionId;
                const oldId = sessionId;
                unsubscribe();
                sessionId = nextId;
                const record = this.operations.get(currentOperationId);
                if (record?.status === "running") {
                    record.runtimeSessionId = nextId;
                    record.events = [];
                    record.runwieldSessionId =
                        this.runtime.getSessionSnapshot(nextId)?.managed?.runwieldSessionId || null;
                }
                this.retainedSessions.set(runwieldSessionId, { sessionId: nextId, unsubscribe: () => unsubscribe() });
                unsubscribe = this.runtime.subscribeSessionEvents(nextId, receive);
                void this.runtime.closeSessionWhenIdle(oldId);
                return;
            }
            if (event.type === "user_message" && event.origin === "background_task_result") {
                currentOperationId = `background:${runwieldSessionId}:${event.taskId}`;
                this.setOperation(currentOperationId, {
                    status: "running",
                    projectId: this.operations.get(operationId)?.projectId || "",
                    runwieldSessionId,
                    runtimeSessionId: sessionId,
                    events: [],
                });
                this.runtime.setInteractionAdapter(
                    sessionId,
                    this.createInteractionAdapter({ operationId: currentOperationId }),
                );
            }
            this.appendOperationEvent(currentOperationId, event);
            if (event.type === "busy_changed" && !event.busy && currentOperationId !== operationId) {
                const record = this.operations.get(currentOperationId);
                if (record) this.setOperation(currentOperationId, { ...record, status: "completed" });
            }
            if (
                (event.type === "busy_changed" && !event.busy) ||
                event.type === "background_task_settled" ||
                event.type === "cancellation"
            ) {
                queueMicrotask(() => void this.releaseRetainedIfDrained(runwieldSessionId));
            }
        };
        unsubscribe = this.runtime.subscribeSessionEvents(sessionId, receive);
        this.retainedSessions.set(runwieldSessionId, { sessionId, unsubscribe: () => unsubscribe() });
    }

    appendOperationEvent(operationId: string, event: import("./session-runtime-events.js").SessionRuntimeEvent) {
        const record = this.operations.get(operationId);
        if (!record || record.status !== "running") return;
        appendLiveSessionEvent(record.events, event);
        if (!record.runwieldSessionId && record.runtimeSessionId) {
            record.runwieldSessionId =
                this.runtime.getSessionSnapshot(record.runtimeSessionId)?.managed?.runwieldSessionId || null;
        }
        if (record.createReceipt && record.runwieldSessionId && !this.store.getOperationReceipt(operationId)) {
            this.store.createOrGetOperationReceipt({
                ...record.createReceipt,
                projectId: record.projectId,
                runwieldSessionId: record.runwieldSessionId,
                kind: "continuation",
                operationId,
            });
            this.store.updateOperationReceipt(operationId, { status: "running" });
        }
        this.notifyAttention(record, event);
        this.notifyOperation(operationId);
    }

    subscribeOperationSession(operationId: string, sessionId: string) {
        let unsubscribe: () => void = () => {};

        const receive = (event: import("./session-runtime-events.js").SessionRuntimeEvent) => {
            this.appendOperationEvent(operationId, event);
            if (event.type !== "session_replaced" || event.reason !== "prompt_template") return;
            unsubscribe();
            const record = this.operations.get(operationId);
            if (record?.status === "running") {
                record.runtimeSessionId = event.newSessionId;
                record.runwieldSessionId =
                    this.runtime.getSessionSnapshot(event.newSessionId)?.managed?.runwieldSessionId || null;
                record.events = [];
            }
            unsubscribe = this.runtime.subscribeSessionEvents(event.newSessionId, receive);
        };
        unsubscribe = this.runtime.subscribeSessionEvents(sessionId, receive);
        return () => unsubscribe();
    }

    subscribeOperationChanges(operationId: string, listener: OperationChangeListener) {
        let listeners = this.operationChanges.get(operationId);
        if (!listeners) {
            listeners = new Set();
            this.operationChanges.set(operationId, listeners);
        }
        listeners.add(listener);
        listener(this.operations.get(operationId)?.status || this.getOperation(operationId).status);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) this.operationChanges.delete(operationId);
        };
    }

    subscribeOperation(operationId: string, listener: OperationListener<Request>) {
        let listeners = this.operationListeners.get(operationId);
        if (!listeners) {
            listeners = new Set();
            this.operationListeners.set(operationId, listeners);
        }
        listeners.add(listener);
        listener(this.getOperation(operationId));
        return () => {
            const current = this.operationListeners.get(operationId);
            if (!current) return;
            current.delete(listener);
            if (!current.size) this.operationListeners.delete(operationId);
        };
    }

    async listSessionOptions(projectId: string, presentation: "browser" | "session-client" = "browser") {
        const projectRoot = requireOwnerProjectRoot(this.store, projectId);
        const settings = getSettingsManager(projectRoot);
        const agentOptions = await listUserAgentOptions(projectRoot);
        const defaultAgent = await getDefaultUserAgentOption(projectRoot);
        const models = await listUserModelOptions();
        const defaultProvider = settings.getDefaultProvider?.() || "";
        const defaultModel = settings.getDefaultModel?.() || "";
        const defaultThinkingLevel = settings.getDefaultThinkingLevel?.() || "default";
        const [templates, skills, commandRegistry] = await Promise.all([
            listPromptTemplates({ cwd: projectRoot }),
            listSkills({ cwd: projectRoot }),
            import("../../cmd/registry.js"),
        ]);
        const { supportedSessionCommands } = await import("./session-commands.ts");
        const builtins =
            presentation === "session-client"
                ? supportedSessionCommands()
                : commandRegistry.getSlashCommandDefinitions("workspace");
        // Options load infrequently, unlike animation renders. Refresh settings
        // edited by another surface/process before publishing visibility.
        clearMascotEnabledCache();
        return {
            mascot: isMascotEnabled(projectRoot),
            defaults: {
                agentName: defaultAgent.name,
                model: defaultAgent.defaults.model || defaultModel,
                provider: defaultAgent.defaults.provider || defaultProvider,
                thinkingLevel: defaultAgent.defaults.thinkingLevel || defaultThinkingLevel,
            },
            agents: agentOptions,
            commands: [
                ...builtins.map((command) => ({
                    name: command.name,
                    description: command.description,
                    kind: "action",
                })),
                ...templates
                    .filter((template) => !commandRegistry.getCommandDefinition(template.name))
                    .map((template) => ({ name: template.name, description: template.description, kind: "prompt" })),
                ...skills.map((skill) => ({
                    name: `skill:${skill.name}`,
                    description: skill.description,
                    kind: "prompt",
                })),
            ],
            models,
            thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        };
    }

    async command(projectId: string, runwieldSessionId: string, text: string) {
        requireOwnerProjectRoot(this.store, projectId);
        const { executeSessionCommand, parseSessionCommand } = await import("./session-commands.ts");
        const { getSlashCommandDefinition } = await import("../../cmd/registry.js");
        const action = getSlashCommandDefinition(parseSessionCommand(text).name, "workspace")?.sessionAction;
        let sessionId: string | undefined;
        let adopted = false;
        if (runwieldSessionId) {
            const session = this.store.getSessionById(runwieldSessionId);
            if (!session || !sessionBelongsToOwnerProject(this.store, session, projectId))
                throw new Error("Session not found.");
            const inspected = this.store.inspectSessionActivation(runwieldSessionId);
            if (inspected.activation?.state === "active") throw new Error("This Session is still busy.");
            sessionId = this.retainedSessions.get(runwieldSessionId)?.sessionId;
            if (!sessionId && action === "context" && inspected.generation) {
                sessionId = (await this.adoptIdleManagedSession(runwieldSessionId, inspected.generation.generation))
                    .sessionId;
                adopted = true;
            }
        }
        try {
            return await executeSessionCommand(text, { runtime: this.runtime, sessionId });
        } finally {
            if (adopted && sessionId) await this.runtime.closeSessionWhenIdle(sessionId);
        }
    }

    async listSessions(projectId: string, options: SessionListOptions = {}) {
        return listSavedSessions(this.store, projectId, options);
    }

    async adoptIdleManagedSession(runwieldSessionId: string, expectedGeneration: number) {
        const session = this.store.getSessionById(runwieldSessionId);
        if (!session) throw new Error("Session not found.");
        const inspected = this.store.inspectSessionActivation(runwieldSessionId);
        if (inspected.activation?.state !== "idle") {
            throw new Error("This Session is still busy. Wait for it to finish, then try again.");
        }
        if (!inspected.generation || inspected.generation.generation !== expectedGeneration) {
            throw new Error("Configuration requires the exact committed generation.");
        }
        const retainedId = this.retainedSessions.get(runwieldSessionId)?.sessionId;
        if (retainedId && this.runtime.getSessionSnapshot(retainedId)) return { sessionId: retainedId };
        const projection = await projectAggregateTranscript({
            cwd: session.transcriptCwd,
            sessionDir: getRunWieldSessionDir(session.transcriptCwd),
            runwieldSessionId,
            generation: inspected.generation,
            segments: this.store.listSessionTranscriptSegments(runwieldSessionId),
            limit: 500,
        });
        if (!projection.ok) throw new Error(projection.message);
        const committedFacts = getCommittedTranscriptAuthorityFacts(projection);
        return this.runtime.adoptManagedSession({
            session,
            generation: expectedGeneration,
            activeAgent: committedFacts.activeAgent,
            model: committedFacts.model,
            provider: committedFacts.provider,
            thinkingLevel: committedFacts.thinkingLevel,
            workflowContext: (committedFacts.workflowContext || null) as
                import("./workflow-context-session.ts").WorkflowContext | null,
        });
    }

    async validateAgentSelection(agentName: string | undefined, projectRoot: string) {
        if (typeof agentName !== "string" || !agentName) return;
        await requireUserAgentOption(agentName, projectRoot);
    }

    async validateModelSelection(model: string | undefined, provider: string | undefined) {
        if (typeof model !== "string" || !model) return;
        await requireUserModelOption(model, provider || "");
    }

    validateThinkingSelection(thinkingLevel: string | undefined, sessionOptions: ThinkingLevelOptions) {
        if (typeof thinkingLevel !== "string" || !thinkingLevel) return;
        if (!sessionOptions.thinkingLevels.includes(thinkingLevel)) {
            throw new Error("Selected thinking level is not supported.");
        }
    }

    findActiveWorkspaceOperation(
        runwieldSessionId: string,
        expectedGeneration: number,
    ): ActiveContinuationOperation<Request> {
        for (const [operationId, record] of this.operations.entries()) {
            if (
                record.runwieldSessionId === runwieldSessionId &&
                record.expectedGeneration === expectedGeneration &&
                record.runtimeSessionId &&
                (record.status === "running" || record.status === "accepted")
            ) {
                return { operationId, record };
            }
        }
        return null;
    }

    async applyPendingConfiguration(runtimeSessionId: string, pendingConfiguration: PendingConfiguration) {
        if (pendingConfiguration.agentName) {
            const result = await applyUserAgentSelection(
                this.runtime,
                runtimeSessionId,
                pendingConfiguration.agentName,
            );
            if (!result.ok) throw new Error(result.error || "Selected Agent could not be applied.");
        }
        if (pendingConfiguration.model) {
            const result = await applyUserModelSelection(
                this.runtime,
                runtimeSessionId,
                pendingConfiguration.model,
                pendingConfiguration.provider || "",
            );
            if (!result.ok) throw new Error(result.error || "Selected model could not be applied.");
        }
    }

    async configureSession(options: SessionConfigurationRequest) {
        if (!options.requestId) return this.applySessionConfiguration(options);
        requireOwnerProjectRoot(this.store, options.projectId);
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId))
            throw new Error("Session not found.");
        const requestHash = stableHash({
            kind: "configuration",
            sessionId: options.runwieldSessionId,
            expectedGeneration: options.expectedGeneration,
            agentName: options.agentName,
            model: options.model,
            provider: options.provider,
            thinkingLevel: options.thinkingLevel,
        });
        const prior = this.store.findOperationReceiptByRequest({
            requestId: options.requestId,
            requestHash,
            runwieldSessionId: options.runwieldSessionId,
        });
        if (prior) {
            if (prior.status !== "completed" || !prior.resultBody)
                throw new Error("Configuration outcome requires refresh; it was not replayed.");
            return prior.resultBody as SessionConfigurationResult;
        }
        const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (inspected.generation?.generation !== options.expectedGeneration)
            throw new Error("Configuration requires the exact committed generation.");
        if (
            inspected.activation?.state === "active" &&
            !this.findActiveWorkspaceOperation(options.runwieldSessionId, options.expectedGeneration)
        )
            throw new Error("Session is busy in another owner.");
        const root = requireOwnerProjectRoot(this.store, options.projectId);
        await this.validateAgentSelection(options.agentName, root);
        await this.validateModelSelection(options.model, options.provider);
        this.validateThinkingSelection(options.thinkingLevel, await this.listSessionOptions(options.projectId));
        const receipt = requireReceipt(
            this.store.createOrGetOperationReceipt({
                requestId: options.requestId,
                requestHash,
                projectId: options.projectId,
                runwieldSessionId: options.runwieldSessionId,
                expectedGeneration: options.expectedGeneration,
                kind: "plan_action",
            }),
        );
        try {
            const result = await this.applySessionConfiguration(options);
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "completed",
                resultGeneration: result.generation,
                resultBody: result,
            });
            return result;
        } catch (error) {
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "failed",
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    private async applySessionConfiguration(options: SessionConfigurationRequest) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const projectRoot = requireOwnerProjectRoot(this.store, options.projectId);
        const sessionOptions = await this.listSessionOptions(options.projectId);
        await this.validateAgentSelection(options.agentName, projectRoot);
        await this.validateModelSelection(options.model, options.provider);
        this.validateThinkingSelection(options.thinkingLevel, sessionOptions);
        const activeOperation = this.findActiveWorkspaceOperation(
            options.runwieldSessionId,
            options.expectedGeneration,
        );
        if (activeOperation) {
            const pendingConfiguration = {
                ...(options.agentName ? {} : activeOperation.record.pendingConfiguration || {}),
                ...(options.agentName ? { agentName: options.agentName } : {}),
                ...(options.model ? { model: options.model, provider: options.provider || "" } : {}),
            };
            if (options.thinkingLevel) {
                const runtimeSessionId = activeOperation.record.runtimeSessionId;
                if (!runtimeSessionId) throw new Error("Active Runtime Session is not available.");
                const thinkingLevel = options.thinkingLevel as ContinuationThinkingLevel;
                const result = await this.runtime.setSessionThinkingLevel(runtimeSessionId, thinkingLevel);
                if (!result?.ok) throw new Error(result?.error || "Selected thinking level could not be applied.");
            }
            const hasPendingConfiguration = Object.keys(pendingConfiguration).length > 0;
            this.setOperation(activeOperation.operationId, {
                ...activeOperation.record,
                pendingConfiguration: hasPendingConfiguration ? pendingConfiguration : undefined,
            });
            return {
                ok: true,
                status: hasPendingConfiguration ? "staged" : "applied",
                operationId: activeOperation.operationId,
                pendingConfiguration: hasPendingConfiguration ? pendingConfiguration : null,
                generation: options.expectedGeneration,
            };
        }
        const adopted = await this.adoptIdleManagedSession(options.runwieldSessionId, options.expectedGeneration);
        try {
            if (typeof options.agentName === "string" && options.agentName) {
                const result = await applyUserAgentSelection(this.runtime, adopted.sessionId, options.agentName);
                if (!result.ok) throw new Error(result.error || "Selected Agent could not be applied.");
            }
            if (typeof options.model === "string" && options.model) {
                const result = await applyUserModelSelection(
                    this.runtime,
                    adopted.sessionId,
                    options.model,
                    options.provider || "",
                );
                if (!result.ok) throw new Error(result.error || "Selected model could not be applied.");
            }
            if (typeof options.thinkingLevel === "string" && options.thinkingLevel) {
                const thinkingLevel = options.thinkingLevel as ContinuationThinkingLevel;
                const result = await this.runtime.setSessionThinkingLevel(adopted.sessionId, thinkingLevel);
                if (!result?.ok) throw new Error(result?.error || "Selected thinking level could not be applied.");
            }
            const snapshot = this.runtime.getSessionSnapshot(adopted.sessionId);
            return {
                ok: true,
                status: "applied",
                generation: snapshot?.managed?.generation ?? options.expectedGeneration,
            };
        } finally {
            if (adopted.sessionId !== this.retainedSessions.get(options.runwieldSessionId)?.sessionId) {
                void this.runtime.closeSession(adopted.sessionId);
            }
        }
    }

    async archiveSession(options: SessionArchiveRequest) {
        requireOwnerProjectRoot(this.store, options.projectId);
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (inspected.activation?.state === "active") {
            if (options.confirmed !== true) {
                throw new SessionArchiveRefusal(
                    "session_busy_confirmation_required",
                    "This Session is busy. Confirm to stop its work and archive it.",
                );
            }
            try {
                const live = await this.liveSession(options.projectId, options.runwieldSessionId);
                if (!live.operation)
                    throw new SessionArchiveRefusal(
                        "session_stop_unavailable",
                        "No running turn to stop. Refresh and try again.",
                    );
                const current = this.store.inspectSessionActivation(options.runwieldSessionId).activation;
                if (
                    current?.fence !== inspected.activation.fence ||
                    current?.operationId !== inspected.activation.operationId
                ) {
                    throw new SessionArchiveRefusal(
                        "session_archive_changed",
                        "This Session started different work. Refresh and confirm again.",
                    );
                }
                const canceled = await this.cancelOperation({ operationId: live.operation.operationId });
                if (!canceled?.ok)
                    throw new SessionArchiveRefusal(
                        "session_stop_unavailable",
                        "Could not stop this Session. Try again.",
                    );
            } catch (error) {
                const current = this.store.inspectSessionActivation(options.runwieldSessionId).activation;
                const finishing =
                    current?.state === "active" &&
                    current.phase === "checkpointing" &&
                    current.operationId === inspected.activation.operationId;
                // A disappearing live connection is not proof of settlement. Only the same writer's
                // durable idle/checkpointing state permits continuing this confirmed archive.
                if (current?.fence !== inspected.activation.fence || (current?.state !== "idle" && !finishing)) {
                    if (error instanceof SessionArchiveRefusal) throw error;
                    throw new SessionArchiveRefusal(
                        "session_stop_unavailable",
                        "Could not stop this Session. Refresh and try again.",
                    );
                }
            }
            try {
                await waitForSessionActivationSettlement(this.store, options.runwieldSessionId);
            } catch {
                throw new SessionArchiveRefusal(
                    "session_stop_unavailable",
                    "The Session is still stopping. Try again.",
                );
            }
            const settled = this.store.inspectSessionActivation(options.runwieldSessionId).activation;
            if (settled?.state !== "idle" || settled.fence !== inspected.activation.fence) {
                throw new SessionArchiveRefusal(
                    "session_archive_changed",
                    "This Session changed before it could be archived. Refresh and try again.",
                );
            }
        }
        try {
            const archived = this.store.archiveSession(options.runwieldSessionId, options.projectId);
            return { runwieldSessionId: archived.runwieldSessionId, archivedAt: archived.archivedAt };
        } catch (error) {
            if (error instanceof Error && error.message === "Session is open in another RunWield surface") {
                throw new SessionArchiveRefusal(
                    "session_archive_changed",
                    "This Session started different work. Refresh and confirm again.",
                );
            }
            throw error;
        }
    }

    unarchiveSession(options: SessionArchiveRequest) {
        requireOwnerProjectRoot(this.store, options.projectId);
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const restored = this.store.unarchiveSession(options.runwieldSessionId, options.projectId);
        return { runwieldSessionId: restored.runwieldSessionId, archivedAt: restored.archivedAt };
    }

    async cancelOperation(options: OperationRequest) {
        if (options.operationId.startsWith("retained:")) {
            const retained = this.retainedSessions.get(options.operationId.slice("retained:".length));
            if (!retained) throw new Error("No retained work to stop.");
            return this.runtime.cancelSession(retained.sessionId);
        }
        const operation = this.operations.get(options.operationId);
        if (operation?.remote && operation.runwieldSessionId) {
            await readLiveSessionConnection(operation.runwieldSessionId, options.operationId, { action: "cancel" });
            return { ok: true };
        }
        if (!operation?.runtimeSessionId) throw new Error("No running turn to stop.");
        return this.runtime.cancelSession(operation.runtimeSessionId);
    }

    async steerOperation(options: SteeringRequest) {
        validateSessionInput(options.text, options.images);
        const operation = this.operations.get(options.operationId);
        if (
            operation?.projectId !== options.projectId ||
            operation.status !== "running" ||
            !operation.runwieldSessionId
        ) {
            throw new Error("The turn has finished. Send your message as a follow-up.");
        }
        const activation = this.store.inspectSessionActivation(operation.runwieldSessionId).activation;
        if (activation?.state !== "active" || !activation.operationId) return { ok: true, queued: false };
        await this.watchRemoteNotifications(activation.operationId, operation);
        return await readLiveSessionConnection(operation.runwieldSessionId, activation.operationId, {
            action: "steer",
            inputSurface: this.inputSurface,
            requestId: options.requestId,
            text: options.text,
            images: options.images,
        });
    }

    async bootstrap(options: SessionBootstrapRequest) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const receipt = requireReceipt(
            this.store.createOrGetOperationReceipt({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash: stableHash({ kind: "bootstrap", session: options.runwieldSessionId }),
                runwieldSessionId: options.runwieldSessionId,
                projectId: options.projectId,
                expectedGeneration: null,
                kind: "bootstrap",
            }),
        );
        const existing = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (existing.generation) {
            return {
                operationId: receipt.operationId,
                generation: existing.generation.generation,
                status: "completed",
            };
        }
        if (["uncertain", "reconcile_required"].includes(existing.activation?.state || "")) {
            const recovered = await this.runtime.ensureInitialSessionGeneration(options.runwieldSessionId);
            const generation = recovered.generation?.generation ?? 0;
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "completed",
                resultGeneration: generation,
            });
            return { operationId: receipt.operationId, generation, status: "completed" };
        }
        const proof = this.store.acquireSessionActivation({
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            ownerInstanceId: this.ownerInstanceId,
            ownerProcessKind: this.ownerProcessKind,
            operationId: receipt.operationId,
            expectedGeneration: null,
            phase: "bootstrap",
        });
        try {
            const evidence = await captureTranscriptEvidence({
                transcriptPath: session.transcriptPath,
                transcriptCwd: session.transcriptCwd,
            });
            const checkpointProof = this.store.changeSessionActivationPhase(proof, "checkpointing");
            this.store.publishGenerationAndRelease(checkpointProof, {
                generation: 0,
                byteLength: evidence.byteLength,
                terminalEntryId: evidence.terminalEntryId,
                digestHex: evidence.digestHex,
            });
            this.store.updateOperationReceipt(receipt.operationId, { status: "completed", resultGeneration: 0 });
            return { operationId: receipt.operationId, generation: 0, status: "completed" };
        } catch (error) {
            const errorCode = codeFromError(error);
            this.store.markSessionReconcileRequired(
                {
                    runwieldSessionId: options.runwieldSessionId,
                    projectId: options.projectId,
                },
                { reason: errorCode },
            );
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "failed",
                errorCode,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async createSession(options: SessionCreateRequest): Promise<CreateSessionResult> {
        validateSessionInput(options.text, options.images);
        if (!options.text?.trim() && !options.images?.length) throw new Error("A message or image is required.");
        await Promise.resolve();
        const project = this.store.getProjectById(options.projectId);
        if (!project || project.lifecycle !== "enabled") throw new Error("Project not found.");
        const projectRoot = requireOwnerProjectRoot(this.store, options.projectId);
        const defaultAgent = await getDefaultUserAgentOption(projectRoot);
        const launch = {
            agentName: options.agentName || defaultAgent.name,
            model: options.model || "",
            provider: options.provider || "",
            thinkingLevel: options.thinkingLevel || "default",
        };
        const sessionOptions = await this.listSessionOptions(options.projectId);
        await this.validateAgentSelection(launch.agentName, projectRoot);
        await this.validateModelSelection(launch.model, launch.provider);
        if (launch.thinkingLevel !== "default" && !sessionOptions.thinkingLevels.includes(launch.thinkingLevel)) {
            throw new Error("Selected thinking level is not supported.");
        }
        const requestHash = stableHash({
            kind: "create",
            projectId: options.projectId,
            text: options.text,
            images: options.images || [],
            launch,
        });
        const savedReceipt = this.store.findOperationReceiptByRequest({
            deviceId: options.deviceId || null,
            projectId: options.projectId,
            requestId: options.requestId,
            requestHash,
        });
        if (savedReceipt)
            return {
                operationId: savedReceipt.operationId,
                status: savedReceipt.status,
                runwieldSessionId: savedReceipt.runwieldSessionId,
                generation: savedReceipt.resultGeneration,
            };
        const createKey = `${options.deviceId || ""}:${options.projectId}:${options.requestId}`;
        const existing = this.createRequests.get(createKey);
        if (existing) {
            if (existing.requestHash !== requestHash) {
                throw new Error("Operation request id was reused with different input");
            }
            const operation = this.operations.get(existing.operationId);
            return {
                operationId: existing.operationId,
                status: operation?.status || "running",
                runwieldSessionId: operation?.runwieldSessionId || null,
                generation: operation?.generation ?? null,
            };
        }
        const pending = this.pendingCreateRequests.get(createKey);
        if (pending) {
            if (pending.requestHash !== requestHash) {
                throw new Error("Operation request id was reused with different input");
            }
            await pending.settled;
            return await this.createSession(options);
        }

        let releasePending: VoidResolver = () => {};
        const reservation = {
            requestHash,
            settled: new Promise<void>((resolve) => {
                releasePending = resolve;
            }),
        };
        this.pendingCreateRequests.set(createKey, reservation);
        try {
            let preparedSessionId = "";
            let preparedModelOverride = "";
            if ((options.images || []).length > 0) {
                try {
                    const created = await this.runtime.createInteractiveSession({
                        cwd: project.currentRoot,
                        mode: "new",
                        deferManagedActivationUntilAgentReady: true,
                    });
                    preparedSessionId = created.sessionId;
                    if (launch.model) {
                        const modelResult = await this.runtime.reconfigureSessionModel(
                            preparedSessionId,
                            launch.model,
                            launch.provider,
                        );
                        if (!modelResult?.ok) throw new Error("Selected model could not be applied.");
                    }
                    if (launch.thinkingLevel !== "default") {
                        const thinkingLevel = launch.thinkingLevel as ContinuationThinkingLevel;
                        const thinkingResult = await this.runtime.setSessionThinkingLevel(
                            preparedSessionId,
                            thinkingLevel,
                        );
                        if (!thinkingResult?.ok) throw new Error("Selected thinking level could not be applied.");
                    }
                    const preflight = await this.runtime.preflightUserTurnImages(preparedSessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: launch.agentName,
                    });
                    if (!preflight.ok) throw new ImageSubmissionValidationError(preflight.message);
                    preparedModelOverride =
                        "preparedModelOverride" in preflight ? preflight.preparedModelOverride || "" : "";
                } catch (error) {
                    if (preparedSessionId) this.runtime.closeSessionWhenIdle(preparedSessionId);
                    throw error;
                }
            }
            const repeated = this.createRequests.get(createKey);
            if (repeated) {
                if (preparedSessionId) this.runtime.closeSessionWhenIdle(preparedSessionId);
                if (repeated.requestHash !== requestHash) {
                    throw new Error("Operation request id was reused with different input");
                }
                const operation = this.operations.get(repeated.operationId);
                return {
                    operationId: repeated.operationId,
                    status: operation?.status || "running",
                    runwieldSessionId: operation?.runwieldSessionId || null,
                    generation: operation?.generation ?? null,
                };
            }
            const operationId = crypto.randomUUID();
            this.createRequests.set(createKey, { requestHash, operationId });
            this.setOperation(operationId, {
                status: "running",
                projectId: options.projectId,
                events: [],
                runwieldSessionId: null,
                createReceipt: { requestId: options.requestId, requestHash, deviceId: options.deviceId || null },
            });
            this.runBackgroundOperation(async () => {
                let sessionId = preparedSessionId;
                let unsubscribe: () => void = () => {};
                try {
                    if (!sessionId) {
                        const created = await this.runtime.createInteractiveSession({
                            cwd: project.currentRoot,
                            mode: "new",
                            deferManagedActivationUntilAgentReady: true,
                        });
                        sessionId = created.sessionId;
                    }
                    this.setOperation(operationId, {
                        ...(this.operations.get(operationId) || { projectId: options.projectId, events: [] }),
                        status: "running",
                        runtimeSessionId: sessionId,
                        runwieldSessionId:
                            this.runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId || null,
                    });
                    this.runtime.setInteractionAdapter(sessionId, this.createInteractionAdapter({ operationId }));
                    unsubscribe = this.subscribeOperationSession(operationId, sessionId);
                    if (!preparedSessionId) {
                        if (launch.model) {
                            const modelResult = await applyUserModelSelection(
                                this.runtime,
                                sessionId,
                                launch.model,
                                launch.provider,
                            );
                            if (!modelResult.ok) {
                                throw new Error(modelResult.error || "Selected model could not be applied.");
                            }
                        }
                        if (launch.thinkingLevel !== "default") {
                            const thinkingLevel = launch.thinkingLevel as ContinuationThinkingLevel;
                            const thinkingResult = await this.runtime.setSessionThinkingLevel(sessionId, thinkingLevel);
                            if (!thinkingResult?.ok) throw new Error("Selected thinking level could not be applied.");
                        }
                    }
                    const result = await this.runtime.promptUserTurn(sessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: launch.agentName,
                        preparedModelOverride,
                    });
                    const snapshot = this.runtime.getSessionSnapshot(sessionId);
                    const runwieldSessionId = snapshot?.managed?.runwieldSessionId || null;
                    const generation = snapshot?.managed?.generation ?? (result.ok ? 1 : 0);
                    this.setOperation(operationId, {
                        ...(this.operations.get(operationId) || { projectId: options.projectId, events: [] }),
                        status: result.ok ? "completed" : "failed",
                        generation,
                        runwieldSessionId,
                        error: result.error,
                    });
                } catch (error) {
                    this.setOperation(operationId, {
                        ...(this.operations.get(operationId) || { projectId: options.projectId, events: [] }),
                        status: "failed",
                        error: codeFromError(error),
                    });
                } finally {
                    unsubscribe();
                    if (sessionId) this.preserveTaskOwnerOrClose(sessionId, operationId);
                }
            });
            return { operationId, status: "running", runwieldSessionId: null, generation: null };
        } finally {
            if (this.pendingCreateRequests.get(createKey) === reservation) {
                this.pendingCreateRequests.delete(createKey);
            }
            releasePending();
        }
    }

    releasePreflightSession(runwieldSessionId: string, adopted: OptionalAdoptedSession) {
        if (adopted?.sessionId && adopted.sessionId !== this.retainedSessions.get(runwieldSessionId)?.sessionId) {
            void this.runtime.closeSession(adopted.sessionId);
        }
    }

    async startContinuation(options: SessionContinuationRequest) {
        validateSessionInput(options.text, options.images);
        if (!options.text?.trim() && !options.images?.length) throw new Error("A message or image is required.");
        this.openingContinuations.set(
            options.runwieldSessionId,
            (this.openingContinuations.get(options.runwieldSessionId) || 0) + 1,
        );
        try {
            await this.closingRetainedSessions.get(options.runwieldSessionId);
            const requestHash = stableHash({
                kind: "continuation",
                session: options.runwieldSessionId,
                expectedGeneration: options.expectedGeneration,
                text: options.text,
                images: options.images || [],
            });
            const existingReceipt = this.store.findOperationReceiptByRequest({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash,
                runwieldSessionId: options.runwieldSessionId,
            });
            if (existingReceipt && existingReceipt.projectId === options.projectId) {
                return {
                    operationId: existingReceipt.operationId,
                    status: this.operations.get(existingReceipt.operationId)?.status || existingReceipt.status,
                    generation: existingReceipt.resultGeneration,
                };
            }
            const session = this.store.getSessionById(options.runwieldSessionId);
            if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
                throw new Error("Session not found.");
            }
            const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
            if (!inspected.generation || inspected.generation.generation !== options.expectedGeneration) {
                throw new Error("Continuation requires the exact committed generation.");
            }
            if (inspected.activation?.state === "active") {
                throw new Error(
                    "This Session is still busy. Keep the message queued in this browser until it finishes.",
                );
            }
            if (inspected.activation?.state !== "idle") {
                throw new Error("This Session needs recovery before it can accept messages.");
            }
            const projection = await projectAggregateTranscript({
                cwd: session.transcriptCwd,
                sessionDir: getRunWieldSessionDir(session.transcriptCwd),
                runwieldSessionId: options.runwieldSessionId,
                generation: inspected.generation,
                segments: this.store.listSessionTranscriptSegments(options.runwieldSessionId),
                limit: 500,
            });
            if (!projection.ok) throw new Error(projection.message);
            const committedFacts = getCommittedTranscriptAuthorityFacts(projection);
            const decision = deriveManagedSessionContinuationDecision({
                activation: inspected.activation,
                generation: inspected.generation,
                projection,
                expectedGeneration: options.expectedGeneration,
            });
            if (!decision.ok) throw new Error(decision.message);
            let preflightAdopted: AdoptedSession | null = null;
            let preparedModelOverride = "";
            if ((options.images || []).length > 0) {
                try {
                    const retained = this.retainedSessions.get(options.runwieldSessionId)?.sessionId;
                    preflightAdopted =
                        retained && this.runtime.getSessionSnapshot(retained)
                            ? { sessionId: retained }
                            : this.runtime.adoptManagedSession({
                                  session,
                                  generation: options.expectedGeneration,
                                  activeAgent: committedFacts.activeAgent,
                                  model: committedFacts.model,
                                  provider: committedFacts.provider,
                                  thinkingLevel: committedFacts.thinkingLevel,
                                  workflowContext: (committedFacts.workflowContext || null) as
                                      import("./workflow-context-session.ts").WorkflowContext | null,
                              });
                    const preflight = await this.runtime.preflightUserTurnImages(preflightAdopted.sessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: decision.agentName,
                    });
                    if (!preflight.ok) throw new ImageSubmissionValidationError(preflight.message);
                    preparedModelOverride =
                        "preparedModelOverride" in preflight ? preflight.preparedModelOverride || "" : "";
                } catch (error) {
                    this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                    throw error;
                }
            }
            const matchingReceipt = this.store.findOperationReceiptByRequest({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash,
                runwieldSessionId: options.runwieldSessionId,
            });
            if (matchingReceipt && matchingReceipt.projectId === options.projectId) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                return {
                    operationId: matchingReceipt.operationId,
                    status: this.operations.get(matchingReceipt.operationId)?.status || matchingReceipt.status,
                    generation: matchingReceipt.resultGeneration,
                };
            }
            const currentSession = this.store.getSessionById(options.runwieldSessionId);
            if (!currentSession || !sessionBelongsToOwnerProject(this.store, currentSession, options.projectId)) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error("Session not found.");
            }
            const currentState = this.store.inspectSessionActivation(options.runwieldSessionId);
            if (!currentState.generation || currentState.generation.generation !== options.expectedGeneration) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error("Continuation requires the exact committed generation.");
            }
            if (currentState.activation?.state === "active") {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error(
                    "This Session is still busy. Keep the message queued in this browser until it finishes.",
                );
            }
            if (currentState.activation?.state !== "idle") {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error("This Session needs recovery before it can accept messages.");
            }
            let receipt;
            try {
                receipt = requireReceipt(
                    this.store.createOrGetOperationReceipt({
                        deviceId: options.deviceId || null,
                        requestId: options.requestId,
                        requestHash,
                        runwieldSessionId: options.runwieldSessionId,
                        projectId: options.projectId,
                        expectedGeneration: options.expectedGeneration,
                        kind: "continuation",
                    }),
                );
            } catch (error) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw error;
            }
            if (this.operations.has(receipt.operationId)) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                return {
                    operationId: receipt.operationId,
                    status: this.operations.get(receipt.operationId)?.status || "running",
                };
            }
            if (receipt.status !== "accepted") {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                return {
                    operationId: receipt.operationId,
                    status: receipt.status,
                    generation: receipt.resultGeneration,
                };
            }
            this.store.updateOperationReceipt(receipt.operationId, { status: "running" });
            this.setOperation(receipt.operationId, {
                status: "running",
                projectId: options.projectId,
                events: [],
                runwieldSessionId: options.runwieldSessionId,
                expectedGeneration: options.expectedGeneration,
            });
            const retainedId = this.retainedSessions.get(options.runwieldSessionId)?.sessionId;
            const retainedSessionId = retainedId && this.runtime.getSessionSnapshot(retainedId) ? retainedId : null;
            const adopted =
                preflightAdopted ||
                (retainedSessionId
                    ? { sessionId: retainedSessionId }
                    : this.runtime.adoptManagedSession({
                          session,
                          generation: options.expectedGeneration,
                          activeAgent: committedFacts.activeAgent,
                          model: committedFacts.model,
                          provider: committedFacts.provider,
                          thinkingLevel: committedFacts.thinkingLevel,
                          workflowContext: (committedFacts.workflowContext || null) as
                              import("./workflow-context-session.ts").WorkflowContext | null,
                      }));
            this.setOperation(receipt.operationId, {
                ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                status: "running",
                runtimeSessionId: adopted.sessionId,
            });
            this.runtime.setInteractionAdapter(
                adopted.sessionId,
                this.createInteractionAdapter({ operationId: receipt.operationId }),
            );
            this.retainContinuationSession(options.runwieldSessionId, adopted.sessionId, receipt.operationId);
            this.runBackgroundOperation(async () => {
                try {
                    const result = await this.runtime.promptUserTurn(adopted.sessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: decision.agentName,
                        preparedModelOverride,
                    });
                    const effectiveSessionId = result.replacementSessionId || adopted.sessionId;
                    const effectiveSnapshot = this.runtime.getSessionSnapshot(effectiveSessionId);
                    let generation = effectiveSnapshot?.managed?.generation ?? options.expectedGeneration;

                    let status: "completed" | "failed" = result.ok ? "completed" : "failed";
                    let error = result.error;
                    const pendingConfiguration = this.operations.get(receipt.operationId)?.pendingConfiguration || null;
                    if (result.ok && pendingConfiguration && Object.keys(pendingConfiguration).length) {
                        try {
                            await this.applyPendingConfiguration(effectiveSessionId, pendingConfiguration);
                            const snapshot = this.runtime.getSessionSnapshot(effectiveSessionId);
                            generation = snapshot?.managed?.generation ?? generation;
                        } catch (configurationError) {
                            status = "failed";
                            error =
                                configurationError instanceof Error
                                    ? configurationError.message
                                    : String(configurationError || "Configuration change failed.");
                        }
                    }
                    this.store.updateOperationReceipt(receipt.operationId, {
                        status,
                        resultGeneration: generation,
                        errorCode: error || null,
                        errorMessage: error || null,
                    });
                    this.setOperation(receipt.operationId, {
                        ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                        status,
                        generation,
                        error,
                        pendingConfiguration: status === "completed" ? undefined : pendingConfiguration || undefined,
                    });
                } catch (error) {
                    const errorCode = codeFromError(error);
                    this.store.updateOperationReceipt(receipt.operationId, {
                        status: "failed",
                        errorCode,
                        errorMessage: error instanceof Error ? error.message : String(error),
                    });
                    this.setOperation(receipt.operationId, {
                        ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                        status: "failed",
                        error: errorCode,
                    });
                } finally {
                    void this.releaseRetainedIfDrained(options.runwieldSessionId);
                }
            });
            return { operationId: receipt.operationId, status: "running" };
        } finally {
            const remaining = (this.openingContinuations.get(options.runwieldSessionId) || 1) - 1;
            if (remaining) this.openingContinuations.set(options.runwieldSessionId, remaining);
            else this.openingContinuations.delete(options.runwieldSessionId);
        }
    }

    async forceRecoverSessionControl(options: SessionRecoveryRequest) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (!inspected.generation) {
            return await this.runtime.ensureInitialSessionGeneration(options.runwieldSessionId);
        }
        const projection = await projectAggregateTranscript({
            cwd: session.transcriptCwd,
            sessionDir: getRunWieldSessionDir(session.transcriptCwd),
            runwieldSessionId: options.runwieldSessionId,
            generation: inspected.generation,
            segments: this.store.listSessionTranscriptSegments(options.runwieldSessionId),
            limit: 1,
        });
        if (!projection.ok) throw new Error(projection.message);
        const currentSegment = this.store
            .listSessionTranscriptSegments(options.runwieldSessionId)
            .find((segment) => segment.segmentId === inspected.generation?.currentSegmentId);
        if (!currentSegment) throw new Error("Current transcript segment is missing.");
        const evidence = await validateExpiredControlTranscriptEvidence({
            transcriptPath: currentSegment.transcriptPath,
            transcriptCwd: currentSegment.transcriptCwd,
            committedGeneration: inspected.generation,
        });
        return this.store.recoverSessionControl({
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            expectedFence: inspected.activation?.fence ?? 0,
            expectedGeneration: options.expectedGeneration,
            expectedCurrentSegmentId: options.expectedCurrentSegmentId ?? inspected.generation.currentSegmentId,
            ownerInstanceId: this.ownerInstanceId,
            ownerProcessKind: this.ownerProcessKind,
            transcriptEvidence: { ...evidence, currentSegmentId: inspected.generation.currentSegmentId },
        });
    }

    async liveSession(projectId: string, runwieldSessionId: string) {
        const session = this.store.getSessionById(runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, projectId)) {
            throw new Error("Session not found.");
        }
        const inspected = this.store.inspectSessionActivation(runwieldSessionId);
        const state = inspected.activation?.state || "uninitialized";
        const generation = inspected.generation?.generation ?? null;
        // Canonical activation owns remote projection lifetime. Never close a Runtime
        // here: these records describe another process, not an owned writer.
        for (const [id, record] of this.operations) {
            if (
                record.remote &&
                record.runwieldSessionId === runwieldSessionId &&
                record.status === "running" &&
                (state !== "active" || inspected.activation?.operationId !== id)
            ) {
                this.setOperation(id, {
                    ...record,
                    status: "completed",
                    generation,
                    liveInteraction: undefined,
                    answer: null,
                });
            }
        }
        const local = [...this.operations.entries()].find(
            ([, operation]) =>
                !operation.remote &&
                operation.runwieldSessionId === runwieldSessionId &&
                operation.status === "running",
        );
        if (local) return { state, generation, operation: this.getOperation(local[0]) };
        const retained = this.retainedSessions.get(runwieldSessionId);
        const tasks = retained ? this.runtime.getSessionBackgroundTaskState(retained.sessionId) : null;
        if (retained && (tasks?.active || tasks?.pending)) {
            return {
                state: "active",
                generation,
                operation: {
                    operationId: `retained:${runwieldSessionId}`,
                    status: "running",
                    projectId,
                    runwieldSessionId,
                    generation,
                    events: [],
                    sessionInfo: projectLiveSessionInfo(this.runtime.getSessionSnapshot(retained.sessionId)),
                    queuedMessages: [],
                    liveInteraction: null,
                    pendingConfiguration: null,
                    error: null,
                },
            };
        }
        const operationId = inspected.activation?.operationId;
        if (state !== "active" || !operationId) return { state, generation, operation: null };
        let live;
        try {
            live = await readLiveSessionConnection(runwieldSessionId, operationId);
        } catch {
            // The process may still be opening or finishing its turn. Retry on the next observation.
            return { state, generation, operation: null };
        }
        this.setOperation(operationId, {
            status: "running",
            projectId,
            runwieldSessionId,
            remote: true,
            generation,
            events: live.events,
            sessionInfo: live.sessionInfo,
            queuedMessages: live.queuedMessages,
        });
        if (live.interaction) {
            const interactionId = live.interaction.id;
            this.registerInteraction(operationId, live.interaction, {
                resolve: async (response) => {
                    await this.watchRemoteNotifications(operationId, this.operations.get(operationId));
                    await readLiveSessionConnection(runwieldSessionId, operationId, {
                        action: "answer",
                        inputSurface: this.inputSurface,
                        interactionId,
                        response,
                    });
                },
                reject: () => {
                    void readLiveSessionConnection(runwieldSessionId, operationId, {
                        action: "answer",
                        inputSurface: this.inputSurface,
                        interactionId,
                        response: { outcome: "canceled" },
                    }).catch(() => {});
                },
            });
        }
        return { state, generation, operation: this.getOperation(operationId) };
    }

    async refreshOperation(operationId: string) {
        const operation = this.operations.get(operationId);
        if (operation?.remote && operation.runwieldSessionId && operation.status === "running") {
            const live = await this.liveSession(operation.projectId, operation.runwieldSessionId);
            if (
                live.operation?.operationId !== operationId &&
                (live.state !== "active" || live.operation || live.generation !== operation.generation)
            ) {
                this.setOperation(operationId, {
                    ...operation,
                    status: live.state === "idle" || live.generation !== operation.generation ? "completed" : "unknown",
                    liveInteraction: undefined,
                    answer: null,
                });
            } else if (!live.operation) {
                this.setOperation(operationId, { ...operation, liveInteraction: undefined, answer: null });
            }
        }
        return this.getOperation(operationId);
    }

    getOperation(operationId: string): ContinuationOperationSnapshot<Request> {
        const live = this.operations.get(operationId);
        const durable = this.store.getOperationReceipt(operationId);
        const sessionInfo = live?.runtimeSessionId
            ? projectLiveSessionInfo(this.runtime.getSessionSnapshot(live.runtimeSessionId))
            : live?.sessionInfo || null;
        if (!durable) {
            if (!live) return { operationId, status: "unknown", events: [] };
            const { answer: _answer, runtimeSessionId: _runtimeSessionId, ...snapshot } = live;
            return {
                operationId,
                ...snapshot,
                sessionInfo,
                queuedMessages: live.runtimeSessionId
                    ? this.runtime.getQueuedMessages(live.runtimeSessionId)
                    : live.queuedMessages || [],
            };
        }
        if (!live && (durable.status === "accepted" || durable.status === "running")) {
            return {
                operationId,
                status: "unknown",
                generation: durable.resultGeneration,
                error: "operation_not_running",
                events: [],
            };
        }
        return {
            operationId,
            runwieldSessionId: live?.runwieldSessionId || durable.runwieldSessionId,
            status: durable.status,
            generation: durable.resultGeneration,
            error: durable.errorMessage || durable.errorCode,
            events: live?.events || [],
            sessionInfo,
            queuedMessages: live?.runtimeSessionId
                ? this.runtime.getQueuedMessages(live.runtimeSessionId)
                : live?.queuedMessages || [],
            liveInteraction: live?.liveInteraction || null,
            pendingConfiguration: live?.pendingConfiguration || null,
        };
    }

    async answerInteraction(options: InteractionAnswerRequest) {
        const operation = this.operations.get(options.operationId);
        const durable = this.store.getOperationReceipt(options.operationId);
        const operationProjectId = operation?.projectId || durable?.projectId || null;
        if (operationProjectId !== options.projectId) {
            throw new Error("Live Workspace interaction is not available for this Project.");
        }
        const requestHash = stableHash({
            kind: "interaction_answer",
            operationId: options.operationId,
            interactionId: options.interactionId,
            response: options.response,
        });
        const operationSessionId = operation?.runwieldSessionId || options.runwieldSessionId || null;
        const existingReceipt = operationSessionId
            ? this.store.findOperationReceiptByRequest({
                  deviceId: options.deviceId || null,
                  requestId: options.requestId,
                  requestHash,
                  runwieldSessionId: operationSessionId,
              })
            : null;
        if (existingReceipt?.status === "completed" && existingReceipt.resultBody) return existingReceipt.resultBody;
        if (existingReceipt && existingReceipt.status !== "accepted") {
            throw new Error("Interaction answer request is already in progress.");
        }
        if (!operation || operation.status !== "running" || !operation.liveInteraction || !operation.answer) {
            throw new Error("Live Workspace interaction is not available.");
        }
        if (operation.liveInteraction.interactionId !== options.interactionId) {
            throw new Error("Interaction id does not match the live Workspace operation.");
        }
        if (options.runwieldSessionId && operation.runwieldSessionId !== options.runwieldSessionId) {
            throw new Error("Interaction Session does not match the live Workspace operation.");
        }
        if (!operation.runwieldSessionId) throw new Error("Live Workspace interaction is missing Session evidence.");
        const receipt =
            existingReceipt ||
            requireReceipt(
                this.store.createOrGetOperationReceipt({
                    deviceId: options.deviceId || null,
                    requestId: options.requestId,
                    requestHash,
                    runwieldSessionId: operation.runwieldSessionId,
                    projectId: options.projectId,
                    expectedGeneration: null,
                    kind: "plan_action",
                }),
            );
        this.store.updateOperationReceipt(receipt.operationId, { status: "running" });
        try {
            const runtimeResponse = await this.resolveInteractionResponse(options, operation);
            if (!("outcome" in runtimeResponse)) {
                this.store.updateOperationReceipt(receipt.operationId, {
                    status: "completed",
                    resultBody: { result: runtimeResponse },
                });
                return runtimeResponse;
            }
            await operation.answer.resolve(runtimeResponse);
            this.interactionAnswered(options.operationId, options.interactionId);
            this.setOperation(options.operationId, { ...operation, liveInteraction: undefined, answer: null });
            const result = { status: "accepted" };
            this.store.updateOperationReceipt(receipt.operationId, { status: "completed", resultBody: result });
            return result;
        } catch (error) {
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "failed",
                errorCode: "interaction_answer_failed",
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    createInteractionAdapter(options: OperationRequest): RuntimeInteractionAdapter {
        return {
            supportsInteraction: () => true,

            requestInteraction: async (
                request: import("./session-runtime-interactions.ts").RuntimeInteractionRequest,
                signal: AbortSignal | undefined,
            ) => {
                await this.prepareInteraction(options.operationId, request);
                const interactionId = String(request.id || crypto.randomUUID());
                return new Promise<RuntimeInteractionResponse>((resolve, reject) => {
                    const current = this.operations.get(options.operationId);
                    if (!current || current.status !== "running") {
                        reject(new Error("Workspace operation is not running."));
                        return;
                    }
                    this.registerInteraction(options.operationId, request, { resolve, reject });
                    const abort = () => {
                        const latest = this.operations.get(options.operationId);
                        if (latest?.liveInteraction?.interactionId === interactionId) {
                            this.setOperation(options.operationId, {
                                ...latest,
                                liveInteraction: undefined,
                                answer: null,
                            });
                        }
                        reject(new DOMException("Interaction canceled.", "AbortError"));
                    };
                    signal?.addEventListener("abort", abort, { once: true });
                    if (signal?.aborted) abort();
                });
            },
            cancelAll: () => {
                const current = this.operations.get(options.operationId);
                current?.answer?.reject(new Error("Interaction canceled."));
            },
        };
    }
}

type ThinkingLevelOptions = { thinkingLevels: string[] };
type ActiveContinuationOperation<Request extends RuntimeInteractionRequest> = {
    operationId: string;
    record: ContinuationOperationRecord<Request>;
} | null;

export interface SessionConfigurationResult {
    ok: boolean;
    status: string;
    generation: number;
    operationId?: string;
    pendingConfiguration?: PendingConfiguration | null;
}
export type SessionConfigurationRequest = {
    requestId?: string;
    projectId: string;
    runwieldSessionId: string;
    expectedGeneration: number;
    agentName?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
};

export type SessionBootstrapRequest = {
    deviceId?: string | null;
    projectId: string;
    runwieldSessionId: string;
    requestId: string;
};
export type SessionCreateRequest = {
    deviceId?: string | null;
    projectId: string;
    requestId: string;
    text: string;
    images?: ImageAttachment[];
    agentName?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
};
type OptionalAdoptedSession = AdoptedSession | null;
export type SessionContinuationRequest = {
    deviceId?: string | null;
    projectId: string;
    runwieldSessionId: string;
    requestId: string;
    expectedGeneration: number;
    text: string;
    images?: ImageAttachment[];
};
export type SessionRecoveryRequest = {
    projectId: string;
    runwieldSessionId: string;
    expectedGeneration: number;
    expectedCurrentSegmentId?: string | null;
};

export type OperationRequest = { operationId: string };
