import { recoverWindowsRename, syncParentDirectory } from "@runwield/resources/fs";
import { randomUUID } from "node:crypto";
import fs, { link, lstat, mkdir, open, opendir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { documents, type WorkRecordFrontMatter, type WorkRecordResource } from "./documents.ts";
import { assertWorkRecordContainedPath } from "./paths.ts";

export const CHECKOUT_RECORD_DIRECTORY = "docs/work-records";

export function canonicalFileName(title: string, date = new Date()): string {
    const slug = String(title || "work-record")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `${date.toISOString().slice(0, 10)}-${slug || "work-record"}.md`;
}

export interface ListWorkRecordsOptions {
    createDir?: boolean;
}

export interface WriteWorkRecordOptions {
    fileName?: string;
    markdown?: string;
}

export class WorkRecordReadError extends Error {
    constructor(
        readonly filePath: string,
        readonly reason: string,
    ) {
        super(`${filePath}: ${reason}`);
        this.name = "WorkRecordReadError";
    }
}

function isFileError(error: Error, code: string): boolean {
    return "code" in error && error.code === code;
}

async function readRegularFile(path: string): Promise<string> {
    if (!(await lstat(path)).isFile()) throw new Error(`Work Record must be a regular file: ${basename(path)}`);
    return await readFile(path, "utf8");
}

function syncRecordDirectory(path: string) {
    try {
        syncParentDirectory(path);
    } catch {
        // Directory sync is best effort on filesystems that cannot open or flush directories.
    }
}

async function publishFile(path: string, markdown: string, replace: boolean) {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx");
    try {
        try {
            await file.writeFile(markdown);
            await file.sync();
        } finally {
            await file.close();
        }
        if (replace) {
            try {
                await fs.rename(temporaryPath, path);
            } catch (error) {
                if (!(error instanceof Error && recoverWindowsRename(error, temporaryPath, path))) throw error;
            }
        } else {
            await link(temporaryPath, path);
        }
        syncRecordDirectory(path);
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
    }
}

export function canonicalFiles(root: string, directory: string, ownerHome?: string) {
    const scope = resolve(ownerHome ?? root);
    const assertPath = (path: string) => assertWorkRecordContainedPath(scope, resolve(path));

    async function recordPath(fileName: string) {
        const name = basename(String(fileName || "").replaceAll("\\", "/"));
        if (!name || name !== fileName || name === "." || name === ".." || !name.endsWith(".md"))
            throw new Error(`Work Record path must be a flat Markdown filename under ${CHECKOUT_RECORD_DIRECTORY}/.`);
        const path = join(directory, name);
        await assertPath(path);
        return path;
    }

    const relativePath = (path: string) => relative(root, path).replaceAll("\\", "/");

    function parse(markdown: string, path: string) {
        return documents.parse(markdown, { path, relativePath: relativePath(path) });
    }

    async function read(fileName: string): Promise<WorkRecordResource> {
        const path = await recordPath(fileName);
        const markdown = await readRegularFile(path);
        try {
            return parse(markdown, path);
        } catch (error) {
            throw new WorkRecordReadError(relativePath(path), error instanceof Error ? error.message : String(error));
        }
    }

    async function readDirectory(options: ListWorkRecordsOptions): Promise<WorkRecordResource[]> {
        await assertPath(directory);
        if (options.createDir === false) {
            try {
                if (!(await lstat(directory)).isDirectory()) return [];
            } catch (error) {
                if (error instanceof Error && isFileError(error, "ENOENT")) return [];
                throw error;
            }
        } else {
            await mkdir(directory, { recursive: true });
        }
        const records: WorkRecordResource[] = [];
        for await (const entry of await opendir(directory)) {
            if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
            records.push(await read(entry.name));
        }
        return records.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }

    async function list(options: ListWorkRecordsOptions = {}): Promise<WorkRecordResource[]> {
        try {
            return await readDirectory(options);
        } catch (error) {
            if (error instanceof Error && "code" in error && typeof error.code === "string")
                throw new Error(`Could not read the Work Record catalog (${error.code}).`);
            throw error;
        }
    }

    async function prepareCreation(attrs: WorkRecordFrontMatter, body: string, options: WriteWorkRecordOptions = {}) {
        await assertPath(directory);
        await mkdir(directory, { recursive: true });
        const title = body.match(/^#\s+(.+)$/m)?.[1] || attrs.recordId;
        const requestedName = options.fileName || canonicalFileName(title);
        const requestedPath = await recordPath(requestedName);
        const markdown = options.markdown ?? documents.format(attrs, body);
        const record = parse(markdown, requestedPath);
        const recordId = record.attrs.recordId;
        const identity = recordId.toLowerCase();
        if (
            ownerHome &&
            (await list({ createDir: false })).some((entry) => entry.attrs.recordId.toLowerCase() === identity)
        )
            throw new Error(`Canonical Work Record identity already exists: ${recordId}. No file was overwritten.`);
        return {
            recordId,
            async publish() {
                await assertPath(requestedPath);
                try {
                    await publishFile(requestedPath, markdown, false);
                    return record;
                } catch (error) {
                    if (!(error instanceof Error && isFileError(error, "EEXIST"))) throw error;
                }
                const alternateName = `${requestedName.slice(0, -3)}-${identity}.md`;
                const alternatePath = await recordPath(alternateName);
                try {
                    await publishFile(alternatePath, markdown, false);
                } catch (error) {
                    if (!(error instanceof Error && isFileError(error, "EEXIST"))) throw error;
                    throw new Error(
                        `Work Record canonical paths already exist: ${requestedName} and ${alternateName}. No file was overwritten.`,
                        { cause: error },
                    );
                }
                return parse(markdown, alternatePath);
            },
        };
    }

    async function create(attrs: WorkRecordFrontMatter, body: string, options?: WriteWorkRecordOptions) {
        return await (await prepareCreation(attrs, body, options)).publish();
    }

    async function existingPath(record: WorkRecordResource) {
        const path = resolve(record.path || "");
        if (dirname(path) !== resolve(directory) || !record.relativePath || !path.endsWith(".md"))
            throw new Error("Current Work Record path must identify a canonical flat Work Record file.");
        const expectedPath = await recordPath(basename(path));
        if (resolve(expectedPath) !== path || record.relativePath !== relativePath(expectedPath))
            throw new Error(
                "Current Work Record path is outside the Work Record store or does not match relativePath.",
            );
        return path;
    }

    async function verifyExisting(path: string, record: WorkRecordResource, operation: "deleting" | "replacing") {
        const onDisk = await read(basename(path));
        if (onDisk.attrs.recordId.toLowerCase() !== record.attrs.recordId.toLowerCase())
            throw new Error("Current Work Record identity does not match the file at its canonical path.");
        if (ownerHome && onDisk.markdown !== record.markdown)
            throw new Error(`Canonical Work Record changed; reload before ${operation} editor content.`);
    }

    async function replace(current: WorkRecordResource, markdown: string): Promise<WorkRecordResource> {
        const path = await existingPath(current);
        const record = parse(markdown, path);
        if (record.attrs.recordId.toLowerCase() !== current.attrs.recordId.toLowerCase())
            throw new Error("Replacement Work Record recordId must match the current Work Record identity.");
        await verifyExisting(path, current, "replacing");
        await publishFile(path, markdown, true);
        return record;
    }

    async function remove(current: WorkRecordResource): Promise<void> {
        const path = await existingPath(current);
        await verifyExisting(path, current, "deleting");
        await rm(path);
        syncRecordDirectory(path);
    }

    return { read, list, prepareCreation, create, replace, delete: remove };
}
