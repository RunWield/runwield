/** Host-neutral, read-only diff parsing and byte paging. */
import type { ReviewDiffScope, ReviewDiffSpan } from "./review-inspection.ts";

export type DiffChangeType = "added" | "deleted" | "modified" | "renamed" | "copied";
export interface DiffHunkLines {
    added: number;
    removed: number;
}
export interface DiffFileEntry {
    path: string;
    changeType: DiffChangeType;
    byteLength: number;
    lineCount: number;
    hunkLines: DiffHunkLines;
    text: string;
}
interface DiffHeader {
    bPath: string;
    start: number;
}
export interface DiffReviewStats {
    changedFiles: number;
    changedLines: number;
    addedLines: number;
    removedLines: number;
    meaningfulAreas: string[];
    lowSignalOnly: boolean;
    paths: string[];
}
export interface DiffPageOptions {
    offsetBytes?: number;
    maxBytes?: number;
}
export interface DiffPage {
    found: true;
    entry: DiffFileEntry;
    content: string;
    offsetBytes: number;
    nextOffsetBytes: number;
    truncated: boolean;
    remainingBytes: number;
}
export interface DiffPageMissing {
    found: false;
    message: string;
}
export type DiffPageResult = DiffPage | DiffPageMissing;
export interface DiffFileSummary {
    path: string;
    changeType: DiffChangeType;
    byteLength: number;
    lineCount: number;
    hunkLines: DiffHunkLines;
    truncated: boolean;
    maxInlineBytes: number | null;
}
export interface DiffInspectionOptions {
    hasRepairScope?: boolean;
    scope?: ReviewDiffScope;
}
export interface ReviewDiffTexts {
    full: string;
    repair?: string;
}
export interface ReviewDiffParams extends DiffPageOptions {
    command: string;
    scope?: string;
    path?: string;
}
export interface ReviewDiffDetails {
    command: string;
    scope: ReviewDiffScope;
    available?: boolean;
    fileCount?: number;
    path?: string;
    found?: boolean;
    truncated?: boolean;
    remainingBytes?: number;
    nextOffsetBytes?: number;
    error?: string;
}
export interface ReviewDiffRead {
    text: string;
    details: ReviewDiffDetails;
    isError?: boolean;
    hasDiff?: boolean;
    coverage?: ReviewDiffSpan;
}

export function parseDiffFiles(diffText: string): DiffFileEntry[] {
    if (!diffText || !diffText.trim()) return [];

    const entries: DiffFileEntry[] = [];
    const headerPattern = /^diff --git (?:"a\/(?:\\.|[^"])*"|a\/.*?) ("b\/(?:\\.|[^"])*"|b\/.*)$/gm;

    // Collect header positions manually to split the diff into per-file chunks
    const headers: DiffHeader[] = [];
    let match: RegExpExecArray | null;
    while ((match = headerPattern.exec(diffText)) !== null) {
        headers.push({ bPath: decodeDiffPath(match[1]).slice(2), start: match.index });
    }

    if (headers.length === 0) {
        // No standard headers found; try simpler diff or return empty
        return [];
    }

    for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        const end = i + 1 < headers.length ? headers[i + 1].start : diffText.length;
        const chunk = diffText.slice(header.start, end);

        // Determine change type from diff headers within this chunk
        let changeType: DiffChangeType = "modified";
        if (/^new file mode /m.test(chunk)) changeType = "added";
        else if (/^deleted file mode /m.test(chunk)) changeType = "deleted";
        else if (/^rename from /m.test(chunk)) changeType = "renamed";
        else if (/^copy from /m.test(chunk)) changeType = "copied";

        // Check for binary files
        if (/^Binary files /m.test(chunk)) {
            changeType = changeType === "deleted" ? "deleted" : "modified";
        }

        // Count diff lines (lines starting with +, -, or @@)
        let added = 0;
        let removed = 0;
        const lines = chunk.split("\n");
        for (const line of lines) {
            const trimmed = line.trimEnd();
            if (trimmed.startsWith("+") && !trimmed.startsWith("+++")) added++;
            else if (trimmed.startsWith("-") && !trimmed.startsWith("---")) removed++;
        }

        entries.push({
            path: header.bPath,
            changeType,
            byteLength: new TextEncoder().encode(chunk).byteLength,
            lineCount: lines.length,
            hunkLines: { added, removed },
            text: chunk,
        });
    }

    return entries;
}

