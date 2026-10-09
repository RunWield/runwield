import { AGENTS, SUBAGENTS } from "../../../constants.js";
import { readPersistedActiveAgentName, readPersistedModelState } from ".././active-agent-session.js";
import { resolveActiveWorkflowRuntimeAgent } from "../../workflow/execution-agent.ts";
import { getModelRegistry } from "../../models/model-registry.ts";
import { parseProviderModel } from "../../models/model-validation.ts";
import { getSettingsManager } from "../../settings.js";
import { isGitRepository } from "../../git.ts";
import { enterProjectRuntime } from "../../project-runtime-layout.ts";
import { readPersistedWorkflowContext } from ".././workflow-context-session.js";
import { createPairCheckpointTool } from "../../../tools/pair-checkpoint.ts";
import { formatPairCheckpointContext, restorePairExecutionState } from ".././pair-checkpoint-session.ts";
import { loadPlan } from "../../../plan-store.js";
import { listEntries } from "../../worktree-registry.js";

/** A delivered execution keeps its transcript origin, but resumes in the registered project. */
export async function restorePublishedSessionProjectRoot(
    session: import("../hosted-session.js").HostedSession,
    store: import("../file-session-store-types.ts").FileSessionStore,
): Promise<void> {
    const managed = session.getManagedMetadata();
    if (!managed) return;
    const segment = store.getCurrentSessionSegment(managed.runwieldSessionId);
    if (segment?.kind !== "execution" && segment?.kind !== "semantic_repair") return;
    const projectRoot = store.requireSessionProjectRoot(managed.projectId);
    if (session.cwd === projectRoot) return;
    const association = store.listSessionPlanAssociations(managed.runwieldSessionId, managed.projectId).at(-1);
    if (!association || !["execution", "recovery"].includes(association.purpose)) return;
    // A retained or newer attempt still owns its execution checkout.
    if ((await listEntries(projectRoot, { migrate: false })).some((entry) => entry.planId === association.planId)) {
        return;
    }
    const plan = await loadPlan(projectRoot, association.planName);
    if (
        plan?.attrs.planId !== association.planId || plan.attrs.status !== "verified" ||
        !plan.attrs.publicationReceipt?.publishedCommit
    ) return;
    session.rebindProjectRoot(projectRoot);
}

/**
 * @param {import('.././types.js').ImageAttachment[]} images
 * @returns {import('.././named-invocation.ts').ImageReference[]}
 */
export type RuntimeRootSessionManager = import("@earendil-works/pi-coding-agent").SessionManager & {
    dispose?(): void;
};

export async function enterGitProjectRuntime(cwd: string) {
    if (await isGitRepository(cwd)) await enterProjectRuntime(cwd);
}

export function isRuntimeRootSessionManager(
    manager:
        | import("../hosted-session.js").MinimalSessionManagerLike
        | import("@earendil-works/pi-coding-agent").SessionManager
        | null
        | undefined,
): manager is RuntimeRootSessionManager {
    return Boolean(
        manager &&
            "sessionId" in manager &&
            "sessionFile" in manager &&
            typeof manager.getEntries === "function",
    );
}

export interface RuntimeAgentSession {
    model: import("@earendil-works/pi-coding-agent").AgentSession["model"];
    settingsManager?: import("@earendil-works/pi-coding-agent").AgentSession["settingsManager"];
    getContextUsage?: import("@earendil-works/pi-coding-agent").AgentSession["getContextUsage"];
    subscribe(listener: (event: { type: string; steering?: readonly string[] }) => void): () => void;
    agent?: import("@earendil-works/pi-coding-agent").AgentSession["agent"];
    modelRegistry?: ReturnType<typeof getModelRegistry>;
    isStreaming?: boolean;
    isCompacting?: boolean;
    getSteeringMessages?(): readonly string[];
    clearQueue?(): void | { steering?: readonly string[]; followUp?: readonly string[] };
    followUp?(
        text: string,
    ): void | Promise<void> | ReturnType<import("@earendil-works/pi-coding-agent").AgentSession["followUp"]>;
    setAutoCompactionEnabled?(enabled: boolean): void;
    cycleThinkingLevel?(): import("../hosted-session.js").ThinkingLevel | undefined;
    setThinkingLevel?(level: import("../hosted-session.js").ThinkingLevel): void;
    compact?: import("@earendil-works/pi-coding-agent").AgentSession["compact"];
    abortCompaction?(): void;
    recordBashResult?(
        command: string,
        result: {
            output: string;
            exitCode: number;
            cancelled: boolean;
            truncated: boolean;
        },
        options: { excludeFromContext: boolean },
    ): void;
}

