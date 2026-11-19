import { isMissingExecutableError, spawnForegroundProcess } from "../../../foreground-process.ts";
import { assertRunWieldAgentName } from "./custom-agent.ts";
import { AgyCliBackendError, isAgyAuthFailure, isAgyMcpUnavailable, isAgyPermissionDenied } from "./failure.ts";
import { concreteAgyModel, type AgyCliEffort } from "./model-options.ts";
import type { AgyCliParseResult, AgyCliStreamCallbacks, AgyCliUsage } from "./stream-parser.ts";

type JsonValue = string | number | boolean | null | JsonRecord | JsonValue[];
interface JsonRecord {
    [key: string]: JsonValue;
}

export interface AgyAcpMcpServer {
    name: string;
    command: string;
    args: string[];
    env: { name: string; value: string }[];
}

export interface AgyAcpPermissionRequest {
    name: string;
    arguments: JsonRecord;
    kind: string;
    toolCallId: string;
}

export interface AgyAcpTurnOptions {
    cwd: string;
    agentName: string;
    model: string;
    effort: AgyCliEffort;
    userRequest: string;
    signal?: AbortSignal;
    terminalSignal?: AbortSignal;
    onReady?: () => void;
    mcpServers?: AgyAcpMcpServer[];
    authorizePermission?: (request: AgyAcpPermissionRequest) => boolean | Promise<boolean>;
}

export interface AgyAcpTurnResult extends AgyCliParseResult {
    modelSelectionSource: "config_options" | "models";
}

const setupTimeoutMs = 30_000;
const promptTimeoutMs = 24 * 60 * 60 * 1000;
const cleanupTimeoutMs = 1_500;
const maximumFrameLength = 16 * 1024 * 1024;

function record(value: JsonValue | undefined): JsonRecord | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function str(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : "";
}

function list(value: JsonValue | undefined): JsonValue[] {
    return Array.isArray(value) ? value : [];
}

function count(value: JsonValue | undefined): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readUsage(value: JsonValue | undefined): AgyCliUsage {
    const usage = record(value);
    return {
        inputTokens: count(usage?.inputTokens),
        outputTokens: count(usage?.outputTokens),
        thinkingTokens: count(usage?.thoughtTokens),
        cacheReadTokens: count(usage?.cachedReadTokens),
        cacheWriteTokens: count(usage?.cachedWriteTokens),
    };
}

interface PendingRequest {
    resolve: (result: JsonRecord) => void;
    reject: (error: Error) => void;
}

