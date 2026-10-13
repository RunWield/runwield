export interface ClaudeCliUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsd: number | null;
}

export interface ClaudeCliFinalMetadata {
    externalSessionId?: string;
    isError: boolean;
    usage: ClaudeCliUsage;
}

export interface ClaudeCliParseResult {
    text: string;
    metadata: ClaudeCliFinalMetadata;
}

export interface ClaudeCliAssistantDelta {
    text: string;
}

export interface ClaudeCliThinkingDelta {
    text: string;
}

export type ClaudeCliStreamEvent =
    | { kind: "assistant_delta"; text: string }
    | { kind: "assistant_continuation"; text: string }
    | { kind: "plain_text"; text: string }
    | { kind: "text_partial"; text: string }
    | { kind: "thinking_partial"; text: string }
    | { kind: "tool_start"; callId: string; toolName: string; args: JsonRecord }
    | { kind: "tool_result"; callId: string; isError: boolean; resultText?: string }
    | { kind: "result"; text: string; externalSessionId?: string; isError: boolean; usage: ClaudeCliUsage };

export interface ClaudeCliStreamCallbacks {
    onDelta: (delta: ClaudeCliAssistantDelta) => void;
    /** Live thinking chunks from `stream_event` partial messages; display-only, never persisted as visible text. */
    onThinkingDelta?: (delta: ClaudeCliThinkingDelta) => void;
    /** Signals the current thinking block ended, either because visible text started or the turn finished. */
    onThinkingEnd?: () => void;
    onThinkingObserved?: () => void;
    isTerminalAccepted?: () => boolean;
    onNativeToolStart?: (call: { callId: string; toolName: string; args?: Record<string, unknown> }) => void;
    onNativeToolResult?: (result: { callId: string; isError: boolean; resultText?: string }) => void;
    /** Request/model detail can overlap the terminal turn total; it is not additive. */
    onUsage?: (observation: {
        sourceId: string;
        model?: string;
        usage: ClaudeCliUsage;
        aggregationBasis: "turn" | "alternative";
    }) => void;
}

type JsonScalar = string | number | boolean | null;
type JsonArray = JsonValue[];
interface JsonRecord {
    [key: string]: JsonValue;
}
type JsonValue = JsonScalar | JsonArray | JsonRecord;

const emptyUsage: ClaudeCliUsage = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
};

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : "";
}

function asNullableNumber(value: JsonValue | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsage(value: JsonValue | undefined, topCost?: JsonValue): ClaudeCliUsage {
    const usage = isJsonRecord(value) ? value : {};
    let cost: number | null = null;
    if (typeof topCost === "number" && Number.isFinite(topCost)) {
        cost = topCost;
    } else if (isJsonRecord(usage.cost)) {
        cost = asNullableNumber(usage.cost.total);
    } else if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
        cost = usage.cost;
    }

    return {
        inputTokens:
            asNullableNumber(usage.input_tokens) ??
            asNullableNumber(usage.inputTokens) ??
            asNullableNumber(usage.input),
        outputTokens:
            asNullableNumber(usage.output_tokens) ??
            asNullableNumber(usage.outputTokens) ??
            asNullableNumber(usage.output),
        cacheReadTokens:
            asNullableNumber(usage.cache_read_input_tokens) ??
            asNullableNumber(usage.cacheReadTokens) ??
            asNullableNumber(usage.cacheReadInputTokens),
        cacheWriteTokens:
            asNullableNumber(usage.cache_creation_input_tokens) ??
            asNullableNumber(usage.cacheWriteTokens) ??
            asNullableNumber(usage.cacheCreationInputTokens),
        costUsd: cost,
    };
}

function contentText(value: JsonValue | undefined): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (!isJsonRecord(item)) return "";
                if (item.type === "text") return asString(item.text);
                return "";
            })
            .join("");
    }
    return "";
}

