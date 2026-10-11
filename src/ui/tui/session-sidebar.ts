import { isKeyRelease, isKeyRepeat, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    buildSessionSidebarProjection,
    SESSION_SIDEBAR_TABS,
    sessionArtifactKindLabel,
    sessionSidebarFields,
    type SessionSidebarProjection,
    type SessionSidebarTab,
} from "../../shared/session/session-sidebar.ts";
import type { SessionArtifactReference } from "../../shared/session/file-session-store-types.ts";
import type { LiveValidationProgress, WorkflowProgressFact } from "../../shared/workflow/workflow-presentation.ts";
import { theme } from "../theme/theme.js";

export interface TuiSessionSidebarSnapshot {
    name?: string | null;
    busy?: boolean;
    activeAgent?: string | null;
    activeModel?: { model?: string | null; provider?: string | null };
    thinkingLevel?: string | null;
    validationProgress?: LiveValidationProgress | null;
    workflowContext?: {
        routingIntent?: string | null;
        summary?: string | null;
        planId?: string | null;
        planName?: string | null;
        parentPlan?: string | null;
        classification?: string | null;
        status?: string | null;
        progressFacts?: readonly WorkflowProgressFact[];
        validationProgress?: LiveValidationProgress;
        liveQuestion?: boolean;
        livePlanReview?: boolean;
        liveCodeReview?: boolean;
        canReopenPlanReview?: boolean;
        canRun?: boolean;
        canResume?: boolean;
        canRecover?: boolean;
        liveReviewUrl?: string | null;
    } | null;
    activeExecutionWorkflow?: {
        planName?: string | null;
        triageMeta?: {
            planId?: string | null;
            parentPlan?: string | null;
            classification?: string | null;
            routingIntent?: string | null;
            complexity?: string | null;
            status?: string | null;
            validationPhase?: "mechanical" | "semantic" | "delivery";
        } | null;
        validationContinuation?: boolean;
        validationRepairGeneration?: string | null;
    } | null;
    managed?: { generation?: number | null } | null;
    sessionStats?: {
        userMessages: number;
        assistantMessages: number;
        toolCalls: number;
        compactionCount: number;
    } | null;
    queuedMessages?: readonly { id?: string }[];
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
    systemContextTokens?: number | null;
    artifacts?: SessionArtifactReference[];
}

