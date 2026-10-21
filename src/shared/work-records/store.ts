import { recoverWindowsRename } from "../native-file-replace-windows.ts";
import fs from "node:fs/promises";
import { link, open, opendir } from "node:fs/promises";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, stat as fsStat } from "node:fs/promises";
/**
 * @module shared/work-records/store
 * Canonical Work Record filesystem store.
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import { WORK_RECORDS_DIR_NAME } from "../../constants.js";
import { formatWorkRecordMarkdown, parseWorkRecordMarkdown } from "./markdown.js";
import { requestWorkspaceSearchRefresh } from "../workspace-search-refresh.ts";
import type { WorkRecordFrontMatter, WorkRecordResource } from "./schema.ts";

export interface ListWorkRecordsOptions {
    createDir?: boolean;
}

export interface WriteWorkRecordOptions {
    fileName?: string;
}

export class WorkRecordReadError extends Error {
    declare filePath: string;
    declare reason: string;
    constructor(filePath: string, reason: string) {
        super(`${filePath}: ${reason}`);
        this.name = "WorkRecordReadError";
        this.filePath = filePath;
        this.reason = reason;
    }
}

export function getWorkRecordsDir(cwd: string) {
    return join(cwd, WORK_RECORDS_DIR_NAME);
}

export async function ensureWorkRecordsDir(cwd: string) {
    const dir = getWorkRecordsDir(cwd);
    await fsMkdir(dir, { recursive: true });
    return dir;
}

export function slugifyWorkRecordTitle(title: string) {
    return (
        String(title || "work-record")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "work-record"
    );
}

export function buildWorkRecordFileName(title: string, date = new Date()) {
    return `${date.toISOString().slice(0, 10)}-${slugifyWorkRecordTitle(title)}.md`;
}

export function resolveWorkRecordPath(cwd: string, fileName: string) {
    const name = basename(String(fileName || "").replaceAll("\\", "/"));
    if (!name || name !== fileName || name === "." || name === ".." || !name.endsWith(".md")) {
        throw new Error(`Work Record path must be a flat Markdown filename under ${WORK_RECORDS_DIR_NAME}/.`);
    }
    return join(getWorkRecordsDir(cwd), name);
}

function relativeWorkRecordPath(cwd: string, filePath: string) {
    return relative(cwd, filePath).replaceAll("\\", "/");
}

export async function readWorkRecord(cwd: string, fileName: string): Promise<WorkRecordResource> {
    const filePath = resolveWorkRecordPath(cwd, fileName);
    const markdown = await fsReadFile(filePath, "utf8");
    try {
        return parseWorkRecordMarkdown(markdown, {
            path: filePath,
            relativePath: relativeWorkRecordPath(cwd, filePath),
        });
    } catch (error) {
        throw new WorkRecordReadError(
            relativeWorkRecordPath(cwd, filePath),
            error instanceof Error ? error.message : String(error),
        );
    }
}

export async function listWorkRecords(
    cwd: string,
    options: ListWorkRecordsOptions = {},
): Promise<WorkRecordResource[]> {
    const dir = options.createDir === false ? getWorkRecordsDir(cwd) : await ensureWorkRecordsDir(cwd);
    if (options.createDir === false) {
        try {
            const stat = await fsStat(dir);
            if (!stat.isDirectory()) return [];
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
            throw error;
        }
    }
    const records: WorkRecordResource[] = [];
    for await (const entry of await opendir(dir)) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        records.push(await readWorkRecord(cwd, entry.name));
    }
    return records.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function findWorkRecordById(cwd: string, recordId: string): Promise<WorkRecordResource | null> {
    const identity = String(recordId).toLowerCase();
    const records = await listWorkRecords(cwd);
    return records.find((record) => record.attrs.recordId.toLowerCase() === identity) || null;
}

/**
 * Publish validated Markdown without replacing an existing canonical path.
 */
