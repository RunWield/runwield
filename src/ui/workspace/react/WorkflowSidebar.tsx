import { Fragment, useRef, useState } from "react";

import type {
    WorkflowPresentation,
    WorkflowPresentationAction,
} from "../../../shared/workflow/workflow-presentation.ts";

interface WorkflowSidebarLinks {
    sessionHref?: string;
    interactionHref?: string;
    reviewHref?: string;
    planHref?: string;
}

interface WorkflowSidebarProps {
    presentation: WorkflowPresentation;
    payload?: WorkflowSidebarLinks;
    title?: string;
    embedded?: boolean;
    onAction?: ((action: WorkflowPresentationAction) => string | undefined | Promise<string | undefined>) | null;
    onOpenSession?: (() => void) | null;
    onAnswerAgent?: (() => void) | null;
}

interface WorkflowSidebarFeedback {
    message: string;
    error: boolean;
}

export function workflowActionHref(payload: WorkflowSidebarLinks, action: WorkflowPresentationAction | null) {
    if (!action) return "";
    if (
        (action.kind === "open_session" || action.kind === "resume" || action.kind === "recover" ||
            action.kind === "answer_agent") && payload.sessionHref
    ) {
        return action.kind === "answer_agent" && payload.interactionHref
            ? payload.interactionHref
            : payload.sessionHref;
    }
    if ((action.kind === "review_plan" || action.kind === "review_code") && payload.reviewHref) {
        return payload.reviewHref;
    }
    return payload.planHref || "";
}

export function WorkflowSidebar(
    {
        presentation,
        payload = {},
        title = "Plan workflow",
        embedded = false,
        onAction = null,
        onOpenSession = null,
        onAnswerAgent = null,
    }: WorkflowSidebarProps,
) {
    const actionInFlight = useRef(false);
    const [pending, setPending] = useState(false);
    const [feedback, setFeedback] = useState<WorkflowSidebarFeedback | null>(null);
    async function runAction(action: WorkflowPresentationAction) {
        if (actionInFlight.current) return;
        actionInFlight.current = true;
        setPending(true);
        setFeedback({ message: `${action.label} in progress…`, error: false });
        try {
            const message = await onAction!(action);
            setFeedback({ message: message || "Workflow updated.", error: false });
        } catch (error) {
            setFeedback({ message: error instanceof Error ? error.message : String(error), error: true });
        } finally {
            actionInFlight.current = false;
            setPending(false);
        }
    }
    const actionHref = workflowActionHref(payload, presentation.action);
    const stageLabels = new Map(presentation.stages.map((stage) => [stage.id, stage.label]));
    const repairReturns = new Map(
        presentation.connections?.filter((connection) => connection.kind === "repair_return")
            .map((connection) => [connection.from, connection.to]) || [],
    );
    return (
        <aside
            className={`rw-plan-home-workflow${embedded ? " rw-plan-home-workflow-embedded" : ""}`}
            aria-label={title}
        >
            {!embedded && (
                <header>
                    <h2>{title}</h2>
                    {presentation.epic ? <p>{presentation.epic}</p> : null}
                </header>
            )}
            {embedded && presentation.epic ? <p className="session-context-empty">{presentation.epic}</p> : null}
            <ol
                className="session-workflow-stage-list workflow-diagram workflow-diagram-connected"
                aria-label="Workflow stages"
            >
                {presentation.stages.map((stage) => {
                    const returnTarget = repairReturns.get(stage.id);
                    return (
                        <Fragment key={stage.id}>
                            <li
                                data-state={stage.state}
                                aria-current={stage.current ? "step" : undefined}
                            >
                                <span>{stage.label}</span>
                                {!["current", "upcoming"].includes(stage.state) && <strong>{stage.state}</strong>}
                                {stage.detail && <p>{stage.detail}</p>}
                            </li>
                            {returnTarget
                                ? (
                                    <li
                                        className="workflow-repair-return"
                                        key={`${stage.id}-${returnTarget}`}
                                        data-state="repair-return"
                                    >
                                        <span>
                                            {stageLabels.get(stage.id)} returns to{" "}
                                            {stageLabels.get(returnTarget) || returnTarget}
                                        </span>
                                        <strong>repair path</strong>
                                        <p>After repair, continue the failed check.</p>
                                    </li>
                                )
                                : null}
                        </Fragment>
                    );
                })}
            </ol>
            {presentation.blocker && presentation.blocker !== presentation.currentStage?.detail
                ? (
                    <section className="workflow-next-card" aria-label="Workflow blocker">
                        <h3>Blocked by</h3>
                        <p>{presentation.blocker}</p>
                    </section>
                )
                : null}
            {presentation.action
                ? (
                    <section className="workflow-next-card" aria-label="Workflow action">
                        <h3>Next action</h3>
                        <p>{presentation.action.detail}</p>
                        {onAnswerAgent && presentation.action.kind === "answer_agent"
                            ? (
                                <button className="rw-toolbar-button" type="button" onClick={onAnswerAgent}>
                                    Answer agent
                                </button>
                            )
                            : onOpenSession && presentation.action.kind === "open_session"
                            ? (
                                <button className="rw-toolbar-button" type="button" onClick={onOpenSession}>
                                    Open Session
                                </button>
                            )
                            : onAction &&
                                    (["run", "resume", "recover", "resume_from_hold"].includes(
                                        presentation.action.kind,
                                    ) ||
                                        (presentation.action.kind === "review_plan" && !payload.reviewHref))
                            ? (
                                <button
                                    className="rw-toolbar-button"
                                    type="button"
                                    disabled={pending}
                                    aria-busy={pending}
                                    onClick={() => runAction(presentation.action!)}
                                >
                                    {presentation.action.label}
                                </button>
                            )
                            : actionHref
                            ? <a className="rw-toolbar-button" href={actionHref}>{presentation.action.label}</a>
                            : null}
                    </section>
                )
                : null}
            {feedback && (
                <p className="session-surface-status" role={feedback.error ? "alert" : "status"}>
                    {feedback.message}
                </p>
            )}
        </aside>
    );
}