export function tuiSessionSidebarProjection(snapshot: TuiSessionSidebarSnapshot): SessionSidebarProjection {
    const savedProgress = snapshot.workflowContext?.validationProgress;
    const progress: LiveValidationProgress | null | undefined = savedProgress?.outcome === "running" &&
            snapshot.busy === false && !snapshot.workflowContext?.liveCodeReview &&
            !snapshot.workflowContext?.livePlanReview
        ? {
            ...savedProgress,
            outcome: "paused",
            message: "Work is paused. Resume from the saved checkpoint.",
            checks: {
                ci: savedProgress.checks.ci === "running" ? "canceled" : savedProgress.checks.ci,
                semanticReview: savedProgress.checks.semanticReview === "running"
                    ? "canceled"
                    : savedProgress.checks.semanticReview,
                humanReview: savedProgress.checks.humanReview === "running"
                    ? "canceled"
                    : savedProgress.checks.humanReview,
                merge: savedProgress.checks.merge === "running" ? "canceled" : savedProgress.checks.merge,
            },
        }
        : savedProgress || snapshot.validationProgress;
    const activeWorkflow = snapshot.activeExecutionWorkflow;
    const plan = activeWorkflow?.planName || snapshot.workflowContext?.planName || snapshot.workflowContext?.planId ||
        "";
    const epic = activeWorkflow?.planName
        ? activeWorkflow.triageMeta?.parentPlan || ""
        : snapshot.workflowContext?.parentPlan || "";
    const projection = buildSessionSidebarProjection({
        sessionName: snapshot.name,
        sessionState: snapshot.busy ? "active" : "idle",
        activeSurface: "tui",
        activeAgent: snapshot.activeAgent,
        activeModel: snapshot.activeModel?.model,
        thinkingLevel: snapshot.thinkingLevel,
        generation: snapshot.managed?.generation,
        userMessages: snapshot.sessionStats?.userMessages,
        assistantMessages: snapshot.sessionStats?.assistantMessages,
        toolCalls: snapshot.sessionStats?.toolCalls,
        compactionCount: snapshot.sessionStats?.compactionCount,
        queuedMessages: snapshot.queuedMessages?.length,
        contextUsedTokens: snapshot.contextUsage?.tokens,
        contextWindowTokens: snapshot.contextUsage?.contextWindow,
        contextPercent: snapshot.contextUsage?.percent,
        systemContextTokens: snapshot.systemContextTokens,
        workflowPlan: plan,
        workflowEpic: epic,
        workflowIntent: snapshot.workflowContext?.routingIntent,
        workflowStatus: activeWorkflow?.triageMeta?.status || snapshot.workflowContext?.status,
        workflowValidationPhase: activeWorkflow?.triageMeta?.validationPhase,
        workflowClassification: activeWorkflow?.triageMeta?.classification || snapshot.workflowContext?.classification,
        workflowProgressFacts: snapshot.workflowContext?.progressFacts?.map((fact) => ({ ...fact })),
        workflowLiveValidationProgress: progress,
        workflowSessionState: snapshot.busy ? "active" : "idle",
        workflowHasWorkingSession: Boolean(plan),
        workflowHasLiveQuestion: snapshot.workflowContext?.liveQuestion,
        workflowHasPlanReview: snapshot.workflowContext?.livePlanReview,
        workflowHasCodeReview: snapshot.workflowContext?.liveCodeReview,
        workflowCanRun: snapshot.workflowContext?.canRun,
        workflowCanResume: snapshot.workflowContext?.canResume,
        workflowCanRecover: snapshot.workflowContext?.canRecover,
        artifacts: snapshot.artifacts,
    });
    if (
        !snapshot.busy && !snapshot.workflowContext?.liveQuestion && snapshot.workflowContext?.canReopenPlanReview &&
        ["draft", "feedback", "approved", "ready_for_work"].includes(snapshot.workflowContext.status || "draft")
    ) {
        projection.workflow.action = {
            kind: "review_plan",
            label: "Reopen Plan review",
            detail: "Reopen the saved Plan review.",
        };
    }
    const action = projection.workflow.action;
    if (
        action && (["answer_agent", "open_session", "open_plan", "resume_from_hold"].includes(action.kind) ||
            progress?.outcome === "verified")
    ) {
        projection.workflow.action = null;
    } else if (action?.kind === "review_plan") {
        action.label = snapshot.workflowContext?.livePlanReview ? "Open Plan review" : "Reopen Plan review";
    } else if (action?.kind === "review_code") {
        action.label = "Open Code Review";
    } else if (action?.kind === "resume" || action?.kind === "recover") {
        const stage = projection.workflow.currentStage?.id;
        action.label = stage === "code_review"
            ? "Reopen Code Review"
            : stage === "repair"
            ? "Resume repair"
            : ["mechanical", "semantic", "delivery"].includes(stage || "")
            ? "Resume validation"
            : "Resume implementation";
    }
    return projection;
}

