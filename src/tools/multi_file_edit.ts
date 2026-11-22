import { toolRegistry, type MultiFileEdit, type MultiFileEditParams } from "@runwield/tools";
import { createHash } from "node:crypto";
import { remoteProjectOwner } from "../shared/remote/personal-resources.ts";
import { enterProjectRuntime } from "../shared/project-runtime-layout.ts";
import { ensurePrivateDir, writeJsonAtomically, syncParentDirectory } from "../shared/private-json-file.ts";
import { openNativeFileLock } from "../shared/native-file-lock.ts";
import { ProjectStorePreconditionError } from "../shared/remote/project-store-client.ts";
import { readFile as fsReadFile, unlink, writeFile as fsWriteFile } from "node:fs/promises";
/**
 * @module tools/multi_file_edit
 *
 * Custom tool for performing multiple exact-text replacements across one or more
 * files. Each edit item carries its own path so the schema is distinct from
 * the single-file `edit` tool.
 */

import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { getHomeDir } from "../constants.ts";
import { operatePlanFile, resolvePlanFileTarget, savePlanFileBatch, type PlanFileResult } from "../plan-store/index.ts";

const multiFileEdit = toolRegistry.get("multi_file_edit");

interface PreparedFileEdit {
    path: string;
    original: string;
    replacement: string;
    plan?: PlanFileResult;
}

