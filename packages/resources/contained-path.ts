import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class ContainedPathError extends Error {
    constructor(
        readonly reason: "outside_root" | "symbolic_link",
        readonly path: string,
    ) {
        super(
            reason === "outside_root"
                ? `Path leaves the storage root: ${path}`
                : `Symbolic link in storage path: ${path}`,
        );
        this.name = "ContainedPathError";
    }
}

/** Refuse escapes and symbolic links, including links whose target is missing. */
export async function assertContainedPath(root: string, path: string): Promise<void> {
    const rel = relative(root, path);
    const separator = sep === "\\" ? /[\\/]/ : "/";
    if (
        !isAbsolute(root) ||
        !isAbsolute(path) ||
        path.split(separator).includes("..") ||
        isAbsolute(rel) ||
        rel === ".." ||
        rel.startsWith("../") ||
        rel.startsWith("..\\")
    )
        throw new ContainedPathError("outside_root", path);
    for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
        try {
            if ((await lstat(cursor)).isSymbolicLink()) throw new ContainedPathError("symbolic_link", cursor);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (relative(root, cursor) === "") return;
        if (dirname(cursor) === cursor) throw new ContainedPathError("outside_root", path);
    }
}
