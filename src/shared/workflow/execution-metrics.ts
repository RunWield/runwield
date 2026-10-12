/**
 * @module shared/workflow/execution-metrics
 * Cohesive execution metrics recording for RunWield local workflow metrics.
 *
 * Owns execution identity, monotonic ordering, tool exposure denominators,
 * lifecycle pairing, bash normalization, batch/memory operation extraction,
 * usage reconciliation, context snapshots, and execution settlement.
 */

import { estimateContextTextTokens } from "../session/session-context-report.ts";
import {
    classifyToolSubUsage,
    drainWorkflowMetrics,
    getWorkflowMetricsFilePath,
    recordWorkflowMetric,
} from "./metrics.js";

import { resolveCollectionEpoch } from "./metrics-journal.ts";

export type ExecutionKind = "root" | "isolated" | "delegated";
export type ExecutionMode = "foreground" | "background";
export type ToolCallOutcome = "success" | "error" | "canceled" | "rejected" | "incomplete";
export type ExecutionOutcome = "succeeded" | "failed" | "canceled" | "rejected" | "interrupted";
export type UsageKind = "turn" | "request" | "compaction" | "summary" | "standalone";
export type MeasurementAvailability = "complete" | "partial" | "unavailable";

/** Session-local context operations are not Agent executions. */
export class SessionContextMetricsRecorder {
    private readonly recorderId = `rec_${crypto.randomUUID()}`;
    private readonly startedAt = Date.now();
    private seq = 0;
    private readonly usageRecorder: ExecutionMetricsRecorder;

    constructor(
        private readonly projectRoot: string,
        private readonly sessionId: string | null,
        private readonly commandId: string | null,
    ) {
        this.usageRecorder = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: sessionId ?? undefined,
            commandId: commandId ?? undefined,
        });
    }

    private async record(
        event: string,
        fields: Record<string, string | number | ContextSnapshotObservation["staticCategoryCounts"] | null>,
    ): Promise<void> {
        await recordWorkflowMetric({
            v: 2,
            category: event.startsWith("retry_") ? "execution" : "context",
            event,
            recorderId: this.recorderId,
            seq: this.seq++,
            sessionId: this.sessionId,
            commandId: this.commandId,
            ...fields,
        }, this.projectRoot);
    }

    async start(snapshot: ContextSnapshotObservation): Promise<void> {
        await this.record("context_snapshot", {
            samplingPoint: "before_compaction",
            capacity: snapshot.capacity ?? null,
            currentUsage: snapshot.currentUsage ?? null,
            staticCategoryCounts: snapshot.staticCategoryCounts ?? null,
            usageState: snapshot.usageState ?? "estimated",
        });
        await this.record("compaction_started", { reason: "manual", beforeTokens: snapshot.currentUsage ?? null });
    }

    async retryStart(attempt: number, maxAttempts: number, delayMs: number): Promise<void> {
        await this.record("retry_started", { retrySource: "summarization_retry", attempt, maxAttempts, delayMs });
    }

    async retryFinish(attempt: number, outcome: "succeeded" | "failed" | "canceled"): Promise<void> {
        await this.record("retry_finished", { retrySource: "summarization_retry", attempt, outcome });
        await drainWorkflowMetrics(100);
    }

    async finish(
        outcome: "success" | "error" | "canceled",
        before: number | null,
        after: number | null,
        capacity: number | null,
        entries: import("@earendil-works/pi-coding-agent").SessionEntry[],
        priorIds: Set<string>,
    ): Promise<void> {
        await this.usageRecorder.reconcilePiEntries(entries, priorIds);
        await this.record("context_snapshot", {
            samplingPoint: "after_compaction",
            capacity,
            currentUsage: null,
            usageState: "unknown_after_compaction",
        });
        await this.record("compaction_finished", {
            outcome,
            beforeTokens: before,
            afterTokens: after,
            durationMs: Math.max(0, Date.now() - this.startedAt),
        });
        await drainWorkflowMetrics(100);
    }
}

export interface ExecutionRecorderOptions {
    projectRoot: string;
    sessionId?: string;
    managedSessionId?: string;
    segmentId?: string;
    executionId?: string;
    requestId?: string;
    attemptId?: string;
    turnId?: string;
    commandId?: string;
    parentExecutionId?: string;
    parentToolCallId?: string;
    taskId?: string;
    agent?: string;
    agentName?: string;
    provider?: string;
    model?: string;
    backend?: string;
    dispatchKind?: import("../session/request-dispatch.ts").RequestDispatchKind | "named" | string;
    executionKind?: ExecutionKind;
    mode?: ExecutionMode;
    sourceSurface?: string;
    userInitiated?: boolean;
}

export interface ModelUsageObservation {
    sourceId?: string;
    usageKind?: UsageKind;
    provider?: string;
    model?: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costAmount?: number | null;
    costUsd?: number | null;
    costCurrency?: "USD";
    costSource?: "calculated" | "reported" | "unavailable";
    measurementAvailability?: MeasurementAvailability;
    unavailableReason?: string | null;
    aggregationBasis?: "turn" | "request" | "alternative";
    inputCacheBasis?: "includes_cache" | "excludes_cache" | "unknown";
    turnId?: string | null;
    requestId?: string;
}

export interface ContextSnapshotObservation {
    capacity?: number | null;
    currentUsage?: number | null;
    staticCategoryCounts?: {
        systemTokens?: number;
        toolsTokens?: number;
        messagesTokens?: number;
    } | null;
    usageState?:
        | "estimated"
        | "reported"
        | "unknown_after_compaction"
        | "normal"
        | "approaching_limit"
        | "clean"
        | "overflow"
        | string;
    samplingPoint:
        | "execution_start"
        | "execution_end"
        | "turn_start"
        | "turn_end"
        | "before_compaction"
        | "after_compaction";
}

export interface ResponseLatencyObservation {
    requestStartedAt?: number | null;
    firstResponseAt?: number | null;
    firstVisibleTextAt?: number | null;
    completedAt?: number | null;
    firstResponseLatencyMs?: number | null;
    firstVisibleTextLatencyMs?: number | null;
    totalLatencyMs?: number | null;
    basis?: "backend_turn" | "model_request";
    availability?: MeasurementAvailability;
}