function decodeDiffPath(path: string): string {
    if (!path.startsWith('"')) return path;
    const escapes = new Map([
        ["a", "\x07"],
        ["b", "\b"],
        ["t", "\t"],
        ["n", "\n"],
        ["v", "\v"],
        ["f", "\f"],
        ["r", "\r"],
    ]);
    const bytes = (path.slice(1, -1).match(/\\[0-7]{3}|\\.|[^\\]+/g) || []).flatMap((part) => {
        if (/^\\[0-7]{3}$/.test(part)) return [parseInt(part.slice(1), 8)];
        const text = part.startsWith("\\") ? escapes.get(part.slice(1)) || part.slice(1) : part;
        return Array.from(new TextEncoder().encode(text));
    });
    return new TextDecoder().decode(new Uint8Array(bytes));
}

export function formatDiffFileSummary(entry: DiffFileEntry): string {
    const typeLabel = entry.changeType.charAt(0).toUpperCase() + entry.changeType.slice(1);
    const lineInfo = `${entry.hunkLines.added} added, ${entry.hunkLines.removed} removed`;
    const sizeInfo = `(${formatByteSize(entry.byteLength)})`;
    return `  ${typeLabel}: ${entry.path} — ${lineInfo} ${sizeInfo}`;
}

export function formatByteSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatChangedFileList(entries: DiffFileEntry[]): string {
    if (entries.length === 0) return "(no changed files detected)";
    const totalBytes = entries.reduce((sum, e) => sum + e.byteLength, 0);
    const totalAdded = entries.reduce((sum, e) => sum + e.hunkLines.added, 0);
    const totalRemoved = entries.reduce((sum, e) => sum + e.hunkLines.removed, 0);
    const lines = [
        `**Total:** ${entries.length} file(s), ${formatByteSize(
            totalBytes,
        )} diff, ${totalAdded} added, ${totalRemoved} removed lines.`,
        "",
    ];

    for (const entry of entries) {
        lines.push(formatDiffFileSummary(entry));
    }

    return lines.join("\n");
}

const LOW_REVIEW_SIGNAL_PATTERNS = [
    /^docs\//,
    /^third_party\//,
    /(^|\/)deno\.lock$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)dist\//,
    /(^|\/)generated\//,
    /\.md$/,
];

export function summarizeDiffForReview(entries: DiffFileEntry[]): DiffReviewStats {
    const paths = entries.map((entry) => entry.path);
    const lowSignalOnly =
        entries.length > 0 &&
        entries.every((entry) => LOW_REVIEW_SIGNAL_PATTERNS.some((pattern) => pattern.test(entry.path)));
    const meaningfulAreas = [
        ...new Set(
            entries.flatMap((entry) => {
                if (LOW_REVIEW_SIGNAL_PATTERNS.some((pattern) => pattern.test(entry.path))) return [];
                const [first, second] = entry.path.split("/");
                return first === "src" && second ? [`src/${second}`] : [first || entry.path];
            }),
        ),
    ].sort();
    const addedLines = entries.reduce((sum, entry) => sum + entry.hunkLines.added, 0);
    const removedLines = entries.reduce((sum, entry) => sum + entry.hunkLines.removed, 0);
    return {
        changedFiles: entries.length,
        changedLines: addedLines + removedLines,
        addedLines,
        removedLines,
        meaningfulAreas,
        lowSignalOnly,
        paths,
    };
}