async function readOrdinarySource(path: string) {
    try {
        return await fsReadFile(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            throw new Error("Could not find file: " + path);
        throw error;
    }
}

interface EditTarget {
    path: string;
    label: string;
    edits: MultiFileEdit[];
    owner?: PlanFileResult;
}

function preparedDocuments(edits: PreparedFileEdit[]) {
    return edits.flatMap((edit) => (edit.plan?.document ? [{ ...edit.plan.document, body: edit.replacement }] : []));
}

async function applySourceEdit(cwd: string, edit: PreparedFileEdit, resume = false) {
    await withFileMutationQueue(edit.path, async () => {
        if (edit.plan) {
            await operatePlanFile(cwd, {
                path: edit.path,
                mode: "edit",
                oldText: edit.original,
                newText: edit.replacement,
            });
        } else {
            const current = await readOrdinarySource(edit.path);
            if (resume && current === edit.replacement) return;
            if (current !== edit.original) throw new Error("File changed before edit: " + edit.path);
            await fsWriteFile(edit.path, edit.replacement);
        }
    });
}

/** Preserve the owner preconditions until both the remote Plan and execution files are settled. */
async function applyManagedMixedEdit(
    cwd: string,
    key: string,
    targets: EditTarget[],
    prepare: () => Promise<PreparedFileEdit[]>,
) {
    const dir = join((await enterProjectRuntime(cwd)).selected.transitionJournalsDir, "managed-file-edits");
    ensurePrivateDir(dir);
    const journalPath = join(dir, createHash("sha256").update(key).digest("hex") + ".json");
    const lock = openNativeFileLock(journalPath + ".lock");
    try {
        await lock.lock(true);
        let edits: PreparedFileEdit[];
        try {
            edits = JSON.parse(await fsReadFile(journalPath, "utf8"));
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            edits = await prepare();
            writeJsonAtomically(journalPath, edits);
        }
        if (
            edits.length !== targets.length ||
            edits.some(
                (item, i) =>
                    item.path !== targets[i].path ||
                    item.plan?.document?.planId !== targets[i].owner?.document?.planId ||
                    item.plan?.document?.resource !== targets[i].owner?.document?.resource,
            )
        )
            throw new Error("A retained edit target changed. Restore the original target before retrying.");
        try {
            await savePlanFileBatch(cwd, preparedDocuments(edits));
        } catch (error) {
            if (error instanceof ProjectStorePreconditionError) {
                await unlink(journalPath);
                syncParentDirectory(journalPath);
            }
            throw error;
        }
        for (const edit of edits) if (!edit.plan) await applySourceEdit(cwd, edit, true);
        await unlink(journalPath);
        syncParentDirectory(journalPath);
        return edits;
    } finally {
        lock.close();
    }
}

interface MultiFileEditDetails {
    diff: string;
    firstChangedLine?: number;
}

type MultiFileEditResult = AgentToolResult<MultiFileEditDetails | null> & { isError?: boolean };

type MultiFileEditToolDefinition = ToolDefinition<
    typeof multiFileEdit.definition.parameters,
    MultiFileEditDetails | null
>;
type PrepareArgumentsFunction = NonNullable<MultiFileEditToolDefinition["prepareArguments"]>;
type InputCandidate = Parameters<PrepareArgumentsFunction>[0];

interface InputRecord {
    path?: InputCandidate;
    file_path?: InputCandidate;
    oldText?: InputCandidate;
    newText?: InputCandidate;
    root?: InputCandidate;
    edits?: InputCandidate;
}

function isInputRecord(input: InputCandidate): input is InputRecord {
    return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

/**
 * @param {string} targetPath
 * @param {string} baseDir
 * @returns {string}
 */
function resolveToBaseDir(targetPath: string, baseDir: string): string {
    const expanded = targetPath.startsWith("~") ? getHomeDir() + targetPath.slice(1) : targetPath;
    if (isAbsolute(expanded)) return expanded;
    return join(baseDir, expanded);
}

/**
 * @param {string} root
 * @param {string} cwd
 * @returns {string}
 */
function resolveRoot(root: string, cwd: string): string {
    const trimmed = root.trim();
    if (!trimmed) return cwd;
    return resolveToBaseDir(trimmed, cwd);
}

/**
 * @param {unknown} input
 * @returns {MultiFileEditParams}
 */
const prepareMultiFileEditArguments: PrepareArgumentsFunction = (input) => {
    if (!isInputRecord(input)) return input as MultiFileEditParams;

    const args = input;
    const topLevelPath =
        typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;

    if (Array.isArray(args.edits)) {
        const edits = args.edits.map((rawEdit) => {
            if (!isInputRecord(rawEdit)) return rawEdit;
            const editPath =
                typeof rawEdit.path === "string"
                    ? rawEdit.path
                    : typeof rawEdit.file_path === "string"
                      ? rawEdit.file_path
                      : topLevelPath;
            return {
                path: editPath,
                oldText: rawEdit.oldText,
                newText: rawEdit.newText,
            };
        });
        return {
            ...(typeof args.root === "string" ? { root: args.root } : {}),
            edits,
        } as MultiFileEditParams;
    }

    if (topLevelPath && typeof args.oldText === "string" && typeof args.newText === "string") {
        return {
            ...(typeof args.root === "string" ? { root: args.root } : {}),
            edits: [{ path: topLevelPath, oldText: args.oldText, newText: args.newText }],
        };
    }

    return input as MultiFileEditParams;
};

/**
 * @param {MultiFileEdit[]} edits
 * @returns {Map<string, MultiFileEdit[]>}
 */
function groupEditsByPath(edits: MultiFileEdit[]): Map<string, MultiFileEdit[]> {
    const grouped = new Map<string, MultiFileEdit[]>();
    for (const edit of edits) {
        const existing = grouped.get(edit.path) || [];
        existing.push(edit);
        grouped.set(edit.path, existing);
    }
    return grouped;
}

/**
 * @param {string} cwd
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition}
 */
export function createMultiFileEditTool(cwd: string) {
    return defineTool<typeof multiFileEdit.definition.parameters, MultiFileEditDetails | null>({
        ...multiFileEdit.definition,
        promptGuidelines: [...multiFileEdit.definition.promptGuidelines],

        prepareArguments: prepareMultiFileEditArguments,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<MultiFileEditResult> {
            const typedParams: MultiFileEditParams = params;
            const baseDir = typedParams.root ? resolveRoot(typedParams.root, cwd) : cwd;
            const groupedEdits = groupEditsByPath(typedParams.edits);
            const written: PreparedFileEdit[] = [];
            try {
                const targets: EditTarget[] = [];
                for (const [label, edits] of groupedEdits) {
                    const targetPath = await resolvePlanFileTarget(baseDir, label);
                    if (targets.some((target) => target.path === targetPath))
                        throw new Error("Duplicate file reached through different paths.");
                    targets.push({
                        path: targetPath,
                        label,
                        edits,
                        owner: await operatePlanFile(cwd, { path: targetPath, mode: "prepare-edit" }),
                    });
                }
                const prepare = async () => {
                    const result: PreparedFileEdit[] = [];
                    for (const target of targets) {
                        const original = target.owner?.content ?? (await readOrdinarySource(target.path));
                        const replacement = multiFileEdit.apply(original, target.edits, target.label);
                        result.push({ path: target.path, original, replacement, plan: target.owner });
                    }
                    return result;
                };
                const remote = remoteProjectOwner();
                const mixed =
                    remote?.kind === "managed-remote" &&
                    targets.some((t) => t.owner?.document) &&
                    targets.some((t) => !t.owner);
                let prepared: PreparedFileEdit[];
                if (mixed) {
                    const key = JSON.stringify({ owner: remote.identity, cwd, baseDir, edits: typedParams.edits });
                    prepared = await applyManagedMixedEdit(cwd, key, targets, prepare);
                } else {
                    prepared = await prepare();
                    for (const edit of prepared)
                        if (!edit.plan?.document) {
                            await applySourceEdit(cwd, edit);
                            written.push(edit);
                        }
                    const documents = preparedDocuments(prepared);
                    if (documents.length) await savePlanFileBatch(cwd, documents);
                }
                const diffSections = [];
                let firstChangedLine;
                for (const [i, edit] of prepared.entries()) {
                    const diff = multiFileEdit.diff(edit.original, edit.replacement);
                    diffSections.push(`--- ${targets[i].label}\n${diff.diff}`);
                    firstChangedLine ??= diff.firstChangedLine;
                }
                const replacementCount = typedParams.edits.length;
                const fileCount = groupedEdits.size;
                const replacementNoun = replacementCount === 1 ? "replacement" : "replacements";
                const fileNoun = fileCount === 1 ? "file" : "files";
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Successfully applied ${replacementCount} ${replacementNoun} across ${fileCount} ${fileNoun}.`,
                        },
                    ],
                    details: { diff: diffSections.join("\n\n"), firstChangedLine },
                };
            } catch (err) {
                for (const edit of written.toReversed()) {
                    try {
                        await withFileMutationQueue(edit.path, async () => {
                            if (edit.plan)
                                await operatePlanFile(cwd, {
                                    path: edit.path,
                                    mode: "edit",
                                    oldText: edit.replacement,
                                    newText: edit.original,
                                });
                            else if ((await fsReadFile(edit.path, "utf8")) === edit.replacement)
                                await fsWriteFile(edit.path, edit.original);
                        });
                    } catch {
                        /* Preserve concurrent edits and report the original failure. */
                    }
                }
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text", text: message }],
                    details: null,
                    isError: true,
                };
            }
        },
    });
}
