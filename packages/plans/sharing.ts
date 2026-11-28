import type { ProjectId } from "@runwield/projects";
import type { PlanId } from "@runwield/plan-storage-format";

/** The admitted Project and the Plan Server chosen by the client. */
export interface OpenPlanSharingOptions {
    projectId: ProjectId;
    serverUrl: string;
}

/** The remote binding recorded by the Plan owner after sharing. */
export interface SharedPlan {
    planName: string;
    planId: PlanId;
    serverUrl: string;
    spaceId: string;
    revision: number;
    expiresAt?: string;
    /** Secret links are available for shares that grant access through capabilities. */
    links?: SharedPlanLinks;
}

export interface SharedPlanLinks {
    reviewerUrl: string;
    maintainerUrl?: string;
}

/** Share an active saved Plan in the bound Project by its durable identity. */
export interface PlanSharing {
    /** Publish the Plan or return its existing binding on the selected server. */
    share(planId: PlanId): Promise<SharedPlan>;
}