export function isRuntimeAgentSession(
    session:
        | import("../hosted-session.js").DisposableLike
        | import("@earendil-works/pi-coding-agent").AgentSession
        | null
        | undefined,
): session is RuntimeAgentSession {
    return Boolean(session && "model" in session && "subscribe" in session && typeof session.subscribe === "function");
}

export function getRuntimeRootAgentSession(session: import("../hosted-session.js").HostedSession) {
    const root = session.getRootAgentSession();
    return isRuntimeAgentSession(root) ? root : null;
}

export function imageReferencesForNamedInvocation(images: import(".././types.js").ImageAttachment[]) {
    return images.map((image) => ({
        ...(image.ref ? { ref: image.ref } : {}),
        ...(image.path ? { path: image.path } : {}),
        ...(image.base64 ? { base64: image.base64 } : {}),
        ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    }));
}

/**
 * Rebuild the workflow-owned root configuration that an active-agent marker
 * alone cannot describe. Slicer needs both its hidden definition and the
 * finalize tool bound to the current Epic.
 *
 * @param {string} agentName
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} sessionManager
 * @param {string} cwd
 */
export async function resolvePersistedRootConfiguration(
    agentName: string,
    sessionManager: import("@earendil-works/pi-coding-agent").SessionManager,
    cwd: string,
) {
    if (agentName !== AGENTS.SLICER) return {};
    const planName = readPersistedWorkflowContext(sessionManager)?.planName || "";
    if (!planName) {
        throw new Error("Cannot resume Slicer because its Epic context is missing from the Session transcript.");
    }
    const { createSlicerFinalizeTool } = await import("../../workflow/workflow-slicer.ts");
    return {
        subAgentDefinition: { id: SUBAGENTS.SLICER },
        customTools: [createSlicerFinalizeTool({ planName, cwd })],
    };
}

/**
 * Restore durable execution ownership and optional Pair context before root activation.
 *
 * @param {import('.././hosted-session.js').HostedSession} hostedSession
 */
export function resolvePersistedExecutionRootConfiguration(
    hostedSession: import(".././hosted-session.js").HostedSession,
) {
    const checkpoint = restorePairExecutionState(hostedSession);
    const workflow = hostedSession.getActiveExecutionWorkflow?.() || null;
    const persistedAgent = readPersistedActiveAgentName(hostedSession.getRootSessionManager());
    // Semantic repair owns this root until its focused repair turn is complete.
    const agentName = persistedAgent === AGENTS.REVIEWER_FEEDBACK_ENGINEER
        ? persistedAgent
        : resolveActiveWorkflowRuntimeAgent(workflow) || "";
    if (!workflow || !agentName) return null;
    const existingProjectState = hostedSession.getProjectStateContext?.() || "";
    const checkpointContext = checkpoint ? formatPairCheckpointContext(checkpoint) : "";
    return {
        agentName,
        cwd: workflow.executionCwd || hostedSession.cwd,
        projectStateContext: existingProjectState
            ? `${existingProjectState}\n\n${checkpointContext}`
            : checkpointContext,
        ...(workflow.collaborationStyle === "pair"
            ? { customTools: [createPairCheckpointTool({ hostedSession })] }
            : {}),
    };
}

/**
 * @param {import("./types.ts").RuntimeQueuedMessageState} message
 * @returns {import('.././session-runtime-events.js').RuntimeQueuedMessage}
 */
export function toRuntimeQueuedMessage(message: import("./types.ts").RuntimeQueuedMessageState) {
    return {
        id: message.id,
        text: message.text,
        images: message.images.map((image) => ({ ...image })),
        delivery: message.delivery,
        queuedAt: message.queuedAt,
        ...(message.inputSurface ? { inputSurface: message.inputSurface } : {}),
    };
}

