import type { SessionArtifactReference } from "./file-session-store-types.ts";
import {
    buildWorkflowPresentation,
    type LiveValidationProgress,
    type WorkflowPresentation,
    type WorkflowProgressFact,
} from "../workflow/workflow-presentation.ts";

export const SESSION_SIDEBAR_TABS = ["workflow", "session", "artifacts"] as const;
export type SessionSidebarTab = typeof SESSION_SIDEBAR_TABS[number];

export interface SessionSidebarProjectionInput {
    sessionName?: string | null;
    sessionState?: string | null;
    activeSurface?: string | null;
    activeAgent?: string | null;
    activeModel?: string | null;
    thinkingLevel?: string | null;
    generation?: number | null;
    userMessages?: number | null;
    assistantMessages?: number | null;
    toolCalls?: number | null;
    compactionCount?: number | null;
    queuedMessages?: number | null;
    contextUsedTokens?: number | null;
    contextWindowTokens?: number | null;
    contextPercent?: number | null;
    systemContextTokens?: number | null;
    workflowPlan?: string | null;
    workflowEpic?: string | null;
    workflowIntent?: string | null;
    workflowClassification?: string | null;
    workflowStatus?: string | null;
    workflowValidationPhase?: "mechanical" | "semantic" | "delivery";
    workflowProgressFacts?: WorkflowProgressFact[];
    workflowLiveValidationProgress?: LiveValidationProgress | null;
    workflowHasLiveQuestion?: boolean;
    workflowHasPlanReview?: boolean;
    workflowHasCodeReview?: boolean;
    workflowCanRun?: boolean;
    workflowCanResume?: boolean;
    workflowCanRecover?: boolean;
    workflowDegradedMessage?: string | null;
    workflowSessionState?: string | null;
    workflowHasWorkingSession?: boolean;
    artifacts?: SessionArtifactReference[];
}

export interface SessionSidebarProjection {
    defaultTab: SessionSidebarTab;
    session: {
        name: string;
        state: string;
        activeSurface: string | null;
        agent: string;
        model: string;
        thinkingLevel: string;
        generation: string;
        stats: {
            totalMessages: number;
            userMessages: number;
            assistantMessages: number;
            toolCalls: number;
            compactionCount: number;
            queuedMessages: number;
        } | null;
        context: {
            usedTokens: number | null;
            contextWindow: number;
            percent: number | null;
            systemTokens: number | null;
            conversationTokens: number | null;
        } | null;
    };
    workflow: WorkflowPresentation;
    artifacts: SessionArtifactReference[];
}

export function defaultSessionSidebarTab(hasWorkflow: boolean): SessionSidebarTab {
    return hasWorkflow ? "workflow" : "session";
}

export interface SessionSidebarField {
    label: string;
    value: string;
}

function formatTokens(tokens: number | null): string {
    return tokens === null ? "Unknown" : tokens.toLocaleString();
}

function formatShare(tokens: number | null, usedTokens: number | null): string {
    if (tokens === null) return "Unknown";
    if (usedTokens === null || usedTokens <= 0) return `~${formatTokens(tokens)}`;
    return `~${formatTokens(tokens)} · ${((tokens / usedTokens) * 100).toFixed(1)}% of used`;
}

/** Identical Session-tab fields for the TUI and Workspace. */
export function sessionSidebarFields(session: SessionSidebarProjection["session"]): SessionSidebarField[] {
    const fields = [{ label: "Session", value: session.name }];
    const { stats, context } = session;
    if (stats) {
        fields.push(
            {
                label: "Messages",
                value: `${stats.totalMessages} · ${stats.userMessages} user / ${stats.assistantMessages} assistant`,
            },
            { label: "Tool calls", value: String(stats.toolCalls) },
            { label: "Compactions", value: stats.compactionCount === 0 ? "None" : String(stats.compactionCount) },
        );
        if (stats.queuedMessages > 0) fields.push({ label: "Queued prompts", value: String(stats.queuedMessages) });
    }
    if (context) {
        const percent = context.percent === null ? "" : ` · ${context.percent.toFixed(1)}%`;
        fields.push(
            {
                label: "Context",
                value: `${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}${percent}`,
            },
            { label: "System & setup", value: formatShare(context.systemTokens, context.usedTokens) },
            { label: "Conversation", value: formatShare(context.conversationTokens, context.usedTokens) },
        );
    }
    return fields;
}

