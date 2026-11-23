/** Tool names that advance workflows or remain expanded in the UI. */

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
