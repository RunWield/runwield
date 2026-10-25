/**
 * @module shared/workflow/validation-scope
 * Whether Workflow Validation applies at all, and what counts as implementation work.
 *
 * These are policy decisions, not review mechanics: they run before any reviewer,
 * command, or worktree is involved, and they change when the lifecycle rules change
 * rather than when review behavior does.
 */

import { createHash } from "node:crypto";
import { isPlannedChangeClassification } from "../../constants.js";
import type { TriageMeta } from "../../tools/plan-written.ts";

/**
 * A Plan document, as opposed to implementation work.
 *
 * Any path under `docs/plans/` counts, not just this Plan's own file: a Plan that only
 * edits sibling Plan documents has still implemented nothing.
 */
function isPlanDocumentPath(path: string, planName: string): boolean {
    return path === `docs/plans/${planName}.md` || /^docs\/plans\/.+\.md$/.test(path);
}

/** Identify reviewed implementation files without validation's own Plan writes. */
export function candidateIdentity(diffText: string, planName: string): string {
    const implementation = diffText
        .split(/(?=^diff --git )/m)
        .filter((section) => {
            const paths = extractDiffPaths(section);
            return paths.length === 0 || paths.some((path) => !isPlanDocumentPath(path, planName));
        })
        .join("");
    return createHash("sha256").update(implementation).digest("hex");
}

export function extractDiffPaths(diffText: string): string[] {
    const paths: string[] = [];
    const diffHeaderPattern = /^diff --git ("a\/(?:\\.|[^"])*"|a\/.*?) ("b\/(?:\\.|[^"])*"|b\/.*)$/gm;
    let match: RegExpExecArray | null;
    while ((match = diffHeaderPattern.exec(diffText)) !== null) {
        paths.push(...match.slice(1).map((path) => (path.startsWith('"') ? path.slice(3, -1) : path.slice(2))));
    }
    return paths;
}

/**
 * Whether a diff contains work outside the Plan document itself.
 *
 * An unparseable-but-non-empty diff counts as implementation. Failing open here is
 * deliberate: treating an unreadable diff as "no work" would let a Plan claim
 * completion with changes RunWield could not account for.
 */
export function hasImplementationDiff(diffText: string, planName: string): boolean {
    if (!diffText.trim()) return false;
    const diffPaths = extractDiffPaths(diffText);
    if (diffPaths.length === 0) return true;
    return diffPaths.some((path) => !isPlanDocumentPath(path, planName));
}

/**
 * Whether a Plan carries implementation work: it enters Workflow Validation, and
 * its completion claim has to be backed by a real diff.
 *
 * Routing and evidence are two questions, but one rule answers both, so there is
 * one body. {@link requiresImplementationDiff} is the same function under the name
 * the evidence check reads by.
 */
export function shouldRunWorkflowValidation(triageMeta: TriageMeta | undefined): boolean {
    return isPlannedChangeClassification(triageMeta?.classification) || triageMeta?.classification === "PROJECT";
}

/**
 * {@link shouldRunWorkflowValidation}, named for the evidence check that reads
 * `requiresImplementationDiff(meta) && !hasImplementationDiff(diff, plan)`.
 *
 * An alias, not a copy: there is one rule, so the two cannot drift. If a work kind
 * ever needs review without producing code, giving this its own body is the edit
 * that expresses it — and having to make that edit deliberately is the point.
 */
export const requiresImplementationDiff = shouldRunWorkflowValidation;

/** A validated child Plan hands control back to its parent Epic. */
export function shouldContinueParentEpicAfterValidation(triageMeta: TriageMeta | undefined): boolean {
    return (
        isPlannedChangeClassification(triageMeta?.classification) &&
        typeof triageMeta?.parentPlan === "string" &&
        triageMeta.parentPlan.trim().length > 0
    );
}
