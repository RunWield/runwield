import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRootSessionBranchEntries } from "./root-session.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

interface JsonRecord {
    [key: string]: JsonValue;
}

interface TextBlock {
    type: "text";
    text: string;
}

interface ToolUseBlock {
    type: "tool_use" | "toolCall";
    name?: string;
    arguments?: JsonRecord;
    input?: JsonRecord;
}

interface ToolResultBlock {
    type: "tool_result";
    text?: string;
    content?: string | TranscriptContentBlock[];
    tool_use_id?: string;
    toolUseId?: string;
    is_error?: boolean;
    isError?: boolean;
}

type TranscriptContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface TranscriptMessage {
    role?: string;
    content?: string | TranscriptContentBlock[];
    toolName?: string;
    tool_name?: string;
    isError?: boolean;
    is_error?: boolean;
}

interface TranscriptEntry {
    type?: string;
    customType?: string;
    data?: { version?: number; compactInvocation?: string; expandedRequest?: string };
    message?: TranscriptMessage;
}

export interface ExternalCliConversationMessage {
    role: "user" | "assistant";
    text: string;
}

export function readExternalCliConversation(sessionManager: SessionManager): ExternalCliConversationMessage[] {
    const messages: ExternalCliConversationMessage[] = [];
    let skipNextCompactInvocation = "";
    for (const entry of getRootSessionBranchEntries(sessionManager)) {
        const transcriptEntry = entry as TranscriptEntry;
        const expanded = readNamedInvocationExpandedText(transcriptEntry);
        if (expanded) {
            messages.push({ role: "user", text: expanded });
            skipNextCompactInvocation = transcriptEntry.data?.compactInvocation || "";
            continue;
        }
        for (const message of normalizeTranscriptEntry(transcriptEntry)) {
            if (skipNextCompactInvocation && message.role === "user" && message.text === skipNextCompactInvocation) {
                skipNextCompactInvocation = "";
                continue;
            }
            skipNextCompactInvocation = "";
            messages.push(message);
        }
    }
    return messages;
}

export function serializeExternalCliConversation(messages: ExternalCliConversationMessage[]): string {
    return messages.map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n\n");
}

function readNamedInvocationExpandedText(entry: TranscriptEntry): string {
    if (entry.type !== "custom" || entry.customType !== "runwield.named_invocation") return "";
    if (entry.data?.version !== 1 || typeof entry.data.expandedRequest !== "string") return "";
    return entry.data.expandedRequest;
}

function normalizeTranscriptEntry(entry: TranscriptEntry): ExternalCliConversationMessage[] {
    if (entry.type !== "message" || !entry.message) return [];
    const text = extractText(entry.message.content);
    if (!text) return [];
    if (entry.message.role === "user" || entry.message.role === "assistant") {
        return [{ role: entry.message.role, text }];
    }
    if (entry.message.role === "toolResult" || entry.message.role === "tool_result") {
        const toolName = entry.message.toolName || entry.message.tool_name || "tool";
        const suffix = entry.message.isError || entry.message.is_error ? " (error)" : "";
        return [{ role: "user", text: `Tool result ${toolName}${suffix}: ${text}` }];
    }
    return [];
}

function extractText(content: string | TranscriptContentBlock[] | undefined): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block) => transcriptContentBlockText(block)).filter(Boolean).join("\n");
}

function isToolUseBlock(block: TranscriptContentBlock): block is ToolUseBlock {
    return block.type === "tool_use" || block.type === "toolCall";
}

function isToolResultBlock(block: TranscriptContentBlock): block is ToolResultBlock {
    return block.type === "tool_result";
}

function transcriptContentBlockText(block: TranscriptContentBlock): string {
    if (block.type === "text") return block.text;
    if (isToolUseBlock(block)) {
        const toolName = block.name || "tool";
        const args = block.arguments || block.input || {};
        return `Tool call ${toolName}: ${JSON.stringify(args)}`;
    }
    if (isToolResultBlock(block)) {
        const toolText = extractText(block.content) || block.text || "";
        const toolCallId = block.tool_use_id || block.toolUseId || "tool";
        const suffix = block.is_error || block.isError ? " (error)" : "";
        return `Tool result ${toolCallId}${suffix}: ${toolText}`;
    }
    return "";
}
