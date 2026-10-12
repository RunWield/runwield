import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { getHomeDir } from "../../../../constants.js";
import type { HostedSession } from "../../hosted-session.js";
import { emitSystemStatus } from "../../session-runtime-events.js";

export type AgyCliBackendStatusKind =
    | "missing_executable"
    | "auth_failed"
    | "custom_agent_invalid"
    | "permission_denied"
    | "mcp_unavailable"
    | "bridge_startup_failed"
    | "bridge_disconnected"
    | "non_zero_exit"
    | "malformed_stream"
    | "empty_result"
    | "result_mismatch"
    | "selection_mismatch"
    | "timeout"
    | "canceled"
    | "cleanup_failed";

export interface AgyCliBackendStatusEntry {
    version: 1;
    backend: "agy-cli";
    kind: AgyCliBackendStatusKind;
    exitCode: number | null;
    message: string;
    requestId?: string;
    attemptId?: string;
    afterAcceptedTerminal?: true;
}

export interface AgyCliBackendStatusOptions {
    exitCode?: number | null;
    message?: string;
    requestId?: string;
    attemptId?: string;
    afterAcceptedTerminal?: boolean;
}

const DEFAULT_MESSAGES: Record<AgyCliBackendStatusKind, string> = {
    missing_executable:
        "Antigravity CLI is not available. Install `agy` and ensure it is on PATH, then retry this turn.",
    auth_failed:
        "Antigravity CLI needs you to sign in. Run `agy` in a terminal, complete Google sign-in, then retry this request in RunWield.",
    custom_agent_invalid:
        "Antigravity CLI works, but it did not load RunWield's temporary Agent. Restart this RunWield session, then retry. If it still fails, run `wld mcp agy-cli --setup`.",
    permission_denied:
        "Antigravity denied a requested action. Adjust Antigravity permissions or the request, then retry.",
    mcp_unavailable: "Antigravity could not use the RunWield MCP bridge. Check MCP setup and retry this turn.",
    bridge_startup_failed: "RunWield could not start the Agy workflow bridge. Retry this turn.",
    bridge_disconnected:
        "The Agy workflow bridge disconnected before the turn ended. Workflow state was not advanced by that disconnect.",
    non_zero_exit: "Antigravity CLI exited before completing the turn.",
    malformed_stream:
        "Antigravity CLI emitted malformed stream output. Retry the turn after checking the Antigravity CLI installation.",
    empty_result: "Antigravity CLI ended without a verified assistant result. Retry this turn.",
    result_mismatch: "Antigravity CLI final output did not match streamed text. Retry this turn.",
    selection_mismatch: "Antigravity CLI used a different model or Agent than RunWield requested. Start a fresh turn.",
    timeout: "Antigravity CLI exceeded RunWield's 24 hour compatibility timeout and was stopped.",
    canceled: "Antigravity CLI turn canceled.",
    cleanup_failed:
        "RunWield preserved a changed Antigravity Agent file instead of deleting it. Check Antigravity Agent files before retrying.",
};

const MAX_MESSAGE_LENGTH = 1024;
const URL = /https?:\/\/\S+/gi;
const AGENT_SELECTOR = /runwield-[A-Za-z0-9._-]+/g;
const SECRET_VALUE =
    /\b(api[_-]?key|token|authorization|bearer|oauth|secret|password|credential)\b\s*[:=]\s*([^\s,;]+)/gi;
const BEARER = /bearer\s+[^\s,;]+/gi;
const ENV_ASSIGNMENT = /\b[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)/g;
const SENSITIVE_LINE =
    /\b(api[_-]?key|token|authorization|bearer|oauth|secret|password|credential|environment|env|prompt|config)\b/i;

export class AgyCliBackendError extends Error {
    readonly kind: AgyCliBackendStatusKind;
    readonly exitCode: number | null;
    readonly afterAcceptedTerminal: boolean;

    constructor(kind: AgyCliBackendStatusKind, options: AgyCliBackendStatusOptions = {}) {
        const status = buildAgyBackendStatusEntry(kind, options);
        super(status.message);
        this.name = "AgyCliBackendError";
        this.kind = kind;
        this.exitCode = status.exitCode;
        this.afterAcceptedTerminal = status.afterAcceptedTerminal === true;
    }
}

export function buildAgyBackendStatusEntry(
    kind: AgyCliBackendStatusKind,
    options: AgyCliBackendStatusOptions = {},
): AgyCliBackendStatusEntry {
    return {
        version: 1,
        backend: "agy-cli",
        kind,
        exitCode: options.exitCode ?? null,
        message: sanitizeAgyStatusMessage(options.message || DEFAULT_MESSAGES[kind], kind),
        ...(options.requestId ? { requestId: options.requestId } : {}),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        ...(options.afterAcceptedTerminal ? { afterAcceptedTerminal: true as const } : {}),
    };
}

export function emitAgyBackendStatus(
    hostedSession: HostedSession | undefined,
    sessionManager: SessionManager,
    entry: AgyCliBackendStatusEntry,
): void {
    sessionManager.appendCustomEntry("runwield.backend_status", entry);
    emitSystemStatus(hostedSession, entry.message, { level: agyBackendStatusLevel(entry) });
}

export function agyBackendStatusLevel(entry: Pick<AgyCliBackendStatusEntry, "kind" | "afterAcceptedTerminal">):
    | "warning"
    | "error" {
    if (entry.afterAcceptedTerminal) return "warning";
    return entry.kind === "canceled" || entry.kind === "bridge_disconnected" || entry.kind === "cleanup_failed"
        ? "warning"
        : "error";
}

export function sanitizeAgyStatusMessage(message: string, kind: AgyCliBackendStatusKind): string {
    if (kind === "auth_failed") return DEFAULT_MESSAGES.auth_failed;
    const redactedHome = redactHomePath(message)
        .replace(URL, "[redacted-url]")
        .replace(SECRET_VALUE, "$1=[redacted]")
        .replace(BEARER, "Bearer [redacted]")
        .replace(ENV_ASSIGNMENT, "[redacted]")
        .replace(AGENT_SELECTOR, "[redacted-agent]");
    const lines = redactedHome
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\s+/g, " "))
        .filter((line) => line && line !== "[redacted]" && !SENSITIVE_LINE.test(line));
    const joined = lines.join("\n").trim();
    const fallback = joined || DEFAULT_MESSAGES[kind];
    return fallback.length > MAX_MESSAGE_LENGTH ? `${fallback.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : fallback;
}

export function isAgyAuthFailure(text: string): boolean {
    return /\b(auth|authentication|login|log in|sign in|signin|unauthorized|forbidden)\b/i.test(text);
}

export function isAgyPermissionDenied(text: string): boolean {
    return /\b(permission denied|denied action|denied_actions|not allowed|blocked by permission|permission)\b/i.test(
        text,
    );
}

export function isAgyMcpUnavailable(text: string): boolean {
    return /\b(mcp|model context protocol|runwield bridge|tool server|stdio)\b/i.test(text) &&
        /\b(unavailable|failed|disconnect|connection|refused|not found|missing|permission)\b/i.test(text);
}

function redactHomePath(message: string): string {
    let home = "";
    try {
        home = getHomeDir();
    } catch {
        home = "";
    }
    if (!home) return message;
    return message.split(home).join("[redacted-home]");
}
