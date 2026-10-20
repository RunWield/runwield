/** Host contracts used by the embedded Plannotator code-review components. */

import { realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isPathInside, readContainedTextFile } from "../../../../shared/contained-text-file.ts";
import { isAbsolute, relative, resolve } from "node:path";
import { captureForegroundProcess } from "../../../../shared/captured-process.ts";
import { readWorktreeReviewBaseFile, WorktreeReviewComparisonError } from "../../../../shared/workflow/git-snapshot.ts";
import { getCwd } from "../../../../constants.js";

export interface WorkspaceFile {
    /** Canonical absolute path. Keep this inside the host, never in browser payloads. */
    absolutePath: string;
    /** Canonical Project-relative path. */
    path: string;
}

export interface WorkspaceFileOptions {
    allowRelativeTraversal?: boolean;
}

/**
 * Resolve one regular file without scanning the Project. Both lexical and final
 * real paths must remain inside the canonical root. Synchronous for TUI rendering.
 * Missing files return null; unsafe paths throw a generic PermissionDenied error.
 * Paths are already decoded by the caller; do not decode query parameters twice.
 * This path result does not authorize a later pathname read; validate the opened file too.
 */
export function resolveWorkspaceFile(
    projectRoot: string,
    filePath: string,
    options: WorkspaceFileOptions = {},
): WorkspaceFile | null {
    if (
        !filePath ||
        filePath.includes("\0") ||
        filePath.includes("\\") ||
        isAbsolute(filePath) ||
        /^[a-z][a-z\d+.-]*:/i.test(filePath) ||
        (!options.allowRelativeTraversal && filePath.split("/").includes(".."))
    )
        throw Object.assign(new Error("File path is outside this review workspace."), { code: "EACCES" });

    try {
        const root = realpathSync(projectRoot);
        const candidate = resolve(root, filePath);
        if (!isPathInside(candidate, root)) {
            throw Object.assign(new Error("File path is outside this review workspace."), { code: "EACCES" });
        }
        const absolutePath = realpathSync(candidate);
        if (!isPathInside(absolutePath, root)) {
            throw Object.assign(new Error("File path is outside this review workspace."), { code: "EACCES" });
        }
        if (!statSync(absolutePath).isFile()) return null;
        return { absolutePath, path: relative(root, absolutePath).replaceAll("\\", "/") };
    } catch (error) {
        if (error instanceof Error && ["ENOENT", "ENOTDIR"].includes(Reflect.get(error, "code"))) return null;
        throw error;
    }
}

export interface ReviewFileContentOptions {
    cwd?: string;
    targetBranch?: string;
    headRef?: string;
}

interface WorkspaceTextFile {
    path: string;
    contents: string;
}

/**
 * Return safely available selected-ref or worktree content and, when a target is supplied,
 * before text from the shared proposed-branch comparison.
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

    const cwd = resolve(options.cwd || getCwd());
    if (
        !hasSafeCandidate(filePath, baseDir, cwd) ||
        (oldPath && !hasSafeCandidate(stripLineReference(oldPath), baseDir, cwd))
    ) {
        return Response.json({ error: "File path is outside this review workspace." }, { status: 403 });
    }

    try {
        const file = options.headRef
            ? await readRefTextFile(cwd, options.headRef, filePath, baseDir)
            : await readWorkspaceTextFile(cwd, filePath, baseDir);
        let oldContent: string | null = null;
        if (options.targetBranch) {
            try {
                const basePath = oldPath ? stripLineReference(oldPath) : file?.path || filePath;
                for (const candidate of candidatePaths(cwd, basePath, baseDir)) {
                    if (!isPathInside(candidate, cwd)) continue;
                    oldContent = await readWorktreeReviewBaseFile(
                        cwd,
                        options.targetBranch,
                        relative(cwd, candidate).replaceAll("\\", "/"),
                    );
                    if (oldContent !== null) break;
                }
                oldContent ??= file ? "" : null;
            } catch (error) {
                if (!(error instanceof WorktreeReviewComparisonError)) throw error;
            }
        }
        return Response.json(
            {
                oldContent,
                newContent: file?.contents ?? null,
                codeFile: file !== null,
                contents: file?.contents,
                filepath: file?.path || filePath,
                ...(!file && { error: `File not found in project: ${filePath}` }),
            },
            {
                headers: { "cache-control": "no-store" },
            },
        );
    } catch (error) {
        if (error instanceof Error && ["EACCES", "EPERM"].includes(Reflect.get(error, "code"))) {
            return Response.json({ error: "File path is outside this review workspace." }, { status: 403 });
        }
        return Response.json({ error: "Unable to read file content." }, { status: 500 });
    }
}

/** Plannotator hides its open-in control when the host reports unavailable. */
export function reviewOpenInAppsApi(): Response {
    return Response.json(
        { available: false, apps: [] },
        {
            headers: { "cache-control": "no-store" },
        },
    );
}

/**
 * Plannotator's config store already persists these settings in its cookies.
 * Acknowledge its optional server-sync request without introducing a second
 * RunWield settings source.
 */
export function reviewLocalConfigApi(): Response {
    return Response.json(
        { ok: true },
        {
            headers: { "cache-control": "no-store" },
        },
    );
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

async function readRefTextFile(
    cwd: string,
    headRef: string,
    filePath: string,
    baseDir: string,
): Promise<WorkspaceTextFile | null> {
    for (const candidate of candidatePaths(cwd, filePath, baseDir)) {
        if (!isPathInside(candidate, cwd)) continue;
        const path = relative(cwd, candidate).replaceAll("\\", "/");
        const result = await captureForegroundProcess("git", {
            cwd,
            args: ["show", `${headRef}:${path}`],
        });
        if (result.success) return { path, contents: new TextDecoder().decode(result.stdout) };
    }
    return null;
}

async function readWorkspaceTextFile(
    cwd: string,
    filePath: string,
    baseDir: string,
): Promise<WorkspaceTextFile | null> {
    const realCwd = await realpath(cwd);
    for (const candidate of candidatePaths(realCwd, filePath, baseDir)) {
        if (!isPathInside(candidate, realCwd)) continue;
        const file = await readCandidate(realCwd, candidate);
        if (file) return file;
    }
    return null;
}

async function readCandidate(realCwd: string, candidate: string): Promise<WorkspaceTextFile | null> {
    const file = resolveWorkspaceFile(realCwd, relative(realCwd, candidate).replaceAll("\\", "/"), {
        allowRelativeTraversal: true,
    });
    if (!file) return null;
    const contents = await readContainedTextFile(realCwd, file.absolutePath);
    return contents === null ? null : { path: file.path, contents };
}
