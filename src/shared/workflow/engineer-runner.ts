// @ts-nocheck: extracted from checked JSDoc workflow.js; tightening types is out of scope for this structural split.
import { AGENTS } from "../../constants.js";
import { getAgentDisplayName } from "../session/agents.js";
import { emitSystemStatus } from "../session/session-runtime-events.js";
import { AgyCliBackendError } from "../session/backends/agy-cli/failure.ts";
import { runActiveAgentTurn } from "../session/agent-switching.js";
import { createPairCheckpointTool } from "../../tools/pair-checkpoint.ts";
import { buildEngineerRequest } from "./workflow-prompts.ts";
import { acknowledgeTaskCompletion, claimPendingTaskCompletion } from "../session/task-completion-session.ts";
import { pairCheckpointMatchesWorkflow, readCurrentPairCheckpoint } from "../session/pair-checkpoint-session.ts";
import { CollaborationStyles, PairPauseReasons } from "./execution-collaboration.ts";
import { resolvePlanExecutionRuntimeAgent } from "./execution-agent.ts";

export async function runEngineerWithPlan(
    planName,
    planBody,
    sessionManager,
    executionCwd,
    hostedSession,
    projectRoot,
    routerMessage,
    reviewFeedback,
    reviewImages,
    executionAgent = AGENTS.ENGINEER,
) {
    if (!hostedSession) throw new Error("runEngineerWithPlan: hostedSession is required");
    const workflow = hostedSession.getActiveExecutionWorkflow?.();
    const runtimeAgent = resolvePlanExecutionRuntimeAgent(executionAgent);
    const collaborationStyle = workflow?.collaborationStyle || CollaborationStyles.AUTONOMOUS;
    const customTools = collaborationStyle === CollaborationStyles.PAIR
        ? [createPairCheckpointTool({ hostedSession })]
        : undefined;
    let messages;
    try {
        messages = await runActiveAgentTurn({
            hostedSession,
            agentName: runtimeAgent,
            userRequest: `${
                buildEngineerRequest(planName, planBody, reviewFeedback, {
                    collaborationStyle,
                    routerMessage,
                })
            }\n\nExecution owner: ${runtimeAgent}.`,
            images: reviewImages,
            sessionManager,
            cwd: executionCwd,
            dispatchKind: "plan_execution",
            ...(customTools ? { customTools } : {}),
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const hostedRootSession = /** @type {any} */ (hostedSession?.getRootAgentSession?.());
        const rootMessages = hostedRootSession?.agent?.state?.messages || [];
        emitSystemStatus(
            hostedSession,
            buildEngineerPausedMessage(error, projectRoot || hostedSession?.cwd, runtimeAgent),
            { level: "error", header: "RunWield" },
        );
        return { completed: false, messages: rootMessages, error: errorMessage };
    }

    const pauseReason = hostedSession.getActiveExecutionWorkflow?.()?.pairPauseReason;
    const currentPairCheckpoint = readCurrentPairCheckpoint(hostedSession);
    const pairCheckpoint =
        currentPairCheckpoint && workflow && pairCheckpointMatchesWorkflow(currentPairCheckpoint, workflow)
            ? currentPairCheckpoint
            : null;
    const activeOwnerSession = hostedSession.getActiveSteeringTargetSession?.() || null;
    const rootOwnerSession = hostedSession.getRootAgentSession() || null;
    const acceptedCompletion = !pauseReason
        ? claimPendingTaskCompletion(hostedSession, activeOwnerSession) ||
            claimPendingTaskCompletion(hostedSession, rootOwnerSession)
        : null;
    const completed = Boolean(acceptedCompletion);
    const completionReport = acceptedCompletion?.report || undefined;
    if (acceptedCompletion) acknowledgeTaskCompletion(hostedSession, acceptedCompletion);
    if (!completed && !pairCheckpoint) {
        emitSystemStatus(
            hostedSession,
            pauseReason
                ? buildPairPausedMessage(pauseReason, projectRoot || hostedSession?.cwd, runtimeAgent)
                : buildEngineerPausedMessage(undefined, projectRoot || hostedSession?.cwd, runtimeAgent),
            { header: "RunWield" },
        );
    }

    return {
        completed,
        messages,
        ...(pairCheckpoint ? { checkpointPending: true, checkpointId: pairCheckpoint.report.checkpointId } : {}),
        ...(pauseReason ? { paused: true, pauseReason } : {}),
        ...(completionReport ? { completionReport } : {}),
    };
}

/**
 * @param {Error|string} [reason]
 * @param {string} [projectRoot]
 */
export function buildEngineerPausedMessage(reason, projectRoot, executionAgent = AGENTS.ENGINEER) {
    const base = `${
        getAgentDisplayName(executionAgent, projectRoot)
    } stopped before reporting the task complete, so the work is unfinished and the Plan stays In Progress. Say "continue" to resume with the execution owner.`;
    // The Antigravity backend already emitted its sanitized failure as a status event.
    return reason && !(reason instanceof AgyCliBackendError)
        ? `${base}\nReason: ${reason instanceof Error ? reason.message : reason}`
        : base;
}

/**
 * @param {"stop"|"canceled"} pauseReason
 * @param {string} [projectRoot]
 */
export function buildPairPausedMessage(pauseReason, projectRoot, executionAgent = AGENTS.ENGINEER) {
    const owner = getAgentDisplayName(resolvePlanExecutionRuntimeAgent(executionAgent), projectRoot);
    return pauseReason === PairPauseReasons.STOP
        ? `${owner} stopped Pair Execution at your checkpoint direction. The Plan remains In Progress; say "continue" to resume Pair Execution.`
        : `${owner} paused Pair Execution because the checkpoint interaction was canceled. No approval or Task Completion was recorded; say "continue" to resume.`;
}

export async function runEngineerWithSegmentHandoff({ continuation, sessionManager, hostedSession }) {
    const workflow = hostedSession.getActiveExecutionWorkflow?.();
    // Continuations written by this version already carry a runtime identity, but
    // one persisted before the split says `engineer`. Resolving is idempotent and
    // keeps a resumed pre-split segment under Plan Engineer.
    const runtimeAgent = resolvePlanExecutionRuntimeAgent(continuation.executionOwner);
    const collaborationStyle = continuation.collaboration?.style || workflow?.collaborationStyle ||
        CollaborationStyles.AUTONOMOUS;
    const customTools = collaborationStyle === CollaborationStyles.PAIR
        ? [createPairCheckpointTool({ hostedSession })]
        : undefined;
    const userRequest = `${
        buildEngineerRequest(continuation.plan.planName, continuation.plan.markdown, continuation.approval?.feedback, {
            collaborationStyle,
        })
    }\n\nExecution owner: ${runtimeAgent}.`;
    let messages;
    try {
        messages = await runActiveAgentTurn({
            hostedSession,
            agentName: runtimeAgent,
            userRequest,
            images: continuation.approval?.images,
            sessionManager,
            cwd: workflow?.executionCwd || hostedSession.cwd,
            dispatchKind: "plan_execution",
            ...(customTools ? { customTools } : {}),
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const hostedRootSession = /** @type {any} */ (hostedSession?.getRootAgentSession?.());
        const rootMessages = hostedRootSession?.agent?.state?.messages || [];
        emitSystemStatus(
            hostedSession,
            buildEngineerPausedMessage(
                error,
                workflow?.projectRoot || hostedSession?.cwd,
                runtimeAgent,
            ),
            { level: "error", header: "RunWield" },
        );
        return { completed: false, messages: rootMessages, error: errorMessage };
    }
    const pauseReason = hostedSession.getActiveExecutionWorkflow?.()?.pairPauseReason;
    const currentPairCheckpoint = readCurrentPairCheckpoint(hostedSession);
    const pairCheckpoint =
        currentPairCheckpoint && workflow && pairCheckpointMatchesWorkflow(currentPairCheckpoint, workflow)
            ? currentPairCheckpoint
            : null;
    const activeOwnerSession = hostedSession.getActiveSteeringTargetSession?.() || null;
    const rootOwnerSession = hostedSession.getRootAgentSession() || null;
    const acceptedCompletion = !pauseReason
        ? claimPendingTaskCompletion(hostedSession, activeOwnerSession) ||
            claimPendingTaskCompletion(hostedSession, rootOwnerSession)
        : null;
    const completed = Boolean(acceptedCompletion);
    const completionReport = acceptedCompletion?.report || undefined;
    if (acceptedCompletion) acknowledgeTaskCompletion(hostedSession, acceptedCompletion);
    if (!completed && !pairCheckpoint) {
        emitSystemStatus(
            hostedSession,
            pauseReason
                ? buildPairPausedMessage(pauseReason, workflow?.projectRoot || hostedSession?.cwd, runtimeAgent)
                : buildEngineerPausedMessage(
                    undefined,
                    workflow?.projectRoot || hostedSession?.cwd,
                    runtimeAgent,
                ),
            { header: "RunWield" },
        );
    }
    return {
        completed,
        messages,
        ...(pairCheckpoint ? { checkpointPending: true, checkpointId: pairCheckpoint.report.checkpointId } : {}),
        ...(pauseReason ? { paused: true, pauseReason } : {}),
        ...(completionReport ? { completionReport } : {}),
    };
}
