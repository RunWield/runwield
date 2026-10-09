/**
 * @module shared/session/early-steering
 * Keeps Pi AgentSessions from interrupting an in-flight tool batch when user steering arrives.
 */

import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

export const EARLY_STEERING_SKIP_REASON =
    "Skipped because user steering is pending; reconsider after reading the user message.";

export interface EarlySteeringAgent {
    toolExecution?: string;
    beforeToolCall?: Agent["beforeToolCall"];
}

export interface EarlySteeringSession {
    agent?: EarlySteeringAgent;
    getSteeringMessages?: () => AgentMessage[] | undefined;
}

const installedSessions = new WeakSet<EarlySteeringSession>();

export function installEarlySteeringInterruption(session: EarlySteeringSession, options = {}) {
    void options;
    if (!session || typeof session !== "object") return;
    if (installedSessions.has(session)) return;
    installedSessions.add(session);

    const agent = session.agent;
    if (!agent || typeof agent !== "object") return;

    const existingBeforeToolCall = agent.beforeToolCall;
    if (typeof existingBeforeToolCall !== "function") return;

    agent.beforeToolCall = async function preserveExistingBeforeToolCall(
        this: EarlySteeringAgent,
        ...args: Parameters<NonNullable<Agent["beforeToolCall"]>>
    ) {
        return await existingBeforeToolCall.apply(this, args);
    };
}
