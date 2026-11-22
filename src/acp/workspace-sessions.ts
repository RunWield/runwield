import { getCommandDefinition } from "../cmd/registry.js";
import { parseSessionCommand } from "../shared/session/session-commands.ts";
import { join } from "node:path";
import { readSessionImageAttachment } from "../shared/session/image-attachments.ts";
import { getRunWieldSessionDir } from "../shared/session/root-session.js";
import { SESSION_IMAGE_BASE64_LIMIT } from "../shared/session/session-input-contract.ts";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "../shared/session/session-runtime-interactions.ts";
import { isApprovalAcceptedValue } from "../shared/session/interaction-values.ts";
import { getSelectedDefaultModelAvailability } from "../shared/session/model-readiness.ts";
import { RequestError } from "@agentclientprotocol/sdk";
import { openOwnerCoordinationStore } from "../shared/owner-coordination/index.ts";
import {
    SessionContinuationService,
    ImageSubmissionValidationError,
    SessionArchiveRefusal,
} from "../shared/session/session-continuation-service.ts";
import { readCommittedSessionTimeline, listSavedSessions } from "../shared/session/session-history.ts";
import type { FileSessionStore } from "../shared/session/file-session-store.ts";
import { validateSessionInput, type SessionImageTransfer } from "../shared/session/session-input-contract.ts";
import { WorkspaceProjectConnection, parseWorkspaceRequest } from "./workspace-projects.ts";
import {
    WORKSPACE_EXTENSION,
    WORKSPACE_OBSERVATION_BYTE_LIMIT,
    type WorkspaceJsonRecord,
    type WorkspaceProjectContext,
    type WorkspaceHistoryRequest,
    type WorkspaceHistoryResult,
    type WorkspaceSnapshotRequest,
    type WorkspaceSnapshotResult,
    type WorkspaceSessionListRequest,
    type WorkspaceSessionListResult,
    type WorkspaceConfigureRequest,
    type WorkspaceAnswerRequest,
    type WorkspaceSessionRequest,
} from "./workspace-contract.ts";

/** Only known refusals cross the wire. Unexpected errors can contain provider secrets. */
export function rethrowWorkspaceError<T>(error: T): never {
    if (error instanceof RequestError) throw error;
    if (error instanceof SessionArchiveRefusal) throw new RequestError(-32002, error.message, { code: error.code });
    if (error instanceof ImageSubmissionValidationError)
        throw new RequestError(-32602, "Cannot attach this image. Check model vision support and retry.", {
            code: "invalid_input",
        });
    const message = error instanceof Error ? error.message : "";
    const refusals = [
        ["session_not_found", /^Session not found\.$/],
        ["session_recovery_required", /^This Session needs recovery before it can accept messages\.$/],
        [
            "session_not_running",
            /^(?:No running turn to stop\.|No retained work to stop\.|The turn has finished\. Send your message as a follow-up\.)$/,
        ],
        ["session_busy", /^(?:This Session is still busy\.|Session is busy in another owner\.)/],
        ["generation_conflict", /^(?:Continuation|Configuration) requires the exact committed generation\.$/],
        ["configuration_refresh_required", /^Configuration outcome requires refresh; it was not replayed\.$/],
        ["configuration_invalid", /^Selected thinking level is not supported\.$/],
        [
            "workspace_binding_invalid",
            /^(?:Unknown wire Session ID\.|Snapshot durable identity does not match\.|Snapshot binding does not match\.)$/,
        ],
        ["receipt_conflict", /^Operation request id was reused with different input\.?$/],
        [
            "interaction_pending",
            /^(?:Interaction operation is no longer current\.|Interaction is no longer waiting\.)$/,
        ],
        [
            "invalid_input",
            /^(?:A message or image is required\.|Message exceeds 65,536 characters\.|Malformed image transfer\.|Image exceeds 7 MiB\.|Images exceed 10 MiB of base64\.|Invalid page size\.|A bounded identity is required\.|Invalid question action\.|An answer is required\.|Choose an exact listed answer\.|Other text is not supported for this choice\.|Unsupported configuration option\.|Unsupported Workspace prompt content\.|Invalid configuration selection\.)$/,
        ],
        [
            "history_cursor_invalid",
            /^(?:History cursor belongs to another Session\.|History generation changed\. Reload history\.|Observation cursor belongs to another Session\.|Invalid cursor\.|List cursor belongs to another query\.|Invalid list cursor\.)$/,
        ],
    ] as const;
    for (const [code, pattern] of refusals) {
        if (pattern.test(message))
            throw new RequestError(code === "invalid_input" ? -32602 : -32002, message, { code });
    }
    throw new RequestError(-32002, "Session request failed. Refresh and retry.", { code: "session_request_failed" });
}

