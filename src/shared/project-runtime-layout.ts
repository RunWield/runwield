import { enter, type ProjectRuntimeLayout } from "@runwield/project-runtime";
import { invalidateProjectRuntimeReadScope } from "@runwield/project-runtime/layout";
import { projects, ProjectIdentityEntryRequired, type ProjectIdentityOptions } from "@runwield/projects";
import { stat } from "node:fs/promises";

/** Admit a checkout for a path-based caller before preparing its runtime. */
export async function enterProjectRuntime(
    checkoutRoot: string,
    options: ProjectIdentityOptions = {},
): Promise<ProjectRuntimeLayout> {
    invalidateProjectRuntimeReadScope();
    try {
        const info = await stat(checkoutRoot).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (!info?.isDirectory()) throw new Error("Project root must be an existing directory");
        const admission = await projects.checkout.admit(checkoutRoot, options);
        if (admission.kind !== "existing") throw new ProjectIdentityEntryRequired(admission);
        return await (options.context
            ? projects.launch.withContext(options.context, () => enter(admission.identity))
            : enter(admission.identity));
    } finally {
        invalidateProjectRuntimeReadScope();
    }
}
