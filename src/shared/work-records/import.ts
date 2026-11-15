/** Byte-preserving explicit import and durable record locations, independent of the derived index. */
import fs from "node:fs/promises";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomically } from "../private-json-file.ts";
import { parseWorkRecordMarkdown } from "./markdown.js";
import { listWorkRecords, writeWorkRecord } from "./store.ts";
import { assertWorkRecordPath, workRecordOwnerLayout, withWorkRecordMutation } from "./owner.ts";
import { syncWorkRecordToIndex, type WorkRecordIndexOptions } from "./index-adapter.ts";

export interface WorkRecordLocation {
    kind: "import" | "copy";
    sourcePath: string;
    digest: string;
    repositoryId?: string;
    repositoryPath?: string;
}
export interface WorkRecordLocations {
    version: 1;
    projectId: string;
    personalOwner: string;
    recordId: string;
    locations: WorkRecordLocation[];
}
export function workRecordDigest(markdown: string): string {
    return createHash("sha256").update(markdown).digest("hex");
}
function locationPath(recordId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(recordId)) throw new Error("Invalid Work Record identity.");
    const owner = workRecordOwnerLayout();
    if (!owner) throw new Error("Work Record locations require explicit personal-store admission.");
    const path = join(owner.internal, "locations", `${recordId.toLowerCase()}.json`);
    assertWorkRecordPath(path);
    return path;
}
export async function readWorkRecordLocations(recordId: string): Promise<WorkRecordLocations | null> {
    const path = locationPath(recordId);
    const text = await fs.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (text === null) return null;
    const value: WorkRecordLocations = JSON.parse(text);
    const owner = workRecordOwnerLayout()!;
    if (
        value.version !== 1 ||
        value.recordId.toLowerCase() !== recordId.toLowerCase() ||
        value.projectId !== owner.identity.projectId ||
        value.personalOwner !== owner.identity.personalOwner.identity ||
        !Array.isArray(value.locations)
    )
        throw new Error("Work Record location evidence belongs to another identity.");
    return value;
}
export async function retainWorkRecordLocation(recordId: string, location: WorkRecordLocation): Promise<void> {
    await withWorkRecordMutation(async () => {
        const owner = workRecordOwnerLayout()!;
        if (
            location.repositoryPath &&
            (!location.repositoryId ||
                isAbsolute(location.repositoryPath) ||
                location.repositoryPath.split(/[\\/]/).some((part) => !part || part === ".." || part === "."))
        )
            throw new Error("Unsafe repository Work Record location.");
        const value = (await readWorkRecordLocations(recordId)) || {
            version: 1 as const,
            projectId: owner.identity.projectId,
            personalOwner: owner.identity.personalOwner.identity,
            recordId,
            locations: [],
        };
        if (!value.locations.some((prior) => JSON.stringify(prior) === JSON.stringify(location))) {
            value.locations.push(location);
            writeJsonAtomically(locationPath(recordId), value);
        }
    });
}

export async function importWorkRecords(cwd: string, selection: string, options: WorkRecordIndexOptions) {
    const owner = workRecordOwnerLayout();
    if (!owner) throw new Error("Work Record import requires explicit personal-store admission.");
    const source = resolve(cwd, selection);
    // External inputs are provenance only. Never follow symlinks, including ancestor links.
    for (let cursor = source; ; cursor = resolve(cursor, "..")) {
        if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Symbolic link in import path: ${cursor}`);
        if (resolve(cursor, "..") === cursor) break;
    }
    const stat = await fs.lstat(source);
    const paths = stat.isDirectory()
        ? (await fs.readdir(source))
              .filter((name) => name.endsWith(".md"))
              .sort()
              .map((name) => join(source, name))
        : [source];
    const results = [];
    for (const path of paths) {
        try {
            const file = await fs.lstat(path);
            if (!file.isFile() || file.isSymbolicLink() || !path.endsWith(".md"))
                throw new Error("Expected a regular Markdown file.");
            const bytes = await fs.readFile(path);
            const markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            const parsed = parseWorkRecordMarkdown(markdown, { path, relativePath: basename(path) });
            const record = await withWorkRecordMutation(async () => {
                const existing = (await listWorkRecords(cwd)).filter(
                    (item) => item.attrs.recordId.toLowerCase() === parsed.attrs.recordId.toLowerCase(),
                );
                if (existing.length > 1 || (existing[0] && existing[0].markdown !== markdown))
                    throw new Error(
                        `Conflicting content for recordId ${parsed.attrs.recordId}; existing content preserved.`,
                    );
                const record =
                    existing[0] ||
                    (await writeWorkRecord(cwd, parsed.attrs, parsed.body, { fileName: basename(path), markdown }));
                const repoPath = relative(owner.identity.checkoutRoot, path).replaceAll("\\", "/");
                const contained = !isAbsolute(repoPath) && repoPath !== ".." && !repoPath.startsWith("../");
                await retainWorkRecordLocation(record.attrs.recordId, {
                    kind: "import",
                    sourcePath: path,
                    digest: workRecordDigest(markdown),
                    ...(contained ? { repositoryId: owner.identity.repositoryId, repositoryPath: repoPath } : {}),
                });
                return record;
            });
            let indexWarning: string | undefined;
            try {
                await syncWorkRecordToIndex(cwd, record, options);
            } catch (error) {
                indexWarning = error instanceof Error ? error.message : String(error);
            }
            results.push({ record, indexWarning });
        } catch (error) {
            throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }
    return results;
}