function fit(text: string, width: number): string {
    const clipped = truncateToWidth(text, Math.max(0, width));
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function composePinnedSessionSidebar(
    mainLines: string[],
    sidebarLines: string[],
    mainWidth: number,
    terminalRows: number,
    bottomDockLines: string[] = [],
): string[] {
    const lineCount = Math.max(mainLines.length, sidebarLines.length);
    const bodyRows = Math.max(1, terminalRows - bottomDockLines.length);
    const viewportStart = Math.max(0, lineCount - bodyRows);
    const visibleSidebarLines = sidebarLines.slice(0, bodyRows);
    const bodyLines = Array.from({ length: lineCount }, (_, index) => {
        const sidebarLine = visibleSidebarLines[index - viewportStart] || "";
        return `${fit(mainLines[index] || "", mainWidth)} ${sidebarLine}`;
    });
    return [...bodyLines, ...bottomDockLines];
}

export function isSessionSidebarCycleKey(data: string): boolean {
    return !isKeyRelease(data) && !isKeyRepeat(data) && matchesKey(data, Key.ctrl("]"));
}

export function isSessionSidebarActionKey(data: string): boolean {
    return !isKeyRelease(data) && !isKeyRepeat(data) && matchesKey(data, Key.ctrl("enter"));
}

export function isSessionArtifactOpenKey(data: string): boolean {
    return !isKeyRelease(data) && !isKeyRepeat(data) && matchesKey(data, Key.alt("]"));
}

function field(label: string, value: string, width: number): string[] {
    return [theme.fg("dim", fit(label.toUpperCase(), width)), fit(value, width)];
}

export class TuiSessionSidebar {
    #activeTab: SessionSidebarTab = "session";
    #sessionKey = "";

    constructor(
        private readonly getSessionKey: () => string,
        private readonly getSnapshot: () => TuiSessionSidebarSnapshot | null,
    ) {}

    cycleTab(): void {
        const index = SESSION_SIDEBAR_TABS.indexOf(this.#activeTab);
        this.#activeTab = SESSION_SIDEBAR_TABS[(index + 1) % SESSION_SIDEBAR_TABS.length];
    }

    invalidate(): void {}

    currentAction(snapshotOverride?: TuiSessionSidebarSnapshot): SessionSidebarProjection["workflow"]["action"] {
        const snapshot = snapshotOverride || this.getSnapshot();
        if (!snapshot?.managed) return null;
        const projection = tuiSessionSidebarProjection(snapshot);
        const activeTab = this.getSessionKey() === this.#sessionKey ? this.#activeTab : projection.defaultTab;
        return activeTab === "workflow" ? projection.workflow.action : null;
    }

    render(width: number, snapshotOverride?: TuiSessionSidebarSnapshot): string[] {
        const snapshot = snapshotOverride || this.getSnapshot();
        if (!snapshot?.managed || width < 20) return [];
        const projection = tuiSessionSidebarProjection(snapshot);
        const sessionKey = this.getSessionKey();
        if (sessionKey !== this.#sessionKey) {
            this.#sessionKey = sessionKey;
            this.#activeTab = projection.defaultTab;
        }
        const inner = Math.max(1, width - 3);
        const tabLine = SESSION_SIDEBAR_TABS.map((tab) => {
            const label = tab[0].toUpperCase() + tab.slice(1);
            return tab === this.#activeTab ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
        }).join(" · ");
        const content = [tabLine, ""];
        if (this.#activeTab === "workflow") {
            if (projection.workflow.epic) {
                content.push(...field("Epic", projection.workflow.epic, inner));
                content.push("");
            }
            content.push(...field("Plan", projection.workflow.plan, inner));
            content.push("");
            content.push(...field("Workflow", projection.workflow.intent.replaceAll("_", " "), inner));
            if (projection.workflow.stages.length) {
                content.push("");
                for (const [index, stage] of projection.workflow.stages.entries()) {
                    const marker = stage.state === "blocked"
                        ? "!"
                        : stage.state === "paused"
                        ? "Ⅱ"
                        : stage.state === "completed"
                        ? "✓"
                        : stage.current
                        ? "●"
                        : "○";
                    const connector = index === 0 ? " " : "│";
                    content.push(fit(`${connector} ${marker} ${stage.label}`, inner));
                    if (stage.current) content.push(theme.fg("dim", fit(`│ ${stage.detail}`, inner)));
                }
                for (
                    const connection of projection.workflow.connections.filter((item) => item.kind === "repair_return")
                ) {
                    content.push(theme.fg("dim", fit(`└ ${connection.from} returns to ${connection.to}`, inner)));
                }
            }
            if (projection.workflow.blocker) {
                content.push("", ...field("Blocked by", projection.workflow.blocker, inner));
            }
            if (projection.workflow.action) {
                content.push("", theme.fg("accent", fit(projection.workflow.action.label, inner)));
                content.push(theme.fg("dim", fit("ctrl+enter", inner)));
            }
            if (!projection.workflow.active) {
                content.push("", theme.fg("dim", fit("No Plan workflow is active.", inner)));
            }
        } else if (this.#activeTab === "session") {
            sessionSidebarFields(projection.session).forEach((item, index) => {
                if (index > 0) content.push("");
                content.push(...field(item.label, item.value, inner));
                if (index !== 0) return;
                const routingIntent = snapshot.workflowContext?.routingIntent;
                if (routingIntent) content.push("", ...field("Triage type", routingIntent.replaceAll("_", " "), inner));
                const summary = snapshot.workflowContext?.summary?.trim();
                if (!summary) return;
                content.push("", theme.fg("dim", fit("TRIAGE SUMMARY", inner)));
                let line = "";
                for (const word of summary.split(/\s+/)) {
                    if (line && visibleWidth(`${line} ${word}`) > inner) {
                        content.push(fit(line, inner));
                        line = word;
                    } else line = line ? `${line} ${word}` : word;
                }
                if (line) content.push(fit(line, inner));
            });
        } else if (projection.artifacts.length === 0) {
            content.push(theme.fg("dim", fit("No declared artifacts yet.", inner)));
        } else {
            for (const artifact of projection.artifacts.slice(-8).reverse()) {
                content.push(theme.bold(fit(artifact.title, inner)));
                content.push(
                    theme.fg("dim", fit(`${sessionArtifactKindLabel(artifact.kind)} · ${artifact.path}`, inner)),
                );
                content.push("");
            }
        }
        content.push("", theme.fg("dim", fit("ctrl+] switch tab", inner)));
        if (this.#activeTab === "artifacts" && projection.artifacts.length > 0) {
            content.push(theme.fg("dim", fit("alt+] open artifact", inner)));
        }
        const border = theme.fg("dim", "│");
        return content.map((line) => `${border} ${fit(line, inner)}`);
    }
}
