import { projects, ProjectIdentityEntryRequired } from "@runwield/projects";

export interface MemoryCollectionContext {
    cwd: string;
    boundCollection?: string;
}

/** The laptop resolves the admitted remote checkout independently before serving Memory. */
export const USE_PROJECT_MEMORY = "@runwield/current-project";

/** Background reads use committed identity without admitting the checkout. */
export function inspectMemoryCollection(cwd: string): string | null {
    const inspection = projects.checkout.inspect(cwd);
    return inspection.kind === "existing" ? inspection.identity.projectId : null;
}

/** A deliberate Memory operation may admit a fresh checkout. Explicit bindings retain their collection. */
export async function resolveMemoryCollection(context: MemoryCollectionContext): Promise<string> {
    if (context.boundCollection && context.boundCollection !== USE_PROJECT_MEMORY) return context.boundCollection;
    const existing = inspectMemoryCollection(context.cwd);
    if (existing) return existing;
    const admission = await projects.checkout.admit(context.cwd);
    if (admission.kind !== "existing") throw new ProjectIdentityEntryRequired(admission);
    return admission.identity.projectId;
}
