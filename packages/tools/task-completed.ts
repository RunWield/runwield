import { Type, type TObject, type TString } from "typebox";

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

const DEFAULT_MESSAGE_DESCRIPTION = "Concise summary of the task you completed and what you verified.";
const FRONTEND_ENGINEER_MESSAGE_DESCRIPTION =
    ENGINEER_MESSAGE_DESCRIPTION +
    " Include final URL/route, headed-browser checks, relevant viewports/states, diagnostics, and visible evidence; Pair checkpoint acceptance is not verification evidence.";

export type BrowserPreflightOutcome = "succeeded" | "failed" | "externally_blocked";
const DESCRIPTION =
    "Declare that you have finished the execution task you were assigned. " +
    "For PLANNED_CHANGE and PROJECT workflows, this signals the orchestrator to begin saved-plan validation. " +
    "For OPERATION work, the Operator must self-verify before calling this tool and no RunWield validation loop runs afterward. " +
    "For QUICK_FIX work, the Engineer must verify before calling this tool; RunWield then runs no-plan Mechanical Validation. " +
    "For frontend UI/UX work, include the dev server URL, headed browser checks performed, and visible evidence. " +
    "Call when your assigned work is done, and include a concise " +
    "report in the required `message` parameter, following its description for content and format. " +
    "A first eligible call with running Background Tasks rejects and lists them; another call cancels remaining " +
    "tasks and accepts completion. Check task status or cancel them yourself before retrying. " +
    "Calling it again is harmless — if the workflow or user asks for another report, comply. " +
    "DO NOT call this tool when you are blocked: a step is impossible, two steps contradict each other, " +
    "something the work depends on does not exist, a credential, permission, service, or artifact you need is " +
    "unavailable, or any part of the assignment could not be done. A blocker ends your turn in plain text — " +
    "say exactly what stopped you and what would unblock it, and stop. Calling this tool while blocked starts " +
    "validation over work that never happened, or reports the Plan as done when it is not. " +
    "If you need to ask the user a clarifying question before finishing, DO NOT call this tool — " +
    "just output the question in text.";

export type TaskCompletedReportKind = "summary" | "implementation" | "frontend-implementation";

const definition = {
    name: "task_completed",
    exposure: "model-only",
    label: "Task Completed",
    description: DESCRIPTION,
} as const;

function createFrontendParameters(message: TString) {
    return Type.Object({
        message,
        browserPreflightOutcome: Type.Union(
            [Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("externally_blocked")],
            {
                description:
                    "Content-free browser/dev-server preflight outcome: succeeded, failed, or externally_blocked.",
            },
        ),
    });
}

type TaskCompletedDefinition = typeof definition & {
    parameters: TObject<{ message: TString }> | ReturnType<typeof createFrontendParameters>;
};

/** Build the parameter schema for the report the host expects from the current Agent. */
export function createTaskCompletedDefinition(reportKind: TaskCompletedReportKind): TaskCompletedDefinition {
    const messageDescription =
        reportKind === "frontend-implementation"
            ? FRONTEND_ENGINEER_MESSAGE_DESCRIPTION
            : reportKind === "implementation"
              ? ENGINEER_MESSAGE_DESCRIPTION
              : DEFAULT_MESSAGE_DESCRIPTION;
    const message = Type.String({
        description: messageDescription,
        minLength: IMPLEMENTATION_REPORT_MIN_LENGTH,
    });
    return {
        ...definition,
        parameters:
            reportKind === "frontend-implementation" ? createFrontendParameters(message) : Type.Object({ message }),
    };
}
