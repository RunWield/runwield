import type { MultiFileEditParams } from "./definitions/multi-file-edit.ts";
export type MultiFileEdit = MultiFileEditParams["edits"][number];
export type TextReplacement = Pick<MultiFileEdit, "oldText" | "newText">;

type LineEnding = "\n" | "\r\n";

interface StripBomResult {
    bom: string;
    text: string;
}

export interface EditedTextDiff {
    diff: string;
    firstChangedLine: number | undefined;
}

interface EditMatch {
    index: number;
    length: number;
    newText: string;
    editIdx: number;
}

function stripBom(content: string): StripBomResult {
    if (content.startsWith("\uFEFF")) {
        return { bom: "\uFEFF", text: content.slice(1) };
    }
    return { bom: "", text: content };
}

function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: LineEnding): string {
    if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
    return text;
}

function detectLineEnding(content: string): LineEnding {
    const crlfIdx = content.indexOf("\r\n");
    const lfIdx = content.indexOf("\n");
    if (lfIdx === -1 || crlfIdx === -1) return "\n";
    return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function generateDiffString(oldContent: string, newContent: string): EditedTextDiff {
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

function applyEdits(normalizedContent: string, edits: readonly TextReplacement[], path: string): string {
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

    return newContent;
}

/** Apply a file's edits atomically in memory, retaining its BOM and original line endings. */
export function applyExactTextEdits(original: string, edits: readonly TextReplacement[], path: string): string {
    const { bom, text } = stripBom(original);
    const newContent = applyEdits(normalizeToLF(text), edits, path);
    return bom + restoreLineEndings(newContent, detectLineEnding(text));
}

/** Compare the original and edited text using the tool’s numbered diff format. */
export function diffEditedText(original: string, replacement: string): EditedTextDiff {
    return generateDiffString(normalizeToLF(stripBom(original).text), normalizeToLF(stripBom(replacement).text));
}

/** A model argument before schema validation. Unsupported field types can pass through unchanged. */
export type MultiFileEditInput =
    string | number | boolean | null | undefined | readonly MultiFileEditInput[] | MultiFileEditInputRecord;

interface MultiFileEditInputRecord {
    readonly [key: string]: MultiFileEditInput;
}

/** An argument record with normalized paths and edit fields still awaiting schema validation. */
export interface MultiFileEditCandidate {
    root?: string;
    edits: readonly MultiFileEditInput[];
}

function isInputRecord(input: MultiFileEditInput): input is MultiFileEditInputRecord {
    return input !== null && typeof input === "object" && !Array.isArray(input);
}

/** Accept legacy single edits and path aliases before the caller validates the current schema. */
export function prepareMultiFileEditArguments<Input extends MultiFileEditInput>(
    input: Input,
): Input | MultiFileEditCandidate {
    if (!isInputRecord(input)) return input;

    const args = input;
    const topLevelPath =
        typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;

    if (Array.isArray(args.edits)) {
        const rawEdits: readonly MultiFileEditInput[] = args.edits;
        const edits = rawEdits.map((rawEdit) => {
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
        };
    }

    if (topLevelPath && typeof args.oldText === "string" && typeof args.newText === "string") {
        return {
            ...(typeof args.root === "string" ? { root: args.root } : {}),
            edits: [{ path: topLevelPath, oldText: args.oldText, newText: args.newText }],
        };
    }

    return input;
}

/** Group edits by the supplied path in submission order. Path resolution is the caller’s responsibility. */
export function groupEditsByPath(edits: readonly MultiFileEdit[]): Map<string, MultiFileEdit[]> {
    const grouped = new Map<string, MultiFileEdit[]>();
    for (const edit of edits) {
        const existing = grouped.get(edit.path) || [];
        existing.push(edit);
        grouped.set(edit.path, existing);
    }
    return grouped;
}