const KNOWN_GIT_SUBCOMMANDS = new Set([
    "status",
    "diff",
    "log",
    "show",
    "add",
    "commit",
    "checkout",
    "switch",
    "branch",
    "worktree",
    "fetch",
    "pull",
    "push",
    "stash",
    "rebase",
    "merge",
    "reset",
    "restore",
    "remote",
    "rev-parse",
    "tag",
    "clean",
    "rm",
]);

const KNOWN_DENO_PUBLIC_TASKS = new Set([
    "test",
    "check",
    "lint",
    "fmt",
    "ci",
    "seams:check",
    "build",
]);

const KNOWN_PACKAGE_TASKS = new Set([
    "test",
    "check",
    "lint",
    "fmt",
    "ci",
    "build",
]);

const KNOWN_SAFE_BINARIES = new Set([
    "ls",
    "find",
    "grep",
    "rg",
    "cat",
    "head",
    "tail",
    "sed",
    "awk",
    "pwd",
    "cd",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "touch",
    "chmod",
    "wc",
    "diff",
    "curl",
    "jq",
    "sleep",
    "echo",
    "cmake",
]);

/**
 * Normalizes a bash command line into ordered safe labels.
 * Strips all arguments, flags, environment assignments, paths, redirects, and literal values.
 * Dynamic expressions, command substitution, or malformed syntax result in ["unknown"].
 */