export function getFileDiff(entries: DiffFileEntry[], path: string, options: DiffPageOptions = {}): DiffPageResult {
    const entry = entries.find((e) => e.path === path) || entries.find((e) => e.path.endsWith(`/${path}`));
    if (!entry) {
        return { found: false, message: `File "${path}" not found in diff. Use "list" to see available files.` };
    }

    const offsetBytes = options.offsetBytes || 0;
    const maxBytes = options.maxBytes || 64 * 1024;

    if (offsetBytes >= entry.byteLength) {
        return {
            found: true,
            entry,
            content: "",
            offsetBytes: entry.byteLength,
            nextOffsetBytes: entry.byteLength,
            truncated: false,
            remainingBytes: 0,
        };
    }

    const fullBytes = new TextEncoder().encode(entry.text);
    let start = offsetBytes;
    while (start > 0 && (fullBytes[start] & 0xc0) === 0x80) start -= 1;
    let end = Math.min(fullBytes.byteLength, start + maxBytes);
    while (end > start && end < fullBytes.byteLength && (fullBytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === start && end < fullBytes.byteLength) {
        end = Math.min(fullBytes.byteLength, start + maxBytes);
        while (end < fullBytes.byteLength && (fullBytes[end] & 0xc0) === 0x80) end += 1;
    }
    const sliced = fullBytes.slice(start, end);
    const remainingBytes = Math.max(0, fullBytes.byteLength - end);
    const truncated = remainingBytes > 0;

    return {
        found: true,
        entry,
        content: new TextDecoder().decode(sliced),
        offsetBytes: start,
        nextOffsetBytes: end,
        truncated,
        remainingBytes,
    };
}

export function listDiffFiles(entries: DiffFileEntry[], maxInlineBytes = 64 * 1024): DiffFileSummary[] {
    return entries.map((entry) => ({
        path: entry.path,
        changeType: entry.changeType,
        byteLength: entry.byteLength,
        lineCount: entry.lineCount,
        hunkLines: entry.hunkLines,
        truncated: entry.byteLength > maxInlineBytes,
        maxInlineBytes: entry.byteLength > maxInlineBytes ? maxInlineBytes : null,
    }));
}

export function buildDiffInspectionSection(diffText: string, options: DiffInspectionOptions = {}): string {
    const entries = parseDiffFiles(diffText);
    const scopeArg = options.scope === "repair" ? ', scope: "repair"' : "";
    const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
    const lines = [
        "### Changed Files",
        "",
        `The ${options.scope === "repair" ? "repair" : "workflow"} diff is ${formatByteSize(
            totalBytes,
        )} across ${entries.length} file(s). It is not inlined here —` + " read it with `review_diff`.",
        "",
        formatChangedFileList(entries),
        "",
        "### How to Inspect",
        "",
        `1. Start with \`review_diff(command: "list"${scopeArg})\` to see everything in this scope.`,
        `2. Read every listed file with \`review_diff(command: "show"${scopeArg}, path: "<file>")\`. Large per-file diffs come back in` +
            " bounded chunks; page through them with `offsetBytes`.",
        "3. Use `read`, `grep`, `find`, and `ls` for surrounding context: the current contents around changed lines," +
            " related modules, type definitions, and tests the change touches.",
    ];

    if (options.hasRepairScope) {
        lines.push(
            '4. Add `scope: "repair"` to either command to see only what the most recent repair changed. The default' +
                ' scope, `"full"`, is the entire proposed branch patch, including uncommitted work.',
        );
    }

    return lines.join("\n");
}

/** Coverage always uses the canonical path and bytes actually returned, not requested offsets. */
export function getDiffCoverage(page: DiffPage, scope: ReviewDiffScope): ReviewDiffSpan | undefined {
    return page.nextOffsetBytes > page.offsetBytes
        ? { scope, path: page.entry.path, start: page.offsetBytes, end: page.nextOffsetBytes }
        : undefined;
}

export type ReviewDiffReader = (params: ReviewDiffParams) => ReviewDiffRead;
interface ReviewDiffEntries {
    full: DiffFileEntry[];
    repair: DiffFileEntry[];
}

/** Parse each immutable round's diffs once, even when the caller pages through many files. */
export function createReviewDiffReader(diffs: string | ReviewDiffTexts): ReviewDiffReader {
    const entries: ReviewDiffEntries = {
        full: parseDiffFiles(typeof diffs === "string" ? diffs : diffs.full || ""),
        repair: parseDiffFiles(typeof diffs === "string" ? "" : diffs.repair || ""),
    };
    const hasRepairScope = typeof diffs !== "string" && typeof diffs.repair === "string";
    return (params) => readParsedReviewDiff(entries, hasRepairScope, params);
}

/** Shared list/show protocol; adapters only publish events and record returned coverage. */
export function readReviewDiff(diffs: string | ReviewDiffTexts, params: ReviewDiffParams): ReviewDiffRead {
    return createReviewDiffReader(diffs)(params);
}

function readParsedReviewDiff(
    entriesByScope: ReviewDiffEntries,
    hasRepairScope: boolean,
    params: ReviewDiffParams,
): ReviewDiffRead {
    const scope = params.scope === "repair" ? "repair" : "full";
    const details: ReviewDiffDetails = { command: params.command || "", scope };
    if (scope === "repair" && !hasRepairScope) {
        return {
            text: "No repair scope in this round: nothing has been repaired yet, so there is no repair diff to inspect. Use scope 'full'.",
            details: { ...details, available: false },
        };
    }
    const entries = entriesByScope[scope];
    const scopeLabel = scope === "repair" ? "repair diff" : "workflow diff";
    const maxBytes = params.maxBytes || 64 * 1024;
    if (params.command === "list") {
        const summaries = listDiffFiles(entries);
        const listDetails = { ...details, fileCount: summaries.length };
        if (!summaries.length) {
            return { text: `No changed files detected in the ${scopeLabel}.`, details: listDetails, hasDiff: false };
        }
        const lines = [
            `## Changed Files — ${scopeLabel} (${summaries.length} total)`,
            "",
            "| Path | Change | Added | Removed | Size | Full diff available |",
            "|------|--------|-------|---------|------|---------------------|",
        ];
        for (const s of summaries) {
            const status = s.truncated ? `Trucated (max ${formatByteSize(64 * 1024)} shown)` : "Yes";
            lines.push(
                `| \`${s.path}\` | ${s.changeType} | ${s.hunkLines.added} | ${s.hunkLines.removed} | ${formatByteSize(
                    s.byteLength,
                )} | ${status} |`,
            );
        }
        lines.push(
            "",
            `Use \`review_diff(command: "show", scope: "${scope}", path: "<file-path>")\` to read the diff for a specific file.`,
        );
        return { text: lines.join("\n"), details: listDetails, hasDiff: true };
    }
    if (params.command === "show") {
        if (!params.path) return { text: "Error: 'path' is required for 'show' command.", isError: true, details };
        const page = getFileDiff(entries, params.path, { offsetBytes: params.offsetBytes, maxBytes });
        if (!page.found) {
            return { text: page.message, isError: true, details: { ...details, path: params.path, found: false } };
        }
        const content = [`## Diff: ${page.entry.path} (${scopeLabel})`];
        if (page.entry.changeType !== "modified") content.push(`Change type: ${page.entry.changeType}`);
        if (page.truncated) {
            content.push(
                "",
                `[Diff truncated at ${formatByteSize(
                    maxBytes,
                )}. Use offsetBytes=${page.nextOffsetBytes} to read next chunk. ${formatByteSize(
                    page.remainingBytes,
                )} remaining.]`,
            );
        }
        content.push("", "```diff", page.content, "```");
        return {
            text: content.join("\n"),
            details: {
                ...details,
                path: page.entry.path,
                truncated: page.truncated,
                remainingBytes: page.remainingBytes,
                nextOffsetBytes: page.nextOffsetBytes,
            },
            hasDiff: true,
            coverage: getDiffCoverage(page, scope),
        };
    }
    return {
        text: `Error: unknown command "${params.command}". Use 'list' or 'show'.`,
        isError: true,
        details: { ...details, error: "unknown_command" },
    };
}
