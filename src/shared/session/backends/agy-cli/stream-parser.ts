import type { AgyCliBackendStatusKind } from "./failure.ts";
import { isAgyAuthFailure, isAgyMcpUnavailable, isAgyPermissionDenied, sanitizeAgyStatusMessage } from "./failure.ts";

export interface AgyCliUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
}

export interface AgyCliMetadata {
    agent?: string;
    model?: string;
    sessionId?: string;
    usage: AgyCliUsage;
    toolInfoCount: number;
    status: string;
    errorText: string;
    deniedActions: boolean;
    permissionDetails: string[];
    authFailed: boolean;
    permissionDenied: boolean;
    mcpUnavailable: boolean;
}

export interface AgyCliParseResult {
    text: string;
    rawResultText: string;
    metadata: AgyCliMetadata;
}

export interface AgyCliAssistantDelta {
    text: string;
}

export interface AgyCliToolStep {
    stepIndex: number;
    state: "ACTIVE" | "DONE" | "ERROR";
    name: string;
    parameters?: JsonRecord;
    output?: string;
    durationMs?: number;
}

export interface AgyCliToolInfoObservation {
    toolName?: string;
    callId?: string;
    stepIndex?: number;
    status?: "success" | "error";
}

export interface AgyCliStreamCallbacks {
    onDelta?: (delta: AgyCliAssistantDelta) => void;
    onTool?: (tool: AgyCliToolStep) => void;
    onToolInfo?: (observation: AgyCliToolInfoObservation) => void;
    onUsage?: (usage: AgyCliUsage) => void;
}

type JsonScalar = string | number | boolean | null;
type JsonArray = JsonValue[];
interface JsonRecord {
    [key: string]: JsonValue;
}
type JsonValue = JsonScalar | JsonArray | JsonRecord;

type AgyCliStreamEvent =
    | { kind: "init"; agent?: string; model?: string; sessionId?: string }
    | { kind: "text_delta"; text: string }
    | { kind: "tool_info"; permissionDetail?: string; tool?: AgyCliToolStep; observation: AgyCliToolInfoObservation }
    | {
        kind: "result";
        text: string;
        usage: AgyCliUsage;
        model?: string;
        sessionId?: string;
        status: string;
        errorText: string;
        deniedActions: boolean;
        permissionDetails: string[];
    };

const emptyUsage: AgyCliUsage = {
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
};

export class AgyCliStreamError extends Error {
    readonly kind: Extract<AgyCliBackendStatusKind, "malformed_stream" | "empty_result" | "result_mismatch">;

    constructor(kind: AgyCliStreamError["kind"], message: string) {
        super(message);
        this.name = "AgyCliStreamError";
        this.kind = kind;
    }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : "";
}

function asNullableNumber(value: JsonValue | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsage(value: JsonValue | undefined): AgyCliUsage {
    const usage = isJsonRecord(value) ? value : {};
    return {
        inputTokens: asNullableNumber(usage.input_tokens) ?? asNullableNumber(usage.inputTokens) ??
            asNullableNumber(usage.input),
        outputTokens: asNullableNumber(usage.output_tokens) ?? asNullableNumber(usage.outputTokens) ??
            asNullableNumber(usage.output),
        thinkingTokens: asNullableNumber(usage.thinking_tokens) ?? asNullableNumber(usage.thinkingTokens),
        cacheReadTokens: asNullableNumber(usage.cache_read_tokens) ?? asNullableNumber(usage.cacheReadTokens),
        cacheWriteTokens: asNullableNumber(usage.cache_write_tokens) ?? asNullableNumber(usage.cacheWriteTokens),
    };
}

function readTextDelta(record: JsonRecord): string {
    const direct = asString(record.text) || asString(record.text_delta) || asString(record.delta);
    if (direct) return direct;
    const delta = isJsonRecord(record.delta) ? record.delta : undefined;
    return asString(delta?.text) || asString(delta?.text_delta);
}

function readResultText(record: JsonRecord): string {
    const direct = asString(record.result) || asString(record.response) || asString(record.text) ||
        asString(record.output);
    if (direct) return direct;
    const result = isJsonRecord(record.result) ? record.result : undefined;
    return asString(result?.response) || asString(result?.text) || asString(result?.output);
}

function readStatus(record: JsonRecord, result: JsonRecord): string {
    return (asString(result.status) || asString(record.status) || asString(result.outcome) ||
        asString(record.outcome) ||
        "success").toLowerCase();
}

function readErrorText(record: JsonRecord, result: JsonRecord): string {
    const direct = asString(result.error) || asString(record.error) || asString(result.message) ||
        asString(record.message);
    if (direct) return direct;
    const error = isJsonRecord(result.error) ? result.error : isJsonRecord(record.error) ? record.error : undefined;
    return asString(error?.message) || asString(error?.text);
}

function hasItems(value: JsonValue | undefined): value is JsonArray {
    return Array.isArray(value) && value.length > 0;
}

function hasDeniedActions(record: JsonRecord, result: JsonRecord): boolean {
    return hasItems(record.denied_actions) || hasItems(result.denied_actions) ||
        hasItems(record.deniedActions) || hasItems(result.deniedActions);
}

function readDeniedActionNames(record: JsonRecord, result: JsonRecord): string[] {
    const names = new Set<string>();
    for (const value of [record.denied_actions, result.denied_actions, record.deniedActions, result.deniedActions]) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
            if (!isJsonRecord(item)) continue;
            const action = asString(item.action);
            if (/^[a-z][a-z0-9_]{0,63}$/i.test(action)) names.add(action);
            if (names.size === 5) return [...names];
        }
    }
    return [...names];
}