function encode(value: WorkspaceJsonRecord): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(cursor: string): WorkspaceJsonRecord {
    if (cursor.length > 4096) throw new Error("Invalid cursor.");
    return parseWorkspaceRequest(Buffer.from(cursor, "base64url").toString());
}
function bounded(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error("Invalid page size.");
    return value;
}
function required(value: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > 512)
        throw new Error("A bounded identity is required.");
    return value;
}
interface BoundSession {
    context: WorkspaceProjectContext;
    durableId: string;
    operationId: string;
    closing?: boolean;
    accepting?: Promise<{ operationId: string }>;
    createRequest?: Pick<MutationMetadata, "requestId" | "configuration">;
}
interface MutationMetadata extends WorkspaceProjectContext {
    requestId: string;
    expectedGeneration: number;
    confirmed?: boolean;
    configuration?: import("./workspace-contract.ts").WorkspaceConfigurationSelection;
}
interface PromptBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
}
export interface StandardRequest {
    sessionId?: string;
    cwd?: string;
    prompt?: PromptBlock[];
    _meta?: WorkspaceJsonRecord;
}

/** ACP is a transport adapter. All negotiated execution belongs to the same Core continuation owner as HTTP. */
export class WorkspaceSessionConnection {
    private service: SessionContinuationService | null = null;
    private draining = false;
    private drainPromise: Promise<import("./workspace-contract.ts").WorkspaceSettlementResult> | null = null;
    private readonly bindings = new Map<string, BoundSession>();
    constructor(private readonly projects: WorkspaceProjectConnection) {}
    async dispatch(operation: string, json: string) {
        return await this.dispatchRequest(operation, json).catch(rethrowWorkspaceError);
    }
    private async dispatchRequest(operation: string, json: string) {
        const request = parseWorkspaceRequest(json);
        if (this.draining && !["history", "snapshot", "options", "drain", "resolveSubmission"].includes(operation))
            throw new RequestError(-32002, "Session connection is draining.");
        const allowed = {
            history: ["context", "sessionId", "cursor", "limit"],
            snapshot: ["context", "sessionId", "wireSessionId", "cursor"],
            options: ["context"],
            command: ["context", "wireSessionId", "text"],
            configure: [
                "context",
                "sessionId",
                "requestId",
                "expectedGeneration",
                "agentName",
                "model",
                "provider",
                "thinkingLevel",
            ],
            answer: ["context", "sessionId", "operationId", "interactionId", "requestId", "response"],
            unarchive: ["context", "sessionId"],
            drain: [],
            resolveSubmission: ["context", "sessionId", "requestId", "kind", "expectedGeneration"],
        };
        const keys = allowed[operation as keyof typeof allowed];
        if (!keys || Object.keys(request).some((key) => !keys.some((allowedKey) => allowedKey === key)))
            throw new RequestError(-32602, "Unsupported Session request.");
        if (operation === "drain") return await this.drain();
        if (operation === "resolveSubmission") {
            const input: import("./workspace-contract.ts").WorkspaceResolveSubmissionRequest = JSON.parse(json);
            this.projects.admitContext(input.context, input.sessionId || undefined);
            required(input.requestId);
            if (
                !["prompt", "bootstrap", "steering"].includes(input.kind) ||
                !Number.isInteger(input.expectedGeneration)
            )
                throw new RequestError(-32602, "Invalid submission identity.");
            if (input.kind !== "bootstrap") required(input.sessionId!);
            return this.owner().resolveSubmission({
                projectId: input.context.projectId,
                runwieldSessionId: input.sessionId,
                requestId: input.requestId,
                kind: input.kind,
                expectedGeneration: input.expectedGeneration,
            });
        }
        if (operation === "history") return await this.history(JSON.parse(json));
        if (operation === "snapshot") return await this.snapshot(JSON.parse(json));
        if (operation === "options") return await this.options(JSON.parse(json));
        if (operation === "command") return await this.command(JSON.parse(json));
        if (operation === "configure") return await this.configure(JSON.parse(json));
        if (operation === "answer") return await this.answer(JSON.parse(json));
        return await this.unarchive(JSON.parse(json));
    }
    private owner(): SessionContinuationService {
        return (this.service ??= new SessionContinuationService({
            store: openOwnerCoordinationStore(),
            ownerProcessKind: "acp",
        }));
    }
    async close(): Promise<void> {
        const service = this.service;
        if (service) {
            await service.close();
            service.store.close();
        }
        this.service = null;
    }
    private admit(request: WorkspaceSessionRequest): WorkspaceProjectContext {
        required(request.sessionId);
        return this.projects.admitContext(request.context, request.sessionId);
    }
    async history(request: WorkspaceHistoryRequest): Promise<WorkspaceHistoryResult> {
        const context = this.admit(request);
        const service = this.owner();
        const cursor = request.cursor ? decode(request.cursor) : null;
        if (cursor && (cursor.sessionId !== request.sessionId || cursor.projectId !== context.projectId))
            throw new Error("History cursor belongs to another Session.");
        const inspected = service.store.inspectSessionActivation(request.sessionId);
        if (cursor && cursor.generation !== inspected.generation?.generation)
            throw new Error("History generation changed. Reload history.");
        const result = await readCommittedSessionTimeline(service.store, service.runtime, request.sessionId, {
            latest: !cursor,
            beforeEventId: cursor ? required(String(cursor.eventId)) : undefined,
            limit: bounded(request.limit, 200, 200),
        });
        if (!("ok" in result) || !result.ok)
            throw new Error("message" in result ? result.message : "Committed history is unavailable.");
        const snapshot = result.snapshot;
        const string = (key: string) => (typeof snapshot[key] === "string" ? String(snapshot[key]) : "");
        const session = service.store.getSessionById(request.sessionId)!;
        const segments = service.store.listSessionTranscriptSegments(request.sessionId);
        let previewBytes = 0;
        const events = result.events.map((event) => {
            if (!Array.isArray(event.images)) return event;
            const previews: SessionImageTransfer[] = [];
            for (const image of event.images) {
                if (!image || typeof image !== "object" || Array.isArray(image)) continue;
                let preview: SessionImageTransfer | null = null;
                if (typeof image.base64 === "string" && typeof image.mimeType === "string")
                    preview = { base64: image.base64, mimeType: image.mimeType };
                else if (typeof image.ref === "string") {
                    const segment = segments.find((segment) => segment.ordinal === event.segmentOrdinal);
                    if (segment) {
                        try {
                            const saved = readSessionImageAttachment(
                                image.ref,
                                join(getRunWieldSessionDir(segment.transcriptCwd), `${segment.piSessionId}_images`),
                            );
                            preview = { base64: saved.base64, mimeType: saved.mimeType };
                        } catch {
                            /* Missing scoped previews do not invalidate committed text evidence. */
                        }
                    }
                }
                if (preview && previewBytes + preview.base64.length <= SESSION_IMAGE_BASE64_LIMIT) {
                    previewBytes += preview.base64.length;
                    previews.push(preview);
                }
            }
            return {
                ...event,
                images: previews.map(({ base64, mimeType }) => ({ base64, mimeType })),
                imagesOmitted: event.images.length - previews.length,
            };
        });
        return {
            sessionId: request.sessionId,
            generation: result.generation,
            archivedAt: session.archivedAt || null,
            events,
            configuration: {
                agentName: string("activeAgent"),
                model: string("model"),
                provider: string("provider"),
                thinkingLevel: string("thinkingLevel"),
            },
            previousCursor: result.previousCursor
                ? encode({
                      sessionId: request.sessionId,
                      projectId: context.projectId,
                      generation: result.generation,
                      eventId: result.previousCursor,
                  })
                : null,
            complete: result.complete,
        };
    }
    async snapshot(request: WorkspaceSnapshotRequest): Promise<WorkspaceSnapshotResult> {
        const identity = request.wireSessionId || request.sessionId;
        const bound = request.wireSessionId ? this.bindings.get(request.wireSessionId) : undefined;
        if (request.wireSessionId && !bound) throw new Error("Unknown wire Session ID.");
        if (bound) {
            if (request.sessionId && bound.durableId && request.sessionId !== bound.durableId)
                throw new Error("Snapshot durable identity does not match.");
            this.projects.admitContext(request.context, bound.durableId || undefined);
            if (JSON.stringify(bound.context) !== JSON.stringify(request.context))
                throw new Error("Snapshot binding does not match.");
        } else this.admit(request);
        const local = bound?.operationId ? this.owner().getOperation(bound.operationId) : null;
        if (bound && local?.runwieldSessionId) bound.durableId = local.runwieldSessionId;
        const durableId = bound?.durableId || request.sessionId;
        const live =
            bound && !bound.durableId
                ? { state: local ? "active" : "idle", generation: null, operation: local }
                : await this.owner().liveSession(request.context.projectId, durableId);
        const operation = live.operation ? parseWorkspaceRequest(JSON.stringify(live.operation)) : null;
        const events = operation?.events;
        let truncated = false;
        if (Array.isArray(events) && events.length > 500) {
            operation!.events = events.slice(-500);
            truncated = true;
        }
        if (operation && Array.isArray(operation.events)) {
            while (
                operation.events.length &&
                Buffer.byteLength(JSON.stringify(operation)) > WORKSPACE_OBSERVATION_BYTE_LIMIT
            ) {
                const first = operation.events[0];
                if (
                    first &&
                    typeof first === "object" &&
                    !Array.isArray(first) &&
                    typeof first.delta === "string" &&
                    first.delta.length > 32768
                ) {
                    // Keep the newest output of an oversized coalesced delta. Canonical history
                    // supplies its full text after settlement; a gap must not hide later output.
                    operation.events[0] = { ...first, delta: first.delta.slice(-32768) };
                } else operation.events.shift();
                truncated = true;
            }
        }
        const cursor = encode({
            sessionId: identity,
            generation: live.generation,
            operationId: live.operation?.operationId || "",
            count: live.operation?.events.length || 0,
            sequence: live.operation?.eventSequence || 0,
        });
        const previous = request.cursor ? decode(request.cursor) : null;
        if (previous && previous.sessionId !== identity)
            throw new Error("Observation cursor belongs to another Session.");
        return {
            sessionId: bound?.durableId || request.sessionId,
            generation: live.generation,
            state: live.state,
            cursor,
            gap: Boolean(
                previous &&
                (previous.generation !== live.generation ||
                    truncated ||
                    (previous.operationId === (live.operation?.operationId || "") &&
                        typeof previous.sequence === "number" &&
                        (previous.sequence < (live.operation?.eventEvictedThrough || 0) ||
                            previous.sequence > (live.operation?.eventSequence || 0)))),
            ),
            operation,
        };
    }
    async listStandard(json: string): Promise<WorkspaceSessionListResult> {
        const request: StandardSessionListRequest = JSON.parse(json);
        const metadata = request._meta?.[WORKSPACE_EXTENSION];
        if (!metadata)
            throw new RequestError(-32002, "Workspace Project context is required.", {
                code: "workspace_binding_invalid",
            });
        if (
            Object.keys(metadata).some(
                (key) => !["connectionId", "projectId", "canonicalRoot", "archiveState", "limit"].includes(key),
            )
        )
            throw new RequestError(-32602, "Unexpected list metadata.");
        const context = {
            connectionId: metadata.connectionId,
            projectId: metadata.projectId,
            canonicalRoot: metadata.canonicalRoot,
        };
        if (request.cwd !== context.canonicalRoot)
            throw new RequestError(-32002, "Project root does not match.", { code: "workspace_binding_invalid" });
        return await this.list({
            context,
            cursor: request.cursor || undefined,
            archiveState: metadata.archiveState,
            limit: metadata.limit,
        });
    }
    async list(request: WorkspaceSessionListRequest): Promise<WorkspaceSessionListResult> {
        const context = this.projects.admitContext(request.context);
        return await listSessionPage(this.owner().store, context.projectId, context.canonicalRoot, request);
    }
    async options(request: { context: WorkspaceProjectContext }) {
        const context = request.context;
        this.projects.admitContext(context);
        return await this.owner().listSessionOptions(context.projectId, "session-client");
    }
    async command(request: import("./workspace-contract.ts").WorkspaceCommandRequest) {
        const binding = this.bindings.get(required(request.wireSessionId));
        if (!binding || JSON.stringify(binding.context) !== JSON.stringify(request.context))
            throw new Error("Snapshot binding does not match.");
        this.projects.admitContext(request.context, binding.durableId || undefined);
        if (binding.operationId && this.owner().getOperation(binding.operationId).status === "running")
            throw new RequestError(-32002, "Wait for the Session to finish before using commands.");
        if (typeof request.text !== "string" || request.text.length > 65536)
            throw new RequestError(-32602, "Invalid command.");
        return await this.owner().command(request.context.projectId, binding.durableId, request.text);
    }
    async configure(request: WorkspaceConfigureRequest) {
        this.admit(request);
        required(request.requestId);
        return await this.owner().configureSession({
            ...request,
            projectId: request.context.projectId,
            runwieldSessionId: request.sessionId,
        });
    }
    async unarchive(request: WorkspaceSessionRequest) {
        this.admit(request);
        return await this.owner().unarchiveSession({
            projectId: request.context.projectId,
            runwieldSessionId: request.sessionId,
        });
    }
    async answer(request: WorkspaceAnswerRequest) {
        this.admit(request);
        const live = await this.owner().liveSession(request.context.projectId, request.sessionId);
        if (live.operation?.operationId !== request.operationId)
            throw new Error("Interaction operation is no longer current.");
        const interaction = live.operation.liveInteraction;
        if (!interaction || interaction.interactionId !== request.interactionId)
            throw new Error("Interaction is no longer waiting.");
        const question = interaction.request;
        const action = request.response.action;
        const answer = request.response.answer;
        const otherAnswer = request.response.otherAnswer;
        if (!["accept", "decline", "cancel"].includes(String(action))) throw new Error("Invalid question action.");
        let response: RuntimeInteractionResponse = { outcome: "canceled" };
        if (action === "accept") {
            if (typeof answer !== "string" || (!question.allowEmpty && !answer.trim()))
                throw new Error("An answer is required.");
            const choice = question.options?.find((option) => option.value === answer);
            if (question.options?.length && !choice) throw new Error("Choose an exact listed answer.");
            if (
                otherAnswer !== undefined &&
                (typeof otherAnswer !== "string" || !question.otherOptionValue || question.otherOptionValue !== answer)
            )
                throw new Error("Other text is not supported for this choice.");
            response =
                question.type === "approval"
                    ? {
                          outcome: isApprovalAcceptedValue(question, answer) ? "accepted" : "canceled",
                          value: isApprovalAcceptedValue(question, answer),
                          valueLabel: choice?.label,
                      }
                    : {
                          outcome: question.type === "select" ? "selected" : "text",
                          value: answer,
                          ...(choice ? { valueLabel: choice.label } : {}),
                          ...(typeof otherAnswer === "string" ? { otherText: otherAnswer } : {}),
                      };
        }
        return this.owner().answerInteraction({
            projectId: request.context.projectId,
            runwieldSessionId: request.sessionId,
            operationId: request.operationId,
            interactionId: request.interactionId,
            requestId: request.requestId,
            response,
        });
    }
    private metadata(request: StandardRequest): MutationMetadata {
        const meta = request._meta?.[WORKSPACE_EXTENSION] as MutationMetadata | undefined;
        if (!meta) {
            this.projects.admitContext({ connectionId: "missing", projectId: "missing", canonicalRoot: "/missing" });
            throw new RequestError(-32002, "Workspace mutation metadata is required.", {
                code: "workspace_binding_invalid",
            });
        }
        if (
            Object.keys(meta).some(
                (key) =>
                    ![
                        "connectionId",
                        "projectId",
                        "canonicalRoot",
                        "requestId",
                        "expectedGeneration",
                        "confirmed",
                        "configuration",
                    ].includes(key),
            )
        )
            throw new RequestError(-32602, "Unexpected Workspace mutation field.");
        if (meta.configuration) {
            if (
                Object.keys(meta.configuration).some(
                    (key) => !["agentName", "model", "provider", "thinkingLevel"].includes(key),
                )
            )
                throw new RequestError(-32602, "Unexpected configuration field.");
            for (const value of Object.values(meta.configuration))
                if (typeof value !== "string" || value.length > 512)
                    throw new RequestError(-32602, "Invalid configuration value.");
        }
        return meta;
    }
    private bound(request: StandardRequest, settlement = false): BoundSession {
        if (this.draining && !settlement) throw new RequestError(-32002, "Session connection is draining.");
        const binding = this.bindings.get(required(request.sessionId!));
        if (!binding) throw new Error("Unknown wire Session ID.");
        if (binding.closing && !settlement) throw new RequestError(-32002, "Session binding is closing.");
        const meta = this.metadata(request);
        if (
            meta.connectionId !== binding.context.connectionId ||
            meta.projectId !== binding.context.projectId ||
            meta.canonicalRoot !== binding.context.canonicalRoot
        )
            throw new RequestError(-32002, "Session binding does not match.", { code: "workspace_binding_invalid" });
        if (!settlement) this.projects.admitContext(binding.context, binding.durableId || undefined);
        return binding;
    }
    async open(request: StandardRequest, load: boolean) {
        if (this.draining) throw new RequestError(-32002, "Session connection is draining.");
        const meta = this.metadata(request);
        const context = {
            connectionId: meta.connectionId,
            projectId: meta.projectId,
            canonicalRoot: meta.canonicalRoot,
        };
        this.projects.admitContext(context, load ? required(request.sessionId!) : undefined);
        if (request.cwd !== context.canonicalRoot)
            throw new RequestError(-32002, "Project root does not match.", { code: "workspace_binding_invalid" });
        const sessionId = `workspace-${crypto.randomUUID()}`;
        const durableId = load ? request.sessionId! : "";
        const history = load ? await this.history({ context, sessionId: durableId }) : null;
        this.bindings.set(sessionId, { context, durableId, operationId: "" });
        return { sessionId, _meta: { runwield: { persistedSessionId: durableId, history } } };
    }
    async setConfig(request: StandardRequest & { configId: string; value: string }) {
        const binding = this.bound(request);
        const meta = this.metadata(request);
        const names = {
            model: "model",
            thinking: "thinkingLevel",
            thinking_level: "thinkingLevel",
            agent: "agentName",
        };
        const key = names[request.configId as keyof typeof names];
        if (!key) throw new Error("Unsupported configuration option.");
        await this.configure({
            context: binding.context,
            sessionId: binding.durableId,
            requestId: required(meta.requestId),
            expectedGeneration: meta.expectedGeneration,
            [key]: request.value,
        });
        return { configOptions: [] };
    }
    async prompt(
        request: StandardRequest,
        interact?: (request: RuntimeInteractionRequest) => Promise<RuntimeInteractionResponse>,
    ) {
        const binding = this.bound(request);
        const meta = this.metadata(request);
        required(meta.requestId);
        const images: SessionImageTransfer[] = [];
        const text: string[] = [];
        for (const block of request.prompt || []) {
            if (block.type === "text" && typeof block.text === "string") text.push(block.text);
            else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
                images.push({ base64: block.data, mimeType: block.mimeType });
            else throw new Error("Unsupported Workspace prompt content.");
        }
        const message = text.join("\n");
        validateSessionInput(message, images);
        if (message.trim().startsWith("/") && getCommandDefinition(parseSessionCommand(message).name))
            throw new RequestError(-32602, "Use the semantic Session command operation for action commands.");
        const service = this.owner();
        const readiness = getSelectedDefaultModelAvailability(binding.context.canonicalRoot);
        if (!readiness.available)
            throw new RequestError(
                -32000,
                "Configure a default model with wld login, then restart desktop. Your history and draft remain available.",
                {
                    code: "default_model_required",
                    cwd: binding.context.canonicalRoot,
                    prerequisite: "default_model",
                    guidance: "Run wld login and restart desktop.",
                },
            );
        if (!binding.durableId)
            binding.createRequest = { requestId: meta.requestId, configuration: meta.configuration };
        const creating = binding.createRequest?.requestId === meta.requestId;
        const acceptance = !creating
            ? service.startContinuation({
                  projectId: binding.context.projectId,
                  runwieldSessionId: binding.durableId,
                  requestId: meta.requestId,
                  expectedGeneration: meta.expectedGeneration,
                  text: message,
                  images,
              })
            : service.createSession({
                  projectId: binding.context.projectId,
                  requestId: meta.requestId,
                  text: message,
                  images,
                  ...(meta.configuration ?? binding.createRequest?.configuration),
              });
        binding.accepting = acceptance;
        const accepted = await acceptance.finally(() => {
            binding.accepting = undefined;
        });
        binding.operationId = accepted.operationId;
        // A v1 prompt returns on foreground settlement; retained background work remains Core-owned.
        let forwarded = "";
        while (true) {
            const operation = service.getOperation(accepted.operationId);
            if (operation.runwieldSessionId) binding.durableId = operation.runwieldSessionId;
            if (interact && operation.liveInteraction && forwarded !== operation.liveInteraction.interactionId) {
                const interaction = operation.liveInteraction;
                forwarded = interaction.interactionId;
                void interact(interaction.request)
                    .then(async (response) => {
                        try {
                            this.projects.admitContext(binding.context, binding.durableId || undefined);
                        } catch {
                            await service.cancelOperation({ operationId: accepted.operationId });
                            response = { outcome: "canceled" };
                        }
                        await service.answerInteraction({
                            projectId: binding.context.projectId,
                            runwieldSessionId: binding.durableId,
                            operationId: accepted.operationId,
                            interactionId: interaction.interactionId,
                            requestId: `elicitation-${interaction.interactionId}`,
                            response,
                        });
                    })
                    .catch(() => {});
            }
            if (!["accepted", "running"].includes(operation.status)) {
                if (operation.status === "failed") throw new Error(operation.error || "Session operation failed.");
                if (operation.status !== "completed")
                    throw new RequestError(
                        -32002,
                        "Session outcome is unknown. Refresh before retrying. Your draft is retained.",
                        {
                            code: "session_outcome_unknown",
                        },
                    );
                return {
                    stopReason: "end_turn" as const,
                    _meta: { runwield: { persistedSessionId: binding.durableId, operationId: accepted.operationId } },
                };
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    async stop(request: StandardRequest) {
        const binding = this.bound(request, true);
        const service = this.owner();
        const local = binding.operationId ? service.operations.get(binding.operationId) : null;
        if (local?.status === "running" && !local.remote) {
            await service.cancelOperation({ operationId: binding.operationId });
            return;
        }
        if (binding.durableId) {
            try {
                const live = await service.liveSession(binding.context.projectId, binding.durableId);
                binding.operationId = live.operation?.operationId || "";
                if (live.state === "active" && !binding.operationId) {
                    throw new RequestError(-32002, "This Session is still starting or stopping. Try again.", {
                        code: "session_stop_unavailable",
                    });
                }
            } catch (error) {
                // Revoked Project admission must not prevent closing its already settled binding.
                if (!(error instanceof Error) || error.message !== "Session not found.") throw error;
                binding.operationId = "";
            }
        }
        if (binding.operationId) await service.cancelOperation({ operationId: binding.operationId });
    }
    async closeSession(request: StandardRequest) {
        const binding = this.bound(request, true);
        // No stop(): that API intentionally permits explicit cancellation of a remote owner.
        // Close and application drain must never forward cancellation to that owner.
        binding.closing = true;
        await binding.accepting;
        // A new composer can have an accepted operation before its durable identity exists.
        let local = binding.operationId ? this.owner().operations.get(binding.operationId) : null;
        while (local && local.status === "running" && !local.runwieldSessionId) {
            if (local.runtimeSessionId) this.owner().runtime.cancelSession(local.runtimeSessionId);
            await new Promise((resolve) => setTimeout(resolve, 10));
            local = this.owner().operations.get(binding.operationId);
        }
        const durableId = binding.durableId || local?.runwieldSessionId || "";
        const result: import("./workspace-contract.ts").WorkspaceSettlementResult = durableId
            ? await this.owner().drainOwnedWork(durableId)
            : { status: "settled", sessions: [] };
        if (result.status === "settled") this.bindings.delete(request.sessionId!);
        return { _meta: { [WORKSPACE_EXTENSION]: result } };
    }
    drain() {
        if (this.drainPromise) return this.drainPromise;
        this.draining = true;
        const drain = this.owner().drainOwnedWork();
        this.drainPromise = drain;
        void drain
            .finally(() => {
                this.drainPromise = null;
            })
            .catch(() => {});
        return drain;
    }
    async archive(request: StandardRequest) {
        if (this.draining) throw new RequestError(-32002, "Session connection is draining.");
        const meta = this.metadata(request);
        const bound = this.bindings.has(request.sessionId!) ? this.bound(request) : undefined;
        const context = bound?.context || {
            connectionId: meta.connectionId,
            projectId: meta.projectId,
            canonicalRoot: meta.canonicalRoot,
        };
        const durableId = bound?.durableId || required(request.sessionId!);
        this.projects.admitContext(context, durableId);
        await this.owner().archiveSession({
            projectId: context.projectId,
            runwieldSessionId: durableId,
            confirmed: meta.confirmed,
        });
        return {};
    }
    async steer(request: StandardRequest & { text: string; images?: SessionImageTransfer[] }) {
        const binding = this.bound(request);
        const meta = this.metadata(request);
        validateSessionInput(request.text, request.images);
        if (request.text.trim().startsWith("/"))
            throw new RequestError(-32602, "Slash commands cannot steer a running turn.");
        const live = await this.owner().liveSession(binding.context.projectId, binding.durableId);
        if (!live.operation)
            throw new RequestError(-32002, "No running operation to steer.", { code: "session_not_running" });
        if (live.operation.liveInteraction)
            throw new RequestError(-32002, "Answer the pending question before steering.", {
                code: "interaction_pending",
            });
        const result = await this.owner().steerOperation({
            projectId: binding.context.projectId,
            operationId: live.operation.operationId,
            requestId: required(meta.requestId),
            text: request.text,
            images: request.images || [],
        });
        if (!result.ok || !result.queued)
            throw new RequestError(-32002, "Steering was not accepted. Refresh and send as a follow-up.", {
                code: "steering_refused",
            });
        return result;
    }
}

/** Standard discovery is file-only for ordinary ACP clients. */
export async function listSessionPage(
    store: FileSessionStore,
    projectId: string,
    cwd: string,
    request: Pick<WorkspaceSessionListRequest, "cursor" | "limit" | "archiveState">,
) {
    const limit = bounded(request.limit, 30, 100);
    const archiveState = request.archiveState || "active";
    if (!["active", "archived", "all"].includes(archiveState))
        throw new RequestError(-32602, "Invalid archive filter.");
    const cursor = request.cursor ? decode(request.cursor) : null;
    if (cursor && (cursor.projectId !== projectId || cursor.archiveState !== archiveState || cursor.limit !== limit))
        throw new Error("List cursor belongs to another query.");
    const page = cursor ? Number(cursor.page) : 0;
    if (!Number.isInteger(page) || page < 0) throw new Error("Invalid list cursor.");
    const result = await listSavedSessions(store, projectId, {
        page,
        pageSize: limit,
        archiveState,
        includeTotal: false,
    });
    return {
        sessions: result.sessions.map((session) => ({
            sessionId: session.runwieldSessionId,
            title: session.displayName,
            cwd,
            updatedAt: session.headerTimestamp || session.lastCatalogedAt || "",
            archivedAt: session.archivedAt || null,
            generation: session.generation,
        })),
        nextCursor: result.hasNext ? encode({ projectId, archiveState, limit, page: page + 1 }) : null,
    };
}

/** JSON parsing is confined to the ACP boundary; handlers validate before entering Core. */
export function parseStandardRequest(json: string): StandardRequest {
    return JSON.parse(json);
}
export interface StandardConfigRequest extends StandardRequest {
    configId: string;
    value: string;
}
export function parseStandardConfigRequest(json: string): StandardConfigRequest {
    const request: StandardConfigRequest = JSON.parse(json);
    if (typeof request.configId !== "string" || typeof request.value !== "string")
        throw new Error("Invalid configuration selection.");
    return request;
}

interface StandardSessionListMetadata {
    [WORKSPACE_EXTENSION]: import("./workspace-contract.ts").WorkspaceSessionListMetadata;
}
interface StandardSessionListRequest {
    cwd?: string;
    cursor?: string;
    _meta?: StandardSessionListMetadata;
}
