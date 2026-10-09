/** @module ui/workspace/server/owner-dashboard */

import { isSequencePlan } from "../../../plan-store.js";
import { findByPlanId, findByPlanIds, type WorktreeRegistryEntry } from "../../../shared/worktree-registry.js";
import { loadPlanActionEvidence } from "../../../shared/workflow/plan-actions.ts";
import { loadPlanSummaries } from "./plan-adapter.js";
import type { OwnerProjectHealth, OwnerProjectRecord, OwnerProjectView } from "./owner-projects.ts";
import { requireOwnerProjectRoot, serializeOwnerProject } from "./owner-projects.ts";
import { readLiveSessionConnection } from "../../../shared/session/live-session-connection.ts";
import { withProjectRuntimeReadScope } from "../../../shared/project-runtime-layout.ts";

type DashboardCategory = "needs-you" | "ready" | "in-progress" | "recently-finished";

type PlanAttrs = {
    status?: string;
    classification?: string;
    type?: string;
    summary?: string;
    updatedAt?: string;
    implementedAt?: string;
    validatedAt?: string;
    userVerifiedAt?: string;
    closedWithoutVerificationAt?: string;
    epicDoneEnoughAt?: string;
    verifiedAt?: string;
    executionMode?: string;
    deliveryEvidence?: { mode?: string };
    validationCheckpoint?: { state?: string; nextPhase?: string; updatedAt?: string } | null;
    humanReviewMode?: string;
    humanReviewDecision?: string;
    failedAt?: string;
    failureReason?: string;
};

type OwnerPlan = {
    planId: string;
    title?: string;
    name?: string;
    planName?: string;
    status?: string;
    statusLabel?: string;
    summary?: string;
    attrs?: PlanAttrs;
};

type OwnerProject = OwnerProjectRecord & {
    healthStatus?: string;
    healthEvidence?: string[];
    enabled?: boolean;
};

type Diagnostic = { source: string; message: string; repairHref: string; repairLabel: string };

type DashboardItem = {
    type: "plan" | "session" | "project";
    category: DashboardCategory;
    projectId: string;
    projectName: string;
    planId: string;
    title: string;
    statusLabel: string;
    actionLabel: string;
    summary: string;
    href: string;
    recentAt: string;
    updatedAt: string;
};

type DashboardSection = { key: DashboardCategory; label: string; items: DashboardItem[] };

type SessionSummary = {
    runwieldSessionId?: string;
    displayName?: string;
    name?: string;
    href?: string;
    state?: string;
    headerTimestamp?: string;
    archivedAt?: string | null;
};

type SidebarPlan = {
    planId: string;
    title: string;
    status: string;
    statusLabel: string;
    href: string;
    muted: boolean;
    sessions: SessionSummary[];
    hasMoreSessions: boolean;
};

type SidebarProject = OwnerProjectView & {
    plans: SidebarPlan[];
    sessions: SessionSummary[];
    hasMorePlans: boolean;
    hasMoreSessions: boolean;
    diagnostics: Diagnostic[];
    dashboardPlans?: OwnerPlan[];
    dashboardSessions?: DashboardItem[];
    activeEvidenceByPlan?: Map<string, ClassificationEvidence>;
    registryByPlan?: Map<string, WorktreeRegistryEntry | null>;
    root?: string;
};

type OwnerStore = {
    listProjects(): OwnerProject[];
    getProjectHealth(projectId: string): OwnerProjectHealth;
    requireEnabledProjectRoot(projectId: string): string;
    listSessionPlanAssociations?: (runwieldSessionId: string, projectId?: string) => Array<{
        planId?: string;
        committedGeneration?: number | null;
    }>;
    inspectSessionActivation?: (runwieldSessionId: string) => {
        activation?: {
            state?: string;
            operationId?: string | null;
            updatedAt?: string;
        } | null;
    };
};

type InteractionPlanReference = { planId?: string; planName?: string; title?: string };
type DashboardInteractionRequest = {
    prompt?: string;
    type?: string;
    planReview?: InteractionPlanReference;
    codeReview?: InteractionPlanReference;
    _meta?: InteractionPlanReference;
};

type WorkspaceOperation = {
    projectId?: string;
    runwieldSessionId?: string;
    status?: string;
    liveInteraction?: { interactionId?: string; request?: DashboardInteractionRequest };
    error?: string;
    remote?: boolean;
    events?: Array<{ timestamp: string }>;
};

type SessionContinuation = {
    operations?: Map<string, WorkspaceOperation>;
    listSessions(
        projectId: string,
        options: { page: number; pageSize: number; includeTotal?: boolean; archiveState?: "all" },
    ): Promise<{
        sessions?: SessionSummary[];
        hasNext?: boolean;
        diagnostics?: Array<{ code?: string; message?: string; source?: string }>;
    }>;
};

const CATEGORY_ORDER: DashboardCategory[] = ["needs-you", "ready", "in-progress", "recently-finished"];

const CATEGORY_LABELS: Record<DashboardCategory, string> = {
    "needs-you": "Needs You",
    ready: "Ready to Continue",
    "in-progress": "In Progress",
    "recently-finished": "Recently Finished",
};

