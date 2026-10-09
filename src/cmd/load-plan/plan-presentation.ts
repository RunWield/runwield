/**
 * @module cmd/load-plan/plan-presentation
 * How a Plan is shown to the user, and the prompts handed to planning agents.
 *
 * Pure formatting: every function here takes Plan data and returns text. Nothing
 * in this module reads or writes the Plan store, so it needs no fixture to test.
 */

import { buildTriageReport } from "../../shared/workflow/workflow-prompts.ts";
import type { PlanFrontMatter } from "../../plan-store.js";

/** One commit in the "these paths changed since the Plan was written" warning. */
export interface CommitHeadsUp {
    hash: string;
    date: string;
    subject: string;
}

/**
 * Build the resume request handed to the planning agent.
 */
export function buildResumeRequest(planName: string, attrs: Partial<PlanFrontMatter>): string {
    return [
        `## Resuming Plan: ${planName}`,
        "",
        `The user re-opened docs/plans/${planName}.md, last saved with status: ${attrs.status}.`,
        "",
        buildTriageReport(attrs),
    ].join("\n");
}

/**
 * Build the prompt that re-runs the planner after the user submits feedback on a
 * previously approved plan that was re-opened for review.
 */
export function buildReReviewRevisionRequest(planName: string, feedback: string | undefined): string {
    return [
        `## Plan Review Re-opened: ${planName}`,
        "",
        `The user provided feedback on the previously approved docs/plans/${planName}.md:`,
        "",
        feedback || "(no specific feedback provided)",
    ].join("\n");
}

/**
 * Build the prompt that sends an executable Plan back to the planning agent for
 * direct re-review without first opening the local review UI.
 */
export function buildPlannerReReviewRequest(planName: string): string {
    return [
        `## Plan Re-review Requested: ${planName}`,
        "",
        `The user wants docs/plans/${planName}.md to go back through Planner re-review before execution, without opening the`,
        "local review UI first. No feedback was submitted with the request.",
    ].join("\n");
}

/** Render the commit list shown before execution starts, capped for readability. */
export function formatCommitHeadsUp(commits: CommitHeadsUp[]): string[] {
    const maxVisible = 12;
    const visible = commits.slice(0, maxVisible).map((commit) =>
        `  - ${commit.hash} ${commit.date} ${commit.subject}`.trimEnd()
    );
    if (commits.length > maxVisible) {
        visible.push(`  - ...and ${commits.length - maxVisible} more`);
    }
    return visible;
}
