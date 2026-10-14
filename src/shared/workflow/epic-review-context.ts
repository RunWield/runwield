/**
 * @module shared/workflow/epic-review-context
 * What a child's Semantic Review needs from its Epic, and where its notes go.
 *
 * A child of an Epic with its own branch is reviewed for its own correctness.
 * The request carries an `### Epic Context` section — the Epic's objective and
 * what each sibling owns — so work a sibling owns is not mistaken for a gap.
 * What only the assembled Epic can show is recorded as Integration Notes in a
 * RunWield-managed `### Integration Notes` subsection of the Epic's
 * Verification Plan, which the Integration Reviewer reads as places to look.
 */

import {
    compareChildPlansByOrder,
    findPlansByParent,
    loadPlan,
    writePlanMarkdownWithRevisionLocked,
} from "../../plan-store.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import { isPlannedChangeClassification } from "../../constants.js";
import { isGitRepository } from "../git.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { findTargetBranchPlansByParent } from "./planning-worktree.ts";
import type { ReviewIntegrationNote } from "../../tools/review-complete.ts";
import { SharedPlanLockError } from "../collaboration/lock.ts";

/** The Epic a child belongs to, and the request section that describes it. */
export interface EpicReviewContext {
    epicPlanName: string;
    section: string;
}

const NOTES_HEADING = "### Integration Notes";

function hasEpicBranch(attrs: Partial<PlanFrontMatter>): boolean {
    return attrs.classification === "PROJECT" && attrs.type !== "sequence" &&
        typeof attrs.targetBranch === "string" && attrs.targetBranch.trim() !== "";
}

