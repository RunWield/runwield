/**
 * @module shared/workflow/review-diff-tool
 * Read-only diff inspection custom tool for the semantic reviewer.
 * Parses unified diff text into per-file entries and exposes bounded
 * list/show operations so the reviewer can inspect changed files
 * without receiving the entire inline diff.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { publishWorkflowToolEvent } from "./workflow-tool-events.ts";

/**
 * @typedef {Object} DiffFileEntry
 * @property {string} path - File path (from b/ side of diff header).
 * @property {"added" | "deleted" | "modified" | "renamed" | "copied"} changeType
 * @property {number} byteLength - Total byte length of this file's diff hunk.
 * @property {number} lineCount - Total line count of this file's diff hunk.
 * @property {{ added: number, removed: number }} hunkLines - Line counts per hunk type.
 * @property {string} text - The full diff text for this file.
 */

/** A non-empty review patch whose changed files cannot be read. */
export class ReviewDiffParseError extends Error {
    constructor() {
        super("RunWield could not read the changed files from the review diff. The change was not approved.");
        this.name = "ReviewDiffParseError";
    }
}

/**
 * Read the files required for approval, without treating unreadable content as an empty patch.
 * @param {string} text
 * @returns {DiffFileEntry[]}
 */
export function requiredReviewDiffFiles(text) {
    const files = parseDiffFiles(text);
    if (text.trim() && files.length === 0) throw new ReviewDiffParseError();
    return files;
}

/**
 * Parse unified diff text into an array of per-file entries.
 * Handles standard diff --git headers, renames, copies, new/deleted files,
 * and binary files.
 *
 * @param {string} diffText - Raw unified diff output.
 * @returns {DiffFileEntry[]}
 */
