/**
 * Canonical agent identifiers. Most values match an agent definition filename
 * (without the `.md` extension) in `packages/agents/definitions/`. The display name
 * for standard agents is the `name:` field inside that file and must be loaded
 * through the Agent Registry.
 *
 * `INIT`, `SLICER`, `REVIEWER`, `REVIEWER_FEEDBACK_ENGINEER`, and `DELEGATED`
 * are workflow-dispatched runtime agent identifiers. Their definitions live in
 * the hidden `SUBAGENTS` registry, not top-level agent discovery, so they do not
 * appear in `/agent` listings.
 *
 * `PLAN_ENGINEER` and `FRONTEND_ENGINEER` are a third kind: workflow-only *root*
 * agents. Their definitions are ordinary top-level, project/home-overridable
 * files, and they become the visible conversational agent while an approved Plan
 * executes — but their `workflowOnly: true` front matter keeps them out of
 * `/agent` listings and manual selection. They are not isolated subagents.
 *
 * Manual QA is also dispatched through `SUBAGENTS`, but it intentionally uses
 * the normal `OPERATOR` runtime agent identifier for its isolated prompt.
 */
export const AGENTS = Object.freeze({
    ROUTER: "router",
    GUIDE: "guide",
    OPERATOR: "operator",
    PLANNER: "planner",
    ARCHITECT: "architect",
    ENGINEER: "engineer",
    PLAN_ENGINEER: "plan-engineer",
    FRONTEND_ENGINEER: "frontend-engineer",
    RECORDER: "recorder",
    AI_REVIEWER: "ai-reviewer",
    REVIEWER: "reviewer",
    REVIEWER_FEEDBACK_ENGINEER: "reviewer-feedback-engineer",
    SLICER: "slicer",
    IDEATOR: "ideator",
    INIT: "init",
    DELEGATED: "delegated",
} as const);

/**
 * Hidden workflow-dispatched subagent definition identifiers. These are loader
 * registry keys, not necessarily the runtime `AgentDefinition.name` returned by
 * the registry entry.
 */
export const SUBAGENTS = Object.freeze({
    DELEGATED: "delegated",
    DELEGATED_READ: "delegated-read",
    INIT: "init",
    INTEGRATION_REVIEWER: "integration-reviewer",
    MANUAL_QA: "manual-qa",
    REVIEWER: "reviewer",
    REVIEWER_FEEDBACK_ENGINEER: "reviewer-feedback-engineer",
    SLICER: "slicer",
} as const);
