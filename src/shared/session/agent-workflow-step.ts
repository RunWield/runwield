import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { IsolatedAgentSessionOptions, SemanticReviewPort } from "../workflow/validation-session-adapter.ts";
import {
    claimWorkflowToolEvent,
    listPendingWorkflowToolEvents,
    waitForWorkflowToolEvent,
    WorkflowStepCompleted,
    type WorkflowToolEvent,
    type WorkflowToolEventKind,
} from "../workflow/workflow-tool-events.ts";

/** Tool acceptance, not a returned transcript, completes an isolated workflow step. */
type AgentWorkflowStepResult = {
    event: WorkflowToolEvent | null;
    diffEvent: WorkflowToolEvent | null;
    messages: AgentMessage[];
};

export async function runValidationAgentUntilEvent(
    port: SemanticReviewPort,
    options: IsolatedAgentSessionOptions,
    terminalKind: WorkflowToolEventKind,
): Promise<AgentWorkflowStepResult> {
    const hostedSession = options.hostedSession;
    const excludeEventIds = listPendingWorkflowToolEvents(hostedSession).map((event) => event.eventId);
    const waitController = new AbortController();
    const turnController = new AbortController();
    const scope = {
        owningSession: null as ReturnType<typeof hostedSession.getRootAgentSession>,
        excludeEventIds,
        sourceSessionId: options.sessionManager?.getSessionId(),
    };
    // Register before starting the external Agent, including synchronous tool acceptance.
    const eventPromise = waitForWorkflowToolEvent(hostedSession, {
        kinds: [terminalKind],
        ...scope,
        signal: waitController.signal,
    });
    const turn = Promise.resolve().then(() =>
        port.runIsolatedAgentSession({
            ...options,
            signal: options.signal ? AbortSignal.any([options.signal, turnController.signal]) : turnController.signal,
        })
    );
    try {
        const first = await Promise.race([
            eventPromise.then((event) => ({ kind: "event" as const, event })),
            turn.then((messages) => ({ kind: "ended" as const, messages })),
        ]);
        if (first.kind === "event") {
            // Stop further edits/tool calls before starting CI. This is cleanup of
            // an already accepted decision, never a request to infer one from output.
            turnController.abort(new WorkflowStepCompleted());
            await turn.catch(() => undefined);
            const diffEvent = claimWorkflowToolEvent(hostedSession, {
                kinds: ["review_diff"],
                ...scope,
                owningSession: first.event.owningSession,
            });
            return { event: first.event, diffEvent, messages: [] };
        }
        return { event: null, diffEvent: null, messages: first.messages };
    } finally {
        waitController.abort();
        await eventPromise.catch(() => undefined);
    }
}