export function parseDiffFiles(diffText) {
    if (!diffText || !diffText.trim()) return [];

    /** @type {DiffFileEntry[]} */
    const entries = [];
    const headerPattern = /^diff --git (?:"a\/(?:\\.|[^"])*"|a\/.*?) ("b\/(?:\\.|[^"])*"|b\/.*)$/gm;

    // Collect header positions manually to split the diff into per-file chunks
    /** @type {{ bPath: string, start: number }[]} */
    const headers = [];
    /** @type {RegExpExecArray | null} */
    let match;
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
        /** @type {"added" | "deleted" | "modified" | "renamed" | "copied"} */
        let changeType = "modified";
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

/** Decode Git's C-quoted paths, including octal UTF-8 bytes.
 * @param {string} path
 * @returns {string}
 */
function decodeDiffPath(path) {
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

/**
 * Produce a human-readable summary line for a file change.
 *
 * @param {DiffFileEntry} entry
 * @returns {string}
 */
export function formatDiffFileSummary(entry) {
    const typeLabel = entry.changeType.charAt(0).toUpperCase() + entry.changeType.slice(1);
    const lineInfo = `${entry.hunkLines.added} added, ${entry.hunkLines.removed} removed`;
    const sizeInfo = `(${formatByteSize(entry.byteLength)})`;
    return `  ${typeLabel}: ${entry.path} — ${lineInfo} ${sizeInfo}`;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatByteSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Produce a markdown changed-file listing for the review prompt.
 *
 * @param {DiffFileEntry[]} entries
 * @returns {string}
 */
export function formatChangedFileList(entries) {
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

/**
 * @typedef {Object} DiffReviewStats
 * @property {number} changedFiles
 * @property {number} changedLines
 * @property {number} addedLines
 * @property {number} removedLines
 * @property {string[]} meaningfulAreas
 * @property {boolean} lowSignalOnly
 * @property {string[]} paths
 */

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

/**
 * Compute compact review-planning statistics from parsed diff entries.
 *
 * @param {DiffFileEntry[]} entries
 * @returns {DiffReviewStats}
 */
export function summarizeDiffForReview(entries) {
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

/**
 * @param {string} path - The requested file path.
 * @param {DiffFileEntry[]} entries
 * @param {{ offsetBytes?: number, maxBytes?: number }} [options]
 * @returns {{ found: true, entry: DiffFileEntry, content: string, offsetBytes: number, nextOffsetBytes: number, truncated: boolean, remainingBytes: number } | { found: false, message: string }}
 */
export function getFileDiff(entries, path, options = {}) {
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

/**
 * Summary info for a single diff file.
 *
 * @typedef {Object} DiffFileSummary
 * @property {string} path
 * @property {string} changeType
 * @property {number} byteLength
 * @property {number} lineCount
 * @property {{ added: number, removed: number }} hunkLines
 * @property {boolean} truncated - True if the full diff exceeds the max inline display size.
 * @property {number | null} maxInlineBytes - The max inline display size, or null if not truncated.
 */

/**
 * Build a list of file summaries for display, with truncation metadata.
 *
 * @param {DiffFileEntry[]} entries
 * @param {number} [maxInlineBytes]
 * @returns {DiffFileSummary[]}
 */
export function listDiffFiles(entries, maxInlineBytes = 64 * 1024) {
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

/**
 * Create the review_diff custom tool for the semantic reviewer.
 * The tool provides bounded, read-only access to the workflow diff.
 *
 * Two scopes exist because a verification round asks two different questions.
 * `full` is the whole proposed branch patch from the target/HEAD common
 * ancestor to current files and answers "does anything diverge from the Plan".
 * `repair` is only what the last repair
 * changed and answers "did the repair fix the open findings without breaking
 * something". Round one has no repair scope.
 *
 * @param {string | { full: string, repair?: string }} diffs - Workflow diff text, or per-scope diff texts.
 * @param {ReviewDiffToolOptions} [options]
 * @returns {ReturnType<typeof defineTool>}
 */
export function createReviewDiffTool(diffs, options = {}) {
    const fullText = typeof diffs === "string" ? diffs : diffs?.full || "";
    const repairText = typeof diffs === "string" ? "" : diffs?.repair || "";
    const hasRepairScope = typeof diffs !== "string" && typeof diffs?.repair === "string";
    /** @type {Record<string, DiffFileEntry[]>} */
    const entriesByScope = {
        full: parseDiffFiles(fullText),
        repair: parseDiffFiles(repairText),
    };
    const MAX_INLINE_BYTES = 64 * 1024;
    const MAX_READ_BYTES = 64 * 1024;

    const scopeDescription = hasRepairScope
        ? " Scope 'full' is the entire proposed branch patch, including uncommitted work; scope 'repair' is only what the most recent repair changed."
        : "";

    const tool = defineTool({
        name: "review_diff",
        label: "Review Diff",
        description:
            "Bounded, read-only access to the current workflow diff. Use 'list' to see changed files with sizes, or 'show' to read the diff for a specific file path. Does not run git commands." +
            scopeDescription,
        promptSnippet:
            "review_diff(list|show): List changed files or read the diff for one file. Prefer 'list' first to see what changed, then 'show <path>' to inspect specific files.",
        parameters: Type.Object({
            command: StringEnum(["list", "show"]),
            scope: Type.Optional(
                StringEnum(["full", "repair"], {
                    description:
                        "Which diff to inspect. 'full' (default) shows the proposed branch patch from its common ancestor with the recorded target through current worktree files. 'repair' is only what the most recent repair changed, and is available from the second review round onward.",
                }),
            ),
            path: Type.Optional(
                Type.String({
                    description:
                        "Required for 'show'. The file path to inspect. Accepts partial path matches for convenience.",
                }),
            ),
            offsetBytes: Type.Optional(
                Type.Integer({
                    minimum: 0,
                    description:
                        "Byte offset into the file's diff content. Use to page through large per-file diffs. Default: 0.",
                }),
            ),
            maxBytes: Type.Optional(
                Type.Integer({
                    minimum: 256,
                    maximum: MAX_READ_BYTES,
                    description: `Maximum bytes to return for this file's diff. Default: ${MAX_READ_BYTES}. Max: ${MAX_READ_BYTES}.`,
                }),
            ),
        }),
        execute(toolCallId, rawParams) {
            /** @type {{ command: string, scope?: string, path?: string, offsetBytes?: number, maxBytes?: number }} */
            const params = /** @type {any} */ (rawParams);
            const scope = params.scope === "repair" ? "repair" : "full";

            if (scope === "repair" && !hasRepairScope) {
                return Promise.resolve({
                    content: [
                        {
                            type: "text",
                            text: "No repair scope in this round: nothing has been repaired yet, so there is no repair diff to inspect. Use scope 'full'.",
                        },
                    ],
                    details: /** @type {any} */ ({ command: params.command || "", scope, available: false }),
                });
            }

            const entries = entriesByScope[scope];
            const scopeLabel = scope === "repair" ? "repair diff" : "workflow diff";

            if (params.command === "list") {
                const summaries = listDiffFiles(entries, MAX_INLINE_BYTES);
                if (summaries.length === 0) {
                    if (options.hostedSession) {
                        publishWorkflowToolEvent({
                            hostedSession: options.hostedSession,
                            toolCallId,
                            kind: "review_diff",
                            payload: { hasDiff: false },
                        });
                    }
                    return Promise.resolve({
                        content: [{ type: "text", text: `No changed files detected in the ${scopeLabel}.` }],
                        details: /** @type {any} */ ({ command: "list", scope, fileCount: 0 }),
                    });
                }

                const lines = [
                    `## Changed Files — ${scopeLabel} (${summaries.length} total)`,
                    "",
                    "| Path | Change | Added | Removed | Size | Full diff available |",
                    "|------|--------|-------|---------|------|---------------------|",
                ];
                for (const s of summaries) {
                    const status = s.truncated ? `Trucated (max ${formatByteSize(MAX_INLINE_BYTES)} shown)` : "Yes";
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

                if (options.hostedSession) {
                    publishWorkflowToolEvent({
                        hostedSession: options.hostedSession,
                        toolCallId,
                        kind: "review_diff",
                        payload: { hasDiff: summaries.length > 0 },
                    });
                }
                return Promise.resolve({
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: /** @type {any} */ ({ command: "list", scope, fileCount: summaries.length }),
                });
            }

            if (params.command === "show") {
                if (!params.path) {
                    return Promise.resolve({
                        content: [{ type: "text", text: "Error: 'path' is required for 'show' command." }],
                        isError: true,
                        details: /** @type {any} */ ({ command: "show", scope }),
                    });
                }

                const result = getFileDiff(entries, params.path, {
                    offsetBytes: params.offsetBytes,
                    maxBytes: params.maxBytes || MAX_READ_BYTES,
                });

                if (!result.found) {
                    return Promise.resolve({
                        content: [{ type: "text", text: result.message }],
                        isError: true,
                        details: /** @type {any} */ ({ command: "show", scope, path: params.path, found: false }),
                    });
                }

                const content = [`## Diff: ${result.entry.path} (${scopeLabel})`];
                if (result.entry.changeType !== "modified") {
                    content.push(`Change type: ${result.entry.changeType}`);
                }
                if (result.truncated) {
                    content.push(
                        "",
                        `[Diff truncated at ${formatByteSize(
                            params.maxBytes || MAX_READ_BYTES,
                        )}. Use offsetBytes=${result.nextOffsetBytes} to read next chunk. ${formatByteSize(
                            result.remainingBytes,
                        )} remaining.]`,
                    );
                }
                content.push("", "```diff", result.content, "```");

                options.inspection?.record(scope, result.entry.path, result.offsetBytes, result.nextOffsetBytes);

                if (options.hostedSession) {
                    publishWorkflowToolEvent({
                        hostedSession: options.hostedSession,
                        toolCallId,
                        kind: "review_diff",
                        payload: { hasDiff: true },
                    });
                }
                return Promise.resolve({
                    content: [{ type: "text", text: content.join("\n") }],
                    details: /** @type {any} */ ({
                        command: "show",
                        scope,
                        path: result.entry.path,
                        truncated: result.truncated,
                        remainingBytes: result.remainingBytes,
                        nextOffsetBytes: result.nextOffsetBytes,
                    }),
                });
            }

            return Promise.resolve({
                content: [{ type: "text", text: `Error: unknown command "${params.command}". Use 'list' or 'show'.` }],
                isError: true,
                details: /** @type {any} */ ({ command: params.command || "", scope, error: "unknown_command" }),
            });
        },
    });
    Object.assign(tool, { __runwieldReviewDiffs: diffs, __runwieldReviewOptions: options });
    return tool;
}

/**
 * @typedef {Object} ReviewDiffToolOptions
 * @property {import('../session/hosted-session.js').HostedSession} [hostedSession]
 * @property {import('./review-inspection.ts').ReviewInspection} [inspection]
 * @property {import('./review-ledger.ts').ReviewLedger} [ledger]
 */

/**
 * Build the changed-files overview and diff-inspection instructions shared by
 * every review round.
 *
 * The diff is never inlined into a review prompt: the Reviewer always reads it
 * through `review_diff`, so there is one delivery path and no size threshold to
 * tune. This overview exists so the Reviewer can plan which files to open.
 *
 * @typedef {Object} DiffInspectionOptions
 * @property {boolean} [hasRepairScope]
 * @property {"full" | "repair"} [scope]
 */

/**
 * @param {string} diffText - The diff for the selected scope.
 * @param {DiffInspectionOptions} [options]
 * @returns {string}
 */
export function buildDiffInspectionSection(diffText, options = {}) {
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