export function parseClaudeCliJsonLine(
    line: string,
    callbacks?: ClaudeCliStreamCallbacks,
): ClaudeCliStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let parsed: JsonValue;
    try {
        parsed = JSON.parse(trimmed) as JsonValue;
    } catch {
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { kind: "plain_text", text: trimmed };
        throw new Error("Claude CLI emitted malformed stream-json output");
    }
    if (!isJsonRecord(parsed)) return null;
    const eventType = asString(parsed.type);
    if (eventType === "assistant") {
        const message = isJsonRecord(parsed.message) ? parsed.message : parsed;
        const messageId = asString(message.id);
        if (messageId && isJsonRecord(message.usage)) {
            callbacks?.onUsage?.({
                sourceId: messageId,
                model: asString(message.model) || undefined,
                usage: readUsage(message.usage),
                aggregationBasis: "alternative",
            });
        }
        if (Array.isArray(message.content)) {
            for (const item of message.content) {
                if (isJsonRecord(item) && item.type === "thinking") callbacks?.onThinkingObserved?.();
                if (isJsonRecord(item) && item.type === "tool_use") {
                    const callId = asString(item.id);
                    const toolName = asString(item.name);
                    const args = isJsonRecord(item.input) ? item.input : {};
                    if (callId) callbacks?.onNativeToolStart?.({ callId, toolName, args });
                } else if (isJsonRecord(item) && item.type === "tool_result") {
                    const callId = asString(item.tool_use_id) || asString(item.id) || "";
                    const isError = item.is_error === true;
                    const resultText = contentText(item.content);
                    callbacks?.onNativeToolResult?.({ callId, isError, resultText });
                }
            }
        }
        const text = contentText(message.content);
        return text ? { kind: "assistant_delta", text } : null;
    }
    if (eventType === "user") {
        const message = isJsonRecord(parsed.message) ? parsed.message : parsed;
        if (Array.isArray(message.content)) {
            for (const item of message.content) {
                if (!isJsonRecord(item) || item.type !== "tool_result") continue;
                const callId = asString(item.tool_use_id);
                if (callId) {
                    callbacks?.onNativeToolResult?.({
                        callId,
                        isError: item.is_error === true,
                        resultText: contentText(item.content),
                    });
                }
            }
        }
        return null;
    }
    if (eventType === "tool_use") {
        const callId = asString(parsed.id);
        if (!callId) return null;
        const toolName = asString(parsed.name);
        const args = isJsonRecord(parsed.input) ? parsed.input : {};
        return { kind: "tool_start", callId, toolName, args };
    }
    if (eventType === "tool_result") {
        const callId = asString(parsed.tool_use_id) || asString(parsed.id) || "";
        const isError = parsed.is_error === true;
        const resultText = contentText(parsed.content);
        return { kind: "tool_result", callId, isError, resultText };
    }
    if (eventType === "content_block_delta") {
        const delta = isJsonRecord(parsed.delta) ? parsed.delta : parsed;
        const text = asString(delta.text);
        return text ? { kind: "assistant_continuation", text } : null;
    }
    if (eventType === "stream_event") {
        const inner = isJsonRecord(parsed.event) ? parsed.event : null;
        if (!inner) return null;
        if (asString(inner.type) === "content_block_start") {
            const block = isJsonRecord(inner.content_block) ? inner.content_block : null;
            if (block && asString(block.type) === "tool_use") {
                const callId = asString(block.id);
                if (!callId) return null;
                const toolName = asString(block.name);
                const args = isJsonRecord(block.input) ? block.input : {};
                return { kind: "tool_start", callId, toolName, args };
            }
        }
        if (asString(inner.type) === "content_block_delta") {
            const delta = isJsonRecord(inner.delta) ? inner.delta : null;
            if (!delta) return null;
            const deltaType = asString(delta.type);
            if (deltaType === "text_delta") {
                const text = asString(delta.text);
                return text ? { kind: "text_partial", text } : null;
            }
            if (deltaType === "thinking_delta") {
                const text = asString(delta.thinking);
                return text ? { kind: "thinking_partial", text } : null;
            }
        }
        return null;
    }
    if (eventType === "result") {
        const text = asString(parsed.result) || asString(parsed.text);
        const usage = readUsage(parsed.usage, parsed.total_cost_usd ?? parsed.cost);
        callbacks?.onUsage?.({ sourceId: "claude_turn_total", usage, aggregationBasis: "turn" });
        const modelUsage = isJsonRecord(parsed.modelUsage)
            ? parsed.modelUsage
            : isJsonRecord(parsed.model_usage)
              ? parsed.model_usage
              : {};
        for (const [model, details] of Object.entries(modelUsage)) {
            if (!/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(model) || !isJsonRecord(details)) continue;
            callbacks?.onUsage?.({
                sourceId: `claude_model_${Object.keys(modelUsage).indexOf(model)}`,
                model,
                usage: readUsage(details, details.costUSD ?? details.cost_usd),
                aggregationBasis: "alternative",
            });
        }
        const externalSessionId = asString(parsed.session_id) || asString(parsed.sessionId) || undefined;
        return {
            kind: "result",
            text,
            isError: parsed.is_error === true,
            usage,
            ...(externalSessionId ? { externalSessionId } : {}),
        };
    }
    return null;
}

