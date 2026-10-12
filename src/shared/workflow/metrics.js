/**
 * @module shared/workflow/metrics
 * Local-only workflow metrics recording helpers.
 */

import { isAbsolute, join } from "node:path";
import { getHomeDir, RUNWIELD_DIR_NAME } from "../../constants.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { encodeCwdForSessionDir } from "../session/root-session.js";
import { appendWorkflowMetric, isWorkflowMetricsEnabled, resolveCollectionEpoch } from "./metrics-journal.ts";
export { isWorkflowMetricsEnabled } from "./metrics-journal.ts";

/**
 * @typedef {"routing"|"planning"|"execution"|"validation"|"recovery"|"model_selection"|"tool_usage"|"command"|"model_usage"|"context"} WorkflowMetricCategory
 */

/**
 * @typedef {string|number|boolean|null|Array<unknown>|Record<string, unknown>} SafeMetricDetails
 */

/**
 * @typedef {Object} WorkflowMetricRecord
 * @property {1} v
 * @property {string} ts
 * @property {WorkflowMetricCategory} category
 * @property {string} event
 * @property {string} cwdHash
 * @property {string} [sessionId]
 * @property {string} [planName]
 * @property {string} [agentName]
 * @property {SafeMetricDetails} [details]
 */

/**
 * @typedef {Object} WorkflowMetricsSettings
 * @property {boolean} [enabled]
 */

const METRICS_DIR_NAME = "workflow-metrics";
const MAX_STRING_LENGTH = 240;
const MAX_ARRAY_LENGTH = 40;
const MAX_OBJECT_KEYS = 80;
const REDACTED = "[redacted]";
const PATH_REDACTED = "[path-redacted]";
const SENSITIVE_KEY_PATTERN =
    /(prompt|request|content|diff|output|apikey|api_key|token|secret|authorization|password|credential|privatekey|private_key)/i;
const PATH_KEY_PATTERN = /(^|_)(path|paths|cwd|dir|directory|file|files|root|worktreepath|executioncwd|projectroot)$/i;
const ALLOWED_PLAN_RELATIVE_PATH_KEYS = new Set(["affectedPaths"]);
const DEDICATED_FRONTEND_EVENTS = new Set([
    "frontend_runtime_style_resolved",
    "pair_checkpoint_decided",
    "frontend_execution_completed",
]);
const FRONTEND_POLICY_SOURCES = new Set(["canonical", "legacy_frontend"]);
const COLLABORATION_VALUES = new Set(["autonomous", "pair"]);
const RUNTIME_RESOLUTION_REASONS = new Set([
    "canonical_pair_capable",
    "canonical_pair_unavailable",
    "canonical_autonomous",
    "legacy_autonomous",
]);
const PAIR_CHECKPOINT_DECISIONS = new Set(["continue", "revise", "switch_to_autonomous", "stop", "canceled"]);
const PAIR_CHECKPOINT_REASONS = new Set([
    "checkpoint_interaction_canceled",
    "revision_feedback_required",
    "pair_capability_lost",
    "invalid_checkpoint_response",
]);
const FRONTEND_COMPLETION_PHASES = new Set(["implementation", "validation_repair"]);
const BROWSER_PREFLIGHT_OUTCOMES = new Set(["succeeded", "failed", "externally_blocked"]);

/** @type {Map<string, string>} */
const cwdHashCache = new Map();
/** @type {Map<string, { subUsage: string, startedAt: number }>} */
const activeToolCalls = new Map();

/**
 * @param {string} cwd
 * @returns {string}
 */
