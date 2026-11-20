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
import { Type } from "typebox";
import { isAbsolute, join } from "node:path";
import { getHomeDir } from "../constants.ts";
import { operatePlanFile, resolvePlanFileTarget, savePlanFileBatch, type PlanFileResult } from "../plan-store/index.ts";

const fileEditSchema = Type.Object(
    {
        path: Type.String({
            description: "Path to the file for this replacement, relative to root or the session cwd.",
        }),
        oldText: Type.String({
            description: "Exact text to replace in this file. It must match one unique, non-overlapping region.",
        }),
        newText: Type.String({ description: "Replacement text for oldText." }),
    },
    { additionalProperties: false },
);

const PARAMETERS = Type.Object(
    {
        root: Type.Optional(
            Type.String({
                description:
                    "Optional base directory for relative edit paths. Defaults to the session working directory.",
            }),
        ),
        edits: Type.Array(fileEditSchema, {
            minItems: 1,
            description:
                "One or more replacements. Use edit instead when there is exactly one replacement in one file.",
        }),
    },
    { additionalProperties: false },
);

interface MultiFileEdit {
    path: string;
    oldText: string;
    newText: string;
}

export interface MultiFileEditParams {
    root?: string;
    edits: MultiFileEdit[];
}

type LineEnding = "\n" | "\r\n";

interface StripBomResult {
    bom: string;
    text: string;
}

interface DiffStringResult {
    diff: string;
    firstChangedLine: number | undefined;
}

interface AppliedEditResult {
    baseContent: string;
    newContent: string;
}

interface EditMatch {
    index: number;
    length: number;
    newText: string;
    editIdx: number;
}

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

type MultiFileEditToolDefinition = ToolDefinition<typeof PARAMETERS, MultiFileEditDetails | null>;
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
 * Strip UTF-8 BOM if present.
 *
 * @param {string} content
 * @returns {{ bom: string, text: string }}
 */
function stripBom(content: string): StripBomResult {
    if (content.startsWith("\uFEFF")) {
        return { bom: "\uFEFF", text: content.slice(1) };
    }
    return { bom: "", text: content };
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * @param {string} text
 * @param {string} ending
 * @returns {string}
 */
function restoreLineEndings(text: string, ending: LineEnding): string {
    if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
    return text;
}

/**
 * @param {string} content
 * @returns {string}
 */
function detectLineEnding(content: string): LineEnding {
    const crlfIdx = content.indexOf("\r\n");
    const lfIdx = content.indexOf("\n");
    if (lfIdx === -1 || crlfIdx === -1) return "\n";
    return crlfIdx < lfIdx ? "\r\n" : "\n";
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
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {{ diff: string, firstChangedLine: number | undefined }}
 */
function generateDiffString(oldContent: string, newContent: string): DiffStringResult {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const maxLen = Math.max(oldLines.length, newLines.length);
    const pad = String(maxLen).length;
    const result: string[] = [];
    let firstChangedLine: number | undefined;

    for (let i = 0; i < maxLen; i++) {
        const oldLine = i < oldLines.length ? oldLines[i] : undefined;
        const newLine = i < newLines.length ? newLines[i] : undefined;

        if (oldLine !== newLine) {
            if (firstChangedLine === undefined) firstChangedLine = i + 1;
            if (oldLine !== undefined) result.push(`-${String(i + 1).padStart(pad)} ${oldLine}`);
            if (newLine !== undefined) result.push(`+${String(i + 1).padStart(pad)} ${newLine}`);
        } else {
            result.push(` ${String(i + 1).padStart(pad)} ${oldLine}`);
        }
    }

    return { diff: result.join("\n"), firstChangedLine };
}

/**
 * @param {string} normalizedContent
 * @param {MultiFileEdit[]} edits
 * @param {string} path
 * @returns {{ baseContent: string, newContent: string }}
 */
function applyEdits(normalizedContent: string, edits: MultiFileEdit[], path: string): AppliedEditResult {
    const normalizedEdits = edits.map((edit) => ({
        oldText: normalizeToLF(edit.oldText),
        newText: normalizeToLF(edit.newText),
    }));

    for (let i = 0; i < normalizedEdits.length; i++) {
        if (normalizedEdits[i].oldText.length === 0) {
            throw new Error(`edits[${i}].oldText must not be empty for ${path}.`);
        }
    }

    const matches: EditMatch[] = [];
    for (let i = 0; i < normalizedEdits.length; i++) {
        const { oldText } = normalizedEdits[i];
        const idx = normalizedContent.indexOf(oldText);
        if (idx === -1) {
            throw new Error(`edits[${i}].oldText was not found in ${path}. It must match exactly.`);
        }
        if (normalizedContent.indexOf(oldText, idx + 1) !== -1) {
            throw new Error(`edits[${i}].oldText was found multiple times in ${path}. Add more context.`);
        }
        matches.push({ index: idx, length: oldText.length, newText: normalizedEdits[i].newText, editIdx: i });
    }

    matches.sort((a, b) => a.index - b.index);
    for (let i = 1; i < matches.length; i++) {
        const prev = matches[i - 1];
        const curr = matches[i];
        if (prev.index + prev.length > curr.index) {
            throw new Error(`edits[${prev.editIdx}] and edits[${curr.editIdx}] overlap in ${path}.`);
        }
    }

    let newContent = normalizedContent;
    for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        newContent =
            newContent.substring(0, match.index) + match.newText + newContent.substring(match.index + match.length);
    }

    if (normalizedContent === newContent) {
        throw new Error(`No changes made to ${path}. The replacement(s) produced identical content.`);
    }

    return { baseContent: normalizedContent, newContent };
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
    return defineTool<typeof PARAMETERS, MultiFileEditDetails | null>({
        name: "multi_file_edit",
        label: "multi_file_edit",
        description:
            "Edit one or more files by applying multiple exact-text replacements. Each edits[] item includes its own path, oldText, and newText. Use edit for a single replacement in a single file.",
        promptSnippet:
            "Apply multiple exact-text replacements across one or more files with edits[].path, edits[].oldText, and edits[].newText",
        promptGuidelines: [
            "Use multi_file_edit when a task needs multiple replacements or touches multiple files",
            "Each edits[] item must include path, oldText, and newText",
            "Use edit instead for exactly one replacement in one file",
            "Within each file, oldText entries are matched against the original file content and must not overlap",
        ],
        parameters: PARAMETERS,
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
                        const { bom, text } = stripBom(original);
                        const { newContent } = applyEdits(normalizeToLF(text), target.edits, target.label);
                        const replacement = bom + restoreLineEndings(newContent, detectLineEnding(text));
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
                    const diff = generateDiffString(
                        normalizeToLF(stripBom(edit.original).text),
                        normalizeToLF(stripBom(edit.replacement).text),
                    );
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