export async function runAgyAcpTurn(
    options: AgyAcpTurnOptions,
    callbacks: AgyCliStreamCallbacks = {},
): Promise<AgyAcpTurnResult> {
    assertRunWieldAgentName(options.agentName);
    if (options.signal?.aborted) throw new AgyCliBackendError("canceled");
    const command = "agy";
    let process: ReturnType<typeof spawnForegroundProcess>;
    try {
        process = spawnForegroundProcess({
            command,
            args: [
                "acp",
                "--process-per-session",
                "--agent",
                options.agentName,
                "--include-default-customizations=false",
                "--disable-telemetry",
                "--sandbox",
            ],
            cwd: options.cwd,
            stdin: "piped",
        });
    } catch (error) {
        if (error instanceof Error && isMissingExecutableError(error))
            throw new AgyCliBackendError("missing_executable");
        throw error;
    }
    const writer = process.stdin?.getWriter();
    if (!writer) {
        process.kill();
        throw new AgyCliBackendError("malformed_stream");
    }
    const encoder = new TextEncoder();
    const reader = process.stdout.getReader();
    const diagnosticReader = process.stderr.getReader();
    const pending = new Map<number, PendingRequest>();
    const permissionIds = new Set<string>();
    const approvedToolIds = new Set<string>();
    const toolSteps = new Map<string, { index: number; name: string; input?: JsonRecord; settled: boolean }>();
    let nextId = 0;
    let sessionId = "";
    let prompting = false;
    let diagnostics = "";
    let output = "";
    let toolInfoCount = 0;
    let deniedActions = false;
    let reportedToolFailure = "";
    let transportFailure: Error | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (frame: JsonRecord) => writer.write(encoder.encode(JSON.stringify(frame) + "\n"));
    const fail = (error: Error) => {
        transportFailure ??= error;
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };
    const request = async (method: string, params: JsonRecord, timeoutMs = setupTimeoutMs) => {
        if (transportFailure) throw transportFailure;
        const id = ++nextId;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = new Promise<JsonRecord>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            timer = setTimeout(() => reject(new AgyCliBackendError("timeout")), timeoutMs);
        });
        void send({ jsonrpc: "2.0", id, method, params }).catch(() => fail(new AgyCliBackendError("non_zero_exit")));
        try {
            return await result;
        } finally {
            clearTimeout(timer);
            pending.delete(id);
        }
    };

    const cancel = () => {
        if (cancelTimer !== undefined) return;
        if (!prompting || !sessionId) {
            fail(new AgyCliBackendError("canceled"));
            process.kill();
            return;
        }
        void send({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId },
        }).catch(() => undefined);
        cancelTimer = setTimeout(() => {
            fail(new AgyCliBackendError("canceled"));
            process.kill();
        }, cleanupTimeoutMs);
    };

    const handlePermission = async (id: string | number, params: JsonRecord | undefined) => {
        const call = record(params?.toolCall);
        const input = record(call?.rawInput);
        const name = str(call?.name);
        const toolCallId = str(call?.toolCallId);
        const requestKey = `${typeof id}:${id}`;
        const allow = list(params?.options)
            .map(record)
            .find((option) => option?.kind === "allow_once" && str(option.optionId));
        const isActive = () => prompting && !options.signal?.aborted && !options.terminalSignal?.aborted;
        let approved = false;
        if (
            isActive() &&
            params?.sessionId === sessionId &&
            input &&
            name &&
            toolCallId &&
            allow &&
            !permissionIds.has(requestKey) &&
            !approvedToolIds.has(toolCallId)
        ) {
            permissionIds.add(requestKey);
            // Reserve the call ID before consulting an asynchronous permission UI.
            approvedToolIds.add(toolCallId);
            try {
                approved =
                    (await options.authorizePermission?.({
                        name,
                        arguments: input,
                        kind: str(call?.kind),
                        toolCallId,
                    })) === true && isActive();
            } catch {
                approved = false;
            }
        }
        if (!approved && isActive()) deniedActions = true;
        await send({
            jsonrpc: "2.0",
            id,
            result: {
                outcome:
                    approved && allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" },
            },
        });
    };

    const handleFrame = (frame: JsonRecord) => {
        if (frame.jsonrpc !== "2.0") throw new AgyCliBackendError("malformed_stream");
        const id = frame.id;
        if (typeof frame.method === "string") {
            const params = record(frame.params);
            if (typeof id === "number" || typeof id === "string") {
                const reply =
                    frame.method === "session/request_permission"
                        ? handlePermission(id, params)
                        : send({
                              jsonrpc: "2.0",
                              id,
                              error: { code: -32601, message: "Unsupported client method" },
                          });
                void reply.catch(() => fail(new AgyCliBackendError("non_zero_exit")));
                return;
            }
            if (frame.method !== "session/update" || !prompting || params?.sessionId !== sessionId) return;
            const update = record(params.update);
            if (update?.sessionUpdate === "agent_message_chunk") {
                const delta = str(record(update.content)?.text);
                // Agy can return end_turn despite reporting executor construction failure.
                output += delta;
                callbacks.onDelta?.({ text: delta });
            } else if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
                const callId = str(update.toolCallId);
                if (!callId) return;
                let step = toolSteps.get(callId);
                if (!step) {
                    const name = str(update.name) || str(update.title);
                    if (!name) return;
                    step = { index: toolSteps.size, name, settled: false };
                    toolSteps.set(callId, step);
                }
                if (step.settled) return;
                const input = record(update.rawInput);
                if (input && (!step.input || Object.keys(input).length)) step.input = input;
                const state = update.status === "completed" ? "DONE" : update.status === "failed" ? "ERROR" : "ACTIVE";
                step.settled = state !== "ACTIVE";
                const output =
                    list(update.content)
                        .map((item) => str(record(record(item)?.content)?.text))
                        .filter(Boolean)
                        .join("\n") || str(update.rawOutput);
                if (state === "ERROR" && output) reportedToolFailure += output + "\n";
                toolInfoCount++;
                callbacks.onToolInfo?.({
                    toolName: step.name,
                    callId,
                    stepIndex: step.index,
                    ...(step.settled ? { status: state === "DONE" ? "success" : "error" } : {}),
                });
                callbacks.onTool?.({
                    name: step.name,
                    stepIndex: step.index,
                    state,
                    parameters: step.input,
                    output,
                });
            }
            return;
        }
        if (typeof id !== "number") return;
        const waiter = pending.get(id);
        if (!waiter) return;
        const error = record(frame.error);
        const result = record(frame.result);
        if (error) {
            const message = str(error.message);
            waiter.reject(
                new AgyCliBackendError(isAgyAuthFailure(message) ? "auth_failed" : "non_zero_exit", { message }),
            );
        } else if (result) waiter.resolve(result);
        else waiter.reject(new AgyCliBackendError("malformed_stream"));
    };

    const receive = async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
                if (end > maximumFrameLength) throw new AgyCliBackendError("malformed_stream");
                const line = buffer.slice(0, end).trim();
                buffer = buffer.slice(end + 1);
                if (!line) continue;
                const frame = record(JSON.parse(line) as JsonValue);
                if (!frame) throw new AgyCliBackendError("malformed_stream");
                handleFrame(frame);
            }
            if (buffer.length > maximumFrameLength) throw new AgyCliBackendError("malformed_stream");
        }
        if (buffer.trim()) throw new AgyCliBackendError("malformed_stream");
        fail(new AgyCliBackendError(isAgyAuthFailure(diagnostics) ? "auth_failed" : "non_zero_exit"));
    };
    const receiveDone = receive().catch((error: Error) => {
        fail(error instanceof AgyCliBackendError ? error : new AgyCliBackendError("malformed_stream"));
    });
    const diagnosticDone = (async () => {
        const decoder = new TextDecoder();
        while (true) {
            const { value, done } = await diagnosticReader.read();
            if (done) return;
            diagnostics = (diagnostics + decoder.decode(value, { stream: true })).slice(-8192);
            if (/^\s*Authentication required\b/im.test(diagnostics)) fail(new AgyCliBackendError("auth_failed"));
        }
    })().catch(() => undefined);

    options.signal?.addEventListener("abort", cancel, { once: true });
    options.terminalSignal?.addEventListener("abort", cancel, { once: true });
    try {
        if (options.signal?.aborted || options.terminalSignal?.aborted) cancel();
        const init = await request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "RunWield", version: "1" },
        });
        if (init.protocolVersion !== 1) throw new AgyCliBackendError("malformed_stream");
        const created = await request("session/new", {
            cwd: options.cwd,
            mcpServers: (options.mcpServers || []).map(({ name, command, args, env }) => ({
                name,
                command,
                args,
                env,
            })),
        });
        sessionId = str(created.sessionId);
        if (!sessionId) throw new AgyCliBackendError("malformed_stream");
        const choose = async (configId: string, value: string) => {
            const result = await request("session/set_config_option", {
                sessionId,
                configId,
                value,
            });
            if (
                !list(result.configOptions)
                    .map(record)
                    .some((item) => item?.id === configId && item.currentValue === value)
            ) {
                throw new AgyCliBackendError("selection_mismatch");
            }
            return result;
        };
        const defaultMode = list(created.configOptions)
            .map(record)
            .find((item) => item?.id === "mode")?.currentValue;
        if (defaultMode !== "default") await choose("mode", "default");
        await choose("model", options.model);
        const finalConfig = await choose("thought_level", options.effort);
        const expectedModel = concreteAgyModel(options.model, options.effort);
        const observedModel = str(record(finalConfig.models)?.currentModelId);
        const observedFamily = list(finalConfig.configOptions)
            .map(record)
            .find((item) => item?.id === "model")?.currentValue;
        if (
            observedFamily !== options.model ||
            (observedModel && observedModel !== expectedModel && observedModel !== observedFamily)
        ) {
            throw new AgyCliBackendError("selection_mismatch");
        }
        if (options.signal?.aborted || options.terminalSignal?.aborted) throw new AgyCliBackendError("canceled");
        options.onReady?.();
        prompting = true;
        const result = await request(
            "session/prompt",
            { sessionId, prompt: [{ type: "text", text: options.userRequest }] },
            promptTimeoutMs,
        );
        prompting = false;
        clearTimeout(cancelTimer);
        const usage = readUsage(result.usage);
        if (result.usage) callbacks.onUsage?.(usage);
        if (options.signal?.aborted || (result.stopReason === "cancelled" && !options.terminalSignal?.aborted)) {
            throw new AgyCliBackendError("canceled");
        }
        if (/^\s*(?:⚠\uFE0F?\s*)?failed to construct executor:/im.test(output)) {
            throw new AgyCliBackendError("custom_agent_invalid");
        }
        if (deniedActions) throw new AgyCliBackendError("permission_denied");
        const permissionDenied = isAgyPermissionDenied(reportedToolFailure);
        const mcpUnavailable = isAgyMcpUnavailable(reportedToolFailure);
        if ((permissionDenied || mcpUnavailable) && !output.trim()) {
            throw new AgyCliBackendError(permissionDenied ? "permission_denied" : "mcp_unavailable");
        }
        if (
            result.stopReason !== "end_turn" &&
            !(result.stopReason === "cancelled" && options.terminalSignal?.aborted)
        ) {
            throw new AgyCliBackendError("empty_result");
        }
        if (!output.trim() && !options.terminalSignal?.aborted) throw new AgyCliBackendError("empty_result");
        return {
            modelSelectionSource: observedModel ? "models" : "config_options",
            text: output,
            rawResultText: output,
            metadata: {
                model: observedModel || options.model,
                sessionId,
                usage,
                toolInfoCount,
                status: "success",
                errorText: "",
                deniedActions: false,
                permissionDetails: [],
                authFailed: false,
                permissionDenied,
                mcpUnavailable,
            },
        };
    } catch (error) {
        if (
            error instanceof AgyCliBackendError &&
            (error.kind === "malformed_stream" || error.kind === "non_zero_exit")
        ) {
            // Stdout and stderr arrive independently. Give an adjacent auth diagnostic a short chance to arrive.
            await Promise.race([diagnosticDone, new Promise((resolve) => setTimeout(resolve, 100))]);
            if (isAgyAuthFailure(diagnostics)) throw new AgyCliBackendError("auth_failed");
        }
        throw error;
    } finally {
        prompting = false;
        clearTimeout(cancelTimer);
        options.signal?.removeEventListener("abort", cancel);
        options.terminalSignal?.removeEventListener("abort", cancel);
        if (sessionId && !transportFailure) {
            await request("session/close", { sessionId }, cleanupTimeoutMs).catch(() => undefined);
        }
        process.kill();
        await Promise.allSettled([
            process.done,
            reader.cancel(),
            diagnosticReader.cancel(),
            receiveDone,
            diagnosticDone,
        ]);
        writer.releaseLock();
    }
}
