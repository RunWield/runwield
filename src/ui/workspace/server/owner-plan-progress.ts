import type { ProjectRegistry } from "@runwield/projects";
import { openWorkflow, type WorkflowProgress } from "@runwield/workflow";
import type { PlanReadAvailability } from "../../../plan-store/index.ts";
import { openRegisteredPlanDocuments } from "../../../plan-store/index.ts";
import type { ValidationCheckpointPhase } from "@runwield/plans/controller-state";
import { getRunWieldSessionDir } from "../../../shared/session/root-session.ts";
import { projectAggregateTranscript } from "../../../shared/session/session-transcript-manifest.ts";
import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";
import { validationStageLabel } from "../../../shared/workflow/validation-progress-presentation.ts";
import {
    buildWorkflowPresentation,
    type WorkflowProgressFact,
} from "../../../shared/workflow/workflow-presentation.ts";

export type ProgressOverallState =
    "waiting" | "running" | "repairing" | "paused" | "needs_attention" | "delivering" | "completed" | "degraded";

export type ProgressStageState =
    | "pending"
    | "running"
    | "passed"
    | "needs_attention"
    | "paused"
    | "failed"
    | "not_required"
    | "completed"
    | "unknown";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type PlanAttrs = { [key: string]: JsonValue | undefined };
type PlanEvidence = {
    planName: string;
    planId: string;
    attrs: PlanAttrs;
    body: string;
    markdown: string;
    readAvailability?: PlanReadAvailability;
};
type OwnerSession = {
    runwieldSessionId: string;
    projectId: string;
    displayName?: string | null;
    transcriptCwd: string;
};
type OwnerStore = {
    projects: ProjectRegistry;
    getSessionById: (runwieldSessionId: string) => OwnerSession | null;
    inspectSessionActivation: (runwieldSessionId: string) => {
        activation?: { state?: string; ownerProcessKind?: string | null; activeAgentName?: string } | null;
        generation?: {
            generation: number;
            byteLength: number;
            terminalEntryId: string | null;
            digestHex: string;
            currentSegmentId: string | null;
        } | null;
    };
    listSessionTranscriptSegments: (runwieldSessionId: string) => Array<{
        segmentId: string;
        runwieldSessionId: string;
        projectId: string;
        piSessionId: string;
        transcriptPath: string;
        transcriptCwd: string;
        ordinal: number;
        kind: string;
        sealedAt: string | null;
        sealedByteLength: number | null;
        sealedDigestHex: string | null;
        sealedTerminalEntryId: string | null;
    }>;
};

type ProgressStage = {
    id:
        | "review"
        | "decomposition"
        | "child_work"
        | "execution"
        | "mechanical"
        | "semantic"
        | "repair"
        | "delivery"
        | "code_review"
        | "completion";
    label: string;
    state: ProgressStageState;
    detail: string;
    updatedAt: string | null;
};

type SafeSessionSegment = {
    ordinal: number;
    kind: string;
    label: string;
    sealed: boolean;
    current: boolean;
};

export type OwnerPlanProgress = {
    ok: boolean;
    readAvailability?: PlanReadAvailability;
    readOnly: true;
    projectId: string;
    plan: {
        planId: string;
        planName: string;
        title: string;
        status: string;
        validationPhase?: ValidationCheckpointPhase;
        classification: string;
        executionAgent: string | null;
        updatedAt: string | null;
    };
    overall: {
        state: ProgressOverallState;
        label: string;
        detail: string;
        updatedAt: string | null;
        settled: boolean;
    };
    stages: ProgressStage[];
    progressFacts?: WorkflowProgressFact[];
    session: {
        runwieldSessionId: string;
        displayName: string;
        state: string;
        activeSurface: string | null;
        activeAgent: string | null;
        projectionState: "ok" | "degraded" | "omitted";
        segments: SafeSessionSegment[];
        progressUrl: string;
    } | null;
    degraded: { code: string; message: string } | null;
    sessionHref?: string;
    interactionHref?: string;
    reviewHref?: string;
    reviewKind?: string;
    continueUrl?: string;
    planWorkflowUrl?: string;
    recoveryUrl?: string;
    canRecover?: boolean;
    canResume?: boolean;
    canRun?: boolean;
    expectedGeneration?: number | null;
    expectedCurrentSegmentId?: string | null;
};

function text(value: JsonValue | undefined, fallback = "") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function savedValidationPhase(attrs: PlanAttrs): ValidationCheckpointPhase | undefined {
    const phase = attrs.validationPhase;
    return phase === "mechanical" || phase === "semantic" || phase === "delivery" ? phase : undefined;
}

