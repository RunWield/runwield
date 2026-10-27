/** The engineer `task_completed.message` contract shared by Session and Attached carriers. */
export const ENGINEER_MESSAGE_DESCRIPTION =
    "Concise Markdown bullet-point report of the work you completed. Use one bullet per major outcome, review " +
    "feedback item or related group, verification result, or frontend browser check; directly " +
    "state each feedback item's disposition when repairing validation/review feedback; do not submit a prose paragraph. " +
    "This report is for finished work: if something blocked you, do not call this tool at all.";

export const IMPLEMENTATION_REPORT_MIN_LENGTH = 1;

/** Preserve the submitted report, including Markdown whitespace, as the Core tool does. */
export function normalizeImplementationReport(message: string): string {
    if (message.length < IMPLEMENTATION_REPORT_MIN_LENGTH) {
        throw new Error("task_completed.message must be a non-empty string.");
    }
    return message;
}
