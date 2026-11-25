import type { WorkRecordLocation, WorkRecordLocations } from "@runwield/plans/work-record-files";
import { workRecords } from "@runwield/plans/work-records";
import { projects } from "@runwield/projects";
/** Byte-preserving explicit import and durable record locations, independent of the derived index. */
import fs from "node:fs/promises";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { listWorkRecords, writeWorkRecord } from "./store.ts";
import { requireOwnedWorkRecordFiles, currentWorkRecordOwner, withWorkRecordMutation } from "./owner.ts";
import { syncWorkRecordToIndex, type WorkRecordIndexOptions } from "./index-adapter.ts";

export function workRecordDigest(markdown: string): string {
    return createHash("sha256").update(markdown).digest("hex");
}
export async function readWorkRecordLocations(recordId: string): Promise<WorkRecordLocations | null> {
    return await requireOwnedWorkRecordFiles().readLocations(recordId);
}

export async function retainWorkRecordLocation(recordId: string, location: WorkRecordLocation): Promise<void> {
    await requireOwnedWorkRecordFiles().retainLocation(recordId, location);
}

export async function importWorkRecords(cwd: string, selection: string, options: WorkRecordIndexOptions) {
    const owner = currentWorkRecordOwner();
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
            const parsed = workRecords.documents.parse(markdown, { path, relativePath: basename(path) });
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
                const repoPath = relative(projects.home.requireCheckout(owner).checkoutRoot, path).replaceAll(
                    "\\",
                    "/",
                );
                const contained = !isAbsolute(repoPath) && repoPath !== ".." && !repoPath.startsWith("../");
                await retainWorkRecordLocation(record.attrs.recordId, {
                    kind: "import",
                    sourcePath: path,
                    digest: workRecordDigest(markdown),
                    ...(contained ? { repositoryId: owner.repositoryId, repositoryPath: repoPath } : {}),
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

/** Called under the record mutation lock after pruning the canonical identity. */
export async function forgetWorkRecordLocations(recordId: string) {
    await requireOwnedWorkRecordFiles().forgetLocations(recordId);
}
