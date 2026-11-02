import { AGENTS } from "../../constants.js";
import { loadAgentDef } from "./agents.js";
import { readPersistedActiveAgentName, readPersistedManualModelState } from "./active-agent-session.ts";
import {
    assertThinkingLevelBackendSupportedForInvocation,
    assertThinkingLevelSupportedForInvocation,
    resolveExecutionThinkingLevel,
    resolveModel,
} from "./session.js";
import { getModelRegistry } from "../models/model-registry.ts";
import { formatProviderModelReference } from "../models/model-validation.ts";
import { resolveActiveWorkflowRuntimeAgent } from "../workflow/execution-agent.ts";
import type { HostedSession } from "./hosted-session.js";
import type { PromptTemplateInvocation, ThinkingLevel } from "./named-invocation.ts";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** Template omissions inherit the conversation; an untouched new session starts with Operator. */
export async function resolvePromptTemplateSettings(
    session: HostedSession,
    invocation: PromptTemplateInvocation,
    manager = session.getRootSessionManager(),
) {
    const pending = session.getPendingManagedTurnIntent();
    const managed = session.getManagedMetadata();
    const entries = (manager?.getBranch?.() || []) as SessionEntry[];
    const hasConversation = entries.some((entry) => entry.type === "message" && entry.message.role === "user");
    const currentAgent = resolveActiveWorkflowRuntimeAgent(session.getActiveExecutionWorkflow()) ||
        pending.agentName || session.getRootAgentName() || readPersistedActiveAgentName(manager || undefined) ||
        session.getActiveAgentInfo()?.agentName || managed?.activeAgent || "";
    const sessionAgent = currentAgent !== AGENTS.ROUTER || hasConversation || pending.agentName ? currentAgent : "";
    const agentName = invocation.agentName || sessionAgent || AGENTS.OPERATOR;
    const keepsAgent = agentName === currentAgent;
    const activeModel = session.getActiveModelState();
    const manualModel = session.isUserModelOverride() ? activeModel : null;
    const persistedModel = keepsAgent ? readPersistedManualModelState(manager || undefined, agentName) : null;
    const inheritedModel = keepsAgent || !hasConversation && !invocation.agentName
        ? manualModel || persistedModel || (keepsAgent && sessionAgent && activeModel.model ? activeModel : null)
        : null;
    const modelOverride = invocation.model ||
        (inheritedModel?.model ? formatProviderModelReference(inheritedModel) : undefined);
    const agentDef = await loadAgentDef(agentName, session.cwd);
    const model = await resolveModel(modelOverride, agentDef, agentName, getModelRegistry(), session, session.cwd, {
        ignoreManualModelOverride: true,
    });
    const thinkingOverride = invocation.thinkingLevel ||
        (keepsAgent || !invocation.agentName ? pending.thinkingLevel : undefined) ||
        (keepsAgent && (hasConversation || sessionAgent)
            ? managed?.thinkingLevel || session.getThinkingLevel()
            : undefined);
    const thinkingLevel = resolveExecutionThinkingLevel({
        agentName,
        cwd: session.cwd,
        agentDef,
        thinkingLevelOverride: thinkingOverride,
    }).resolvedThinkingLevel as ThinkingLevel | undefined;
    assertThinkingLevelSupportedForInvocation(model, thinkingLevel || "off", Boolean(invocation.thinkingLevel));
    assertThinkingLevelBackendSupportedForInvocation(model, thinkingLevel);
    return {
        agentName,
        model: `${model.provider}/${model.id}`,
        thinkingLevel: thinkingLevel || "off" as ThinkingLevel,
        manualModel: Boolean(invocation.model || inheritedModel && (manualModel || persistedModel)),
    };
}

/** Planning has an owner before a Plan or execution record exists. */
export function promptTemplateWorkflowConflict(session: HostedSession, agentName: string): string | null {
    const workflow = session.getActiveExecutionWorkflow();
    const manager = session.getRootSessionManager() as SessionManager | null;
    const currentAgent = resolveActiveWorkflowRuntimeAgent(workflow) || session.getRootAgentName() ||
        readPersistedActiveAgentName(manager || undefined) || session.getManagedMetadata()?.activeAgent || "";
    if (agentName === currentAgent) return null;
    if (workflow) {
        return workflow.planName ? `the workflow for ${workflow.planName}` : "an unfinished execution workflow";
    }
    const hasConversation = manager?.getBranch().some((entry) =>
        entry.type === "message" && entry.message.role === "user"
    );
    if (hasConversation && (currentAgent === AGENTS.PLANNER || currentAgent === AGENTS.ARCHITECT)) {
        return "an unfinished planning workflow";
    }
    return null;
}
