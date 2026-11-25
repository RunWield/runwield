import type { ReviewLedger } from "@runwield/plans/controller-state";
import type { PlanAccess, PackageWorkflowInput } from "../../src/plan-store/index.ts";
import type { PlanFrontMatter } from "@runwield/plans";
import type { PlanClassification } from "@runwield/plans/format";
import type { WorkKind } from "@runwield/tools";

export interface TriageMeta extends Partial<PlanFrontMatter> {
    classification?: PlanClassification;
    workKind?: WorkKind;
    complexity?: "LOW" | "MEDIUM" | "HIGH";
}

export interface ActiveExecutionWorkflow {
    planName: string;
    packageSelection?: PlanAccess;
    packageInput?: PackageWorkflowInput;
    packageAttemptId?: string;
    triageMeta: TriageMeta;
    executionAgent: "engineer" | "frontend-engineer";
    executionStarted?: boolean;
    executionAttemptStartedAtMs?: number;
    collaborationStyle?: "autonomous" | "pair";
    collaborationRecommendation?: "autonomous" | "pair";
    pairCheckpointCount?: number;
    pairSwitchedToAutonomous?: boolean;
    pairCapabilityLost?: boolean;
    pairPauseReason?: "stop" | "canceled";
    pairStopRequested?: boolean;
    executionMode?: "worktree" | "non_git_in_place";
    baselineTree?: string;
    projectRoot?: string;
    executionCwd?: string;
    worktreeId?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    worktreeBaseRef?: string;
    worktreeBaseCommit?: string;
    nonGitInPlace?: boolean;
    validationContinuation?: boolean;
    validationGeneration?: string;
    validationRepairGeneration?: string;
    manualQaName?: string;
    manualQaContext?: string;
    semanticRound?: number;
    reviewLedger?: ReviewLedger;
    repairBaselineTree?: string;
    lastRepairReport?: string;
    humanReviewCycle?: number;
}