export function normalizeBashCommand(command: string): string[] {
    if (!command || typeof command !== "string") return ["unknown"];
    const trimmed = command.trim();
    if (!trimmed) return ["unknown"];

    // Detect dynamic expressions, command substitutions, expansions, and backticks.
    if (
        /`|\$\(|\$\{|\$\(\(|\$\[|\$[A-Za-z_0-9@*?#$!-]|<[<(]|<<|[\r\n]|\(/.test(trimmed) ||
        /\b(?:sh|bash|zsh|dash)\s+-c\b|(?:^|[;&|]\s*)\b(?:sh|bash|zsh|dash)\b/.test(trimmed) ||
        !isBalancedQuoting(trimmed)
    ) {
        return ["unknown"];
    }

    // Split safely by shell pipeline/chain operators: |, &&, ||, ;, &
    const segments = splitShellSegments(trimmed);
    if (!segments) return ["unknown"];
    const labels: string[] = [];

    for (const segment of segments) {
        const label = classifySingleCommandSegment(segment);
        if (label) labels.push(label);
    }

    return labels.length > 0 ? labels : ["other"];
}

function isBalancedQuoting(input: string): boolean {
    let singleOpen = false;
    let doubleOpen = false;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === "\\" && (singleOpen || doubleOpen)) {
            i++;
            continue;
        }
        if (char === "'" && !doubleOpen) singleOpen = !singleOpen;
        else if (char === '"' && !singleOpen) doubleOpen = !doubleOpen;
    }
    return !singleOpen && !doubleOpen;
}

function splitShellSegments(input: string): string[] | null {
    const segments: string[] = [];
    let current = "";
    let singleOpen = false;
    let doubleOpen = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === "'" && !doubleOpen) singleOpen = !singleOpen;
        else if (char === '"' && !singleOpen) doubleOpen = !doubleOpen;

        if (!singleOpen && !doubleOpen) {
            const prevChar = i > 0 ? input[i - 1] : "";
            if (char === "&" && (prevChar === ">" || prevChar === "<")) {
                current += char;
                continue;
            }

            if (char === "|" || char === "&" || char === ";") {
                if (char === "|" && input[i + 1] === "|") {
                    i++;
                } else if (char === "&" && input[i + 1] === "&") {
                    i++;
                }
                if (!current.trim()) return null;
                segments.push(current.trim());
                current = "";
                continue;
            }
        }
        current += char;
    }
    if (!current.trim()) return null;
    segments.push(current.trim());
    return segments;
}

function tokenizeCommandWords(segment: string): string[] {
    // Strip redirection like > /dev/null, 2>&1, >> file, < file
    const cleaned = segment
        .replace(/>>\s*\S+|>\s*\S+|2>&1|<&[0-9]+|<\s*\S+/g, " ")
        .trim();
    const words: string[] = [];
    let current = "";
    let singleOpen = false;
    let doubleOpen = false;

    for (let i = 0; i < cleaned.length; i++) {
        const char = cleaned[i];
        if (char === "'" && !doubleOpen) {
            singleOpen = !singleOpen;
            continue;
        }
        if (char === '"' && !singleOpen) {
            doubleOpen = !doubleOpen;
            continue;
        }
        if (!singleOpen && !doubleOpen && /\s/.test(char)) {
            if (current) {
                words.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (current) words.push(current);
    return words;
}

function classifySingleCommandSegment(segment: string): string {
    const rawTokens = tokenizeCommandWords(segment);
    // Strip leading env assignments: FOO=bar, A=1
    const tokens = rawTokens.filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    if (tokens.length === 0) return "other";

    let binary = tokens[0].trim();
    if (binary.includes("/") || binary.includes("\\")) {
        binary = binary.split(/[\\/]/).pop() || binary;
    }

    if (binary === "git") {
        const sub = tokens[1]?.trim().toLowerCase();
        if (sub && KNOWN_GIT_SUBCOMMANDS.has(sub)) return `git ${sub}`;
        return "git other";
    }

    if (binary === "deno") {
        const sub = tokens[1]?.trim().toLowerCase();
        if (sub === "task") {
            const task = tokens[2]?.trim().toLowerCase();
            if (task && KNOWN_DENO_PUBLIC_TASKS.has(task)) return `deno task ${task}`;
            return "deno task other";
        }
        if (sub && ["test", "check", "lint", "fmt", "run", "compile"].includes(sub)) {
            return `deno ${sub}`;
        }
        return "deno other";
    }

    if (binary === "npm") {
        const sub = tokens[1]?.trim().toLowerCase();
        if (sub === "test") return "npm test";
        if (sub === "run") {
            const task = tokens[2]?.trim().toLowerCase();
            if (task && KNOWN_PACKAGE_TASKS.has(task)) return `npm run ${task}`;
            return "npm run other";
        }
        if (sub && ["ci", "install", "build"].includes(sub)) return `npm ${sub}`;
        return "npm other";
    }

    if (binary === "pnpm" || binary === "yarn" || binary === "bun") {
        const sub = tokens[1]?.trim().toLowerCase();
        if (sub === "test") return `${binary} test`;
        if (sub === "run") {
            const task = tokens[2]?.trim().toLowerCase();
            if (task && KNOWN_PACKAGE_TASKS.has(task)) return `${binary} run ${task}`;
            return `${binary} run other`;
        }
        if (sub && ["ci", "install", "build"].includes(sub)) return `${binary} ${sub}`;
        return `${binary} other`;
    }

    if (binary === "cargo") {
        const sub = tokens[1]?.trim().toLowerCase();
        if (sub && ["test", "check", "build", "clippy"].includes(sub)) return `cargo ${sub}`;
        return "cargo other";
    }

    if (binary === "go") {
        const sub = tokens[1]?.trim().toLowerCase();
        if (sub && ["test", "build", "vet"].includes(sub)) return `go ${sub}`;
        return "go other";
    }

    if (binary === "pytest") return "pytest";

    if (binary === "python" || binary === "python3") {
        const rest = tokens.slice(1).join(" ");
        if (rest.includes("-m pytest")) return "pytest";
        return "python other";
    }

    if (KNOWN_SAFE_BINARIES.has(binary)) return binary;

    return "other";
}

/**
 * Extracts action and scope from Memory tool calls.
 * Omits query, content, tags, and document IDs.
 */
export function classifyMemoryOperation(
    toolNameOrArgs: string | Record<string, unknown>,
    maybeArgs?: unknown,
): { action: "recall" | "store" | "delete"; scope: "project" | "global" | "unified" } | null {
    const isString = typeof toolNameOrArgs === "string";
    const toolName = isString ? toolNameOrArgs : "memory";
    const args = isString ? maybeArgs : toolNameOrArgs;

    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

    // Check if mnemoteca CLI command line was passed
    if (typeof record.CommandLine === "string" || typeof record.command === "string") {
        const cmd = ((record.CommandLine || record.command) as string).toLowerCase();
        if (cmd.includes("mnemoteca")) {
            let action: "recall" | "store" | "delete" = "recall";
            if (cmd.includes(" add ") || cmd.includes(" store ")) action = "store";
            else if (cmd.includes(" delete ") || cmd.includes(" rm ")) action = "delete";
            else action = "recall";

            const scope: "project" | "global" | "unified" = cmd.includes(" -g") || cmd.includes(" --global")
                ? "global"
                : "project";
            return { action, scope };
        }
    }

    if (!toolName.startsWith("memory") && !record.action) return null;

    let action: "recall" | "store" | "delete" = "recall";
    if (toolName === "memory" || !toolName) {
        if (record.action === "store") action = "store";
        else if (record.action === "delete") action = "delete";
        else action = "recall";
    } else if (toolName.includes("store") || toolName.includes("write")) {
        action = record.action === "delete" ? "delete" : "store";
    } else if (toolName.includes("delete")) {
        action = "delete";
    }

    let scope: "project" | "global" | "unified" = "project";
    if (action === "recall") {
        scope = "unified";
    } else {
        if (toolName.endsWith("_global") || record.scope === "global") scope = "global";
        else scope = "project";
    }

    return { action, scope };
}

/**
 * Extracts requested code_batch child operations and statuses.
 * Excludes symbol names, file paths, and source code.
 */
export function extractCodeBatchOperations(
    args: unknown,
    result?: unknown,
): Array<{
    batchKind: "show" | "outline";
    status: "success" | "error" | "truncated" | "unavailable";
    truncated: boolean | null;
}> {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const operations = Array.isArray(record.operations) ? record.operations : [];
    if (operations.length === 0) return [];

    let resultItems: Array<Record<string, unknown>> = [];
    if (result && typeof result === "object") {
        const resObj = result as Record<string, unknown>;
        const details = resObj.details && typeof resObj.details === "object"
            ? (resObj.details as Record<string, unknown>)
            : null;
        if (Array.isArray(resObj.results)) {
            resultItems = resObj.results.filter((item): item is Record<string, unknown> =>
                Boolean(item && typeof item === "object")
            );
        } else if (details && Array.isArray(details.results)) {
            resultItems = details.results.filter(
                (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
            );
        }
    }

    return operations.map((op, index) => {
        const opObj = op && typeof op === "object" ? (op as Record<string, unknown>) : {};
        const opKind = typeof opObj.op === "string"
            ? opObj.op
            : typeof opObj.kind === "string"
            ? opObj.kind
            : typeof opObj.type === "string"
            ? opObj.type
            : "";
        const batchKind: "show" | "outline" = opKind === "outline" ? "outline" : "show";

        const resItem = resultItems[index];
        let status: "success" | "error" | "truncated" | "unavailable" = "unavailable";
        let truncated: boolean | null = null;

        if (resItem) {
            if (typeof resItem.truncated === "boolean") truncated = resItem.truncated;
            if (resItem.status === "success") status = "success";
            if (resItem.status === "error" || resItem.isError === true || resItem.error) status = "error";
            else if (resItem.status === "truncated" || resItem.truncated === true) {
                status = "truncated";
                truncated = true;
            }
        }

        return { batchKind, status, truncated };
    });
}

/**
 * Estimates schema-only tokens and resident-context tokens for a Tool Definition.
 */
export function estimateToolSchemaTokens(definition: {
    name: string;
    description?: string;
    parameters?: unknown;
    residentTokens?: number;
}): { schemaTokens: number; residentTokens: number } {
    const schemaString = definition.parameters ? JSON.stringify(definition.parameters) : "";
    const schemaTokens = estimateContextTextTokens(schemaString);
    const residentTokens = definition.residentTokens ?? estimateContextTextTokens(
        `Tool: ${definition.name}\nDescription: ${definition.description || ""}\nParameters schema: ${schemaString}`,
    );
    return { schemaTokens, residentTokens };
}

interface OpenToolCall {
    callId: string;
    toolName: string;
    subUsage: string;
    startedAt: number;
    seq: number;
    exposureId?: string;
    args?: unknown;
}

/**
 * Cohesive Execution Metrics Recorder.
 */
export class ExecutionMetricsRecorder {
    readonly recorderId: string;
    readonly executionId: string;
    readonly projectRoot: string;
    readonly sessionId?: string;
    readonly managedSessionId?: string;
    readonly segmentId?: string;
    readonly requestId?: string;
    readonly attemptId?: string;
    readonly turnId?: string;
    readonly commandId?: string;
    readonly parentExecutionId?: string;
    readonly parentToolCallId?: string;
    readonly taskId?: string;
    readonly agent: string;
    readonly provider?: string;
    readonly model?: string;
    readonly backend: string;
    readonly dispatchKind: string;
    readonly executionKind: ExecutionKind;
    readonly mode: ExecutionMode;
    readonly sourceSurface: string;
    readonly userInitiated: boolean;
    private historyEpoch: string;

    private seq = 0;
    private startedAt: number;
    private requestStartedAt?: number;
    private currentTurnId?: string;
    private firstResponseAt?: number;
    private firstVisibleTextAt?: number;
    private completedAt?: number;
    private activeExposureId?: string;
    private observedCallCount = 0;
    private missingToolEnds = false;
    private observedContext = false;
    private usageCoverage: MeasurementAvailability = "unavailable";
    private usageIncomplete = false;
    private inventoryCoverage: MeasurementAvailability = "unavailable";
    private openToolCalls = new Map<string, OpenToolCall>();
    private completedToolCallIds = new Set<string>();
    private nativeObservationIds = new Set<string>();
    private reconciledUsageEntryIds = new Set<string>();
    private piEntryTurnIds = new Map<string, string>();
    private settled = false;

    constructor(options: ExecutionRecorderOptions) {
        this.recorderId = `rec_${crypto.randomUUID()}`;
        this.executionId = options.executionId || `exec_${crypto.randomUUID()}`;
        this.projectRoot = options.projectRoot;
        this.sessionId = options.sessionId;
        this.managedSessionId = options.managedSessionId;
        this.segmentId = options.segmentId;
        this.requestId = options.requestId;
        this.attemptId = options.attemptId;
        this.turnId = options.turnId;
        this.commandId = options.commandId;
        this.parentExecutionId = options.parentExecutionId;
        this.parentToolCallId = options.parentToolCallId;
        this.taskId = options.taskId;
        this.agent = options.agent || options.agentName || "unknown";
        this.provider = options.provider;
        this.model = options.model;
        this.backend = options.backend || "pi";
        this.dispatchKind = options.dispatchKind || "interactive";
        this.executionKind = options.executionKind || "root";
        this.mode = options.mode || "foreground";
        this.sourceSurface = options.sourceSurface || "cli";
        this.userInitiated = options.userInitiated === true;
        try {
            this.historyEpoch = resolveCollectionEpoch(getWorkflowMetricsFilePath(options.projectRoot)).historyEpoch;
        } catch {
            this.historyEpoch = "unavailable";
        }
        this.startedAt = Date.now();
    }

    private nextSeq(): number {
        return this.seq++;
    }

    private baseLinks() {
        return {
            v: 2,
            recorderId: this.recorderId,
            historyEpoch: this.historyEpoch,
            executionId: this.executionId,
            sessionId: this.sessionId ?? null,
            managedSessionId: this.managedSessionId ?? null,
            segmentId: this.segmentId ?? null,
            requestId: this.requestId ?? null,
            attemptId: this.attemptId ?? null,
            turnId: this.currentTurnId ?? this.turnId ?? null,
            commandId: this.commandId ?? null,
            parentExecutionId: this.parentExecutionId ?? null,
            parentToolCallId: this.parentToolCallId ?? null,
            taskId: this.taskId ?? null,
            agent: this.agent,
            ...(this.provider ? { provider: this.provider } : {}),
            ...(this.model ? { model: this.model } : {}),
            backend: this.backend,
            dispatchKind: this.dispatchKind,
            executionKind: this.executionKind,
            mode: this.mode,
        };
    }

    async recordExecutionStart(): Promise<void> {
        this.startedAt = Date.now();
        const result = await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "execution",
                event: "execution_started",
                seq: this.nextSeq(),
                sourceSurface: this.sourceSurface,
                userInitiated: this.userInitiated,
            },
            this.projectRoot,
        );
        if (result.persisted && result.historyEpoch) this.historyEpoch = result.historyEpoch;
    }

    async recordToolExposure(
        tools: Array<{ name: string; description?: string; parameters?: unknown; residentTokens?: number }>,
        inventoryCoverage: MeasurementAvailability = "complete",
    ): Promise<string> {
        const exposureId = `exp_${crypto.randomUUID()}`;
        this.activeExposureId = exposureId;
        this.inventoryCoverage = inventoryCoverage;
        const totalCount = tools.length;
        let totalSchemaTokens = 0;
        let totalResidentTokens = 0;

        const evaluatedTools = tools.map((tool, index) => {
            const estimates = estimateToolSchemaTokens(tool);
            totalSchemaTokens += estimates.schemaTokens;
            totalResidentTokens += estimates.residentTokens;
            return {
                toolIndex: index,
                toolName: tool.name,
                schemaTokens: estimates.schemaTokens,
                residentTokens: estimates.residentTokens,
            };
        });

        const summarySeq = this.nextSeq();
        const itemSeqs = evaluatedTools.map(() => this.nextSeq());
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "tool_usage",
                event: "tool_exposure_summary",
                seq: summarySeq,
                exposureId,
                toolCount: totalCount,
                estimatorVersion: "1",
                inventoryCoverage,
                totalSchemaTokens,
                totalResidentTokens,
            },
            this.projectRoot,
        );

        // One row per tool keeps inventories larger than 40 complete.
        for (const [index, item] of evaluatedTools.entries()) {
            await recordWorkflowMetric(
                {
                    ...this.baseLinks(),
                    category: "tool_usage",
                    event: "tool_exposure",
                    seq: itemSeqs[index],
                    exposureId,
                    toolIndex: item.toolIndex,
                    toolName: item.toolName,
                    schemaTokens: item.schemaTokens,
                    residentTokens: item.residentTokens,
                    totalCount,
                },
                this.projectRoot,
            );
        }

        return exposureId;
    }

    /** The bridge's committed messages are its authoritative call observations. */
    async recordBridgeMessage(
        message: import("@earendil-works/pi-coding-agent").SessionMessageEntry["message"],
    ): Promise<void> {
        if (message.role === "assistant") {
            for (const part of message.content) {
                if (part.type === "toolCall") await this.recordToolStart(part.id, part.name, part.arguments);
            }
        } else if (message.role === "toolResult") {
            const reason = message.details && typeof message.details === "object" && "reason" in message.details &&
                    typeof message.details.reason === "string"
                ? message.details.reason
                : null;
            const outcome = reason === "aborted"
                ? "canceled"
                : reason && reason !== "execution_error"
                ? "rejected"
                : message.isError
                ? "error"
                : "success";
            await this.recordToolFinish(message.toolCallId, message.toolName, {
                outcome,
                isError: message.isError,
                reason: reason === "aborted"
                    ? "aborted"
                    : reason === "execution_error"
                    ? "execution_error"
                    : reason?.startsWith("invalid arguments")
                    ? "invalid_arguments"
                    : reason?.includes("closed the gate")
                    ? "gate_closed"
                    : reason
                    ? "rejected"
                    : undefined,
                result: message,
            });
        }
    }

    async recordNativeToolInfo(
        observation: { toolName?: string; callId?: string; stepIndex?: number; status?: "success" | "error" },
    ): Promise<void> {
        const identity = observation.callId ??
            (observation.stepIndex !== undefined ? `step_${observation.stepIndex}` : null);
        if (
            identity && (this.nativeObservationIds.has(identity) || this.openToolCalls.has(identity) ||
                this.completedToolCallIds.has(identity))
        ) return;
        if (identity) this.nativeObservationIds.add(identity);
        await recordWorkflowMetric({
            ...this.baseLinks(),
            category: "tool_usage",
            event: "native_tool_observed",
            seq: this.nextSeq(),
            callId: observation.callId ?? null,
            stepIndex: observation.stepIndex ?? null,
            toolName: observation.toolName ?? "unknown",
            status: observation.status ?? null,
        }, this.projectRoot);
    }

    async recordToolStart(callId: string, toolName: string, args?: unknown): Promise<void> {
        if (!callId || this.settled || this.openToolCalls.has(callId) || this.completedToolCallIds.has(callId)) return;
        const subUsage = classifyToolSubUsage(toolName, args);
        const seq = this.nextSeq();
        const exposureId = this.activeExposureId;

        this.openToolCalls.set(callId, {
            callId,
            toolName,
            subUsage,
            startedAt: Date.now(),
            seq,
            exposureId,
            args,
        });
        this.observedCallCount++;

        // Capture child observations before any asynchronous write can interleave with this call.
        const command = toolName === "bash" && args && typeof args === "object" &&
                typeof (args as { command?: unknown }).command === "string"
            ? (args as { command: string }).command
            : "";
        const labels = toolName === "bash" ? normalizeBashCommand(command) : [];
        const memoryOp = toolName.startsWith("memory") ? classifyMemoryOperation(toolName, args) : null;
        const operationSeqs = Array.from({ length: labels.length + (memoryOp ? 1 : 0) }, () => this.nextSeq());

        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "tool_usage",
                event: "tool_call_started",
                seq,
                callId,
                exposureId,
                toolName,
                subUsage,
            },
            this.projectRoot,
        );

        if (toolName === "bash") {
            for (let i = 0; i < labels.length; i++) {
                await recordWorkflowMetric(
                    {
                        ...this.baseLinks(),
                        category: "tool_usage",
                        event: "tool_operation",
                        seq: operationSeqs[i],
                        parentCallId: callId,
                        operationIndex: i,
                        operationKind: "bash_command",
                        commandLabel: labels[i],
                    },
                    this.projectRoot,
                );
            }
        } else if (memoryOp) {
            await recordWorkflowMetric(
                {
                    ...this.baseLinks(),
                    category: "tool_usage",
                    event: "tool_operation",
                    seq: operationSeqs[0],
                    parentCallId: callId,
                    operationIndex: 0,
                    operationKind: "memory",
                    action: memoryOp.action,
                    scope: memoryOp.scope,
                },
                this.projectRoot,
            );
        }
    }

    async recordToolFinish(
        callId: string,
        toolName: string,
        options: {
            outcome?: ToolCallOutcome;
            reason?: string;
            isError?: boolean;
            durationMs?: number | null;
            result?: unknown;
            truncated?: boolean | null;
            args?: unknown;
        } = {},
    ): Promise<void> {
        if (!callId || this.settled || this.completedToolCallIds.has(callId)) return;
        const open = this.openToolCalls.get(callId);
        if (!open) return;
        this.openToolCalls.delete(callId);
        this.completedToolCallIds.add(callId);

        const now = Date.now();
        const durationMs = options.durationMs !== undefined
            ? options.durationMs
            : open
            ? Math.max(0, now - open.startedAt)
            : null;

        const subUsage = open?.subUsage || classifyToolSubUsage(toolName, options.args);
        const exposureId = open?.exposureId || this.activeExposureId;

        let outcome: ToolCallOutcome = options.outcome || (options.isError ? "error" : "success");
        if (options.isError && outcome !== "rejected" && outcome !== "canceled") {
            outcome = "error";
        }

        const effectiveToolName = toolName || open?.toolName || "unknown";

        // Calculate result sizes
        const { resultBytes, resultTokens, imageCount, truncated } = evaluateToolResultMetrics(
            options.result,
            options.truncated,
        );

        const batchOps = effectiveToolName === "code_batch"
            ? extractCodeBatchOperations(options.args ?? open.args, options.result)
            : [];
        const operationSeqs = batchOps.map(() => this.nextSeq());
        const finishSeq = this.nextSeq();
        if (batchOps.length > 0) {
            for (let i = 0; i < batchOps.length; i++) {
                const op = batchOps[i];
                await recordWorkflowMetric(
                    {
                        ...this.baseLinks(),
                        category: "tool_usage",
                        event: "tool_operation",
                        seq: operationSeqs[i],
                        parentCallId: callId,
                        operationIndex: i,
                        operationKind: "code_batch",
                        batchKind: op.batchKind,
                        status: op.status,
                        truncated: op.truncated,
                    },
                    this.projectRoot,
                );
            }
        }

        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "tool_usage",
                event: "tool_call_finished",
                seq: finishSeq,
                callId,
                exposureId,
                toolName: effectiveToolName,
                subUsage,
                outcome,
                reason: options.reason || (outcome === "error" ? "returned_error" : "completed"),
                durationMs,
                resultBytes,
                resultTokens,
                imageCount,
                truncated,
                isError: outcome === "error" || outcome === "rejected",
            },
            this.projectRoot,
        );
    }

    /** Associate persisted Pi entries with the turn that produced them before settlement. */
    associatePiTurnEntries(
        entries: import("@earendil-works/pi-coding-agent").SessionEntry[],
        priorIds: Set<string>,
    ): void {
        if (!this.currentTurnId) return;
        for (const entry of entries) {
            if (!priorIds.has(entry.id)) this.piEntryTurnIds.set(entry.id, this.currentTurnId);
        }
    }

    /** Reconcile only entries appended during this operation, including failed turns. */
    async reconcilePiEntries(
        entries: import("@earendil-works/pi-coding-agent").SessionEntry[],
        priorIds: Set<string>,
    ): Promise<void> {
        for (const entry of entries) {
            if (priorIds.has(entry.id)) continue;
            let usage: import("@earendil-works/pi-ai").Usage | undefined;
            let usageKind: UsageKind = "turn";
            let provider = this.provider;
            let model = this.model;
            if (entry.type === "usage") {
                usage = entry.usage;
                usageKind = "standalone";
                provider = entry.provider;
                model = entry.model;
            } else if (entry.type === "compaction" || entry.type === "branch_summary") {
                usage = entry.usage;
                usageKind = entry.type === "compaction" ? "compaction" : "summary";
            } else if (
                entry.type === "message" &&
                (entry.message.role === "assistant" || entry.message.role === "toolResult")
            ) {
                usage = entry.message.usage;
                usageKind = entry.message.role === "assistant" ? "turn" : "request";
                if (entry.message.role === "assistant") {
                    provider = entry.message.provider;
                    model = entry.message.model;
                }
            }
            if (!usage) continue;
            await this.recordModelUsage({
                sourceId: entry.id,
                usageKind,
                provider,
                model,
                inputTokens: typeof usage.input === "number" ? usage.input : null,
                outputTokens: typeof usage.output === "number" ? usage.output : null,
                cacheReadTokens: typeof usage.cacheRead === "number" ? usage.cacheRead : null,
                cacheWriteTokens: typeof usage.cacheWrite === "number" ? usage.cacheWrite : null,
                costAmount: typeof usage.cost?.total === "number" ? usage.cost.total : null,
                costSource: typeof usage.cost?.total === "number" ? "calculated" : "unavailable",
                inputCacheBasis: "excludes_cache",
                aggregationBasis: usageKind === "request" ? "request" : "turn",
                turnId: this.piEntryTurnIds.get(entry.id) ?? null,
            });
        }
    }

    async recordModelUsage(usage: ModelUsageObservation): Promise<void> {
        const sourceId = usage.sourceId || `usage_${crypto.randomUUID()}`;
        const availability = usage.measurementAvailability ||
            (usage.inputTokens === null && usage.outputTokens === null
                ? "unavailable"
                : usage.inputTokens === null || usage.outputTokens === null ||
                        usage.cacheReadTokens == null || usage.cacheWriteTokens == null
                ? "partial"
                : "complete");
        if (this.reconciledUsageEntryIds.has(sourceId)) return;
        this.reconciledUsageEntryIds.add(sourceId);
        if (availability !== "complete") this.usageIncomplete = true;
        if (availability !== "unavailable") this.usageCoverage = this.usageIncomplete ? "partial" : "complete";
        else if (this.usageCoverage === "complete") this.usageCoverage = "partial";

        const costAmount = usage.costAmount ?? usage.costUsd ?? null;
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "model_usage",
                event: "model_usage",
                seq: this.nextSeq(),
                sourceId,
                usageKind: usage.usageKind || "turn",
                provider: usage.provider || this.provider,
                model: usage.model || this.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens ?? null,
                cacheWriteTokens: usage.cacheWriteTokens ?? null,
                costAmount,
                costCurrency: usage.costCurrency || "USD",
                costSource: usage.costSource || (costAmount != null ? "calculated" : "unavailable"),
                measurementAvailability: availability,
                unavailableReason: usage.unavailableReason ?? null,
                aggregationBasis: usage.aggregationBasis || "turn",
                inputCacheBasis: usage.inputCacheBasis || "unknown",
                turnId: usage.turnId !== undefined ? usage.turnId : this.currentTurnId ?? this.turnId ?? null,
                requestId: usage.requestId || this.requestId,
            },
            this.projectRoot,
        );
    }

    async recordContextSnapshot(
        samplingPointOrSnapshot:
            | ContextSnapshotObservation
            | "execution_start"
            | "execution_end"
            | "turn_start"
            | "turn_end"
            | "before_compaction"
            | "after_compaction",
        maybeSnapshot?: {
            capacityTokens?: number | null;
            currentTokens?: number | null;
            capacity?: number | null;
            currentUsage?: number | null;
            usageState?: "normal" | "approaching_limit" | "clean" | "overflow" | string;
            staticCategoryCounts?: Record<string, number> | null;
        },
    ): Promise<void> {
        let samplingPoint:
            | "execution_start"
            | "execution_end"
            | "turn_start"
            | "turn_end"
            | "before_compaction"
            | "after_compaction" = "turn_end";
        let capacity: number | null = null;
        let currentUsage: number | null = null;
        let usageState = "normal";
        let staticCategoryCounts: Record<string, number> | null = null;

        if (typeof samplingPointOrSnapshot === "string") {
            samplingPoint = samplingPointOrSnapshot;
            if (maybeSnapshot) {
                capacity = maybeSnapshot.capacity ?? maybeSnapshot.capacityTokens ?? null;
                currentUsage = maybeSnapshot.currentUsage ?? maybeSnapshot.currentTokens ?? null;
                usageState = maybeSnapshot.usageState || "normal";
                staticCategoryCounts = maybeSnapshot.staticCategoryCounts ?? null;
            }
        } else {
            const snap = samplingPointOrSnapshot;
            samplingPoint = snap.samplingPoint;
            capacity = snap.capacity ?? null;
            currentUsage = snap.currentUsage ?? null;
            usageState = snap.usageState || "normal";
            staticCategoryCounts = snap.staticCategoryCounts ?? null;
        }

        if (currentUsage !== null && capacity !== null) this.observedContext = true;
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "context",
                event: "context_snapshot",
                seq: this.nextSeq(),
                capacity,
                currentUsage,
                staticCategoryCounts,
                usageState,
                samplingPoint,
            },
            this.projectRoot,
        );
    }

    async recordCompactionStart(options: {
        reason: "manual" | "threshold" | "overflow";
        beforeTokens?: number | null;
    }): Promise<void> {
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "context",
                event: "compaction_started",
                seq: this.nextSeq(),
                reason: options.reason,
                beforeTokens: options.beforeTokens ?? null,
            },
            this.projectRoot,
        );
    }

    async recordCompactionFinish(options: {
        outcome: "succeeded" | "failed" | "canceled";
        beforeTokens?: number | null;
        afterTokens?: number | null;
        durationMs?: number | null;
    }): Promise<void> {
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "context",
                event: "compaction_finished",
                seq: this.nextSeq(),
                outcome: options.outcome,
                beforeTokens: options.beforeTokens ?? null,
                afterTokens: options.afterTokens ?? null,
                durationMs: options.durationMs ?? null,
            },
            this.projectRoot,
        );
    }

    async recordCompaction(options: {
        reason?: "manual" | "threshold" | "overflow" | string;
        phase?: "start" | "end" | "finish";
        outcome?: "succeeded" | "failed" | "canceled" | "error" | "success";
        tokensBefore?: number | null;
        tokensAfter?: number | null;
        beforeTokens?: number | null;
        afterTokens?: number | null;
        durationMs?: number;
    }): Promise<void> {
        if (options.phase === "start") {
            const reason = options.reason === "manual" || options.reason === "overflow" ? options.reason : "threshold";
            await this.recordCompactionStart({
                reason,
                beforeTokens: options.tokensBefore ?? options.beforeTokens ?? null,
            });
            return;
        }

        let outcome: "succeeded" | "failed" | "canceled" = "succeeded";
        if (options.outcome === "canceled") outcome = "canceled";
        else if (options.outcome === "failed" || options.outcome === "error") outcome = "failed";

        await this.recordCompactionFinish({
            outcome,
            beforeTokens: options.tokensBefore ?? options.beforeTokens ?? null,
            afterTokens: options.tokensAfter ?? options.afterTokens ?? null,
            durationMs: options.durationMs ?? null,
        });
    }

    async recordRetryStart(options: {
        retrySource: "auto_retry" | "summarization_retry";
        attempt: number;
        maxAttempts: number;
        delayMs: number;
    }): Promise<void> {
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "execution",
                event: "retry_started",
                seq: this.nextSeq(),
                retrySource: options.retrySource,
                attempt: options.attempt,
                maxAttempts: options.maxAttempts,
                delayMs: options.delayMs,
            },
            this.projectRoot,
        );
    }

    async recordRetryFinish(options: {
        retrySource: "auto_retry" | "summarization_retry";
        attempt: number;
        outcome: "succeeded" | "failed" | "canceled";
        reason?: string | null;
    }): Promise<void> {
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "execution",
                event: "retry_finished",
                seq: this.nextSeq(),
                retrySource: options.retrySource,
                attempt: options.attempt,
                outcome: options.outcome,
                reason: options.reason ?? null,
            },
            this.projectRoot,
        );
    }

    async recordRetry(options: {
        retrySource?: "model" | "auto_retry" | "summarization_retry" | string;
        attempt: number;
        maxAttempts?: number;
        delayMs?: number;
        outcome?: "succeeded" | "failed" | "canceled" | "success";
        reason?: string | null;
        finalError?: string | null;
    }): Promise<void> {
        const source = options.retrySource === "summarization_retry" ? "summarization_retry" : "auto_retry";
        if (options.outcome) {
            const outcome = options.outcome === "canceled"
                ? "canceled"
                : options.outcome === "success" || options.outcome === "succeeded"
                ? "succeeded"
                : "failed";
            await this.recordRetryFinish({
                retrySource: source,
                attempt: options.attempt,
                outcome,
                reason: options.reason || options.finalError || null,
            });
        } else {
            await this.recordRetryStart({
                retrySource: source,
                attempt: options.attempt,
                maxAttempts: options.maxAttempts || 3,
                delayMs: options.delayMs || 0,
            });
        }
    }

    async recordResponseLatency(
        latencyOrPhase: ResponseLatencyObservation | "turn_start" | "first_response" | "first_text" | "turn_finish",
    ): Promise<void> {
        if (typeof latencyOrPhase === "string") {
            const now = Date.now();
            if (latencyOrPhase === "turn_start") {
                this.currentTurnId = this.turnId ?? `turn_${crypto.randomUUID()}`;
                this.requestStartedAt = now;
                this.firstResponseAt = undefined;
                this.firstVisibleTextAt = undefined;
                this.completedAt = undefined;
                return;
            }
            if (latencyOrPhase === "first_response") {
                if (!this.firstResponseAt) this.firstResponseAt = now;
                return;
            }
            if (latencyOrPhase === "first_text") {
                if (!this.firstVisibleTextAt) this.firstVisibleTextAt = now;
                if (!this.firstResponseAt) this.firstResponseAt = now;
                return;
            }
            if (latencyOrPhase === "turn_finish") {
                this.completedAt = now;
                const started = this.requestStartedAt || this.startedAt;
                const firstResp = this.firstResponseAt ?? null;
                const firstText = this.firstVisibleTextAt ?? null;
                const firstResponseLatencyMs = firstResp === null ? null : Math.max(0, firstResp - started);
                const firstVisibleTextLatencyMs = firstText === null ? null : Math.max(0, firstText - started);
                const totalLatencyMs = Math.max(0, now - started);
                // Retire this turn before the asynchronous write; a subsequent turn may start meanwhile.
                const links = this.baseLinks();
                this.currentTurnId = undefined;

                await recordWorkflowMetric(
                    {
                        ...links,
                        category: "execution",
                        event: "response_latency",
                        seq: this.nextSeq(),
                        requestStartedAt: started,
                        firstResponseAt: firstResp,
                        firstVisibleTextAt: firstText,
                        completedAt: now,
                        firstResponseLatencyMs,
                        firstVisibleTextLatencyMs,
                        totalLatencyMs,
                        basis: "backend_turn",
                        availability: firstResp !== null && firstText !== null ? "complete" : "partial",
                    },
                    this.projectRoot,
                );
                return;
            }
        }

        const latency = latencyOrPhase as ResponseLatencyObservation;
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "execution",
                event: "response_latency",
                seq: this.nextSeq(),
                requestStartedAt: latency.requestStartedAt ?? null,
                firstResponseAt: latency.firstResponseAt ?? null,
                firstVisibleTextAt: latency.firstVisibleTextAt ?? null,
                completedAt: latency.completedAt ?? null,
                firstResponseLatencyMs: latency.firstResponseLatencyMs ?? null,
                firstVisibleTextLatencyMs: latency.firstVisibleTextLatencyMs ?? null,
                totalLatencyMs: latency.totalLatencyMs ?? null,
                basis: latency.basis || "backend_turn",
                availability: latency.availability || "complete",
            },
            this.projectRoot,
        );
    }

    async settleExecution(
        outcome: ExecutionOutcome = "succeeded",
        reason = "completed",
    ): Promise<void> {
        if (this.settled) return;
        this.settled = true;

        // Settle any unclosed tool calls as canceled or incomplete
        this.missingToolEnds = this.openToolCalls.size > 0;
        for (const [callId, open] of this.openToolCalls.entries()) {
            this.completedToolCallIds.add(callId);
            await recordWorkflowMetric(
                {
                    ...this.baseLinks(),
                    category: "tool_usage",
                    event: "tool_call_finished",
                    seq: this.nextSeq(),
                    callId,
                    exposureId: open.exposureId,
                    toolName: open.toolName,
                    subUsage: open.subUsage,
                    outcome: outcome === "canceled" ? "canceled" : "incomplete",
                    reason: outcome === "canceled" ? "execution_canceled" : "execution_settled",
                    durationMs: Math.max(0, Date.now() - open.startedAt),
                    resultBytes: null,
                    resultTokens: null,
                    imageCount: 0,
                    truncated: null,
                    isError: outcome !== "succeeded",
                },
                this.projectRoot,
            );
        }
        this.openToolCalls.clear();

        const elapsedMs = Math.max(0, Date.now() - this.startedAt);
        await recordWorkflowMetric(
            {
                ...this.baseLinks(),
                category: "execution",
                event: "execution_finished",
                seq: this.nextSeq(),
                outcome,
                reason,
                elapsedMs,
                callCount: this.observedCallCount,
                coverage: {
                    tools: this.inventoryCoverage === "unavailable" && this.observedCallCount === 0
                        ? "unavailable"
                        : this.missingToolEnds || this.inventoryCoverage !== "complete"
                        ? "partial"
                        : "complete",
                    usage: this.usageCoverage,
                    context: this.observedContext ? "partial" : "unavailable",
                },
            },
            this.projectRoot,
        );

        await this.drain();
    }

    async drain(): Promise<void> {
        await drainWorkflowMetrics();
    }
}

function evaluateToolResultMetrics(
    result: unknown,
    explicitTruncated?: boolean | null,
): {
    resultBytes: number | null;
    resultTokens: number | null;
    imageCount: number;
    truncated: boolean | null;
} {
    if (result === undefined || result === null) {
        return {
            resultBytes: null,
            resultTokens: null,
            imageCount: 0,
            truncated: explicitTruncated ?? null,
        };
    }

    let text = "";
    let imageCount = 0;
    let foundTruncated = explicitTruncated ?? null;

    if (typeof result === "string") {
        text = result;
    } else if (typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (typeof obj.truncated === "boolean") foundTruncated = obj.truncated;
        if (
            obj.details && typeof obj.details === "object" &&
            typeof (obj.details as Record<string, unknown>).truncated === "boolean"
        ) {
            foundTruncated = (obj.details as Record<string, unknown>).truncated as boolean;
        }

        if (Array.isArray(obj.content)) {
            for (const item of obj.content) {
                if (item && typeof item === "object") {
                    const block = item as Record<string, unknown>;
                    if (block.type === "text" && typeof block.text === "string") {
                        text += (text ? "\n" : "") + block.text;
                    } else if (block.type === "image") {
                        imageCount++;
                    }
                }
            }
        } else if (typeof obj.text === "string") {
            text = obj.text;
        }
    }

    const resultBytes = text ? new TextEncoder().encode(text).byteLength : 0;
    const resultTokens = text ? estimateContextTextTokens(text) : 0;

    return {
        resultBytes,
        resultTokens,
        imageCount,
        truncated: foundTruncated,
    };
}