function readToolStep(update: JsonRecord): AgyCliToolStep | undefined {
    if (
        update.step_type !== "tool" || typeof update.step_index !== "number" ||
        !Number.isSafeInteger(update.step_index) || update.step_index < 0
    ) return undefined;
    const state = asString(update.state);
    if (state !== "ACTIVE" && state !== "DONE" && state !== "ERROR") return undefined;
    const info = isJsonRecord(update.tool_info) ? update.tool_info : undefined;
    const name = asString(update.tool_name) || asString(info?.name);
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(name)) return undefined;
    const duration = update.duration_seconds;
    return {
        stepIndex: update.step_index,
        state,
        name,
        ...(isJsonRecord(info?.parameters) ? { parameters: info.parameters } : {}),
        ...(typeof info?.output === "string" ? { output: info.output } : {}),
        ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0
            ? { durationMs: Math.round(duration * 1000) }
            : {}),
    };
}

function readToolInfo(update: JsonRecord): AgyCliToolInfoObservation {
    const info = isJsonRecord(update.tool_info) ? update.tool_info : undefined;
    const name = asString(info?.name) || asString(update.tool_name);
    const id = asString(info?.id) || asString(update.tool_call_id);
    const state = asString(update.state).toLowerCase();
    return {
        ...(name && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) ? { toolName: name } : {}),
        ...(id && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) ? { callId: id } : {}),
        ...(typeof update.step_index === "number" && Number.isSafeInteger(update.step_index) && update.step_index >= 0
            ? { stepIndex: update.step_index }
            : {}),
        ...(state === "error"
            ? { status: "error" as const }
            : state === "success"
            ? { status: "success" as const }
            : {}),
    };
}

function readToolPermissionDetail(update: JsonRecord): string | undefined {
    const info = isJsonRecord(update.tool_info) ? update.tool_info : undefined;
    const error = info && isJsonRecord(info.error) ? info.error : undefined;
    if (!error || !isAgyPermissionDenied(asString(error.message))) return undefined;
    const name = asString(info?.name) || asString(update.tool_name);
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(name)) return undefined;
    // Retain file targets, never shell commands, tool output, or arbitrary arguments.
    const parameters = info && isJsonRecord(info.parameters) ? info.parameters : undefined;
    const path = name === "view_file"
        ? asString(parameters?.AbsolutePath)
        : ["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(name)
        ? asString(parameters?.TargetFile)
        : "";
    return sanitizeAgyStatusMessage(path ? `${name}: ${path}` : name, "permission_denied");
}

export function parseAgyCliJsonLine(line: string): AgyCliStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let parsed: JsonValue;
    try {
        parsed = JSON.parse(trimmed) as JsonValue;
    } catch {
        throw new AgyCliStreamError("malformed_stream", "Agy CLI emitted malformed JSON output");
    }
    if (!isJsonRecord(parsed)) return null;
    const type = asString(parsed.type) || asString(parsed.event);
    if (type === "init") {
        const init = isJsonRecord(parsed.init) ? parsed.init : parsed;
        return {
            kind: "init",
            agent: asString(init.agent) || undefined,
            model: asString(init.model) || asString(parsed.model) || undefined,
            sessionId: asString(parsed.conversation_id) || asString(init.conversation_id) ||
                asString(init.session_id) ||
                asString(init.sessionId) || undefined,
        };
    }
    if (type === "step_update") {
        const updateType = asString(parsed.update_type) || asString(parsed.kind) || asString(parsed.step_update);
        if (updateType === "text_delta") {
            const text = readTextDelta(parsed);
            return text ? { kind: "text_delta", text } : null;
        }
        if (updateType === "tool_info") return { kind: "tool_info", observation: readToolInfo(parsed) };
        const nested = isJsonRecord(parsed.step_update) ? parsed.step_update : undefined;
        if (nested) {
            if (isJsonRecord(nested.tool_info)) {
                return {
                    kind: "tool_info",
                    permissionDetail: readToolPermissionDetail(nested),
                    tool: readToolStep(nested),
                    observation: readToolInfo(nested),
                };
            }
            const nestedType = asString(nested.type) || asString(nested.update_type) || asString(nested.kind);
            if (nestedType === "text_delta" || asString(nested.step_type) === "agent_response") {
                const text = readTextDelta(nested);
                return text ? { kind: "text_delta", text } : null;
            }
            if (nestedType === "tool_info") return { kind: "tool_info", observation: readToolInfo(nested) };
        }
        return null;
    }
    if (type === "result") {
        const result = isJsonRecord(parsed.result) ? parsed.result : parsed;
        const errorText = readErrorText(parsed, result);
        return {
            kind: "result",
            text: readResultText(parsed),
            usage: readUsage(result.usage || parsed.usage),
            model: asString(result.model) || asString(parsed.model) || undefined,
            sessionId: asString(parsed.conversation_id) || asString(result.conversation_id) ||
                asString(result.session_id) ||
                asString(result.sessionId) || undefined,
            status: readStatus(parsed, result),
            errorText,
            deniedActions: hasDeniedActions(parsed, result),
            permissionDetails: readDeniedActionNames(parsed, result),
        };
    }
    return null;
}

