/**
 * @module shared/workflow/validation-prompts
 *
 * Loading the bundled prompts Workflow Validation runs on: the Reviewer,
 * the Reviewer-Feedback Engineer, and the manual QA checklist.
 */

import { SUBAGENTS } from "../../constants.js";
import { loadSubAgentDefinition } from "../session/subagent-definitions.ts";

// Validation prompts use the same layered role names in every runtime.
export { getAgentDisplayName } from "../session/agents.js";

/**
 * Load reviewer as a bare workflow prompt instead of a normal agent definition.
 * Normal agent definitions are wrapped with RunWield' shared system prompt, which
 * advertises skills, memory, and exploration tools. Semantic review is a
 * mechanical plan-vs-diff check, so it intentionally receives none of that by default.
 *
 * Every review gets the plan, read-only repository exploration tools (`read`,
 * `grep`, `find`, `ls`), and the `review_diff` tool. The diff is never inlined —
 * there is one delivery path for every round regardless of size. Reviewer has no
 * memory tools so its judgment remains grounded in the supplied evidence.
 *
 * `mode` selects the round contract: `"discovery"` sweeps the whole Plan (rounds
 * one and two), `"verify"` only checks the open ledger and the repair delta
 * (rounds three and above).
 *
 * @param {"discovery" | "verify"} [mode]
 * @returns {Promise<import('../session/types.js').AgentDefinition>}
 */
export async function loadReviewerPrompt(mode: "discovery" | "verify" = "discovery") {
    return await loadSubAgentDefinition(SUBAGENTS.REVIEWER, {
        reviewerMode: mode,
    });
}

/**
 * Load the Reviewer-Feedback Engineer definition.
 *
 * Unlike the Reviewer, this is a real execution agent and receives the full
 * shared system prompt via the subagent definition registry. Workflow Validation
 * dispatches it — a user never selects it, so it must stay out of `/agent`
 * listings and hidden subagent targets.
 *
 * @returns {Promise<import('../session/types.js').AgentDefinition>}
 */
export async function loadReviewerFeedbackEngineerDef() {
    return await loadSubAgentDefinition(SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER);
}

/**
 * Load the post-verification Manual QA generator as a bare, tool-free prompt.
 *
 * @returns {Promise<import('../session/types.js').AgentDefinition>}
 */
export async function loadManualQaPrompt() {
    return await loadSubAgentDefinition(SUBAGENTS.MANUAL_QA);
}
