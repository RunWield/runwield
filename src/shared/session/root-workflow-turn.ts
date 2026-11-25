import { emitSystemStatus } from "./session-runtime-events.ts";
import { clearAgentSessionQueueForTransition, runRootTurn } from "./session.ts";
import {
    workflowEvents,
    type PlanWrittenEventPayload,
    WorkflowStepCompleted,
    type WorkflowToolEvent,
    type WorkflowToolEventKind,
} from "@runwield/workflow/events";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "./hosted-session.ts";
import type { ImageAttachment } from "./image-attachments.ts";

interface RootAgentSessionState {
    dispose?: () => void | Promise<void>;
    agent?: { state?: { messages?: AgentMessage[] } };
}

interface RootTurnWorkflowEventResult {
    messages: AgentMessage[];
    event: WorkflowToolEvent | null;
}

export async function runRootTurnUntilRootWorkflowEvent(args: {
    hostedSession: HostedSession;
    agentName: string;
    userRequest: string;
    images?: ImageAttachment[];
    customTools?: ToolDefinition[];
    rootAgentSession: RootAgentSessionState | null;
    signal?: AbortSignal;
}): Promise<RootTurnWorkflowEventResult> {
    const waitController = new AbortController();
    const turnController = new AbortController();
    const abortBoth = () => {
        const reason = args.signal?.reason || new DOMException("Root workflow turn canceled.", "AbortError");
        waitController.abort(reason);
        turnController.abort(reason);
    };
    if (args.signal?.aborted) abortBoth();
    args.signal?.addEventListener("abort", abortBoth, { once: true });

    const claimOptions: {
        kinds: WorkflowToolEventKind[];
        owningSession: RootAgentSessionState | null;
        excludeEventIds: string[];
    } = {
        kinds: ["triage_report", "plan_written"],
        owningSession: args.rootAgentSession,
        excludeEventIds: workflowEvents(args.hostedSession)
            .pending()
            .map((event) => event.eventId),
    };
    const eventPromise = workflowEvents(args.hostedSession).wait({
        ...claimOptions,
        signal: waitController.signal,
    });
    const turnPromise = runRootTurn({
        hostedSession: args.hostedSession,
        agentName: args.agentName,
        userRequest: args.userRequest,
        images: args.images,
        customTools: args.customTools,
        signal: turnController.signal,
    });

    try {
        const first = await Promise.race([
            eventPromise.then((event) => ({ kind: "event" as const, event })),
            turnPromise.then((messages) => ({ kind: "turn" as const, messages })),
        ]);
        const stopForTerminalEvent = async (event: WorkflowToolEvent): Promise<RootTurnWorkflowEventResult> => {
            if (!args.hostedSession.isAgentTransitioning()) args.hostedSession.beginAgentTransition();
            try {
                clearAgentSessionQueueForTransition(args.rootAgentSession);
            } catch (error) {
                turnController.abort(new WorkflowStepCompleted());
                await turnPromise.catch(() => undefined);
                const transitionId = args.hostedSession.getAgentTransitionId();
                if (transitionId) args.hostedSession.completeAgentTransition(transitionId);
                throw error;
            }
            turnController.abort(new WorkflowStepCompleted());
            await turnPromise.catch(() => undefined);
            return { messages: [], event };
        };
        if (first.kind === "event") {
            if (
                first.event.kind === "plan_written" &&
                ["feedback", "conversation"].includes((first.event.payload as PlanWrittenEventPayload).outcome)
            ) {
                let feedbackEvent = first.event;
                const excludedEventIds = [...claimOptions.excludeEventIds, feedbackEvent.eventId];
                while (true) {
                    const feedbackWaitController = new AbortController();
                    const nextEventPromise = workflowEvents(args.hostedSession).wait({
                        ...claimOptions,
                        excludeEventIds: excludedEventIds,
                        signal: feedbackWaitController.signal,
                    });
                    try {
                        const next = await Promise.race([
                            nextEventPromise.then((event) => ({ kind: "event" as const, event })),
                            turnPromise
                                .then((messages) => ({ kind: "turn" as const, messages }))
                                .catch((error: Error) => {
                                    if ((feedbackEvent.payload as PlanWrittenEventPayload).outcome !== "conversation")
                                        throw error;
                                    emitSystemStatus(args.hostedSession, error.message || "The Agent turn failed.", {
                                        level: "error",
                                    });
                                    return { kind: "turn" as const, messages: [] };
                                }),
                        ]);
                        if (next.kind === "turn") {
                            const payload = feedbackEvent.payload as PlanWrittenEventPayload;
                            if (payload.outcome === "conversation" && payload.planName) {
                                workflowEvents(args.hostedSession).settle(feedbackEvent);
                                const { rearmPlanReviewConversation } = await import("./session-runtime.ts");
                                const outcome = await rearmPlanReviewConversation(
                                    args.hostedSession,
                                    payload.planName,
                                    args.agentName,
                                );
                                const accepted = workflowEvents(args.hostedSession).publish({
                                    toolCallId: `rearmed-review-${crypto.randomUUID()}`,
                                    kind: "plan_written",
                                    payload: outcome,
                                });
                                return { messages: next.messages, event: accepted };
                            }
                            return { messages: next.messages, event: feedbackEvent };
                        }
                        excludedEventIds.push(next.event.eventId);
                        if (
                            next.event.kind === "plan_written" &&
                            ["feedback", "conversation"].includes(
                                (next.event.payload as PlanWrittenEventPayload).outcome,
                            )
                        ) {
                            workflowEvents(args.hostedSession).settle(feedbackEvent);
                            feedbackEvent = next.event;
                            continue;
                        }
                        workflowEvents(args.hostedSession).settle(feedbackEvent);
                        return await stopForTerminalEvent(next.event);
                    } finally {
                        feedbackWaitController.abort();
                        await nextEventPromise.catch(() => undefined);
                    }
                }
            }
            return await stopForTerminalEvent(first.event);
        }
        waitController.abort(new DOMException("Agent turn finished without root workflow event.", "AbortError"));
        const waitedEvent = await eventPromise.catch(() => null);
        return {
            messages: first.messages,
            event: waitedEvent || workflowEvents(args.hostedSession).claim(claimOptions),
        };
    } finally {
        waitController.abort();
        await eventPromise.catch(() => undefined);
        args.signal?.removeEventListener("abort", abortBoth);
    }
}
