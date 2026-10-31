import { ProjectRuntimeReadPendingError } from "../../../shared/project-runtime-layout.ts";
import { inspectWorktreeRegistry } from "../../../shared/worktree-registry.js";

/** Pending authority is not an empty registry and cannot satisfy a status wait. */
export async function readScenarioRegistryForPoll(projectRoot: string) {
    try {
        return await inspectWorktreeRegistry(projectRoot);
    } catch (error) {
        if (error instanceof ProjectRuntimeReadPendingError) return null;
        throw error;
    }
}