function getStreamingAssistantContextTokens(session: RuntimeAgentSession) {
    if (!session.isStreaming) return null;
    const messages = session.agent?.state.messages;
    if (!Array.isArray(messages)) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") {
            continue;
        }
        const usage = message.usage;
        if (!usage) return null;
        const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        return tokens > 0 ? tokens : null;
    }
    return null;
}

/**
 * Project the context-capacity state of the Agent currently represented by the
 * Runtime. Transient Agents take precedence while they are active, matching the
 * active-agent information exposed in the footer without leaking AgentSession
 * objects across the Runtime boundary.
 *
 * @param {import('.././hosted-session.js').HostedSession} session
 * @returns {RuntimeContextCapacity}
 */
export function getRuntimeContextCapacity(session: import(".././hosted-session.js").HostedSession) {
    const sessions = [session.getRootAgentSession(), ...session.getSubAgentSessions()].filter((candidate) =>
        candidate !== null
    );
    const activeSession = sessions.at(-1);
    if (!activeSession) {
        const compactionSettings = getSettingsManager(session.cwd).getCompactionSettings();
        return { contextUsage: null, autoCompactionEnabled: compactionSettings.enabled !== false };
    }

    const rawUsage = activeSession.getContextUsage?.();
    const streamingTokens = isRuntimeAgentSession(activeSession)
        ? getStreamingAssistantContextTokens(activeSession)
        : null;
    const tokens = typeof streamingTokens === "number" ? streamingTokens : rawUsage?.tokens;
    const contextWindow = Number(rawUsage?.contextWindow ?? activeSession.model?.contextWindow ?? 0) || 0;
    const contextUsage = contextWindow > 0
        ? {
            tokens: typeof tokens === "number" ? tokens : null,
            contextWindow,
            percent: typeof tokens === "number" ? (tokens / contextWindow) * 100 : null,
        }
        : null;
    const compactionSettings = activeSession.settingsManager?.getCompactionSettings?.();

    return {
        contextUsage,
        autoCompactionEnabled: compactionSettings?.enabled !== false,
    };
}

/**
 * @param {string | null | undefined} value
 * @returns {import('.././hosted-session.js').ThinkingLevel}
 */
export function normalizeThinkingLevel(value: string | null | undefined) {
    switch (value) {
        case "minimal":
        case "low":
        case "medium":
        case "high":
        case "xhigh":
        case "max":
            return value;
        default:
            return "off";
    }
}

/**
 * @param {{ model?: string | null, provider?: string | null }} modelState
 * @param {{ model?: string | null, provider?: string | null }} managed
 * @returns {{ model: string, provider: string }}
 */
export function normalizeManagedActiveModelState(
    modelState: { model?: string | null; provider?: string | null },
    managed: { model?: string | null; provider?: string | null },
) {
    const model = modelState.model || managed.model || "";
    const provider = modelState.provider || managed.provider || "";
    if (model && provider && model.startsWith(`${provider}/`)) {
        const parsed = parseProviderModel(model);
        if (parsed.ok && parsed.provider === provider) return { model: parsed.id, provider };
    }
    return { model, provider };
}

export function isAgyCliMcpSetupApprovalError(error: Error) {
    return error instanceof Error && error.name === "AgyCliMcpSetupApprovalError";
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} sessionManager
 * @returns {string | undefined}
 */
export function resolvePersistedResumeModel(sessionManager: import("@earendil-works/pi-coding-agent").SessionManager) {
    const persisted = readPersistedModelState(sessionManager);
    if (!persisted?.provider || !persisted.model) return undefined;
    try {
        const registry = getModelRegistry();
        const model = registry.find(persisted.provider, persisted.model);
        return model && registry.isSelectable(model) ? `${model.provider}/${model.id}` : undefined;
    } catch {
        return undefined;
    }
}

/**
 * @param {NonNullable<import('.././hosted-session.js').ManagedSessionMetadata['syncState']> | null | undefined} previous
 * @param {NonNullable<import('.././hosted-session.js').ManagedSessionMetadata['syncState']>} next
 * @returns {boolean}
 */
