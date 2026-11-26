import type { WorktreeRegistryEntry } from "../../src/shared/worktree-registry.ts";
import type { PublicationAttempt } from "./publication-attempt.ts";

/** Current execution and publication facts for one Plan in a Project. */
export interface WorkflowActivity {
    attemptId: string;
    status: WorktreeRegistryEntry["status"];
    updatedAt: string;
    publication?: Pick<PublicationAttempt, "phase" | "updatedAt" | "verifiedAt" | "failure">;
}

export function projectWorkflowActivity(entry: WorktreeRegistryEntry, planId: string | undefined): WorkflowActivity {
    const record = entry.publication;
    const publication =
        record && record.planId === planId && record.attemptId === entry.id
            ? {
                  phase: record.phase,
                  updatedAt: record.updatedAt,
                  verifiedAt: record.verifiedAt,
                  failure: record.failure,
              }
            : undefined;
    return { attemptId: entry.id, status: entry.status, updatedAt: entry.updatedAt, publication };
}

/** Read the active attempts for a set of Plan IDs in a single registry snapshot. */
export async function readWorkflowActivity(
    projectRoot: string,
    planIds: readonly string[],
): Promise<ReadonlyMap<string, WorkflowActivity>> {
    const { findByPlanIds } = await import("../../src/shared/worktree-registry.ts");
    const entries = await findByPlanIds(projectRoot, [...planIds]);
    const activity = new Map<string, WorkflowActivity>();
    for (const [planId, entry] of entries) {
        if (entry) activity.set(planId, projectWorkflowActivity(entry, planId));
    }
    return activity;
}