export function getWorkflowMetricsFilePath(cwd) {
    if (!cwd) throw new Error("getWorkflowMetricsFilePath: cwd is required");
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const homeDir = getHomeDir() || "~";
    return join(homeDir, RUNWIELD_DIR_NAME, METRICS_DIR_NAME, encodeCwdForSessionDir(projectRoot), "metrics.jsonl");
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function hashMetricCwd(value) {
    if (!value) throw new Error("hashMetricCwd: value is required");
    const cached = cwdHashCache.get(value);
    if (cached) return cached;
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    cwdHashCache.set(value, hash);
    return hash;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeAbsolutePath(value) {
    if (!value) return false;
    if (isAbsolute(value)) return true;
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("file://");
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeRelativePath(value) {
    if (!value || looksLikeAbsolutePath(value)) return false;
    return value.startsWith("./") || value.startsWith("../") || value.includes("/") || value.includes("\\");
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {SafeMetricDetails | undefined}
 */
function sanitizeMetricValue(key, value) {
    if (value === undefined) return undefined;
    if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        if (looksLikeAbsolutePath(value)) return PATH_REDACTED;
        if (PATH_KEY_PATTERN.test(key) && !ALLOWED_PLAN_RELATIVE_PATH_KEYS.has(key)) return PATH_REDACTED;
        if (looksLikeRelativePath(value) && !ALLOWED_PLAN_RELATIVE_PATH_KEYS.has(key)) return PATH_REDACTED;
        return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeMetricValue(key, item)).filter((item) =>
            item !== undefined
        );
    }
    if (isPlainObject(value)) {
        /** @type {{[key: string]: SafeMetricDetails}} */
        const output = {};
        for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
            const sanitized = sanitizeMetricValue(entryKey, entryValue);
            if (sanitized !== undefined) output[entryKey] = sanitized;
        }
        return output;
    }
    return undefined;
}

/**
 * @param {unknown} details
 * @returns {SafeMetricDetails | undefined}
 */
export function sanitizeMetricDetails(details) {
    return sanitizeMetricValue("details", details);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isString(value) {
    return typeof value === "string";
}

/**
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @returns {string | undefined}
 */
function allowEnum(value, allowed) {
    return isString(value) && allowed.has(value) ? value : undefined;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
export function normalizeObservedTime(value) {
    const parts =
        /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
            value,
        );
    if (!parts) return null;
    const local = `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0")}Z`;
    if (!Number.isFinite(Date.parse(local)) || new Date(local).toISOString() !== local) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function allowNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function allowPositiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * @param {Record<string, unknown>} output
 * @param {string} key
 * @param {unknown} value
 * @param {Set<string>} allowed
 */
function setAllowedEnum(output, key, value, allowed) {
    const normalized = allowEnum(value, allowed);
    if (normalized !== undefined) output[key] = normalized;
}

/**
 * @param {string} event
 * @param {unknown} details
 * @returns {Record<string, unknown> | undefined}
 */
function sanitizeDedicatedFrontendMetricDetails(event, details) {
    if (!isPlainObject(details)) return undefined;
    /** @type {Record<string, unknown>} */
    const output = {};
    if (event === "frontend_runtime_style_resolved") {
        setAllowedEnum(output, "policySource", details.policySource, FRONTEND_POLICY_SOURCES);
        setAllowedEnum(output, "recommendation", details.recommendation, COLLABORATION_VALUES);
        setAllowedEnum(output, "runtimeStyle", details.runtimeStyle, COLLABORATION_VALUES);
        if (typeof details.pairCapable === "boolean") output.pairCapable = details.pairCapable;
        setAllowedEnum(output, "resolutionReason", details.resolutionReason, RUNTIME_RESOLUTION_REASONS);
    } else if (event === "pair_checkpoint_decided") {
        const checkpointNumber = allowPositiveInteger(details.checkpointNumber);
        if (checkpointNumber !== undefined) output.checkpointNumber = checkpointNumber;
        setAllowedEnum(output, "decision", details.decision, PAIR_CHECKPOINT_DECISIONS);
        setAllowedEnum(output, "reason", details.reason, PAIR_CHECKPOINT_REASONS);
    } else if (event === "frontend_execution_completed") {
        setAllowedEnum(output, "phase", details.phase, FRONTEND_COMPLETION_PHASES);
        setAllowedEnum(output, "runtimeStyle", details.runtimeStyle, COLLABORATION_VALUES);
        const checkpointCount = allowNonNegativeInteger(details.checkpointCount);
        if (checkpointCount !== undefined) output.checkpointCount = checkpointCount;
        if (typeof details.switchedToAutonomous === "boolean") {
            output.switchedToAutonomous = details.switchedToAutonomous;
        }
        if (typeof details.capabilityLost === "boolean") output.capabilityLost = details.capabilityLost;
        setAllowedEnum(output, "browserPreflightOutcome", details.browserPreflightOutcome, BROWSER_PREFLIGHT_OUTCOMES);
        const elapsedMs = allowNonNegativeInteger(details.elapsedMs);
        if (elapsedMs !== undefined) output.elapsedMs = elapsedMs;
    }
    return Object.keys(output).length ? output : undefined;
}

// Each event owns its fields. Nothing from an unrecognized event is persisted.
/** @type {Record<string, string[]>} */
const V2_EVENTS = {
    mechanical_validation_finished: ["outcome"],
    operation_completed_observed: ["outcome"],
    quick_fix_completed_observed: ["outcome"],
    operational_recovery: ["outcome"],
    validation_attempt: [
        "attempt",
        "outcome",
        "phase",
        "findingCount",
        "advisoryCount",
        "initialFindingCount",
        "missedOriginalCount",
        "repairRegressionCount",
        "unclassifiedNewCount",
        "existingStillOpenCount",
        "fixConfirmedCount",
    ],
    repair_round: ["round", "outcome", "phase"],
    repair_round_finished: ["outcome", "phase"],
    publication_confirmed: ["outcome", "planKind"],
    workflow_abandoned: ["outcome"],
    workflow_transition_committed: ["outcome"],
    implementation_finished: ["outcome"],
    plan_execution_result: ["outcome"],
    implementation_checkpoint_failed: ["outcome"],
    execution_context_resolution: ["outcome"],
    feature_project_outcome: ["outcome", "phase"],
    review_complete: ["outcome", "findingCount", "advisoryCount"],
    guided_review_generation_result: ["outcome", "elapsedMs", "sectionCount", "failureKind"],
    execution_started: ["sourceSurface", "userInitiated"],
    execution_finished: ["outcome", "reason", "elapsedMs", "callCount", "coverage"],
    retry_started: ["retrySource", "attempt", "maxAttempts", "delayMs"],
    retry_finished: ["retrySource", "attempt", "outcome", "reason"],
    response_latency: [
        "requestStartedAt",
        "firstResponseAt",
        "firstVisibleTextAt",
        "completedAt",
        "firstResponseLatencyMs",
        "firstVisibleTextLatencyMs",
        "totalLatencyMs",
        "basis",
        "availability",
    ],
    tool_exposure_summary: [
        "exposureId",
        "toolCount",
        "estimatorVersion",
        "inventoryCoverage",
        "totalSchemaTokens",
        "totalResidentTokens",
    ],
    tool_exposure: ["exposureId", "toolIndex", "toolName", "schemaTokens", "residentTokens", "totalCount"],
    tool_call_started: ["callId", "exposureId", "toolName", "subUsage"],
    tool_call_finished: [
        "callId",
        "exposureId",
        "toolName",
        "subUsage",
        "outcome",
        "reason",
        "durationMs",
        "resultBytes",
        "resultTokens",
        "imageCount",
        "truncated",
        "isError",
    ],
    tool_operation: [
        "parentCallId",
        "operationIndex",
        "operationKind",
        "commandLabel",
        "action",
        "scope",
        "batchKind",
        "status",
        "truncated",
    ],
    native_tool_observed: ["callId", "stepIndex", "toolName", "status"],
    model_usage: [
        "sourceId",
        "startedAt",
        "endedAt",
        "reasoningTokens",
        "usageKind",
        "provider",
        "model",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "costAmount",
        "costCurrency",
        "costSource",
        "measurementAvailability",
        "unavailableReason",
        "aggregationBasis",
        "inputCacheBasis",
        "turnId",
        "requestId",
    ],
    context_snapshot: ["capacity", "currentUsage", "staticCategoryCounts", "usageState", "samplingPoint"],
    compaction_started: ["reason", "beforeTokens"],
    compaction_finished: ["outcome", "beforeTokens", "afterTokens", "durationMs"],
    command_started: [
        "commandId",
        "command",
        "alias",
        "kind",
        "sourceSurface",
        "sessionId",
        "requestId",
        "executionId",
        "phase",
    ],
    command_dispatched: [
        "commandId",
        "command",
        "alias",
        "kind",
        "sourceSurface",
        "sessionId",
        "requestId",
        "executionId",
        "phase",
    ],
    command_finished: [
        "commandId",
        "command",
        "alias",
        "kind",
        "sourceSurface",
        "sessionId",
        "requestId",
        "executionId",
        "outcome",
        "durationMs",
        "errorReason",
        "phase",
    ],
};
/** @type {Record<string, string>} */
const V2_EVENT_CATEGORIES = {
    mechanical_validation_finished: "validation",
    operation_completed_observed: "execution",
    quick_fix_completed_observed: "execution",
    operational_recovery: "recovery",
    validation_attempt: "validation",
    repair_round: "recovery",
    repair_round_finished: "recovery",
    publication_confirmed: "recovery",
    workflow_abandoned: "recovery",
    workflow_transition_committed: "recovery",
    implementation_finished: "execution",
    plan_execution_result: "execution",
    implementation_checkpoint_failed: "execution",
    execution_context_resolution: "validation",
    feature_project_outcome: "execution",
    review_complete: "validation",
    guided_review_generation_result: "validation",
    execution_started: "execution",
    execution_finished: "execution",
    retry_started: "execution",
    retry_finished: "execution",
    response_latency: "execution",
    tool_exposure_summary: "tool_usage",
    tool_exposure: "tool_usage",
    tool_call_started: "tool_usage",
    tool_call_finished: "tool_usage",
    tool_operation: "tool_usage",
    native_tool_observed: "tool_usage",
    model_usage: "model_usage",
    context_snapshot: "context",
    compaction_started: "context",
    compaction_finished: "context",
    command_started: "command",
    command_dispatched: "command",
    command_finished: "command",
};
/** @type {Record<string, Set<string>>} */
const V2_ENUMS = {
    planKind: new Set(["PLANNED_CHANGE", "PROJECT", "QUICK_FIX", "OPERATION"]),
    outcome: new Set([
        "succeeded",
        "failed",
        "canceled",
        "rejected",
        "interrupted",
        "success",
        "error",
        "incomplete",
        "ongoing",
        "approved",
        "feedback",
    ]),
    reason: new Set([
        "completed",
        "returned_error",
        "execution_error",
        "execution_canceled",
        "execution_settled",
        "canceled",
        "failed",
        "aborted",
        "rejected",
        "unknown",
        "manual",
        "threshold",
        "overflow",
        "auth_failed",
        "non_zero_exit",
        "malformed_stream",
        "bridge_startup_failed",
        "empty_result",
        "invalid_arguments",
        "gate_closed",
        "unavailable",
        "not_found",
    ]),
    failureKind: new Set(["invalid_json", "empty_output", "schema_invalid", "aborted", "provider_failed"]),
    errorReason: new Set(["failed", "canceled", "rejected", "unknown", "unavailable", "unknown_command"]),
    executionKind: new Set(["root", "isolated", "delegated"]),
    mode: new Set(["foreground", "background"]),
    inventoryCoverage: new Set(["complete", "partial", "unavailable"]),
    operationKind: new Set(["bash_command", "memory", "code_batch"]),
    commandLabel: new Set([
        "unknown",
        "other",
        "git other",
        "deno other",
        "deno task other",
        "npm other",
        "npm run other",
        "pnpm other",
        "pnpm run other",
        "yarn other",
        "yarn run other",
        "bun other",
        "bun run other",
        "cargo other",
        "go other",
        "python other",
        "pytest",
        "git status",
        "git diff",
        "git log",
        "git show",
        "git add",
        "git commit",
        "git checkout",
        "git switch",
        "git branch",
        "git worktree",
        "git fetch",
        "git pull",
        "git push",
        "git stash",
        "git rebase",
        "git merge",
        "git reset",
        "git restore",
        "git remote",
        "git rev-parse",
        "git tag",
        "git clean",
        "git rm",
        "deno task test",
        "deno task check",
        "deno task lint",
        "deno task fmt",
        "deno task ci",
        "deno task seams:check",
        "deno task build",
        "deno test",
        "deno check",
        "deno lint",
        "deno fmt",
        "deno run",
        "deno compile",
        "npm test",
        "npm ci",
        "npm install",
        "npm build",
        "pnpm test",
        "pnpm ci",
        "pnpm install",
        "pnpm build",
        "yarn test",
        "yarn ci",
        "yarn install",
        "yarn build",
        "bun test",
        "bun ci",
        "bun install",
        "bun build",
        "cargo test",
        "cargo check",
        "cargo build",
        "cargo clippy",
        "go test",
        "go build",
        "go vet",
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
    ]),
    action: new Set(["recall", "store", "delete"]),
    scope: new Set(["project", "global", "unified"]),
    batchKind: new Set(["show", "outline"]),
    status: new Set(["success", "error", "truncated", "unavailable"]),
    usageKind: new Set(["turn", "request", "compaction", "summary", "standalone"]),
    costCurrency: new Set(["USD"]),
    costSource: new Set(["calculated", "reported", "unavailable"]),
    measurementAvailability: new Set(["complete", "partial", "unavailable"]),
    aggregationBasis: new Set(["turn", "request", "alternative"]),
    inputCacheBasis: new Set(["includes_cache", "excludes_cache", "unknown"]),
    usageState: new Set([
        "estimated",
        "reported",
        "unknown_after_compaction",
        "normal",
        "approaching_limit",
        "clean",
        "overflow",
    ]),
    samplingPoint: new Set([
        "execution_start",
        "execution_end",
        "turn_start",
        "turn_end",
        "before_compaction",
        "after_compaction",
    ]),
    retrySource: new Set(["auto_retry", "summarization_retry"]),
    basis: new Set(["backend_turn", "model_request"]),
    availability: new Set(["complete", "partial", "unavailable"]),
    kind: new Set(["builtin", "template", "skill"]),
    phase: new Set([
        "start",
        "finish",
        "opened",
        "dispatched",
        "rejected",
        "mechanical",
        "semantic",
        "delivery",
        "planning",
    ]),
    sourceSurface: new Set(["tui", "workspace", "acp", "cli", "headless"]),
};
for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
    for (const task of ["test", "check", "lint", "fmt", "ci", "build"]) {
        V2_ENUMS.commandLabel.add(`${manager} run ${task}`);
    }
}
const V2_LINKS = new Set([
    "planId",
    "transitionId",
    "roundId",
    "operationId",
    "sessionId",
    "managedSessionId",
    "segmentId",
    "executionId",
    "requestId",
    "attemptId",
    "turnId",
    "modelRequestId",
    "commandId",
    "parentExecutionId",
    "parentToolCallId",
    "taskId",
    "exposureId",
    "callId",
    "parentCallId",
    "sourceId",
]);
const V2_NUMBERS = new Set([
    "reasoningTokens",
    "sectionCount",
    "round",
    "initialFindingCount",
    "missedOriginalCount",
    "repairRegressionCount",
    "unclassifiedNewCount",
    "existingStillOpenCount",
    "fixConfirmedCount",
    "findingCount",
    "advisoryCount",
    "elapsedMs",
    "callCount",
    "toolCount",
    "totalCount",
    "toolIndex",
    "schemaTokens",
    "residentTokens",
    "totalSchemaTokens",
    "totalResidentTokens",
    "durationMs",
    "resultBytes",
    "resultTokens",
    "imageCount",
    "operationIndex",
    "stepIndex",
    "attempt",
    "maxAttempts",
    "delayMs",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "capacity",
    "currentUsage",
    "beforeTokens",
    "afterTokens",
    "requestStartedAt",
    "firstResponseAt",
    "firstVisibleTextAt",
    "completedAt",
    "firstResponseLatencyMs",
    "firstVisibleTextLatencyMs",
    "totalLatencyMs",
]);
const V2_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const V2_NAME = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/;
let metricsWriteQueue = Promise.resolve();

/**
 * @param {Promise<unknown>} pending
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForMetrics(pending, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        void pending.then(() => {
            clearTimeout(timer);
            resolve();
        }, () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/** @param {number} [timeoutMs] */
export function drainWorkflowMetrics(timeoutMs = 5000) {
    return waitForMetrics(metricsWriteQueue, timeoutMs);
}

/**
 * @param {Record<string, unknown>} metric
 * @param {string} cwdHash
 * @returns {Record<string, unknown> | null}
 */
function sanitizeV2MetricRecord(metric, cwdHash) {
    const event = typeof metric.event === "string" ? metric.event : "";
    if (!Object.hasOwn(V2_EVENTS, event) || metric.category !== V2_EVENT_CATEGORIES[event]) return null;
    if (typeof metric.recorderId !== "string" || !V2_IDENTIFIER.test(metric.recorderId)) return null;
    const seq = allowNonNegativeInteger(metric.seq);
    if (seq === undefined) return null;
    /** @type {Record<string, unknown>} */
    const record = {
        v: 2,
        ts: typeof metric.ts === "string" && Number.isFinite(Date.parse(metric.ts))
            ? new Date(metric.ts).toISOString()
            : new Date().toISOString(),
        eventId: typeof metric.eventId === "string" && V2_IDENTIFIER.test(metric.eventId)
            ? metric.eventId
            : crypto.randomUUID(),
        recorderId: metric.recorderId,
        seq,
        event,
        category: metric.category,
        cwdHash,
    };
    const fields = [
        ...V2_EVENTS[event],
        ...V2_LINKS,
        "agent",
        "provider",
        "model",
        "backend",
        "dispatchKind",
        "executionKind",
        "mode",
    ];
    for (const key of fields) {
        const value = metric[key];
        if (key === "startedAt" || key === "endedAt") {
            // Observed UTC ISO instants only. Invalid or missing edges are unavailable, not write time.
            record[key] = typeof value === "string" ? normalizeObservedTime(value) : null;
        } else if (V2_LINKS.has(key)) {
            if (typeof value === "string" && V2_IDENTIFIER.test(value)) record[key] = value;
            else if (value === null) record[key] = null;
        } else if (Object.hasOwn(V2_ENUMS, key)) {
            const allowed = V2_ENUMS[key];
            if (typeof value === "string" && allowed.has(value)) record[key] = value;
            else if (value === null) record[key] = null;
        } else if (V2_NUMBERS.has(key)) {
            if (value === null) record[key] = null;
            else if (key === "costAmount" && typeof value === "number" && Number.isFinite(value) && value >= 0) {
                record[key] = value;
            } else {
                const number = allowNonNegativeInteger(value);
                if (number !== undefined) record[key] = number;
            }
        } else if (key === "costAmount") {
            if (value === null) record[key] = null;
            else if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = value;
        } else if (key === "isError" || key === "truncated" || key === "userInitiated") {
            if (typeof value === "boolean" || value === null) record[key] = value;
        } else if (key === "coverage" && isPlainObject(value)) {
            record.coverage = Object.fromEntries(
                ["tools", "usage", "context"].filter((part) =>
                    typeof value[part] === "string" && V2_ENUMS.availability.has(value[part])
                ).map((part) => [part, value[part]]),
            );
        } else if (key === "staticCategoryCounts" && isPlainObject(value)) {
            record.staticCategoryCounts = Object.fromEntries(
                ["systemTokens", "toolsTokens", "messagesTokens"].filter((part) =>
                    allowNonNegativeInteger(value[part]) !== undefined
                ).map((part) => [part, value[part]]),
            );
        } else if (key === "unavailableReason") {
            if (value === null || value === "not_reported" || value === "source_unavailable") record[key] = value;
        } else if (key === "estimatorVersion") {
            if (value === "1") record[key] = value;
        } else if (key === "command" || key === "alias") {
            if (typeof value === "string" && V2_NAME.test(value)) record[key] = value;
            else if (value !== undefined) record[key] = "unknown";
        } else if (["agent", "provider", "model", "backend", "dispatchKind", "toolName", "subUsage"].includes(key)) {
            if (typeof value === "string" && V2_NAME.test(value)) record[key] = value;
        }
    }
    return record;
}

/**
 * @typedef {import("./metrics-journal.ts").JournalResult & Pick<WorkflowMetricRecord, "details">} WorkflowMetricResult
 *
 * @param {Record<string, unknown>} metric
 * @param {string} cwd
 * @returns {Promise<WorkflowMetricResult>}
 */
export async function recordWorkflowMetric(metric, cwd) {
    try {
        if (!cwd) throw new Error("recordWorkflowMetric: cwd is required");
        const projectRoot = resolvePrimaryCheckoutRoot(cwd);
        // Git and Plan storage can load without booting the agent package.
        // Actual metric writes still read the real settings and honor opt-out.
        const { getMergedCustomSetting } = await import("../settings.js");
        const resolvedSetting = getMergedCustomSetting("workflowMetrics", projectRoot);
        const filePath = getWorkflowMetricsFilePath(projectRoot);
        const epochState = resolveCollectionEpoch(filePath, isWorkflowMetricsEnabled(resolvedSetting));
        const invocation = {
            enabled: metric.persisted === false && typeof metric.collectionEnabledAtCall === "boolean"
                ? metric.collectionEnabledAtCall
                : isWorkflowMetricsEnabled(resolvedSetting),
            epoch: metric.persisted === false && typeof metric.collectionEpoch === "string"
                ? metric.collectionEpoch
                : epochState.collectionEpoch.id,
            historyEpoch: typeof metric.historyEpoch === "string" ? metric.historyEpoch : epochState.historyEpoch,
            deadline: typeof metric.persistenceDeadline === "number"
                ? Math.min(Date.now() + 1000, metric.persistenceDeadline)
                : Date.now() + 1000,
        };
        const cwdHash = await hashMetricCwd(projectRoot);

        let record;
        if (metric.v === 2) {
            record = sanitizeV2MetricRecord(metric, cwdHash);
            if (!record) return { persisted: false, reason: "invalid_record" };
        } else {
            const eventName = typeof metric.event === "string" ? metric.event : "";
            const categoryName = typeof metric.category === "string"
                ? /** @type {WorkflowMetricCategory} */ (metric.category)
                : "execution";
            const dedicatedFrontendEvent = DEDICATED_FRONTEND_EVENTS.has(eventName);
            const dedicatedDetails = dedicatedFrontendEvent
                ? sanitizeDedicatedFrontendMetricDetails(eventName, metric.details)
                : undefined;
            /** @type {WorkflowMetricRecord} */
            record = {
                v: 1,
                ts: new Date().toISOString(),
                category: categoryName,
                event: eventName,
                cwdHash,
                ...(!dedicatedFrontendEvent && metric.sessionId ? { sessionId: String(metric.sessionId) } : {}),
                ...(!dedicatedFrontendEvent && metric.planName ? { planName: String(metric.planName) } : {}),
                ...(!dedicatedFrontendEvent && metric.agentName ? { agentName: String(metric.agentName) } : {}),
                ...(dedicatedFrontendEvent
                    ? dedicatedDetails !== undefined ? { details: dedicatedDetails } : {}
                    : metric.details !== undefined
                    ? { details: sanitizeMetricDetails(metric.details) }
                    : {}),
            };
        }

        const pending = metricsWriteQueue.then(() => appendWorkflowMetric(filePath, projectRoot, record, invocation));
        metricsWriteQueue = pending.then(() => {}, () => {});
        return await pending;
    } catch {
        return { persisted: false, reason: "storage_failure" };
    }
}

/**
 * @param {string} command
 * @returns {string}
 */
function classifyBashCommand(command) {
    const trimmed = command.trim();
    if (/^(deno|npm|pnpm|yarn|bun|make|ninja|cargo|go|pytest|python\s+-m\s+pytest|mvn|gradle)\b/.test(trimmed)) {
        return /(test|check|lint|fmt|format|ci|build|pytest)/.test(trimmed) ? "validation_command" : "package_manager";
    }
    if (/^git\b/.test(trimmed)) return "git";
    if (/^(ls|find|grep|rg|cat|sed|awk|pwd|mkdir|rm|cp|mv|touch|chmod)\b/.test(trimmed)) return "filesystem";
    return "shell_other";
}

/**
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string}
 */
export function classifyToolSubUsage(toolName, args = undefined) {
    if (toolName === "bash") {
        const command = isPlainObject(args) && typeof args.command === "string" ? args.command : "";
        return classifyBashCommand(command);
    }
    if (toolName === "code_search") return "search";
    if (toolName === "code_show") return "read";
    if (toolName === "code_outline") return "outline";
    if (toolName === "code_refs") return "refs";
    if (toolName === "code_impact") return "impact";
    if (toolName === "code_trace" || toolName === "code_investigate" || toolName === "code_impls") return "trace";
    if (toolName === "code_batch") return "read";
    if (toolName === "code_importers" || toolName === "code_structure") return "search";
    if (toolName === "memory_recall" || toolName === "memory_recall_global") return "read";
    if (toolName === "memory") {
        const action = isPlainObject(args) && typeof args.action === "string" ? args.action : "recall";
        if (action === "recall") return "read";
        return action === "delete" ? "delete" : "write";
    }
    if (toolName === "memory_write") {
        const action = isPlainObject(args) && typeof args.action === "string" ? args.action : "store";
        return action === "delete" ? "delete" : "write";
    }
    if (toolName === "memory_store" || toolName === "memory_store_global") return "write";
    if (toolName === "memory_delete") return "delete";
    if (toolName === "read") return "read";
    if (toolName === "grep") return "search";
    if (toolName === "find" || toolName === "ls") return "list";
    if (toolName === "edit" || toolName === "edit_docs") return "edit";
    if (toolName === "multi_file_edit") return "multi_edit";
    if (toolName === "write" || toolName === "write_docs") return "write";
    if (toolName === "triage_report") return "triage";
    if (toolName === "plan_written") return "plan_written";
    if (toolName === "task_completed") return "task_completed";
    if (toolName === "user_interview") return "user_interview";
    if (/browser|agent-browser|screenshot|navigate|click|type/i.test(toolName)) {
        if (/screenshot/i.test(toolName)) return "screenshot";
        if (/navigate|open|goto/i.test(toolName)) return "navigate";
        if (/click|type|fill|press|select|interact/i.test(toolName)) return "interact";
        if (/inspect|snapshot|console|network/i.test(toolName)) return "inspect";
        return "browser_other";
    }
    return "other";
}

/**
 * @param {string} toolCallId
 * @param {string} toolName
 * @param {unknown} args
 * @param {string} cwd
 * @param {string} [agentName]
 * @returns {Promise<import("./metrics-journal.ts").JournalResult>}
 */
export function recordToolCallStarted(toolCallId, toolName, args, cwd, agentName) {
    const subUsage = classifyToolSubUsage(toolName, args);
    activeToolCalls.set(toolCallId, { subUsage, startedAt: Date.now() });
    return recordWorkflowMetric({
        category: "tool_usage",
        event: "tool_call_started",
        agentName,
        details: { toolName, subUsage },
    }, cwd);
}

/**
 * @param {string} toolCallId
 * @param {string} toolName
 * @param {boolean} isError
 * @param {string} cwd
 * @param {string} [agentName]
 * @returns {Promise<import("./metrics-journal.ts").JournalResult>}
 */
export function recordToolCallFinished(toolCallId, toolName, isError, cwd, agentName) {
    const started = activeToolCalls.get(toolCallId);
    activeToolCalls.delete(toolCallId);
    const now = Date.now();
    return recordWorkflowMetric({
        category: "tool_usage",
        event: "tool_call_finished",
        agentName,
        details: {
            toolName,
            subUsage: started?.subUsage || classifyToolSubUsage(toolName),
            isError,
            durationMs: started ? now - started.startedAt : undefined,
        },
    }, cwd);
}

/**
 * @typedef {Object} LegacyWorkflowMetricInput
 * @property {number} v
 * @property {string} ts
 * @property {string} event
 *
 * @typedef {Object} LegacyWorkflowMetricReport
 * @property {string} timestamp
 * @property {string} event
 * @property {"legacy/partial"} availability
 */

/** Read only understood v1 fields. Generic details and mutable Plan names are never report joins.
 * @param {LegacyWorkflowMetricInput} record
 * @returns {LegacyWorkflowMetricReport | null}
 */
export function readLegacyWorkflowMetric(record) {
    if (
        record.v !== 1 || !Number.isFinite(Date.parse(record.ts)) ||
        ["collection_epoch", "history_epoch", "measurement_gap"].includes(record.event)
    ) return null;
    return {
        timestamp: record.ts,
        event: /^[a-z][a-z0-9_]{0,80}$/.test(record.event) ? record.event : "legacy",
        availability: "legacy/partial",
    };
}
