/**
 * @module acp/event-mapper
 * Maps adapter-neutral SessionRuntime events to ACP session/update notifications.
 */

import { RuntimeEventTypes } from "@runwield/session-runtime/events";

import type {
    AvailableCommand,
    SessionNotification,
    SessionUpdate,
    ToolCallContent,
    UsageUpdate,
} from "@agentclientprotocol/sdk/unstable";
import type { ToolContentBlock } from "@runwield/pi-ai/turn";
import type {
    PromptTemplateMeta,
    RuntimeEventMetadata,
    RuntimeValidationProgress,
    SessionRuntimeEvent,
    SkillRecord,
} from "@runwield/session-runtime/events";

export interface AcpContextUsage {
    tokens: number | null;
    contextWindow: number;
}

interface RuntimeAcpMetadata extends RuntimeEventMetadata {
    agentName?: string;
    messageKind?: string;
    workflowMessage?: string;
    approved?: boolean;
    toolName?: string;
    durationMs?: number | null;
    type?: SessionRuntimeEvent["type"];
    model?: string | null;
    provider?: string | null;
    thinkingLevel?: string;
    interactionId?: string;
    interactionType?: string;
    outcome?: string;
    level?: string;
    validationProgress?: RuntimeValidationProgress;
    planName?: string;
    reviewerUrl?: string;
    spaceId?: string;
    serverUrl?: string;
    revision?: number;
    reused?: boolean;
}

export interface AcpUsageUpdate extends UsageUpdate {
    sessionUpdate: "usage_update";
}

function definedMetadata(value: RuntimeAcpMetadata) {
    const fields = { ...value };
    for (const key of Object.keys(fields) as (keyof RuntimeAcpMetadata)[]) {
        if (fields[key] === undefined) delete fields[key];
    }
    return Object.keys(fields).length ? { runwield: fields } : undefined;
}

function runtimeMeta(event: SessionRuntimeEvent, extra: RuntimeAcpMetadata = {}) {
    return definedMetadata({ ...event._meta, ...extra });
}

/** A host command shown in the client's list of available slash commands. */
export interface AcpCommandDefinition {
    name: string;
    description: string;
    usage?: readonly string[];
}

/** Supplies built-in commands and resolves name collisions with Session skills and prompt templates. */
export interface AcpCommandCatalog {
    /** List built-in commands offered by the host. */
    listBuiltins(): readonly AcpCommandDefinition[];
    /** Check whether a name is already owned by a built-in command. */
    isReserved(name: string): boolean;
}

export function buildAcpCommandCatalog(
    catalog: AcpCommandCatalog | undefined,
    promptTemplates: readonly Pick<PromptTemplateMeta, "name" | "description" | "argumentHint">[] = [],
    skills: readonly Pick<SkillRecord, "name" | "description">[] = [],
): AvailableCommand[] {
    return [
        ...(catalog?.listBuiltins() ?? []).map((command) => ({
            name: command.name,
            description: command.description,
            ...(command.usage?.[0] ? { input: { hint: command.usage[0].replace(/^.*?\s+/, "") } } : {}),
        })),
        ...promptTemplates
            .filter((template) => !catalog?.isReserved(template.name))
            .map((template) => ({
                name: template.name,
                description: template.description || "Prompt template",
                ...(template.argumentHint ? { input: { hint: template.argumentHint } } : {}),
            })),
        ...skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description || "Skill" })),
    ];
}

/** ACP uses the same content-block shapes inside one protocol wrapper. */
function mapToolContent(content: ToolContentBlock[]): ToolCallContent[] {
    return content.map((block): ToolCallContent => ({ type: "content", content: block }));
}

/** Map exact current Runtime context usage and cumulative ACP Session cost in USD. */
export function mapRuntimeContextToAcpUpdate(
    contextUsage: AcpContextUsage | null,
    sessionCostUsd = 0,
): AcpUsageUpdate | null {
    const used = contextUsage?.tokens;
    const size = contextUsage?.contextWindow;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
    return {
        sessionUpdate: "usage_update",
        used,
        size,
        ...(sessionCostUsd > 0 ? { cost: { amount: sessionCostUsd, currency: "USD" } } : {}),
    };
}

