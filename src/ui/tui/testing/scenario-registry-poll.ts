import { ProjectRuntimeReadPendingError } from "@runwield/project-runtime/layout";
import { inspectWorktreeRegistry } from "../../../shared/worktree-registry.ts";

/** Pending authority is not an empty registry and cannot satisfy a status wait. */
export async function readScenarioRegistryForPoll(projectRoot: string) {
    try {
        return await inspectWorktreeRegistry(projectRoot);
    } catch (error) {
        if (error instanceof ProjectRuntimeReadPendingError) return null;
        throw error;
    }
}