export async function parseAgyCliStream(
    stream: ReadableStream<Uint8Array>,
    callbacks: AgyCliStreamCallbacks = {},
): Promise<AgyCliParseResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let visibleText = "";
    let rawResultText = "";
    let sawResult = false;
    let agent: string | undefined;
    let model: string | undefined;
    let sessionId: string | undefined;
    let usage = emptyUsage;
    let status = "success";
    let errorText = "";
    let deniedActions = false;
    let deniedActionNames: string[] = [];
    const toolPermissionDetails = new Set<string>();
    let toolInfoCount = 0;
    let streamError: AgyCliStreamError | null = null;

    const applyEvent = (event: AgyCliStreamEvent) => {
        if (event.kind === "init") {
            if (event.agent) agent = event.agent;
            if (event.model) model = event.model;
            if (event.sessionId) sessionId = event.sessionId;
            return;
        }
        if (event.kind === "text_delta") {
            visibleText += event.text;
            callbacks.onDelta?.({ text: event.text });
            return;
        }
        if (event.kind === "tool_info") {
            toolInfoCount += 1;
            if (event.tool) callbacks.onTool?.(event.tool);
            if (event.permissionDetail && toolPermissionDetails.size < 5) {
                toolPermissionDetails.add(event.permissionDetail);
            }
            callbacks.onToolInfo?.(event.observation);
            return;
        }
        sawResult = true;
        rawResultText = event.text;
        usage = event.usage;
        callbacks.onUsage?.(usage);
        status = event.status;
        errorText = event.errorText;
        deniedActions = event.deniedActions;
        deniedActionNames = event.permissionDetails;
        if (event.model) model = event.model;
        if (event.sessionId) sessionId = event.sessionId;
    };

    while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || "";
        for (const line of lines) {
            let event: AgyCliStreamEvent | null = null;
            try {
                event = parseAgyCliJsonLine(line);
            } catch (error) {
                if (!streamError) {
                    streamError = error instanceof AgyCliStreamError
                        ? error
                        : new AgyCliStreamError("malformed_stream", String(error));
                }
            }
            if (event) applyEvent(event);
        }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
        let event: AgyCliStreamEvent | null = null;
        try {
            event = parseAgyCliJsonLine(buffered);
        } catch (error) {
            if (!streamError) {
                streamError = error instanceof AgyCliStreamError
                    ? error
                    : new AgyCliStreamError("malformed_stream", String(error));
            }
        }
        if (event) applyEvent(event);
    }
    if (streamError) throw streamError;
    if (!sawResult) {
        if (!visibleText) throw new AgyCliStreamError("empty_result", "Agy CLI stream ended without output");
        throw new AgyCliStreamError("empty_result", "Agy CLI stream ended without a terminal result");
    }
    const successfulStatus = !status || status === "success" || status === "ok" || status === "completed";
    const permissionDenied = deniedActions || toolPermissionDetails.size > 0 ||
        isAgyPermissionDenied(`${status}\n${errorText}`);
    if (successfulStatus && !rawResultText && !permissionDenied) {
        throw new AgyCliStreamError("empty_result", "Agy CLI stream ended with an empty terminal result");
    }
    if (successfulStatus && rawResultText && visibleText && rawResultText !== visibleText) {
        throw new AgyCliStreamError("result_mismatch", "Agy CLI terminal result did not match streamed assistant text");
    }
    const combinedText = `${status}\n${errorText}`;
    return {
        text: rawResultText,
        rawResultText,
        metadata: {
            ...(agent ? { agent } : {}),
            ...(model ? { model } : {}),
            ...(sessionId ? { sessionId } : {}),
            usage,
            toolInfoCount,
            status,
            errorText,
            deniedActions,
            permissionDetails: toolPermissionDetails.size ? [...toolPermissionDetails] : deniedActionNames,
            authFailed: isAgyAuthFailure(combinedText),
            permissionDenied,
            mcpUnavailable: isAgyMcpUnavailable(combinedText),
        },
    };
}
