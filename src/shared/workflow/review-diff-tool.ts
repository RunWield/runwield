/** Pi tool wrapper for host-neutral review diff reads. */
import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { workflowEvents } from "@runwield/workflow/events";
import { createReviewDiffReader } from "./review-diff.ts";
import type { HostedSession } from "../session/hosted-session.ts";
import type { ReviewInspection } from "./review-inspection.ts";
import type { ReviewLedger } from "@runwield/plans/controller-state";
import type { ReviewDiffTexts } from "./review-diff.ts";

export type {
    DiffFileEntry,
    DiffFileSummary,
    DiffReviewStats,
    DiffInspectionOptions,
    ReviewDiffTexts,
    ReviewDiffDetails,
    ReviewDiffParams,
} from "./review-diff.ts";

export interface ReviewDiffToolOptions {
    hostedSession?: HostedSession;
    inspection?: ReviewInspection;
    ledger?: ReviewLedger;
}

// Preserve the existing imports used by Session prompt builders and callers.
export {
    buildDiffInspectionSection,
    formatChangedFileList,
    formatDiffFileSummary,
    getFileDiff,
    listDiffFiles,
    parseDiffFiles,
    requiredReviewDiffFiles,
    ReviewDiffParseError,
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
 */
export function createReviewDiffTool(diffs: string | ReviewDiffTexts, options: ReviewDiffToolOptions = {}) {
    const readDiff = createReviewDiffReader(diffs);
    const hasRepairScope = typeof diffs !== "string" && typeof diffs?.repair === "string";
    const definition = toolRegistry.get("review_diff").definition;

    const scopeDescription = hasRepairScope
        ? " Scope 'full' is the entire proposed branch patch, including uncommitted work; scope 'repair' is only what the most recent repair changed."
        : "";

    const tool = defineTool({
        ...definition,
        description: definition.description + scopeDescription,
        execute(toolCallId, rawParams) {
            const result = readDiff(rawParams);
            if (result.coverage) {
                const { scope, path, start, end } = result.coverage;
                options.inspection?.record(scope, path, start, end);
            }
            if (options.hostedSession && result.hasDiff !== undefined) {
                workflowEvents(options.hostedSession).publish({
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
