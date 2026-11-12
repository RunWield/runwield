/**
 * @module shared/plan-presentation
 * How a Plan is shown to the user in system messages.
 *
 * Pure formatting: every function here takes Plan data and returns text. Nothing
 * in this module reads or writes the Plan store, so it needs no fixture to test.
 */

import type { PlanFrontMatter } from "../plan-store/index.ts";

/** The parts of a loaded Plan the summary view reads. */
export interface SummarisablePlan {
    attrs: PlanFrontMatter;
    body: string;
    markdown?: string;
}

/**
 * Extract a markdown section by its `## <name>` heading. Returns the body up to
 * (but not including) the next `## ` heading, or null if not found.
 */
function extractSection(body: string, name: string): string | null {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
    const match = body.match(re);
    return match ? match[2].trim() : null;
}

/**
 * Build a compact summary view of a plan: front matter highlights plus the
 * Context and Objective sections (when present).
 */
export function buildPlanSummary(plan: SummarisablePlan): string {
    const a = plan.attrs;
    const lines = [
        `Classification: ${a.classification}`,
        `Complexity:     ${a.complexity}`,
        `Status:         ${a.status}`,
        `Summary:        ${a.summary || "(none)"}`,
    ];
    if (a.targetBranch) lines.push(`Target branch:  ${a.targetBranch}`);
    if (a.affectedPaths?.length) {
        lines.push(`Affected paths:`);
        for (const p of a.affectedPaths) lines.push(`  - ${p}`);
    }

    const sections = [];
    const context = extractSection(plan.body, "Context");
    if (context) sections.push(`── Context ──\n${context}`);
    const objective = extractSection(plan.body, "Objective");
    if (objective) sections.push(`── Objective ──\n${objective}`);

    return [lines.join("\n"), ...sections].join("\n\n");
}
