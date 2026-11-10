/**
 * @module acp/event-mapper
 * Maps adapter-neutral SessionRuntime events to ACP session/update notifications.
 */

import { getCommandDefinition, getSlashCommandDefinitions } from "../cmd/registry.ts";
import { RuntimeEventTypes } from "../shared/session/session-runtime-events.js";

import type { SessionNotification, SessionUpdate, ToolCallContent, UsageUpdate } from "@agentclientprotocol/sdk";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { RuntimeToolContentBlock, SessionRuntimeEvent } from "../shared/session/session-runtime-events.js";

export type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
export type AcpContextUsage = Pick<ContextUsage, "tokens" | "contextWindow">;
export type RuntimeAcpMetadata = NonNullable<SessionRuntimeEvent["_meta"]>;

export interface AcpUsageUpdate extends UsageUpdate {
    sessionUpdate: "usage_update";
}

function safeMeta(value: unknown) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object") return { runwield: value };
    return {
        runwield: Object.fromEntries(
            Object.entries(value as RuntimeAcpMetadata).filter(([, entry]) => entry !== undefined),
        ),
    };
}

function runtimeMeta(event: SessionRuntimeEvent, extra: RuntimeAcpMetadata = {}) {
    const raw = event._meta;
    const base = raw && typeof raw === "object" ? raw : {};
    const merged = Object.fromEntries(Object.entries({ ...base, ...extra }).filter(([, value]) => value !== undefined));
    return Object.keys(merged).length > 0 ? safeMeta(merged) : undefined;
}

/** ACP uses the same content-block shapes inside one protocol wrapper. */
function mapToolContent(content: RuntimeToolContentBlock[]): ToolCallContent[] {
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
                _meta: safeMeta({
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
                availableCommands: [
                    ...getSlashCommandDefinitions("acp").map((command) => ({
                        name: command.name,
                        description: command.description,
                        ...(command.usage?.[0] ? { input: { hint: command.usage[0].replace(/^.*?\s+/, "") } } : {}),
                    })),
                    ...(event.promptTemplates || [])
                        .filter((template) => !getCommandDefinition(template.name))
                        .map((template) => ({
                            name: template.name,
                            description: template.description || "Prompt template",
                            ...(template.argumentHint ? { input: { hint: template.argumentHint } } : {}),
                        })),
                    ...(event.skills || []).map((skill) => ({
                        name: `skill:${skill.name}`,
                        description: skill.description || "Skill",
                    })),
                ],
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
): SessionNotification | null {
    const update = mapRuntimeEventToAcpUpdate(event, sessionCostUsd, contextUsage);
    if (!update) return null;
    return { sessionId: acpSessionId, update };
}
