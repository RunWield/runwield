import { readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
/**
 * @module tools/multi_file_edit
 *
 * Custom tool for performing multiple exact-text replacements across one or more
 * files. Each edit item carries its own path so the schema is distinct from
 * the single-file `edit` tool.
 */

import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isAbsolute, join } from "node:path";
import { getHomeDir } from "../constants.js";
import { operatePlanFile } from "../plan-store/index.ts";

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

interface WrittenSnapshot {
    path: string;
    content: string;
    writtenPlanContent?: string;
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

function coerceErrorMessage(value: null | undefined | string | number | boolean | Error): string {
    return value instanceof Error ? value.message : String(value);
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
            const diffSections: string[] = [];
            let firstChangedLine: number | undefined;
            let replacementCount = 0;

            const writtenSnapshots: WrittenSnapshot[] = [];
            const applyAllEdits = async () => {
                for (const [filePath, fileEdits] of groupedEdits) {
                    const absolutePath = resolveToBaseDir(filePath, baseDir);
                    await withFileMutationQueue(absolutePath, async () => {
                        try {
                            await fsStat(absolutePath);
                        } catch (err) {
                            const msg =
                                err instanceof Error && "code" in err && err.code === "ENOENT"
                                    ? `Could not find file: ${filePath}`
                                    : `Could not access file: ${filePath}. ${coerceErrorMessage(
                                          err instanceof Error ? err : String(err),
                                      )}`;
                            throw new Error(msg);
                        }

                        const owned = await operatePlanFile(cwd, { path: absolutePath, mode: "read" });
                        const rawContent = owned ? owned.content! : await fsReadFile(absolutePath, "utf8");
                        const { bom, text: content } = stripBom(rawContent);
                        const originalEnding = detectLineEnding(content);
                        const normalizedContent = normalizeToLF(content);
                        const { baseContent, newContent } = applyEdits(normalizedContent, fileEdits, filePath);
                        const finalContent = bom + restoreLineEndings(newContent, originalEnding);

                        if (owned) {
                            await operatePlanFile(cwd, {
                                path: absolutePath,
                                mode: "edit",
                                oldText: rawContent,
                                newText: finalContent,
                            });
                            writtenSnapshots.push({
                                path: absolutePath,
                                content: rawContent,
                                writtenPlanContent: finalContent,
                            });
                        } else {
                            writtenSnapshots.push({ path: absolutePath, content: rawContent });
                            await fsWriteFile(absolutePath, finalContent);
                        }

                        const diffResult = generateDiffString(baseContent, newContent);
                        diffSections.push(`--- ${filePath}\n${diffResult.diff}`);
                        if (firstChangedLine === undefined) firstChangedLine = diffResult.firstChangedLine;
                        replacementCount += fileEdits.length;
                    });
                }
            };

            try {
                await applyAllEdits();

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
                for (const snapshot of writtenSnapshots.toReversed()) {
                    try {
                        if (snapshot.writtenPlanContent !== undefined) {
                            await operatePlanFile(cwd, {
                                path: snapshot.path,
                                mode: "edit",
                                oldText: snapshot.writtenPlanContent,
                                newText: snapshot.content,
                            });
                        } else {
                            await fsWriteFile(snapshot.path, snapshot.content);
                        }
                    } catch {
                        // Preserve the original error; doctor surfaces stale partial Plan edits if rollback cannot finish.
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