function planTitle(evidence: PlanEvidence) {
    const heading = evidence.body.split("\n").find((line) => line.startsWith("# "));
    return heading ? heading.replace(/^#\s+/, "").trim() : evidence.planName;
}

function normalizeSegmentKind(kind: string) {
    if (kind === "planning" || kind === "execution" || kind === "semantic_repair") return kind;
    return "session";
}

function segmentLabel(kind: string, ordinal: number) {
    if (kind === "planning") return `Planning segment ${ordinal + 1}`;
    if (kind === "execution") return `Execution segment ${ordinal + 1}`;
    if (kind === "semantic_repair") return `AI review repair segment ${ordinal + 1}`;
    return `Session segment ${ordinal + 1}`;
}

function stage(
    id: ProgressStage["id"],
    label: string,
    state: ProgressStageState,
    detail: string,
    updatedAt: string | null,
): ProgressStage {
    return { id, label, state, detail, updatedAt };
}

function toProgressStageState(id: string, state: string): ProgressStageState {
    if (state === "completed") return id === "completion" ? "completed" : "passed";
    if (state === "current") return "running";
    if (state === "blocked") return "needs_attention";
    if (state === "paused") return "paused";
    if (state === "skipped") return "not_required";
    if (state === "unavailable") return "unknown";
    return "pending";
}

function progressFromSharedPresentation(evidence: PlanEvidence, workflow: WorkflowProgress, published: boolean) {
    const status = published ? "verified" : text(evidence.attrs.status, "draft");
    const updatedAt =
        text(evidence.attrs.updatedAt) || text(evidence.attrs.verifiedAt) || workflow.registryUpdatedAt || null;
    const facts = workflow.facts;
    const presentation = buildWorkflowPresentation({
        planName: evidence.planName,
        classification: text(evidence.attrs.classification, "PLANNED_CHANGE"),
        projectPlanType: text(evidence.attrs.type),
        status,
        validationPhase: savedValidationPhase(evidence.attrs),
        progressFacts: facts,
    });
    const stages = presentation.stages.map((item) =>
        stage(
            item.id as ProgressStage["id"],
            item.id === "mechanical"
                ? validationStageLabel("ci")
                : item.id === "semantic"
                  ? validationStageLabel("semantic_review")
                  : item.label,
            toProgressStageState(item.id, item.state),
            item.detail,
            updatedAt,
        ),
    );
    if (published) {
        const delivery = stages.find((item) => item.id === "delivery");
        if (delivery) delivery.state = "completed";
    }
    const priority =
        stages.find((item) => ["failed", "needs_attention", "paused", "running"].includes(item.state)) || stages.at(-1);
    const overallState: ProgressOverallState =
        priority?.state === "failed" || priority?.state === "needs_attention"
            ? "needs_attention"
            : priority?.state === "paused"
              ? "paused"
              : priority?.id === "repair" && priority?.state === "running"
                ? "repairing"
                : priority?.id === "delivery" && priority?.state === "running"
                  ? "delivering"
                  : stages.at(-1)?.state === "completed"
                    ? "completed"
                    : priority?.state === "running"
                      ? "running"
                      : "waiting";
    return { stages, overallState, updatedAt, progressFacts: facts };
}

function degraded(projectId: string, plan: PlanEvidence, code: string, message: string): OwnerPlanProgress {
    const updatedAt = text(plan.attrs.updatedAt) || null;
    return {
        ok: false,
        readAvailability: plan.readAvailability,
        readOnly: true,
        projectId,
        plan: {
            planId: plan.planId,
            planName: plan.planName,
            title: planTitle(plan),
            status: text(plan.attrs.status, "draft"),
            classification: text(plan.attrs.classification, "PLANNED_CHANGE"),
            executionAgent: text(plan.attrs.executionAgent) || null,
            updatedAt,
        },
        overall: { state: "degraded", label: "Progress needs attention", detail: message, updatedAt, settled: true },
        stages: [stage("execution", "Execution", "unknown", "Evidence is degraded.", updatedAt)],
        progressFacts: [],
        session: null,
        degraded: { code, message },
    };
}

async function sessionProjection(store: OwnerStore, projectId: string, planId: string, runwieldSessionId: string) {
    if (!runwieldSessionId) return null;
    const session = store.getSessionById(runwieldSessionId);
    if (!session || !sessionBelongsToOwnerProject(store, session, projectId)) throw new Error("Session not found.");
    const inspected = store.inspectSessionActivation(runwieldSessionId);
    const generation = inspected.generation;
    let segments: SafeSessionSegment[] = [];
    let projectionState: "ok" | "degraded" | "omitted" = "omitted";
    if (generation) {
        const projection = await projectAggregateTranscript({
            cwd: session.transcriptCwd,
            sessionDir: getRunWieldSessionDir(session.transcriptCwd),
            runwieldSessionId,
            generation,
            segments: store.listSessionTranscriptSegments(runwieldSessionId),
        });
        projectionState = projection.ok ? "ok" : "degraded";
        if (projection.ok) {
            const currentOrdinal = projection.segments.find((segment) => segment.current)?.ordinal;
            segments = projection.segments.map((segment) => {
                const kind = normalizeSegmentKind(segment.kind);
                return {
                    ordinal: segment.ordinal,
                    kind,
                    label: segmentLabel(kind, segment.ordinal),
                    sealed: segment.sealed,
                    current: segment.ordinal === currentOrdinal,
                };
            });
        }
    }
    const activation = inspected.activation;
    return {
        runwieldSessionId,
        displayName: session.displayName || "Session",
        state: activation?.state || "idle",
        activeSurface: activation?.state === "active" ? activation.ownerProcessKind || null : null,
        activeAgent: activation?.activeAgentName || null,
        projectionState,
        segments,
        progressUrl: `/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}?session=${encodeURIComponent(
            runwieldSessionId,
        )}`,
    };
}

interface OwnerPlanProgressOptions {
    projectId: string;
    planId: string;
    runwieldSessionId?: string | null;
}

export async function loadOwnerPlanProgress(
    store: OwnerStore,
    options: OwnerPlanProgressOptions,
): Promise<OwnerPlanProgress> {
    const resource = await openRegisteredPlanDocuments(options.projectId, store.projects).byId(options.planId);
    const primary = resource as PlanEvidence;
    if (primary.readAvailability?.kind === "pending") {
        return degraded(
            options.projectId,
            primary,
            "workflow_details_pending",
            primary.readAvailability.message || "Workflow details pending. Load this Plan to prepare its workflow.",
        );
    }
    const authoritative = primary;
    let workflow: WorkflowProgress;
    try {
        const current = await openWorkflow({
            cwd: requireOwnerProjectRoot(store, options.projectId),
            planName: primary.planName,
            planId: primary.planId,
        }).readProgress();
        if (!current) throw new Error("The Workflow Plan is unavailable.");
        workflow = current;
    } catch (error) {
        return degraded(
            options.projectId,
            primary,
            "progress_evidence_degraded",
            error instanceof Error ? error.message : String(error),
        );
    }

    const published = workflow.publication === "confirmed";
    const publicationUnconfirmed = workflow.publication === "unconfirmed";
    const publicationNotice = "Publication is unconfirmed. No applicable saved publication receipt is available.";
    // A raw terminal label is not publication proof. Document bytes keep that label;
    // progress projects unfinished delivery until the lifecycle owner confirms publication.
    const progressEvidence =
        publicationUnconfirmed && authoritative.attrs.status === "verified"
            ? { ...authoritative, attrs: { ...authoritative.attrs, status: "reviewed", validationPhase: "delivery" } }
            : authoritative;
    const derived = progressFromSharedPresentation(progressEvidence, workflow, published);
    if (publicationUnconfirmed) {
        derived.overallState = "delivering";
        const completion = derived.stages.find((item) => item.id === "completion");
        if (completion) completion.state = "pending";
        const deliveryStage = derived.stages.find((item) => item.id === "delivery");
        if (deliveryStage) {
            deliveryStage.detail = publicationNotice;
            deliveryStage.state = "unknown";
        }
    }
    const session = await sessionProjection(store, options.projectId, primary.planId, options.runwieldSessionId || "");
    const settled =
        derived.overallState === "completed" ||
        derived.overallState === "needs_attention" ||
        derived.overallState === "paused";
    return {
        ok: true,
        readAvailability: authoritative.readAvailability,
        readOnly: true,
        projectId: options.projectId,
        plan: {
            planId: primary.planId,
            planName: primary.planName,
            title: planTitle(authoritative),
            status: published ? "verified" : text(progressEvidence.attrs.status, "draft"),
            validationPhase: savedValidationPhase(progressEvidence.attrs),
            classification: text(primary.attrs.classification, "PLANNED_CHANGE"),
            executionAgent: text(primary.attrs.executionAgent) || null,
            updatedAt: derived.updatedAt,
        },
        overall: {
            state: derived.overallState,
            label: derived.overallState.replaceAll("_", " "),
            detail: publicationUnconfirmed
                ? publicationNotice
                : derived.stages.find((item) => ["running", "needs_attention", "paused", "failed"].includes(item.state))
                      ?.detail || "Progress is available.",
            updatedAt: derived.updatedAt,
            settled,
        },
        stages: derived.stages,
        progressFacts: derived.progressFacts,
        session,
        degraded: null,
    };
}
