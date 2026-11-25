import type { ProjectId } from "@runwield/projects";
import type { PlanFrontMatter } from "./document.ts";
import type { PlanId } from "./identity.ts";
import type { PlanEvent, PlanEventDetails } from "./lifecycle.ts";

export interface PlanAuthoringDefinition {
    title?: string;
    classification?: "PLANNED_CHANGE" | "PROJECT";
    type?: "epic" | "sequence";
    summary?: string;
    tickets?: PlanFrontMatter["tickets"];
    supersedes?: string[];
    workKind?: PlanFrontMatter["workKind"];
    complexity?: PlanFrontMatter["complexity"];
    affectedPaths?: string[];
    executionAgent?: PlanFrontMatter["executionAgent"];
    collaborationRecommendation?: PlanFrontMatter["collaborationRecommendation"];
    targetBranch?: string;
    order?: number;
    frontend?: boolean;
    devServerCommand?: string;
    devServerUrl?: string;
    devServerHmr?: boolean;
}

export interface CreateProjectPlan {
    planName: string;
    contextMarkdown: string;
    validationMarkdown?: string;
    definition?: PlanAuthoringDefinition;
    parentPlan?: string;
    dependencies?: string[];
}

export interface ReviseProjectPlan extends Omit<CreateProjectPlan, "planName"> {
    expectedRevision: string;
}

export interface ProjectPlanReadAvailability {
    kind: "ready" | "pending";
    message?: string;
}

export interface ProjectPlanDocument {
    name: string;
    planId: PlanId;
    /** Plan document label relative to the Project's logical Plan namespace. */
    relativePath: string;
    attrs: Omit<PlanFrontMatter, "worktreePath" | "archivedFromPath" | "restoredFromPath">;
    body: string;
    revision: string;
    readAvailability?: ProjectPlanReadAvailability;
}

/** A legacy display entry can lack a durable ID. */
export type ProjectPlanCatalogEntry = ProjectPlanDocument | (Omit<ProjectPlanDocument, "planId"> & { planId: "" });

export interface ProjectPlanDiagnostic {
    name: string;
    kind: "malformed" | "not_file" | "unreadable";
    message: string;
    planId?: PlanId;
}

export interface ProjectPlanCatalog {
    resources: ProjectPlanCatalogEntry[];
    diagnostics: ProjectPlanDiagnostic[];
}

export interface ArchiveProjectPlan {
    expectedRevision: string;
    reason?: string;
    force?: boolean;
}

export interface EditProjectPlan {
    body: string;
    expectedRevision: string;
}

export interface ApplyProjectPlanEvent {
    event: PlanEvent;
    expectedRevision: string;
    details?: Omit<PlanEventDetails, "triageMeta" | "now">;
}

/** Operations against a single admitted Project and its canonical Plan owner. */
export interface ProjectPlanStore {
    readonly projectId: ProjectId;
    list(): Promise<ProjectPlanCatalog>;
    read(planId: PlanId): Promise<ProjectPlanDocument>;
    readArchived(planId: PlanId): Promise<ProjectPlanDocument>;
    create(input: CreateProjectPlan): Promise<ProjectPlanDocument>;
    revise(planId: PlanId, input: ReviseProjectPlan): Promise<ProjectPlanDocument>;
    edit(planId: PlanId, edit: EditProjectPlan): Promise<ProjectPlanDocument>;
    applyEvent(planId: PlanId, request: ApplyProjectPlanEvent): Promise<ProjectPlanDocument>;
    archive(planId: PlanId, options: ArchiveProjectPlan): Promise<ProjectPlanDocument>;
    restore(planId: PlanId, expectedRevision: string): Promise<ProjectPlanDocument>;
}