export function isSameManagedSyncState(
    previous: NonNullable<import(".././hosted-session.js").ManagedSessionMetadata["syncState"]> | null | undefined,
    next: NonNullable<import(".././hosted-session.js").ManagedSessionMetadata["syncState"]>,
) {
    return previous?.status === next.status && previous.localGeneration === next.localGeneration &&
        previous.latestGeneration === next.latestGeneration && previous.owningSurfaceKind === next.owningSurfaceKind &&
        previous.message === next.message;
}

interface SemanticRepairSource {
    triageMeta?: SemanticTriageMeta;
    semanticRound?: number;
    ciState?: SemanticCiState;
}
interface SemanticTriageMeta {
    status?: string;
    validationCiAttempts?: number;
    validationSemanticRounds?: number;
}
interface SemanticCiState {
    status?: string;
    validationCiAttempts?: number;
    validationSemanticRounds?: number;
    semanticRound?: number;
    lastCompletedPhase?: string;
    currentPhase?: string;
}
interface SemanticWorkflowMeta {
    validationCheckpoint?: SemanticProgressSource | null;
    publication?: SemanticProgressSource | null;
    worktreeStatus?: string | null;
}
interface SemanticProgressSource {
    nextPhase?: string;
    state?: string;
    repairKind?: string;
    updatedAt?: string;
    phase?: string;
    failure?: boolean;
}

export function buildSemanticRepairCiState(
    options: SemanticRepairSource,
    workflow: SemanticRepairSource,
    handoff: SemanticRepairSource,
) {
    const triageMeta = workflow?.triageMeta || options?.triageMeta || {};
    const state = {
        status: typeof triageMeta.status === "string" ? triageMeta.status : "",
        validationCiAttempts: typeof triageMeta.validationCiAttempts === "number" ? triageMeta.validationCiAttempts : 0,
        validationSemanticRounds: typeof triageMeta.validationSemanticRounds === "number"
            ? triageMeta.validationSemanticRounds
            : handoff.semanticRound ?? 0,
        semanticRound: handoff.semanticRound ?? 0,
        lastCompletedPhase: "ci",
        currentPhase: "semantic_review",
    };
    return handoff.ciState ? { ...state, ...handoff.ciState } : state;
}

/**
 * @param {SemanticWorkflowMeta} activeWorkflowMeta
 * @returns {Array<import('../../workflow/workflow-presentation.ts').WorkflowProgressFact>}
 */
export function workflowProgressFactsFromActiveMeta(
    activeWorkflowMeta: Partial<import("../../../plan-store.js").PlanFrontMatter> & SemanticWorkflowMeta,
): import("../../workflow/workflow-presentation.ts").WorkflowProgressFact[] {
    const facts: import("../../workflow/workflow-presentation.ts").WorkflowProgressFact[] = [];
    const checkpoint = activeWorkflowMeta.validationCheckpoint;
    if (checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
        const source = checkpoint;
        facts.push({
            kind: "validation_checkpoint",
            phase: typeof source.nextPhase === "string" ? source.nextPhase : null,
            state: typeof source.state === "string" ? source.state : null,
            repairKind: typeof source.repairKind === "string" ? source.repairKind : null,
            updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
        });
    }
    const publication = activeWorkflowMeta.publication;
    if (publication && typeof publication === "object" && !Array.isArray(publication)) {
        const source = publication;
        facts.push({
            kind: "publication",
            phase: typeof source.phase === "string" ? source.phase : null,
            failure: Boolean(source.failure),
            updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
        });
    }
    const worktreeStatus = typeof activeWorkflowMeta.worktreeStatus === "string"
        ? activeWorkflowMeta.worktreeStatus
        : "";
    if (worktreeStatus) facts.push({ kind: "registry", status: worktreeStatus });
    return facts;
}

export interface ManagedOperationContext {
    runtime: import("./managed-operations.ts").RuntimeManagedOperations;
    sessionId: string;
    capability: import("../managed-operation.ts").ManagedOperationCapability;
}

export class SessionTurnInProgressError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string) {
        super(`Session "${sessionId}" already has an active turn`);
        this.name = "SessionTurnInProgressError";
        this.sessionId = sessionId;
    }
}
