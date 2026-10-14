/**
 * @module tools/registry
 * Shared tool policy constants for agent capability resolution.
 */

/**
 * Tools present for every user-facing Agent and protected from runtime narrowing.
 * Isolated Subagent definitions do not receive this list.
 */
export const UNIVERSAL_AGENT_TOOL_NAMES: readonly string[] = Object.freeze(["set_session_name"]);

/**
 * Tools protected from removal when they are present in an agent's bundled frontmatter.
 */
export const PROTECTED_TOOL_NAMES: readonly string[] = Object.freeze([
    // memory
    "memory",
    // codebase exploration
    "code_search",
    "code_show",
    "code_outline",
    "code_batch",
    "code_refs",
    "code_impact",
    "code_trace",
    "code_investigate",
    "code_structure",
    "code_impls",
    "code_importers",
    // web access
    "web_search",
    "web_fetch",
    "web_code_search",
    "web_docs_search",
    // workflow tools
    "triage_report",
    "plan_written",
    "artifact_written",
    "review_complete",
    "qa_checklist_generated",
    "task_completed",
    "user_interview",
    "work_record_search",
    "work_record_read",
]);

/**
 * Agent-definition tool names that grant `delegate_agent` limited to one mode. Plain `delegate_agent` allows both.
 */
export const DELEGATE_AGENT_MODE_TOOL_NAMES = Object.freeze({
    delegate_agent_read: "read",
    delegate_agent_write: "write",
} as const);

/**
 * Named tool groups an Agent definition can request with `toolSets` instead of
 * listing each tool. Keep these in sync when a tool is added to a family.
 */
export const AGENT_TOOL_SETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    read: Object.freeze([
        "read",
        "grep",
        "find",
        "ls",
        "code_search",
        "code_show",
        "code_outline",
        "code_batch",
        "code_refs",
        "code_impact",
        "code_trace",
        "code_investigate",
        "code_structure",
        "code_impls",
        "code_importers",
        "memory",
        "user_interview",
        "work_record_search",
        "work_record_read",
        "delegate_agent_read",
    ]),
    write: Object.freeze(["edit", "write", "multi_file_edit", "delegate_agent_write"]),
    docs: Object.freeze(["write_docs", "edit_docs"]),
    shell: Object.freeze(["bash", "background_task"]),
    web: Object.freeze(["web_search", "web_fetch", "web_code_search", "web_docs_search"]),
});

/**
 * Tools that advance or finalize a RunWield workflow.
 */
export const WORKFLOW_ADVANCEMENT_TOOL_NAMES: readonly string[] = Object.freeze([
    "triage_report",
    "plan_written",
    "task_completed",
    "review_complete",
    "qa_checklist_generated",
    "pair_checkpoint",
    "record_plan_deviation",
    "slicer_finalize",
    "slicer_finalize_decomposition",
]);

/**
 * Tools that advance a workflow or record its decisions and completed steps stay
 * visible as full blocks. Inspection tools such as review_diff remain ordinary
 * activity, even when the workflow records their results as evidence.
 */
export const WORKFLOW_TOOL_NAMES: readonly string[] = Object.freeze([
    ...WORKFLOW_ADVANCEMENT_TOOL_NAMES,
    "artifact_written",
    "user_interview",
    "work_record_completed",
    "manual_qa_completed",
]);
