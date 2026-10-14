/** Pi tool wrapper for host-neutral review diff reads. */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { publishWorkflowToolEvent } from "./workflow-tool-events.ts";
import { createReviewDiffReader } from "./review-diff.ts";
/** @typedef {import('./review-diff.ts').DiffFileEntry} DiffFileEntry */
/** @typedef {import('./review-diff.ts').DiffFileSummary} DiffFileSummary */
/** @typedef {import('./review-diff.ts').DiffReviewStats} DiffReviewStats */
/** @typedef {import('./review-diff.ts').DiffInspectionOptions} DiffInspectionOptions */
// Preserve the existing imports used by Session prompt builders and callers.
export {
    buildDiffInspectionSection,
    formatChangedFileList,
    formatDiffFileSummary,
    getFileDiff,
    listDiffFiles,
    parseDiffFiles,
    summarizeDiffForReview,
} from "./review-diff.ts";

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
    const readDiff = createReviewDiffReader(diffs);
    const hasRepairScope = typeof diffs !== "string" && typeof diffs?.repair === "string";
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
            const result = readDiff(rawParams);
            if (result.coverage) {
                const { scope, path, start, end } = result.coverage;
                options.inspection?.record(scope, path, start, end);
            }
            if (options.hostedSession && result.hasDiff !== undefined) {
                publishWorkflowToolEvent({
                    hostedSession: options.hostedSession,
                    toolCallId,
                    kind: "review_diff",
                    payload: { hasDiff: result.hasDiff },
                });
            }
            return Promise.resolve({
                content: [{ type: "text", text: result.text }],
                ...(result.isError ? { isError: true } : {}),
                details: result.details,
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
