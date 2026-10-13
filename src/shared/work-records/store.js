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

export class WorkRecordReadError extends Error {
    /** @param {string} filePath @param {string} reason */
    constructor(filePath, reason) {
        super(`${filePath}: ${reason}`);
        this.name = "WorkRecordReadError";
        this.filePath = filePath;
        this.reason = reason;
    }
}

/** @param {string} cwd */
export function getWorkRecordsDir(cwd) {
    return join(cwd, WORK_RECORDS_DIR_NAME);
}

/** @param {string} cwd */
export async function ensureWorkRecordsDir(cwd) {
    const dir = getWorkRecordsDir(cwd);
    await fsMkdir(dir, { recursive: true });
    return dir;
}

/** @param {string} title */
export function slugifyWorkRecordTitle(title) {
    return (
        String(title || "work-record")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "work-record"
    );
}

/**
 * @param {string} title
 * @param {Date} [date]
 */
export function buildWorkRecordFileName(title, date = new Date()) {
    return `${date.toISOString().slice(0, 10)}-${slugifyWorkRecordTitle(title)}.md`;
}

/**
 * @param {string} cwd
 * @param {string} fileName
 */
export function resolveWorkRecordPath(cwd, fileName) {
    const name = basename(String(fileName || "").replaceAll("\\", "/"));
    if (!name || name !== fileName || name === "." || name === ".." || !name.endsWith(".md")) {
        throw new Error(`Work Record path must be a flat Markdown filename under ${WORK_RECORDS_DIR_NAME}/.`);
    }
    return join(getWorkRecordsDir(cwd), name);
}

/**
 * @param {string} cwd
 * @param {string} filePath
 */
function relativeWorkRecordPath(cwd, filePath) {
    return relative(cwd, filePath).replaceAll("\\", "/");
}

/**
 * @param {string} cwd
 * @param {string} fileName
 */
export async function readWorkRecord(cwd, fileName) {
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

/**
 * @param {string} cwd
 * @param {{ createDir?: boolean }} [options]
 * @returns {Promise<import('./schema.ts').WorkRecordResource[]>}
 */
export async function listWorkRecords(cwd, options = {}) {
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
    const records = [];
    for await (const entry of await opendir(dir)) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        records.push(await readWorkRecord(cwd, entry.name));
    }
    return records.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * @param {string} cwd
 * @param {string} recordId
 */
export async function findWorkRecordById(cwd, recordId) {
    const identity = String(recordId).toLowerCase();
    const records = await listWorkRecords(cwd);
    return records.find((record) => record.attrs.recordId.toLowerCase() === identity) || null;
}

/**
 * Publish validated Markdown without replacing an existing canonical path.
 * @param {string} directory
 * @param {string} filePath
 * @param {string} markdown
 */
async function createCanonicalFile(directory, filePath, markdown) {
    const tempPath = join(directory, `.${basename(filePath)}.${crypto.randomUUID()}.tmp`);
    let file;
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

/**
 * @param {string} fileName
 * @param {string} recordId
 */
function collisionFileName(fileName, recordId) {
    return `${fileName.slice(0, -3)}-${recordId.toLowerCase()}.md`;
}

/**
 * @param {string} cwd
 * @param {import('./schema.ts').WorkRecordFrontMatter} attrs
 * @param {string} body
 * @param {{ fileName?: string }} [options]
 */
export async function writeWorkRecord(cwd, attrs, body, options = {}) {
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

/** @param {string} directory */
async function syncDirectory(directory) {
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
 * @param {string} cwd
 * @param {import('./schema.ts').WorkRecordResource} currentRecord
 */
export async function deleteWorkRecord(cwd, currentRecord) {
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
 * @param {string} cwd
 * @param {import('./schema.ts').WorkRecordResource} currentRecord
 * @param {string} markdown
 */
export async function replaceWorkRecord(cwd, currentRecord, markdown) {
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
    let file;
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