const READY = new Set(["ready_for_work", "ready_for_decomposition"]);
const UNFINISHED_EXECUTION = new Set([
    "in_progress",
    "implemented",
    "validated_ci",
    "reviewed",
    "failed",
    "ci_failed",
    "review_failed",
    "blocked",
]);
const FINISHED = new Set(["verified", "user_verified", "closed_without_verification"]);
const TERMINAL = new Set([...FINISHED, "archived"]);
const STATUS_PRIORITY: Record<DashboardCategory, number> = {
    "needs-you": 0,
    ready: 1,
    "in-progress": 2,
    "recently-finished": 3,
};
const PUBLICATION_PHASE_ORDER = [
    "candidate_sealed",
    "artifacts_committed",
    "target_integrated",
    "target_published",
    "publication_verified",
    "cleanup_complete",
];

function safeText(value?: string | null): string {
    return String(value || "");
}

function scrubLocalPaths(value: string): string {
    return value
        .replace(/\b[A-Za-z]:[\\/][^\s"'`<>),;]*/g, "[local path]")
        .replace(/(^|[\s("'`=:])\/[A-Za-z0-9._~+\-/]+/g, "$1[local path]");
}

function diagnosticMessage(error: Error): string {
    const message = scrubLocalPaths(error.message || "Project reader failed.");
    return message === error.message ? message : "Project reader failed. Open Project settings to repair it.";
}

function planHref(projectId: string, planId: string): string {
    return `/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}?from=dashboard`;
}

function sessionHref(projectId: string, runwieldSessionId: string): string {
    return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(runwieldSessionId)}`;
}

function settingsHref(projectId: string): string {
    return `/projects/${encodeURIComponent(projectId)}/settings`;
}

function section(category: DashboardCategory): DashboardSection {
    return { key: category, label: CATEGORY_LABELS[category], items: [] };
}

function planStatus(plan: OwnerPlan): string {
    return safeText(plan.status || plan.attrs?.status).toLowerCase();
}

function planUpdatedAt(plan: OwnerPlan): string {
    const attrs = plan.attrs || {};
    return safeText(
        attrs.updatedAt || attrs.failedAt || attrs.implementedAt || attrs.validatedAt || attrs.verifiedAt ||
            attrs.userVerifiedAt || attrs.closedWithoutVerificationAt || attrs.epicDoneEnoughAt,
    );
}

function isDashboardEligible(plan: OwnerPlan): boolean {
    if (!safeText(plan.planId).trim()) return false;
    if (planStatus(plan) === "on_hold") return false;
    if (isSequencePlan(plan.attrs || {})) return false;
    return true;
}

function publicationPhaseAtLeast(entry: WorktreeRegistryEntry | null, phase: string): boolean {
    const current = safeText(entry?.publication?.phase);
    return PUBLICATION_PHASE_ORDER.indexOf(current) >= PUBLICATION_PHASE_ORDER.indexOf(phase);
}

function registryMatchesPlan(plan: OwnerPlan, registry: WorktreeRegistryEntry | null): boolean {
    return Boolean(
        registry?.publication && registry.publication.planId === plan.planId &&
            registry.publication.attemptId === registry.id,
    );
}

function completionTime(plan: OwnerPlan, registry: WorktreeRegistryEntry | null = null): string {
    const attrs = plan.attrs || {};
    const status = planStatus(plan);
    if (status === "user_verified") return safeText(attrs.userVerifiedAt);
    if (status === "closed_without_verification") return safeText(attrs.closedWithoutVerificationAt);
    if (attrs.classification === "PROJECT" && status === "validated") {
        return safeText(attrs.epicDoneEnoughAt || attrs.validatedAt);
    }
    if (status === "verified") {
        return safeText(registryMatchesPlan(plan, registry) ? registry?.publication?.verifiedAt : attrs.verifiedAt);
    }
    if (status === "validated" && attrs.verifiedAt) return safeText(attrs.verifiedAt);
    if (status === "validated" && attrs.deliveryEvidence?.mode === "non_git_in_place") {
        return safeText(attrs.verifiedAt || attrs.validatedAt);
    }
    if (
        status === "validated" && registryMatchesPlan(plan, registry) &&
        publicationPhaseAtLeast(registry, "publication_verified")
    ) {
        return safeText(registry?.publication?.verifiedAt || attrs.verifiedAt || attrs.validatedAt);
    }
    return "";
}

type ClassificationEvidence = {
    activeSession?: boolean;
    liveQuestion?: boolean;
    ready?: boolean;
    stopped?: boolean;
    attentionLabel?: string;
    attentionHref?: string;
    updatedAt?: string;
};

function classifyPlan(
    plan: OwnerPlan,
    registry: WorktreeRegistryEntry | null = null,
    evidence: ClassificationEvidence = {},
): DashboardCategory | null {
    if (!isDashboardEligible(plan)) return null;
    const status = planStatus(plan);
    if (evidence.liveQuestion) return "needs-you";
    if (completionTime(plan, registry)) return "recently-finished";
    if (READY.has(status) && evidence.ready) return "ready";
    if (evidence.activeSession) return "in-progress";
    if (evidence.stopped && UNFINISHED_EXECUTION.has(status)) return "needs-you";
    return null;
}

function dashboardItem(
    project: SidebarProject,
    plan: OwnerPlan,
    category: DashboardCategory,
    registry: WorktreeRegistryEntry | null = null,
    evidence: ClassificationEvidence = {},
): DashboardItem {
    return {
        type: "plan",
        category,
        projectId: project.projectId,
        projectName: project.displayName || "Project",
        planId: plan.planId,
        title: plan.title || plan.name || plan.planName || plan.planId,
        statusLabel: category === "needs-you"
            ? evidence.attentionLabel || "Agent stopped before completing the workflow"
            : plan.statusLabel || plan.status || plan.attrs?.status || "unknown",
        actionLabel: category === "needs-you"
            ? evidence.liveQuestion ? attentionAction(evidence.attentionLabel) : "Resume Session"
            : category === "ready"
            ? "View Plan"
            : category === "in-progress"
            ? "View progress"
            : "View outcome",
        summary: plan.summary || plan.attrs?.summary || "",
        href: category === "needs-you" && evidence.attentionHref
            ? evidence.attentionHref
            : planHref(project.projectId, plan.planId),
        recentAt: completionTime(plan, registry),
        updatedAt: latestTimestamp(
            planUpdatedAt(plan),
            evidence.updatedAt,
            registry?.updatedAt,
            completionTime(plan, registry),
        ),
    };
}

function latestTimestamp(...values: Array<string | undefined>): string {
    return values.filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || "";
}

function interactionLabel(operation: WorkspaceOperation): string {
    switch (operation.liveInteraction?.request?.type) {
        case "plan_review":
            return "Plan ready for review";
        case "code_review":
            return "Code ready for review";
        case "artifact_review":
            return "Artifact ready for review";
        default:
            return "Question waiting for you";
    }
}

function attentionAction(label?: string): string {
    if (label === "Plan ready for review") return "Review Plan";
    if (label === "Code ready for review") return "Review code";
    if (label === "Artifact ready for review") return "Review artifact";
    return "Answer question";
}

function interactionPlan(operation: WorkspaceOperation): InteractionPlanReference {
    const request = operation.liveInteraction?.request;
    return request?.planReview || request?.codeReview || request?._meta || {};
}

function operationItem(
    project: SidebarProject,
    operationId: string,
    operation: WorkspaceOperation,
    plan?: OwnerPlan,
    session?: SessionSummary,
): DashboardItem {
    const waiting = Boolean(operation.liveInteraction?.interactionId);
    const sessionId = safeText(operation.runwieldSessionId);
    return {
        type: "session",
        category: waiting ? "needs-you" : "in-progress",
        projectId: project.projectId,
        projectName: project.displayName || "Project",
        planId: plan?.planId || safeText(interactionPlan(operation).planId),
        title: plan?.title || plan?.name || plan?.planName || safeText(interactionPlan(operation).planName) ||
            session?.displayName || session?.name || "Untitled Session",
        statusLabel: waiting ? interactionLabel(operation) : "active Session",
        actionLabel: waiting ? attentionAction(interactionLabel(operation)) : "View Session",
        summary: operation.liveInteraction?.request?.prompt || operation.error || operationId,
        href: sessionId
            ? `${sessionHref(project.projectId, sessionId)}#interaction-${
                operation.liveInteraction?.interactionId || ""
            }`
            : "/",
        recentAt: "",
        updatedAt: latestTimestamp(...(operation.events || []).map((event) => event.timestamp)),
    };
}

function sidebarPlan(project: SidebarProject, plan: OwnerPlan, sessions: SessionSummary[]): SidebarPlan {
    const status = planStatus(plan);
    return {
        planId: plan.planId,
        title: plan.title || plan.name || plan.planName || plan.planId,
        status: plan.status || plan.attrs?.status || "unknown",
        statusLabel: plan.statusLabel || plan.status || plan.attrs?.status || "unknown",
        href: planHref(project.projectId, plan.planId),
        muted: status === "on_hold",
        sessions,
        hasMoreSessions: sessions.length > 2,
    };
}

function recentTime(item: DashboardItem): number {
    return Date.parse(item.recentAt || "") || 0;
}

function isRecent(item: DashboardItem, now = Date.now()): boolean {
    if (item.type !== "plan") return true;
    const time = recentTime(item);
    return time > 0 && now - time <= 7 * 24 * 60 * 60 * 1000;
}

function sessionSummary(projectId: string, session: SessionSummary): SessionSummary {
    const runwieldSessionId = safeText(session.runwieldSessionId);
    return {
        ...session,
        displayName: session.displayName || session.name || "Untitled Session",
        href: runwieldSessionId ? sessionHref(projectId, runwieldSessionId) : session.href,
        state: session.state || "idle",
    };
}

function operationPlanId(store: OwnerStore, projectId: string, operation: WorkspaceOperation): string {
    const reference = interactionPlan(operation);
    if (reference.planId) return reference.planId;
    const sessionId = safeText(operation.runwieldSessionId);
    if (!sessionId) return "";
    const associations = store.listSessionPlanAssociations?.(sessionId, projectId) || [];
    return safeText(associations.filter((association) => association.committedGeneration !== null).at(-1)?.planId);
}

async function registryFor(
    root: string,
    plan: OwnerPlan,
    diagnostics: Diagnostic[],
    projectId: string,
    onFailure: () => void,
): Promise<WorktreeRegistryEntry | null> {
    if (!safeText(plan.planId)) return null;
    try {
        return await findByPlanId(root, plan.planId);
    } catch (error) {
        onFailure();
        diagnostics.push({
            source: "registry-reader",
            message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
            repairHref: projectId ? settingsHref(projectId) : "/",
            repairLabel: "Open Project settings",
        });
        return null;
    }
}

async function projectPayload(
    store: OwnerStore,
    sessionContinuation: SessionContinuation,
    projectRecord: OwnerProject,
    publish: (item: DashboardItem) => void,
    setPending: (categories: DashboardCategory[]) => void,
    reportFailure: (categories: DashboardCategory[]) => void,
): Promise<SidebarProject> {
    const health = store.getProjectHealth(projectRecord.projectId);
    const project = serializeOwnerProject(projectRecord, health) as SidebarProject;
    const diagnostics: Diagnostic[] = [];
    let root = "";
    try {
        root = requireOwnerProjectRoot(store, project.projectId);
    } catch (error) {
        if (projectRecord.lifecycle === "enabled") {
            diagnostics.push({
                source: "project-reader",
                message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
                repairHref: settingsHref(project.projectId),
                repairLabel: "Open Project settings",
            });
            reportFailure(CATEGORY_ORDER);
        }
    }

    let plans: OwnerPlan[] = [];
    if (root) {
        try {
            plans = (await loadPlanSummaries(root)) as OwnerPlan[];
        } catch (error) {
            diagnostics.push({
                source: "plans-reader",
                message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
                repairHref: settingsHref(project.projectId),
                repairLabel: "Open Project settings",
            });
            reportFailure(CATEGORY_ORDER);
        }
    }

    let sessions: SessionSummary[] = [];
    let hasMoreSessions = false;
    try {
        const result = await sessionContinuation.listSessions(project.projectId, {
            page: 0,
            pageSize: 100,
            includeTotal: false,
            archiveState: "all",
        });
        sessions = (result.sessions || []).filter((session) => session.runwieldSessionId).map((session) =>
            sessionSummary(project.projectId, session)
        );
        for (const diagnostic of result.diagnostics || []) {
            diagnostics.push({
                source: safeText(diagnostic.source || diagnostic.code || "sessions-reader"),
                message: scrubLocalPaths(safeText(diagnostic.message || diagnostic.code || "Session reader failed.")),
                repairHref: settingsHref(project.projectId),
                repairLabel: "Open Project settings",
            });
            reportFailure(["needs-you", "in-progress", "recently-finished"]);
        }
        hasMoreSessions = result.hasNext === true;
    } catch (error) {
        diagnostics.push({
            source: "sessions-reader",
            message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
            repairHref: settingsHref(project.projectId),
            repairLabel: "Open Project settings",
        });
        reportFailure(["needs-you", "in-progress", "recently-finished"]);
    }

    const associatedSessionIds = new Set<string>();
    const associatedSessionsByPlan = new Map<string, SessionSummary[]>();
    const currentPlanBySession = new Map<string, string>();
    const planIds = new Set(plans.map((plan) => safeText(plan.planId)).filter(Boolean));
    for (const session of sessions) {
        if (!session.runwieldSessionId) continue;
        const associations = store.listSessionPlanAssociations?.(session.runwieldSessionId, project.projectId) || [];
        const currentPlanId = associations.filter((association) => association.committedGeneration !== null).at(-1)
            ?.planId;
        if (currentPlanId) currentPlanBySession.set(session.runwieldSessionId, currentPlanId);
        const committedPlanIds = new Set(
            associations.filter((association) =>
                association.committedGeneration !== null && association.planId && planIds.has(association.planId)
            ).map((association) => association.planId),
        );
        for (const planId of committedPlanIds) {
            if (!planId) continue;
            const matches = associatedSessionsByPlan.get(planId) || [];
            matches.push(session);
            associatedSessionsByPlan.set(planId, matches);
            associatedSessionIds.add(session.runwieldSessionId);
        }
    }

    const activeEvidenceByPlan = new Map<string, ClassificationEvidence>();
    const dashboardSessions: DashboardItem[] = [];
    const currentOperations = new Map(
        [...(sessionContinuation.operations?.entries() || [])].filter(([, operation]) =>
            operation.projectId === project.projectId && operation.status === "running" && !operation.remote
        ),
    );
    // Observe active TUI Sessions too; never infer a pending question from transcript history.
    const liveBySession = new Map(
        sessions.filter((session) => session.runwieldSessionId).map((session) => [
            session.runwieldSessionId!,
            (async () => {
                const sessionId = session.runwieldSessionId;
                if (!sessionId) return;
                const activation = store.inspectSessionActivation?.(sessionId).activation;
                const planId = currentPlanBySession.get(sessionId);
                if (planId && activation) {
                    const current = activeEvidenceByPlan.get(planId) || {};
                    activeEvidenceByPlan.set(planId, {
                        ...current,
                        activeSession: current.activeSession || activation.state === "active",
                        stopped: current.stopped || activation.state === "idle" || activation.state === "interrupted",
                        attentionHref: current.attentionHref || sessionHref(project.projectId, sessionId),
                        updatedAt: latestTimestamp(current.updatedAt, activation.updatedAt, session.headerTimestamp),
                    });
                }
                if (
                    activation?.state !== "active" || !activation.operationId ||
                    currentOperations.has(activation.operationId)
                ) return;
                try {
                    const live = await readLiveSessionConnection(sessionId, activation.operationId);
                    currentOperations.set(activation.operationId, {
                        projectId: project.projectId,
                        runwieldSessionId: sessionId,
                        status: "running",
                        events: live.events,
                        liveInteraction: live.interaction?.id
                            ? { interactionId: live.interaction.id, request: live.interaction }
                            : undefined,
                    });
                } catch {
                    // A turn can finish while its live socket is being observed. Retry on the next refresh.
                }
            })(),
        ]),
    );
    const allLive = Promise.all(liveBySession.values());
    // Resolve a Plan after only its own live connections (and any unassociated
    // Session that could identify it by name). Other live sockets remain independent.
    const liveForPlan = (plan: OwnerPlan) =>
        Promise.all(
            [...liveBySession].filter(([sessionId]) => {
                const linked = currentPlanBySession.get(sessionId);
                return !linked || linked === plan.planId;
            }).map(([, result]) => result),
        );
    const publishedStandalone = new Set<string>();
    const publishStandalone = () => {
        for (const [operationId, operation] of currentOperations) {
            if (operation.projectId !== project.projectId || operation.status !== "running") continue;
            const reference = interactionPlan(operation);
            const candidateId = operationPlanId(store, project.projectId, operation);
            const plan = plans.find((candidate) => candidate.planId === candidateId) ||
                plans.find((candidate) =>
                    reference.planName && [candidate.name, candidate.planName].includes(reference.planName)
                );
            const planId = plan?.planId;
            const session = sessions.find((candidate) => candidate.runwieldSessionId === operation.runwieldSessionId);
            if (planId && plan && isDashboardEligible(plan)) {
                const current = activeEvidenceByPlan.get(planId) || {};
                const waiting = Boolean(operation.liveInteraction?.interactionId);
                const item = operationItem(project, operationId, operation, plan, session);
                activeEvidenceByPlan.set(planId, {
                    ...current,
                    activeSession: true,
                    liveQuestion: current.liveQuestion || waiting,
                    attentionLabel: waiting ? interactionLabel(operation) : current.attentionLabel,
                    attentionHref: waiting ? item.href : current.attentionHref,
                    updatedAt: latestTimestamp(current.updatedAt, item.updatedAt),
                });
                continue;
            }
            const item = operationItem(project, operationId, operation, plan, session);
            if (publishedStandalone.has(operationId)) continue;
            publishedStandalone.add(operationId);
            dashboardSessions.push(item);
            publish(item);
        }
    };

    const plansForSidebar = plans.filter((plan) => {
        if (!safeText(plan.planId)) return false;
        if (TERMINAL.has(planStatus(plan))) return false;
        if (isSequencePlan(plan.attrs || {})) return false;
        return true;
    });
    associatedSessionIds.clear();
    for (const plan of plansForSidebar) {
        for (const session of associatedSessionsByPlan.get(plan.planId) || []) {
            if (session.runwieldSessionId) associatedSessionIds.add(session.runwieldSessionId);
        }
    }
    const standaloneSessions = sessions.filter((session) =>
        session.runwieldSessionId && !session.archivedAt && !associatedSessionIds.has(session.runwieldSessionId)
    );
    // A resolved live socket can publish its standalone Session without waiting for other sockets.
    for (const task of liveBySession.values()) task.then(publishStandalone);
    publishStandalone();
    const registries = new Map<string, WorktreeRegistryEntry | null>();
    const registryBatch = root
        ? findByPlanIds(root, plans.map((plan) => plan.planId)).catch(() => null)
        : Promise.resolve(null);
    // Each Plan settles after its own evidence, not after another Plan's readiness.
    const remaining = new Map<DashboardCategory, number>(CATEGORY_ORDER.map((category) => [category, 0]));
    const categoriesFor = (plan: OwnerPlan): DashboardCategory[] => {
        if (!isDashboardEligible(plan)) return [];
        const status = planStatus(plan);
        if (READY.has(status)) return ["needs-you", "ready", "in-progress"];
        if (FINISHED.has(status) || status === "validated") return ["needs-you", "in-progress", "recently-finished"];
        return ["needs-you", "in-progress"];
    };
    for (const plan of plans) {
        for (const category of categoriesFor(plan)) {
            remaining.set(category, (remaining.get(category) || 0) + 1);
        }
    }
    // A live Session can affect the attention and running cards even without a Plan.
    for (const category of ["needs-you", "in-progress"] as DashboardCategory[]) {
        remaining.set(category, (remaining.get(category) || 0) + 1);
    }
    const updatePending = () => setPending(CATEGORY_ORDER.filter((category) => (remaining.get(category) || 0) > 0));
    updatePending();
    const finish = (categories: DashboardCategory[]) => {
        for (const category of categories) remaining.set(category, (remaining.get(category) || 0) - 1);
        updatePending();
    };
    allLive.then(() => {
        publishStandalone();
        finish(["needs-you", "in-progress"]);
    });
    let nextPlan = 0;
    await Promise.all(Array.from({ length: Math.min(6, plans.length) }, async () => {
        while (nextPlan < plans.length) {
            const plan = plans[nextPlan++];
            const [, batch] = await Promise.all([liveForPlan(plan), registryBatch]);
            let ready = false;
            if (root && READY.has(planStatus(plan))) {
                try {
                    const result = await loadPlanActionEvidence(root, plan.planId);
                    if (result.kind === "success") ready = READY.has(result.evidence.status);
                    else {
                        diagnostics.push({
                            source: "readiness-reader",
                            message: result.message,
                            repairHref: settingsHref(project.projectId),
                            repairLabel: "Open Project settings",
                        });
                        reportFailure(["ready"]);
                    }
                } catch (error) {
                    diagnostics.push({
                        source: "readiness-reader",
                        message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
                        repairHref: settingsHref(project.projectId),
                        repairLabel: "Open Project settings",
                    });
                    reportFailure(["ready"]);
                }
            }
            const registry = batch
                ? batch.get(plan.planId) || null
                : root
                ? await registryFor(root, plan, diagnostics, project.projectId, () =>
                    reportFailure(categoriesFor(plan)))
                : null;
            registries.set(plan.planId, registry);
            const evidence = activeEvidenceByPlan.get(plan.planId) || {};
            for (const [operationId, operation] of currentOperations) {
                if (operation.projectId !== project.projectId || operation.status !== "running") continue;
                const reference = interactionPlan(operation);
                const candidateId = operationPlanId(store, project.projectId, operation);
                if (
                    candidateId !== plan.planId &&
                    !(reference.planName && [plan.name, plan.planName].includes(reference.planName))
                ) continue;
                const session = sessions.find((candidate) =>
                    candidate.runwieldSessionId === operation.runwieldSessionId
                );
                const item = operationItem(project, operationId, operation, plan, session);
                const waiting = Boolean(operation.liveInteraction?.interactionId);
                evidence.activeSession = true;
                evidence.liveQuestion = evidence.liveQuestion || waiting;
                evidence.attentionLabel = waiting ? interactionLabel(operation) : evidence.attentionLabel;
                evidence.attentionHref = waiting ? item.href : evidence.attentionHref;
                evidence.updatedAt = latestTimestamp(evidence.updatedAt, item.updatedAt);
            }
            if (ready) evidence.ready = true;
            activeEvidenceByPlan.set(plan.planId, evidence);
            const category = classifyPlan(plan, registry, evidence);
            if (category) publish(dashboardItem(project, plan, category, registry, evidence));
            finish(categoriesFor(plan));
        }
    }));
    await allLive;
    plansForSidebar.sort((left, right) => {
        const leftHold = planStatus(left) === "on_hold" ? 1 : 0;
        const rightHold = planStatus(right) === "on_hold" ? 1 : 0;
        if (leftHold !== rightHold) return leftHold - rightHold;
        const leftCategory =
            classifyPlan(left, registries.get(left.planId) || null, activeEvidenceByPlan.get(left.planId) || {}) ||
            "recently-finished";
        const rightCategory =
            classifyPlan(right, registries.get(right.planId) || null, activeEvidenceByPlan.get(right.planId) || {}) ||
            "recently-finished";
        return STATUS_PRIORITY[leftCategory] - STATUS_PRIORITY[rightCategory] ||
            (Date.parse(planUpdatedAt(right)) || 0) - (Date.parse(planUpdatedAt(left)) || 0) ||
            left.planId.localeCompare(right.planId);
    });
    return {
        ...project,
        root,
        plans: plansForSidebar.map((plan) =>
            sidebarPlan(project, plan, associatedSessionsByPlan.get(plan.planId) || [])
        ),
        hasMorePlans: plansForSidebar.length > 5,
        sessions: standaloneSessions.slice(0, 5),
        hasMoreSessions: hasMoreSessions || standaloneSessions.length > 5,
        diagnostics,
        dashboardPlans: plans,
        dashboardSessions,
        activeEvidenceByPlan,
        registryByPlan: registries,
    };
}

// Navigation reads only saved Plan and Session evidence. Dashboard classification,
// readiness checks and live connections must not delay the sidebar response.
export async function loadOwnerSidebar(
    store: OwnerStore,
    continuation: SessionContinuation,
): Promise<SidebarProject[]> {
    return await withProjectRuntimeReadScope(async () => {
        const records = store.listProjects();
        const projects: SidebarProject[] = new Array(records.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
            while (next < records.length) {
                const index = next++;
                const record = records[index];
                const project = serializeOwnerProject(
                    record,
                    store.getProjectHealth(record.projectId),
                ) as SidebarProject;
                const diagnostics: Diagnostic[] = [];
                let root = "";
                try {
                    root = requireOwnerProjectRoot(store, record.projectId);
                } catch (error) {
                    if (record.lifecycle === "enabled") {
                        diagnostics.push({
                            source: "project-reader",
                            message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
                            repairHref: settingsHref(record.projectId),
                            repairLabel: "Open Project settings",
                        });
                    }
                }
                const plansRead = (async (): Promise<OwnerPlan[]> => {
                    if (!root) return [];
                    try {
                        return (await loadPlanSummaries(root)) as OwnerPlan[];
                    } catch (error) {
                        diagnostics.push({
                            source: "plans-reader",
                            message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
                            repairHref: settingsHref(record.projectId),
                            repairLabel: "Open Project settings",
                        });
                        return [];
                    }
                })();
                const sessionsRead = (async () => {
                    try {
                        const result = await continuation.listSessions(record.projectId, {
                            page: 0,
                            pageSize: 100,
                            includeTotal: false,
                            archiveState: "all",
                        });
                        for (const diagnostic of result.diagnostics || []) {
                            diagnostics.push({
                                source: safeText(diagnostic.source || diagnostic.code || "sessions-reader"),
                                message: scrubLocalPaths(
                                    safeText(diagnostic.message || diagnostic.code || "Session reader failed."),
                                ),
                                repairHref: settingsHref(record.projectId),
                                repairLabel: "Open Project settings",
                            });
                        }
                        return {
                            sessions: (result.sessions || []).filter((session) => session.runwieldSessionId).map((
                                session,
                            ) => sessionSummary(record.projectId, session)),
                            hasMoreSessions: result.hasNext === true,
                        };
                    } catch (error) {
                        diagnostics.push({
                            source: "sessions-reader",
                            message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
                            repairHref: settingsHref(record.projectId),
                            repairLabel: "Open Project settings",
                        });
                        const sessions: SessionSummary[] = [];
                        return { sessions, hasMoreSessions: false };
                    }
                })();
                const [plans, { sessions, hasMoreSessions }] = await Promise.all([plansRead, sessionsRead]);
                const plansForSidebar = plans.filter((plan) =>
                    safeText(plan.planId) && !TERMINAL.has(planStatus(plan)) && !isSequencePlan(plan.attrs || {})
                );
                const associations = new Map<string, SessionSummary[]>();
                const associatedIds = new Set<string>();
                const planIds = new Set(plansForSidebar.map((plan) => plan.planId));
                const stateByPlan = new Map<string, { activeSession: boolean; stopped: boolean }>();
                for (const session of sessions) {
                    const id = session.runwieldSessionId!;
                    const committed = new Set(
                        (store.listSessionPlanAssociations?.(id, record.projectId) || [])
                            .filter((association) =>
                                association.committedGeneration !== null && planIds.has(association.planId || "")
                            )
                            .map((association) => association.planId!),
                    );
                    for (const planId of committed) {
                        const matches = associations.get(planId) || [];
                        matches.push(session);
                        associations.set(planId, matches);
                        associatedIds.add(id);
                        const state = stateByPlan.get(planId) || { activeSession: false, stopped: false };
                        state.activeSession ||= session.state === "active";
                        state.stopped ||= session.state === "idle" || session.state === "interrupted";
                        stateByPlan.set(planId, state);
                    }
                }
                plansForSidebar.sort((left, right) => {
                    const leftHold = planStatus(left) === "on_hold" ? 1 : 0;
                    const rightHold = planStatus(right) === "on_hold" ? 1 : 0;
                    const rank = (plan: OwnerPlan) =>
                        STATUS_PRIORITY[
                            classifyPlan(plan, null, {
                                ...stateByPlan.get(plan.planId),
                                ready: READY.has(planStatus(plan)),
                            }) || "recently-finished"
                        ];
                    return leftHold - rightHold || rank(left) - rank(right) ||
                        (Date.parse(planUpdatedAt(right)) || 0) - (Date.parse(planUpdatedAt(left)) || 0) ||
                        left.planId.localeCompare(right.planId);
                });
                const standalone = sessions.filter((session) =>
                    !session.archivedAt && !associatedIds.has(session.runwieldSessionId!)
                );
                projects[index] = {
                    ...project,
                    plans: plansForSidebar.map((plan) =>
                        sidebarPlan(project, plan, associations.get(plan.planId) || [])
                    ),
                    hasMorePlans: plansForSidebar.length > 5,
                    sessions: standalone.slice(0, 5),
                    hasMoreSessions: hasMoreSessions || standalone.length > 5,
                    diagnostics,
                };
            }
        }));
        return projects;
    });
}

type DashboardPayload = { projects: SidebarProject[]; dashboard: { sections: DashboardSection[] } };
type DashboardFrame = {
    type: "snapshot" | "complete" | "error";
    sections: DashboardSection[];
    progress: { completedProjects: number; totalProjects: number; pending: boolean };
    diagnostics: Diagnostic[];
    sectionProgress: Record<DashboardCategory, { pending: boolean; failed: boolean }>;
    error?: string;
};
type PendingRead = {
    promise: Promise<DashboardPayload>;
    listeners: Set<(frame: DashboardFrame) => void>;
    frame: DashboardFrame;
};

// The read and its listeners exist only until settlement; subsequent calls use fresh evidence.
const pendingDashboardReads = new WeakMap<OwnerStore, WeakMap<SessionContinuation, PendingRead>>();

function startDashboardRead(store: OwnerStore, continuation: SessionContinuation): PendingRead {
    let pending = pendingDashboardReads.get(store);
    if (!pending) {
        pending = new WeakMap();
        pendingDashboardReads.set(store, pending);
    }
    const existing = pending.get(continuation);
    if (existing) return existing;
    const frame: DashboardFrame = {
        type: "snapshot",
        sections: CATEGORY_ORDER.map(section),
        progress: { completedProjects: 0, totalProjects: 0, pending: true },
        diagnostics: [],
        sectionProgress: Object.fromEntries(
            CATEGORY_ORDER.map((category) => [category, { pending: true, failed: false }]),
        ) as DashboardFrame["sectionProgress"],
    };
    const read: PendingRead = {
        frame,
        listeners: new Set(),
        promise: Promise.resolve({ projects: [], dashboard: { sections: [] } }),
    };
    const emit = (next: DashboardFrame) => {
        read.frame = next;
        for (const listener of read.listeners) {
            try {
                listener(next);
            } catch {
                read.listeners.delete(listener);
            }
        }
    };
    read.promise = withProjectRuntimeReadScope(() => readOwnerDashboard(store, continuation, emit))
        .then((payload) => {
            emit({ ...read.frame, type: "complete", progress: { ...read.frame.progress, pending: false } });
            return payload;
        }, (error: Error) => {
            emit({
                ...read.frame,
                type: "error",
                error: diagnosticMessage(error),
                progress: { ...read.frame.progress, pending: false },
            });
            throw error;
        }).finally(() => {
            pending.delete(continuation);
            read.listeners.clear();
        });
    pending.set(continuation, read);
    return read;
}

export function loadOwnerDashboard(store: OwnerStore, continuation: SessionContinuation): Promise<DashboardPayload> {
    return startDashboardRead(store, continuation).promise;
}

/** Subscribe to the latest verified snapshot and all subsequent frames. Unsubscribe on disconnect. */
export function subscribeOwnerDashboard(
    store: OwnerStore,
    continuation: SessionContinuation,
    listener: (frame: DashboardFrame) => void,
): () => void {
    const read = startDashboardRead(store, continuation);
    // Stream-only consumers observe the error frame, not the JSON Promise rejection.
    read.promise.catch(() => {});
    read.listeners.add(listener);
    listener(read.frame);
    return () => read.listeners.delete(listener);
}

async function readOwnerDashboard(
    store: OwnerStore,
    continuation: SessionContinuation,
    emit: (frame: DashboardFrame) => void,
): Promise<DashboardPayload> {
    const records = store.listProjects();
    const projects: SidebarProject[] = new Array(records.length);
    const items = new Map<string, DashboardItem>();
    let completedProjects = 0;
    const projectProgress = records.map(() => ({
        pending: new Set<DashboardCategory>(CATEGORY_ORDER),
        failed: new Set<DashboardCategory>(),
    }));
    const snapshot = (type: DashboardFrame["type"] = "snapshot") => {
        const sections = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, section(category)])) as Record<
            DashboardCategory,
            DashboardSection
        >;
        for (const item of items.values()) {
            if (item.category !== "recently-finished" || isRecent(item)) sections[item.category].items.push(item);
        }
        for (const value of Object.values(sections)) {
            value.items.sort((left, right) =>
                (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0) ||
                left.href.localeCompare(right.href)
            );
        }
        const diagnostics = projects.filter(Boolean).flatMap((project) => project.diagnostics);
        const frame = {
            type,
            sections: CATEGORY_ORDER.map((category) => sections[category]),
            progress: { completedProjects, totalProjects: records.length, pending: completedProjects < records.length },
            diagnostics,
            sectionProgress: Object.fromEntries(CATEGORY_ORDER.map((category) => [category, {
                pending: projectProgress.some((progress) => progress.pending.has(category)),
                failed: projectProgress.some((progress) => progress.failed.has(category)),
            }])) as DashboardFrame["sectionProgress"],
        };
        emit(frame);
        return frame;
    };
    snapshot();
    // A small worker pool bounds simultaneous Project readers without serializing independent Projects.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
        while (next < records.length) {
            const index = next++;
            const record = records[index];
            try {
                const project = await projectPayload(store, continuation, record, (item) => {
                    items.set(
                        `${item.projectId}:${item.type}:${item.type === "session" ? item.href : item.planId}`,
                        item,
                    );
                    snapshot();
                }, (categories) => {
                    projectProgress[index].pending = new Set(categories);
                    snapshot();
                }, (categories) => {
                    for (const category of categories) projectProgress[index].failed.add(category);
                    snapshot();
                });
                for (const diagnostic of project.diagnostics) {
                    const affected: DashboardCategory[] = diagnostic.source === "readiness-reader"
                        ? ["ready"]
                        : diagnostic.source === "sessions-reader"
                        ? ["needs-you", "in-progress", "recently-finished"]
                        : CATEGORY_ORDER;
                    for (const category of affected) projectProgress[index].failed.add(category);
                }
                delete project.dashboardPlans;
                delete project.dashboardSessions;
                delete project.activeEvidenceByPlan;
                delete project.registryByPlan;
                delete project.root;
                projects[index] = project;
            } catch (error) {
                projectProgress[index].failed = new Set(CATEGORY_ORDER);
                // Rows already verified within this Project remain available with an incomplete warning.
                projects[index] = {
                    projectId: record.projectId,
                    displayName: record.displayName || "Project",
                    rootLabel: "registered Project",
                    lifecycle: record.lifecycle || "enabled",
                    healthStatus: "unavailable",
                    healthEvidence: [],
                    enabled: false,
                    plans: [],
                    sessions: [],
                    hasMorePlans: false,
                    hasMoreSessions: false,
                    diagnostics: [{
                        source: "project-reader",
                        message: diagnosticMessage(error instanceof Error ? error : new Error(String(error))),
                        repairHref: settingsHref(record.projectId),
                        repairLabel: "Open Project settings",
                    }],
                } as SidebarProject;
            }
            projectProgress[index].pending.clear();
            completedProjects++;
            snapshot();
        }
    }));
    const final = snapshot();
    return { projects, dashboard: { sections: final.sections } };
}
