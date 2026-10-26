import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function containedFile(root: string, requested: string): Promise<string> {
    const base = await realpath(root);
    const target = await realpath(resolve(base, requested));
    const path = relative(base, target);
    if (!path || path === ".." || path.startsWith(".." + sep) || isAbsolute(path)) {
        throw new Error("Artifact must be beneath the archive root");
    }
    return target;
}
