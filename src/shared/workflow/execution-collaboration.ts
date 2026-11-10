// @ts-nocheck: extracted from checked JSDoc workflow.js; tightening types is out of scope for this structural split.
import { AGENTS } from "../../constants.ts";
import { resolvePlanExecutionPolicy } from "../../plan-store.ts";
import { emitSystemStatus } from "../session/session-runtime-events.ts";

export function resolveExecutionOwner(meta) {
    const policy = resolvePlanExecutionPolicy(meta);
    if (policy.ok) return policy.policy.executionAgent;
    if (policy.reason === "project_epic") return /** @type {"engineer"} */ (AGENTS.ENGINEER);
    throw new Error(policy.error);
}

export const CollaborationStyles = Object.freeze({
    AUTONOMOUS: "autonomous",
    PAIR: "pair",
});

export const PairCheckpointDecisions = Object.freeze({
    CONTINUE: "continue",
    REVISE: "revise",
    SWITCH_TO_AUTONOMOUS: "switch_to_autonomous",
    STOP: "stop",
});

export const PairPauseReasons = Object.freeze({
    STOP: "stop",
    CANCELED: "canceled",
});

/**
 * @param {import('../session/hosted-session.ts').HostedSession} hostedSession
 * @returns {boolean}
 */
export function supportsPairExecution(hostedSession) {
    return Boolean(hostedSession?.getInteractionAdapter?.());
}

/**
 * @typedef {Object} RuntimeCollaborationSelection
 * @property {"autonomous"|"pair"} style
 * @property {"autonomous"|"pair"} recommendation
 * @property {boolean} pairCapable
 * @property {"canonical_pair_capable"|"canonical_pair_unavailable"|"canonical_autonomous"|"legacy_autonomous"} resolutionReason
 */

/**
 * @param {import('../session/hosted-session.ts').HostedSession} hostedSession
 * @param {{ executionAgent: "engineer"|"frontend-engineer", collaborationRecommendation: "autonomous"|"pair", source: "canonical"|"legacy_frontend"|"legacy_frontend_false"|"absent" }} policy
 * @returns {RuntimeCollaborationSelection}
 */
export function selectRuntimeCollaborationStyle(hostedSession, policy) {
    const recommendation = policy.collaborationRecommendation || CollaborationStyles.AUTONOMOUS;
    const pairCapable = supportsPairExecution(hostedSession);
    // Legacy `frontend:`-derived policies never carried a collaboration choice, so
    // there is no recommendation to honour and pair would be invented, not requested.
    if (policy.source !== "canonical") {
        return {
            style: CollaborationStyles.AUTONOMOUS,
            recommendation,
            pairCapable,
            resolutionReason: "legacy_autonomous",
        };
    }
    if (recommendation !== CollaborationStyles.PAIR) {
        return {
            style: CollaborationStyles.AUTONOMOUS,
            recommendation,
            pairCapable,
            resolutionReason: "canonical_autonomous",
        };
    }
    if (!pairCapable) {
        emitSystemStatus(
            hostedSession,
            "Pair Execution is recommended by the Plan but unavailable in this host; continuing with autonomous Plan execution.",
            { header: "RunWield" },
        );
        return {
            style: CollaborationStyles.AUTONOMOUS,
            recommendation,
            pairCapable,
            resolutionReason: "canonical_pair_unavailable",
        };
    }
    return { style: CollaborationStyles.PAIR, recommendation, pairCapable, resolutionReason: "canonical_pair_capable" };
}