/** The body of one `## Heading` section, without its heading. */
function markdownSection(markdown: string, heading: string): string {
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
    if (start < 0) return "";
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^##\s/.test(line));
    return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** The Epic family as the Epic branch and registered worktrees see it, falling back to the document checkout. */
async function epicChildren(primaryRoot: string, epicPlanName: string, epic: PlanFrontMatter) {
    const branch = String(epic.targetBranch || "").trim();
    const family = branch && await isGitRepository(primaryRoot)
        ? await findTargetBranchPlansByParent(primaryRoot, branch, epicPlanName).catch(() => null)
        : null;
    return (family || await findPlansByParent(primaryRoot, epicPlanName))
        .filter((child) => isPlannedChangeClassification(child.attrs.classification))
        .sort(compareChildPlansByOrder);
}

/**
 * Build the `### Epic Context` request section for a child of an Epic with its
 * own branch. Returns null for a standalone Plan, a Sequence child, or an Epic
 * without a branch, which keep the ordinary review.
 */
export async function loadEpicReviewContext(
    projectRoot: string,
    childPlanName: string,
    childAttrs: Partial<PlanFrontMatter> | undefined,
): Promise<EpicReviewContext | null> {
    const epicPlanName = typeof childAttrs?.parentPlan === "string" ? childAttrs.parentPlan.trim() : "";
    if (!epicPlanName) return null;
    const primaryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const epic = (await resolveWorkflowPlanLocation(primaryRoot, epicPlanName, { readOnly: true })).plan;
    if (!epic || !hasEpicBranch(epic.attrs)) return null;
    const objective = markdownSection(epic.markdown, "Objective") || "(The Epic has no Objective section.)";
    const siblings = (await epicChildren(primaryRoot, epicPlanName, epic.attrs)).map((child) => {
        const marker = child.name === childPlanName ? " ← this Plan" : "";
        const summary = child.attrs.summary ? `: ${child.attrs.summary}` : "";
        return `- ${child.name} (${child.attrs.status})${summary}${marker}`;
    });
    return {
        epicPlanName,
        section: [
            "### Epic Context",
            "",
            `This Plan is one child of the Epic ${epicPlanName}. Review only whether this child's work is correct for this`,
            "child's Plan. Work a sibling owns is not a finding. Record anything only the assembled Epic can show as",
            "`integrationNotes`, or leave them out.",
            "",
            "#### Epic Objective",
            "",
            objective,
            "",
            "#### Children",
            "",
            ...(siblings.length ? siblings : ["- (none listed)"]),
        ].join("\n"),
    };
}

function noteMarker(kind: "start" | "end", childPlanName: string): string {
    return `<!-- runwield:integration-notes:${kind} child="${childPlanName.replaceAll('"', "&quot;")}" -->`;
}

function renderNotesBlock(childPlanName: string, notes: ReviewIntegrationNote[]): string {
    return [
        noteMarker("start", childPlanName),
        `**${childPlanName}**`,
        "",
        ...notes.map((note) => `- ${note.check}${note.where ? ` (${note.where})` : ""}`),
        noteMarker("end", childPlanName),
    ].join("\n");
}

/**
 * Place one child's notes in the Epic's managed `### Integration Notes`
 * subsection. A child's earlier block is replaced; the rest of the Epic body,
 * which the user owns, is left as it is.
 */
export function withIntegrationNotes(markdown: string, childPlanName: string, notes: ReviewIntegrationNote[]): string {
    const block = renderNotesBlock(childPlanName, notes);
    const start = noteMarker("start", childPlanName);
    const end = noteMarker("end", childPlanName);
    const startIndex = markdown.indexOf(start);
    const endIndex = markdown.indexOf(end);
    if (startIndex >= 0 && endIndex > startIndex) {
        return markdown.slice(0, startIndex) + block + markdown.slice(endIndex + end.length);
    }

    const lines = markdown.replace(/\s+$/, "").split("\n");
    const headingIndex = lines.findIndex((line) => line.trim() === NOTES_HEADING);
    if (headingIndex >= 0) {
        const after = lines.slice(headingIndex + 1).findIndex((line) => /^#{2,3}\s/.test(line));
        const insertAt = after < 0 ? lines.length : headingIndex + 1 + after;
        const before = lines.slice(0, insertAt).join("\n").replace(/\s+$/, "");
        const rest = lines.slice(insertAt).join("\n");
        return `${before}\n\n${block}\n${rest ? `\n${rest}\n` : ""}`;
    }

    const verificationIndex = lines.findIndex((line) => /^##\s+Verification Plan\s*$/i.test(line));
    const section =
        `${NOTES_HEADING}\n\nLeft by the reviewers of individual children for the integration review. These are places to look, not requirements.\n\n${block}`;
    if (verificationIndex < 0) return `${lines.join("\n")}\n\n${section}\n`;
    const after = lines.slice(verificationIndex + 1).findIndex((line) => /^##\s/.test(line));
    const insertAt = after < 0 ? lines.length : verificationIndex + 1 + after;
    const before = lines.slice(0, insertAt).join("\n").replace(/\s+$/, "");
    const rest = lines.slice(insertAt).join("\n");
    return `${before}\n\n${section}\n${rest ? `\n${rest}\n` : ""}`;
}

/**
 * Write a child reviewer's Integration Notes into its Epic. Nothing to note
 * writes nothing. Returns the Epic-relative description of what changed, or
 * null when nothing was written.
 */
export async function recordIntegrationNotes(
    projectRoot: string,
    epicPlanName: string,
    childPlanName: string,
    notes: ReviewIntegrationNote[] | undefined,
): Promise<string | null> {
    if (!notes || notes.length === 0) return null;
    const primaryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const location = await resolveWorkflowPlanLocation(primaryRoot, epicPlanName, { readOnly: true });
    const epic = location.plan ? await loadPlan(location.documentRoot, epicPlanName) : null;
    if (!epic) return null;
    const next = withIntegrationNotes(epic.markdown, childPlanName, notes);
    if (next === epic.markdown) return null;
    try {
        await writePlanMarkdownWithRevisionLocked(location.documentRoot, epicPlanName, epic.path, next, epic.revision);
    } catch (error) {
        // A shared Epic is written through collaboration; the notes stay in the review result instead.
        if (error instanceof SharedPlanLockError) return null;
        throw error;
    }
    return `docs/plans/${epicPlanName}.md`;
}
