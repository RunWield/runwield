import type { Workspace } from "./model.ts";
import { getWorkspace, saveWorkspace } from "./store.ts";

export function defaultWorkspace(): Workspace {
    return { id: "default", label: "Workspace" };
}

export async function initializeWorkspace(root: string): Promise<Workspace> {
    const saved = await getWorkspace(root);
    if (saved) return saved;
    const workspace = defaultWorkspace();
    await saveWorkspace(root, workspace);
    return workspace;
}