export function mapRuntimeEventToAcpUpdate(
    event: SessionRuntimeEvent,
    sessionCostUsd = 0,
    contextUsage: AcpContextUsage | null = null,
    commandCatalog?: AcpCommandCatalog,
): SessionUpdate | null {
    switch (event.type) {
        case RuntimeEventTypes.USER_MESSAGE:
            return {
                sessionUpdate: "user_message_chunk",
                messageId: event.messageId,
                content: { type: "text", text: event.text },
                ...(runtimeMeta(event) ? { _meta: runtimeMeta(event) } : {}),
            };
        case RuntimeEventTypes.ASSISTANT_TEXT_DELTA:
            return {
                sessionUpdate: "agent_message_chunk",
                messageId: event.messageId,
                content: { type: "text", text: event.delta },
                _meta: runtimeMeta(event, {
                    agentName: event.agentName,
                    messageKind: event.messageKind,
                    workflowMessage: event.workflowMessage,
                    approved: event.approved,
                }),
            };
        case RuntimeEventTypes.ASSISTANT_THINKING_DELTA:
            return {
                sessionUpdate: "agent_thought_chunk",
                messageId: event.messageId,
                content: { type: "text", text: event.delta },
                _meta: runtimeMeta(event, { agentName: event.agentName }),
            };
        case RuntimeEventTypes.TOOL_START:
            return {
                sessionUpdate: "tool_call",
                toolCallId: event.toolCallId,
                title: event.title,
                kind: event.kind,
                status: "in_progress",
                rawInput: event.args,
                _meta: runtimeMeta(event, { toolName: event.toolName }),
            };
        case RuntimeEventTypes.TOOL_UPDATE:
            return {
                sessionUpdate: "tool_call_update",
                toolCallId: event.toolCallId,
                title: event.title,
                kind: event.kind,
                status: "in_progress",
                content: mapToolContent(event.content),
                rawOutput: { content: event.content, details: event.details },
                _meta: runtimeMeta(event, { toolName: event.toolName }),
            };
        case RuntimeEventTypes.TOOL_END:
            return {
                sessionUpdate: "tool_call_update",
                toolCallId: event.toolCallId,
                title: event.title,
                kind: event.kind,
                status: event.isError ? "failed" : "completed",
                content: mapToolContent(event.content),
                rawOutput: { content: event.content, details: event.details },
                _meta: runtimeMeta(event, { toolName: event.toolName, durationMs: event.durationMs }),
            };
        case RuntimeEventTypes.USAGE:
            return mapRuntimeContextToAcpUpdate(contextUsage, sessionCostUsd);
        case RuntimeEventTypes.PLAN_REVIEW_LINK: {
            return {
                sessionUpdate: "agent_message_chunk",
                messageId: event.messageId,
                content: { type: "text", text: event.message },
                _meta: definedMetadata({
                    type: event.type,
                    planName: event.planName,
                    reviewerUrl: event.reviewerUrl,
                    spaceId: event.spaceId,
                    serverUrl: event.serverUrl,
                    revision: event.revision,
                    reused: event.reused,
                }),
            };
        }
        case RuntimeEventTypes.AGENT_CHANGED: {
            // Activation and same-Agent rebuilds also publish profile updates.
            // Only a committed identity change belongs in the conversation.
            if (!event.rootHandoff) return null;
            return {
                sessionUpdate: "agent_message_chunk",
                messageId: event.messageId,
                content: { type: "text", text: `Active agent: ${event.agentName}` },
                _meta: runtimeMeta(event, {
                    type: event.type,
                    agentName: event.agentName,
                    model: event.model,
                }),
            };
        }
        case RuntimeEventTypes.MODEL_CHANGED: {
            const model =
                event.provider && !event.model.includes("/") ? `${event.provider}/${event.model}` : event.model;
            return {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Model changed: ${model}` },
                _meta: runtimeMeta(event, {
                    type: event.type,
                    model: event.model,
                    provider: event.provider,
                }),
            };
        }
        case RuntimeEventTypes.THINKING_LEVEL_CHANGED: {
            return {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Thinking level changed: ${event.thinkingLevel}` },
                _meta: runtimeMeta(event, {
                    type: event.type,
                    thinkingLevel: event.thinkingLevel,
                }),
            };
        }
        case RuntimeEventTypes.COMMAND_CATALOG_CHANGED: {
            return {
                sessionUpdate: "available_commands_update",
                availableCommands: buildAcpCommandCatalog(commandCatalog, event.promptTemplates, event.skills),
            };
        }
        case RuntimeEventTypes.INTERACTION_RESOLVED:
        case RuntimeEventTypes.INTERACTION_CANCELED: {
            if (!event.message) return null;
            return {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: event.message },
                _meta: runtimeMeta(event, {
                    type: event.type,
                    interactionId: event.interactionId,
                    interactionType: event.interactionType,
                    outcome: event.outcome,
                }),
            };
        }
        case RuntimeEventTypes.SYSTEM_STATUS:
        case RuntimeEventTypes.CANCELLATION:
        case RuntimeEventTypes.TERMINAL_ERROR: {
            if (!event.message) return null;
            return {
                sessionUpdate: "agent_message_chunk",
                messageId: event.messageId,
                content: { type: "text", text: event.message },
                _meta: runtimeMeta(event, {
                    type: event.type,
                    level: "level" in event ? event.level : undefined,
                    validationProgress: "validationProgress" in event ? event.validationProgress : undefined,
                }),
            };
        }
        default:
            return null;
    }
}

export function mapRuntimeEventToAcpSessionNotification(
    acpSessionId: string,
    event: SessionRuntimeEvent,
    sessionCostUsd = 0,
    contextUsage: AcpContextUsage | null = null,
    commandCatalog?: AcpCommandCatalog,
): SessionNotification | null {
    const update = mapRuntimeEventToAcpUpdate(event, sessionCostUsd, contextUsage, commandCatalog);
    if (!update) return null;
    return { sessionId: acpSessionId, update };
}