export async function parseClaudeCliStream(
    stream: ReadableStream<Uint8Array>,
    callbacks: ClaudeCliStreamCallbacks,
): Promise<ClaudeCliParseResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let visibleText = "";
    let resultText = "";
    let metadata: ClaudeCliFinalMetadata = { isError: false, usage: emptyUsage };
    let sawResult = false;
    // Text already forwarded live through `text_partial` `stream_event`s for the block currently
    // in progress; used to avoid re-emitting it when the matching complete `assistant` message arrives.
    let streamedBlockText = "";
    let thinkingActive = false;
    let previousCompletePlainLine = false;
    let previousAssistantComplete = false;

    const endThinking = () => {
        if (!thinkingActive) return;
        thinkingActive = false;
        callbacks.onThinkingEnd?.();
    };

    const applyEvent = (event: ClaudeCliStreamEvent) => {
        if (event.kind === "tool_start") {
            endThinking();
            callbacks.onNativeToolStart?.({ callId: event.callId, toolName: event.toolName, args: event.args });
            return;
        }
        if (event.kind === "tool_result") {
            callbacks.onNativeToolResult?.({
                callId: event.callId,
                isError: event.isError,
                resultText: event.resultText,
            });
            return;
        }
        if (event.kind === "thinking_partial") {
            thinkingActive = true;
            callbacks.onThinkingDelta?.({ text: event.text });
            return;
        }
        if (event.kind === "text_partial" || event.kind === "assistant_continuation") {
            previousCompletePlainLine = false;
            endThinking();
            const separator =
                event.kind === "text_partial" &&
                previousAssistantComplete &&
                visibleText &&
                !visibleText.endsWith("\n") &&
                !event.text.startsWith("\n")
                    ? "\n"
                    : "";
            previousAssistantComplete = false;
            const text = separator + event.text;
            visibleText += text;
            streamedBlockText += event.text;
            callbacks.onDelta({ text });
            return;
        }
        if (event.kind === "plain_text") {
            endThinking();
            const text = previousCompletePlainLine ? `\n${event.text}` : event.text;
            previousCompletePlainLine = false;
            previousAssistantComplete = false;
            visibleText += text;
            callbacks.onDelta({ text });
            return;
        }
        if (event.kind === "assistant_delta") {
            previousCompletePlainLine = false;
            endThinking();
            const alreadyStreamed = streamedBlockText;
            streamedBlockText = "";
            const separator =
                previousAssistantComplete && visibleText && !visibleText.endsWith("\n") && !event.text.startsWith("\n")
                    ? "\n"
                    : "";
            previousAssistantComplete = true;
            if (alreadyStreamed && event.text === alreadyStreamed) return;
            const remainder =
                alreadyStreamed && event.text.startsWith(alreadyStreamed)
                    ? event.text.slice(alreadyStreamed.length)
                    : event.text;
            if (!remainder) return;
            const text = separator + remainder;
            visibleText += text;
            callbacks.onDelta({ text });
            return;
        }
        endThinking();
        sawResult = true;
        resultText = event.text;
        metadata = {
            isError: event.isError,
            usage: event.usage,
            ...(event.externalSessionId ? { externalSessionId: event.externalSessionId } : {}),
        };
    };

    streamLoop: while (callbacks.isTerminalAccepted?.() !== true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || "";
        for (const line of lines) {
            // A killed process can still have buffered stdout, especially on Windows.
            // Once RunWield accepts the lifecycle signal, none of that is a new reply.
            if (callbacks.isTerminalAccepted?.() === true) break streamLoop;
            const event: ClaudeCliStreamEvent | null =
                line === "" && previousCompletePlainLine
                    ? { kind: "plain_text", text: "" }
                    : parseClaudeCliJsonLine(line, callbacks);
            if (event) {
                applyEvent(event);
                previousCompletePlainLine = event.kind === "plain_text";
            } else {
                previousCompletePlainLine = false;
            }
        }
    }
    if (buffered.trim() && callbacks.isTerminalAccepted?.() !== true) {
        const event = parseClaudeCliJsonLine(buffered, callbacks);
        if (event) applyEvent(event);
    }
    endThinking();
    if (!sawResult) {
        if (visibleText || callbacks.isTerminalAccepted?.() === true) {
            return { text: visibleText, metadata: { isError: false, usage: emptyUsage } };
        }
        throw new Error("Claude CLI stream ended without a terminal result");
    }
    if (!metadata.isError && resultText !== visibleText && callbacks.isTerminalAccepted?.() !== true) {
        if (!resultText || !visibleText.includes(resultText)) {
            throw new Error("Claude CLI terminal result did not match visible assistant stream");
        }
        return { text: visibleText, metadata };
    }
    return { text: callbacks.isTerminalAccepted?.() === true ? visibleText : resultText, metadata };
}
