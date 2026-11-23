import type { FrontMatterValue } from "@runwield/parsing/front-matter";
import type { WorkKind } from "@runwield/tools";
import type { PlanClassification } from "./classification.ts";
import type { WorkflowControllerState, WorkflowWorktreeContext } from "./controller-state.ts";
import type { PlanDeviation } from "./format/plan-deviations.ts";
import type { TicketReference } from "./format/ticket-references.ts";

export type { NonGitDeliveryEvidence, WorktreeDeliveryEvidence } from "./controller-state.ts";

export type HumanReviewMode = Exclude<WorkflowControllerState["humanReviewMode"], undefined>;

export type HumanReviewDecision = Exclude<WorkflowControllerState["humanReviewDecision"], undefined>;

export type ExecutionMode = Exclude<WorkflowControllerState["executionMode"], undefined>;

export type DeliveryEvidence = Exclude<WorkflowControllerState["deliveryEvidence"], undefined>;

type PlanWorkRecordBacklink = {
    status?: "generated" | "failed";
    recordId?: string;
    path?: string;
    lastAttemptAt?: string;
    error?: string;
};

export type PlanDocumentMetadata = {
    title?: string;
    /** Durable project-scoped resource identity for URL/addressable Plan lookup */
    planId?: string;
    classification: PlanClassification;
    /** Optional nature of planned executable work. */
    workKind?: WorkKind;
    /** PROJECT capability: epic (default) or sequence. Invalid values remain visible for correction. */
    type?: string;
    complexity: "LOW" | "MEDIUM" | "HIGH";
    /** Files that will be created/modified */
    affectedPaths: string[];
    /** Optional provider-neutral Ticket References identified by the user. */
    tickets?: TicketReference[];
    /** Optional ordered Work Record IDs that this Plan is confirmed to replace. */
    supersedes?: string[];
    /** Ordered user-confirmed replacements to effective Plan requirements. */
    planDeviations?: PlanDeviation[];
    /** Canonical FEATURE execution owner, preserved raw when invalid for diagnostics */
    executionAgent?: FrontMatterValue;
    /** Planner's suggested execution style, preserved raw when invalid for diagnostics */
    collaborationRecommendation?: FrontMatterValue;
    /** Legacy browser UI/UX marker retained for source compatibility */
    frontend?: boolean;
    /** Project dev/preview command for browser verification, if known */
    devServerCommand?: string | null;
    /** Local URL expected for browser verification, if known */
    devServerUrl?: string | null;
    /** Whether the dev server is expected to support hot module reload */
    devServerHmr?: boolean | null;
    /** ISO timestamp */
    createdAt: string;
    status:
        | "draft"
        | "approved"
        | "ready_for_decomposition"
        | "ready_for_work"
        | "in_progress"
        | "failed"
        | "implemented"
        | "validated_ci"
        | "reviewed"
        | "validated"
        | "verified"
        | "user_verified"
        | "closed_without_verification"
        | "on_hold";
    /** "internal" = created by a RunWield agent; "external" = a pre-existing markdown file loaded from an arbitrary path and resumed with RunWield */
    origin?: "internal" | "external";
    /** Canonical parent plan name for child FEATURE plans */
    parentPlan?: string;
    /** Epic child FEATURE execution order. */
    order?: number;
    /** Sibling FEATURE plan identifiers that should be completed first */
    dependencies?: string[];
    /** ISO timestamp when the user attested verification outside Workflow Validation */
    userVerifiedAt?: string | null;
    /** Required note for user_verified terminal plans */
    userVerificationNote?: string | null;
    /** Required reason for new manual closed_without_verification transitions */
    closedWithoutVerificationReason?: string | null;
    /** ISO timestamp when the Plan was manually closed without verification */
    closedWithoutVerificationAt?: string | null;
    /** Neutral backlink to canonical Work Record generation state */
    workRecord?: PlanWorkRecordBacklink;
    /** Explicit Epic completion mode when an Epic is marked done enough for now */
    epicCompletionMode?: "done_enough" | null;
    /** ISO timestamp when an Epic was marked done enough for now */
    epicDoneEnoughAt?: string | null;
    /** Human-readable summary captured when an Epic was marked done enough for now */
    epicDoneEnoughSummary?: string | null;
    /** Final target of the reviewed Epic branch */
    epicDeliveryTargetBranch?: string | null;
    /** Primary-branch commit the Epic branch was created from; the integration gate diffs from it */
    epicBaseCommit?: string | null;
    /** Project-relative path of the latest failing Epic integration gate report */
    epicIntegrationReport?: string | null;
    /** Recorded landing branch, independent of setting changes */
    deliveryBranch?: string;
    /** User-selected target branch, independent of the current execution attempt */
    targetBranch?: string;
    /** Validated implementation commit; durable after runtime cleanup */
    validatedCommit?: string | null;
    /** Current Workflow Validation phase while status stays "implemented" */
    validationPhase?: "mechanical" | "semantic" | "delivery";
    /** Status captured before the Plan moved to on_hold */
    heldFromStatus?: PlanFrontMatter["status"] | null;
    /** ISO timestamp when the Plan was put on hold */
    heldAt?: string | null;
    /** Optional human reason for the hold */
    holdReason?: string | null;
    /** ISO timestamp when the Plan was physically moved to docs/plans/archived/ */
    archivedAt?: string | null;
    /** Optional human reason captured when the Plan was archived */
    archiveReason?: string | null;
    /** Durable lifecycle status captured before archival */
    archivedFromStatus?: PlanFrontMatter["status"] | null;
    /** Project-relative path the Plan occupied before archival */
    archivedFromPath?: string | null;
    /** ISO timestamp when the Plan was physically restored to active docs/plans/ */
    restoredAt?: string | null;
    /** Project-relative archived path restored from */
    restoredFromPath?: string | null;
};

export type PlanPresentationFields = {
    /** First paragraph of Context; not duplicated in Front Matter */
    summary: string;
};

export type PlanFrontMatter = PlanDocumentMetadata &
    PlanPresentationFields &
    WorkflowControllerState &
    WorkflowWorktreeContext;

type PlanFieldValue = FrontMatterValue | PlanFrontMatter[keyof PlanFrontMatter];

type RawPlanFields = Record<string, PlanFieldValue>;

export type PlanFrontMatterWithCustomFields = PlanFrontMatter & RawPlanFields;

export type PlanFrontMatterInput = Partial<PlanFrontMatter> & RawPlanFields;
