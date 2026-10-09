/** Host contracts used by the embedded Plannotator code-review components. */

import { isAbsolute, relative, resolve } from "node:path";

export interface ReviewFileContentOptions {
    cwd?: string;
}

interface WorkspaceTextFile {
    path: string;
    contents: string;
}

/**
 * Return the current working-tree content when it is safely available.
 * The workflow diff's baseline tree is intentionally not guessed here, so
 * oldContent remains null instead of showing content from the wrong revision.
 */
export async function reviewFileContentApi(
    request: Request,
    options: ReviewFileContentOptions = {},
): Promise<Response> {
    const url = new URL(request.url);
    const filePath = stripLineReference(url.searchParams.get("path")?.trim() || "");
    const oldPath = url.searchParams.get("oldPath")?.trim();
    const baseDir = url.searchParams.get("base")?.trim() || "";
    if (!filePath) return Response.json({ error: "File path required." }, { status: 400 });

    const cwd = resolve(options.cwd || Deno.cwd());
    if (
        !hasSafeCandidate(filePath, baseDir, cwd) ||
        (oldPath && !hasSafeCandidate(stripLineReference(oldPath), baseDir, cwd))
    ) {
        return Response.json({ error: "File path is outside this review workspace." }, { status: 403 });
    }

    try {
        const file = await readWorkspaceTextFile(cwd, filePath, baseDir);
        return Response.json({
            oldContent: null,
            newContent: file?.contents ?? null,
            codeFile: file !== null,
            contents: file?.contents,
            filepath: file?.path || filePath,
            ...(!file && { error: `File not found in project: ${filePath}` }),
        }, {
            headers: { "cache-control": "no-store" },
        });
    } catch (error) {
        if (error instanceof Deno.errors.PermissionDenied) {
            return Response.json({ error: "File path is outside this review workspace." }, { status: 403 });
        }
        return Response.json({ error: "Unable to read file content." }, { status: 500 });
    }
}

/** Plannotator hides its open-in control when the host reports unavailable. */
export function reviewOpenInAppsApi(): Response {
    return Response.json({ available: false, apps: [] }, {
        headers: { "cache-control": "no-store" },
    });
}

/**
 * Plannotator's config store already persists these settings in its cookies.
 * Acknowledge its optional server-sync request without introducing a second
 * RunWield settings source.
 */
export function reviewLocalConfigApi(): Response {
    return Response.json({ ok: true }, {
        headers: { "cache-control": "no-store" },
    });
}

function stripLineReference(value: string): string {
    return value.replace(/#.*$/, "").replace(/:\d+(?:-\d+)?$/, "");
}

function hasSafeCandidate(path: string, baseDir: string, cwd: string): boolean {
    if (!path || path.includes("\0") || isAbsolute(path)) return false;
    return candidatePaths(cwd, path, baseDir).some((candidate) => isPathInside(candidate, cwd));
}

function candidatePaths(cwd: string, filePath: string, baseDir: string): string[] {
    const candidates = [resolve(cwd, filePath)];
    if (baseDir && !baseDir.includes("\0") && !isAbsolute(baseDir)) {
        candidates.push(resolve(cwd, baseDir, filePath));
    }
    return [...new Set(candidates)];
}

async function readWorkspaceTextFile(
    cwd: string,
    filePath: string,
    baseDir: string,
): Promise<WorkspaceTextFile | null> {
    const realCwd = await Deno.realPath(cwd);
    for (const candidate of candidatePaths(cwd, filePath, baseDir)) {
        if (!isPathInside(candidate, cwd)) continue;
        const file = await readCandidate(realCwd, candidate);
        if (file) return file;
    }
    return null;
}

async function readCandidate(realCwd: string, candidate: string): Promise<WorkspaceTextFile | null> {
    try {
        const realPath = await Deno.realPath(candidate);
        if (!isPathInside(realPath, realCwd)) throw new Deno.errors.PermissionDenied();
        const stat = await Deno.stat(realPath);
        return stat.isFile ? { path: relative(realCwd, realPath), contents: await Deno.readTextFile(realPath) } : null;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
    }
}

function isPathInside(path: string, root: string): boolean {
    const rel = relative(resolve(root), resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