export function sessionArtifactKindLabel(kind: string): string {
    switch (kind) {
        case "prd":
            return "PRD";
        case "adr":
            return "ADR";
        case "work-record":
            return "Work Record";
        case "design-system":
            return "Design System";
        case "domain-language":
            return "Domain Language";
        case "epic-artifact":
            return "Epic Artifact";
        case "plan":
            return "Plan";
        case "report":
            return "Report";
        case "document":
            return "Document";
        default:
            return "Artifact";
    }
}

export function buildSessionSidebarProjection(input: SessionSidebarProjectionInput): SessionSidebarProjection {
    const workflowPlan = input.workflowPlan?.trim() || "";
    const workflowEpic = input.workflowEpic?.trim() || "";
    const workflowIntent = input.workflowIntent?.trim() || "";
    const workflow = buildWorkflowPresentation({
        planName: workflowPlan,
        epicName: workflowEpic,
        intent: workflowIntent,
        classification: input.workflowClassification,
        status: input.workflowStatus,
        validationPhase: input.workflowValidationPhase,
        progressFacts: input.workflowProgressFacts,
        liveValidationProgress: input.workflowLiveValidationProgress,
        degradedMessage: input.workflowDegradedMessage,
        sessionState: input.workflowSessionState,
        hasWorkingSession: input.workflowHasWorkingSession,
        hasLiveQuestion: input.workflowHasLiveQuestion,
        hasPlanReview: input.workflowHasPlanReview,
        hasCodeReview: input.workflowHasCodeReview,
        canRun: input.workflowCanRun,
        canResume: input.workflowCanResume,
        canRecover: input.workflowCanRecover,
    });
    const hasSessionStats = typeof input.userMessages === "number" || typeof input.assistantMessages === "number" ||
        typeof input.toolCalls === "number" || typeof input.compactionCount === "number";
    const userMessages = Math.max(0, input.userMessages || 0);
    const assistantMessages = Math.max(0, input.assistantMessages || 0);
    const contextWindow = Math.max(0, input.contextWindowTokens || 0);
    const usedTokens = typeof input.contextUsedTokens === "number" ? Math.max(0, input.contextUsedTokens) : null;
    const systemTokens = typeof input.systemContextTokens === "number" ? Math.max(0, input.systemContextTokens) : null;
    return {
        defaultTab: defaultSessionSidebarTab(workflow.active),
        session: {
            name: input.sessionName?.trim() || "Untitled Session",
            state: input.sessionState?.trim() || "unknown",
            activeSurface: input.activeSurface?.trim() || null,
            agent: input.activeAgent?.trim() || "Not recorded",
            model: input.activeModel?.trim() || "Project default",
            thinkingLevel: input.thinkingLevel?.trim() || "default",
            generation: typeof input.generation === "number" ? String(input.generation) : "Not committed",
            stats: hasSessionStats
                ? {
                    totalMessages: userMessages + assistantMessages,
                    userMessages,
                    assistantMessages,
                    toolCalls: Math.max(0, input.toolCalls || 0),
                    compactionCount: Math.max(0, input.compactionCount || 0),
                    queuedMessages: Math.max(0, input.queuedMessages || 0),
                }
                : null,
            context: contextWindow > 0
                ? {
                    usedTokens,
                    contextWindow,
                    percent: typeof input.contextPercent === "number" ? input.contextPercent : null,
                    systemTokens,
                    conversationTokens: usedTokens === null || systemTokens === null
                        ? null
                        : Math.max(0, usedTokens - systemTokens),
                }
                : null,
        },
        workflow,
        artifacts: (input.artifacts || []).map((artifact) => ({ ...artifact })),
    };
}