async function createCanonicalFile(directory: string, filePath: string, markdown: string) {
    const tempPath = join(directory, `.${basename(filePath)}.${crypto.randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(tempPath, "wx");
        await file.writeFile(markdown);
        await file.sync();
        await file.close();
        file = undefined;
        await link(tempPath, filePath);
        await syncDirectory(directory);
    } finally {
        if (file) await file.close();
        await fsRm(tempPath).catch(() => {});
    }
}

function collisionFileName(fileName: string, recordId: string) {
    return `${fileName.slice(0, -3)}-${recordId.toLowerCase()}.md`;
}

export async function writeWorkRecord(
    cwd: string,
    attrs: WorkRecordFrontMatter,
    body: string,
    options: WriteWorkRecordOptions = {},
): Promise<WorkRecordResource> {
    const directory = await ensureWorkRecordsDir(cwd);
    const title = body.match(/^#\s+(.+)$/m)?.[1] || attrs.recordId;
    const requestedFileName = options.fileName || buildWorkRecordFileName(title);
    let filePath = resolveWorkRecordPath(cwd, requestedFileName);
    const markdown = formatWorkRecordMarkdown(attrs, body);
    const validated = parseWorkRecordMarkdown(markdown, {
        path: filePath,
        relativePath: relativeWorkRecordPath(cwd, filePath),
    });
    try {
        await createCanonicalFile(directory, filePath, markdown);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const alternateName = collisionFileName(requestedFileName, validated.attrs.recordId);
        filePath = resolveWorkRecordPath(cwd, alternateName);
        try {
            await createCanonicalFile(directory, filePath, markdown);
        } catch (alternateError) {
            if (alternateError instanceof Error && "code" in alternateError && alternateError.code === "EEXIST") {
                throw new Error(
                    `Work Record canonical paths already exist: ${requestedFileName} and ${alternateName}. No file was overwritten.`,
                    { cause: alternateError },
                );
            }
            throw alternateError;
        }
    }
    const record = parseWorkRecordMarkdown(markdown, {
        path: filePath,
        relativePath: relativeWorkRecordPath(cwd, filePath),
    });
    await requestWorkspaceSearchRefresh(cwd);
    return record;
}

async function syncDirectory(directory: string) {
    try {
        const handle = await open(directory, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Some filesystems do not support directory sync. Rename is still atomic.
    }
}

/**
 * Delete one canonical Work Record only when its path and identity still match.
 */
export async function deleteWorkRecord(cwd: string, currentRecord: WorkRecordResource) {
    const expectedDir = resolve(getWorkRecordsDir(cwd));
    const currentPath = resolve(currentRecord.path || "");
    if (dirname(currentPath) !== expectedDir || !currentRecord.relativePath || !currentPath.endsWith(".md")) {
        throw new Error("Current Work Record path must identify a canonical flat Work Record file.");
    }
    const expectedPath = resolveWorkRecordPath(cwd, basename(currentPath));
    if (
        resolve(expectedPath) !== currentPath ||
        currentRecord.relativePath !== relativeWorkRecordPath(cwd, expectedPath)
    ) {
        throw new Error("Current Work Record path is outside the Work Record store or does not match relativePath.");
    }
    const onDisk = await readWorkRecord(cwd, basename(currentPath));
    if (onDisk.attrs.recordId.toLowerCase() !== currentRecord.attrs.recordId.toLowerCase()) {
        throw new Error("Current Work Record identity does not match the file at its canonical path.");
    }
    await fsRm(currentPath);
    await syncDirectory(expectedDir);
    await requestWorkspaceSearchRefresh(cwd);
}

/**
 * Atomically replace one canonical Work Record without permitting an identity or path change.
 */
export async function replaceWorkRecord(
    cwd: string,
    currentRecord: WorkRecordResource,
    markdown: string,
): Promise<WorkRecordResource> {
    const expectedDir = resolve(getWorkRecordsDir(cwd));
    const currentPath = resolve(currentRecord.path || "");
    if (dirname(currentPath) !== expectedDir || !currentRecord.relativePath || !currentPath.endsWith(".md")) {
        throw new Error("Current Work Record path must identify a canonical flat Work Record file.");
    }
    const expectedPath = resolveWorkRecordPath(cwd, basename(currentPath));
    const expectedRelativePath = relativeWorkRecordPath(cwd, expectedPath);
    if (resolve(expectedPath) !== currentPath || currentRecord.relativePath !== expectedRelativePath) {
        throw new Error("Current Work Record path is outside the Work Record store or does not match relativePath.");
    }
    const parsed = parseWorkRecordMarkdown(markdown, {
        path: currentPath,
        relativePath: relativeWorkRecordPath(cwd, currentPath),
    });
    if (parsed.attrs.recordId.toLowerCase() !== currentRecord.attrs.recordId.toLowerCase()) {
        throw new Error("Replacement Work Record recordId must match the current Work Record identity.");
    }
    const onDisk = await readWorkRecord(cwd, basename(currentPath));
    if (onDisk.attrs.recordId.toLowerCase() !== currentRecord.attrs.recordId.toLowerCase()) {
        throw new Error("Current Work Record identity does not match the file at its canonical path.");
    }
    const tempPath = join(expectedDir, `.${basename(currentPath)}.${crypto.randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(tempPath, "wx");
        await file.writeFile(markdown);
        await file.sync();
        await file.close();
        file = undefined;
        try {
            await fs.rename(tempPath, currentPath);
        } catch (error) {
            if (!(error instanceof Error && recoverWindowsRename(error, tempPath, currentPath))) throw error;
        }
        await syncDirectory(expectedDir);
    } catch (error) {
        if (file) await file.close();
        await fsRm(tempPath).catch(() => {});
        throw error;
    }
    await requestWorkspaceSearchRefresh(cwd);
    return parsed;
}
