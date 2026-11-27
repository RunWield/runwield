import type { ProjectId, ProjectRegistry, ProjectStoreIdentity } from "@runwield/projects";
import type { PlanFrontMatter } from "./document.ts";
import type { EpicArtifactName } from "./format/artifacts.ts";
import type { PackageDocuments, PlanHistory } from "./history.ts";
import type { PlanId } from "@runwield/plan-storage-format";
import type { ProjectPublicationCopies } from "./publication-copies.ts";
import type { PlanEvent, PlanEventDetails } from "./lifecycle.ts";
import type { ProjectWorkRecord, WorkRecordFrontMatter } from "./work-records.ts";
export type { ProjectWorkRecord } from "./work-records.ts";

export type ProjectPlanStoreOptions = RegisteredProjectPlanOptions | AdmittedProjectPlanOptions;

interface RegisteredProjectPlanOptions {
    /** Trusted registration already opened by the application. */
    registry?: ProjectRegistry;
    admitted?: never;
}

interface AdmittedProjectPlanOptions {
    /** The checkout or owner already admitted by Projects. */
    admitted: ProjectStoreIdentity;
    registry?: never;
}

export interface CreateProjectWorkRecord extends Pick<
    WorkRecordFrontMatter,
    | "status"
    | "scope"
    | "workKind"
    | "origin"
    | "completionMode"
    | "tickets"
    | "supersedes"
    | "supersessionProposal"
    | "provenance"
> {
    body: string;
    createdAt?: string;
}

/** Work Records bound to the same Project and owner as the Plan Store. */
export interface ProjectWorkRecords {
    /** List all stored documents without creating storage. */
    list(): Promise<ProjectWorkRecord[]>;
    /** Read a case-insensitive ID, return null if missing, and reject duplicate IDs across all statuses. */
    read(recordId: string): Promise<ProjectWorkRecord | null>;
    /** Assign an ID and filename and return the persisted document. */
    create(input: CreateProjectWorkRecord): Promise<ProjectWorkRecord>;
}

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

export interface EditProjectPlanBody {
    body: string;
    expectedRevision: string;
}

export interface ApplyProjectPlanEvent {
    event: PlanEvent;
    expectedRevision: string;
    details?: Omit<PlanEventDetails, "triageMeta" | "now">;
}

export interface ProjectPlanHistory {
    list(planId: PlanId): Promise<PlanHistory>;
    read(planId: PlanId, version: string): Promise<PackageDocuments>;
    restore(planId: PlanId, version: string, expectedRevision: string): Promise<string>;
}

export interface ProjectPlanArtifact {
    planId: PlanId;
    name: EpicArtifactName;
    /** Logical reference to this resource inside the admitted Project. */
    relativePath: string;
    body: string;
    /** Revision used to guard the next save of this artifact. */
    revision: string;
}

export interface ManualQaSection {
    childHeading: string;
    checklistMarkdown: string;
}

export interface ManualQaSectionLookup {
    exists: boolean;
    relativePath: string;
}

export interface ManualQaSectionAppend {
    status: "recorded" | "already_present";
    relativePath: string;
}

export interface ProjectPlanArtifacts {
    /** Return null when the Epic exists and this optional artifact has not been created. */
    read(planId: PlanId, name: EpicArtifactName): Promise<ProjectPlanArtifact | null>;
    /** Save a generated artifact. A supplied revision must still match the owner's current artifact revision. */
    save(planId: PlanId, name: EpicArtifactName, body: string, expectedRevision?: string): Promise<ProjectPlanArtifact>;
    findManualQaSection(epicPlanId: PlanId, childPlanId: PlanId): Promise<ManualQaSectionLookup>;
    appendManualQaSection(
        epicPlanId: PlanId,
        childPlanId: PlanId,
        section: ManualQaSection,
    ): Promise<ManualQaSectionAppend>;
}

/** Operations against a single admitted Project and its canonical Plan owner. */
export interface ProjectPlanStore {
    readonly projectId: ProjectId;
    readonly history: ProjectPlanHistory;
    readonly artifacts: ProjectPlanArtifacts;
    readonly workRecords: ProjectWorkRecords;
    readonly publicationCopies: ProjectPublicationCopies;
    list(): Promise<ProjectPlanCatalog>;
    read(planId: PlanId): Promise<ProjectPlanDocument>;
    readArchived(planId: PlanId): Promise<ProjectPlanDocument>;
    create(input: CreateProjectPlan): Promise<ProjectPlanDocument>;
    revise(planId: PlanId, input: ReviseProjectPlan): Promise<ProjectPlanDocument>;
    editBody(planId: PlanId, input: EditProjectPlanBody): Promise<ProjectPlanDocument>;
    applyEvent(planId: PlanId, request: ApplyProjectPlanEvent): Promise<ProjectPlanDocument>;
    archive(planId: PlanId, options: ArchiveProjectPlan): Promise<ProjectPlanDocument>;
    restore(planId: PlanId, expectedRevision: string): Promise<ProjectPlanDocument>;
}

export { StalePlanWriteError } from "./store-errors.ts";
export type {
    PackageAttemptContinuation,
    PackagePublicationManifest,
    PackageWorkflowInput,
    PreparedPlanImport,
} from "./package-storage.ts";
