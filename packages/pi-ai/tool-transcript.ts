import { validateToolCall, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JsonRecord } from "@runwield/parsing/jsonc";
import type { ToolContentBlock } from "./turn.ts";

/** Provider and model fields stamped onto an assistant tool call in the Pi transcript. */
export type ToolCallModel = Pick<AssistantMessage, "api" | "provider" | "model">;

/** A tool name, call ID and arguments supplied by an external tool dispatcher. */
export interface ToolCallInput {
    id: string;
    name: string;
    args: JsonRecord;
}

/** Tool output and caller-supplied details to record against a Pi tool call. */
export interface ToolResultMessageInput {
    id: string;
    name: string;
    content: ToolContentBlock[];
    details: JsonRecord;
    isError?: boolean;
}

type ToolSchema = Pick<ToolDefinition, "description" | "parameters">;

const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** Validate and coerce a tool call using the same schema validation as the Pi agent loop. */
export function validateToolArguments(definition: ToolSchema, { id, name, args }: ToolCallInput): JsonRecord {
    return validateToolCall([{ name, description: definition.description, parameters: definition.parameters }], {
        type: "toolCall",
        id,
        name,
        arguments: args,
    });
}

/** Build the Pi assistant message that records a call made by an external tool dispatcher. */
export function toolCallMessage(
    { api, provider, model }: ToolCallModel,
    { id, name, args }: ToolCallInput,
): AssistantMessage {
    return {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "toolCall", id, name, arguments: args }],
        api,
        provider,
        model,
        usage: { ...ZERO_USAGE },
        stopReason: "toolUse",
    };
}

/** Build the Pi tool result message without appending it to a session. */
export function toolResultMessage({ id, name, content, details, isError }: ToolResultMessageInput): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content,
        details,
        isError: isError === true,
        timestamp: Date.now(),
    };
}
