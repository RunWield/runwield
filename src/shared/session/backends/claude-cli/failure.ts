import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../../hosted-session.ts";
import { emitSystemStatus } from "../../session-runtime-events.ts";

export type ClaudeCliBackendErrorKind =
    | "missing_executable"
    | "auth_failed"
    | "non_zero_exit"
    | "malformed_stream"
    | "bridge_startup_failed"
    | "bridge_disconnected"
    | "canceled";

export interface ClaudeCliBackendStatusEntry {
    version: 1;
    backend: "claude-cli";
    kind: ClaudeCliBackendErrorKind;
    exitCode: number | null;
    message: string;
    requestId?: string;
    attemptId?: string;
}

export interface BackendStatusOptions {
    exitCode?: number | null;
    message?: string;
    requestId?: string;
    attemptId?: string;
}

const DEFAULT_MESSAGES: Record<ClaudeCliBackendErrorKind, string> = {
    missing_executable: "Claude Code is not available. Install the Claude CLI and ensure `claude` is on PATH.",
    auth_failed: "Claude Code authentication failed. Sign in to Claude Code, then retry this turn.",
    non_zero_exit: "Claude Code exited before completing the turn.",
    malformed_stream:
        "Claude Code emitted malformed stream output. Retry the turn after checking the Claude CLI installation.",
    bridge_startup_failed: "RunWield could not start the Claude workflow bridge. Retry the turn.",
    bridge_disconnected:
        "The Claude workflow bridge disconnected before the turn ended. Workflow state was not advanced by that disconnect.",
    canceled: "Claude Code turn canceled.",
};

const SECRET_LINE =
    /(api[_-]?key|token|authorization|bearer|oauth|secret|password|credential|env|environment|home=|path=)/i;
const SETTINGS_LINE = /settings/i;
const CLAUDE_USAGE_REFERENCE = /(?:https:\/\/)?claude\.ai\/settings\/usage(?:\?from=cc_cli_limit_message)?/i;
const URL = /https?:\/\/\S+/gi;
const CLAUDE_USAGE_URL = /^https:\/\/claude\.ai\/settings\/usage(?:\?from=cc_cli_limit_message)?$/i;
const MAX_MESSAGE_LENGTH = 1024;

export class ClaudeCliBackendError extends Error {
    readonly kind: ClaudeCliBackendErrorKind;
    readonly exitCode: number | null;

    constructor(kind: ClaudeCliBackendErrorKind, options: BackendStatusOptions = {}) {
        const status = buildBackendStatusEntry(kind, options);
        super(status.message);
        this.name = "ClaudeCliBackendError";
        this.kind = kind;
        this.exitCode = status.exitCode;
    }
}

export function buildBackendStatusEntry(
    kind: ClaudeCliBackendErrorKind,
    options: BackendStatusOptions = {},
): ClaudeCliBackendStatusEntry {
    return {
        version: 1,
        backend: "claude-cli",
        kind,
        exitCode: options.exitCode ?? null,
        message: sanitizePersistedMessage(options.message || DEFAULT_MESSAGES[kind], kind),
        ...(options.requestId ? { requestId: options.requestId } : {}),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    };
}

export function sanitizeStderrForDisplay(stderr: string): string {
    const lines = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) =>
            line && !SECRET_LINE.test(line) && (!SETTINGS_LINE.test(line) || CLAUDE_USAGE_REFERENCE.test(line))
        )
        .map((line) => line.replace(URL, (url) => CLAUDE_USAGE_URL.test(url) ? url : "[redacted-url]"));
    const joined = lines.join("\n");
    return joined.length > MAX_MESSAGE_LENGTH ? `${joined.slice(0, MAX_MESSAGE_LENGTH)}…` : joined;
}

export function emitBackendStatus(
    hostedSession: HostedSession | undefined,
    sessionManager: SessionManager,
    entry: ClaudeCliBackendStatusEntry,
): void {
    sessionManager.appendCustomEntry("runwield.backend_status", entry);
    emitSystemStatus(hostedSession, entry.message, { level: backendStatusLevel(entry.kind) });
}

export function backendStatusLevel(kind: ClaudeCliBackendErrorKind): "warning" | "error" {
    return kind === "canceled" || kind === "bridge_disconnected" ? "warning" : "error";
}

function sanitizePersistedMessage(message: string, kind: ClaudeCliBackendErrorKind): string {
    const sanitized = sanitizeStderrForDisplay(message).replace(
        /`[^`]*(?:claude|RUNWIELD|HOME|PATH|TOKEN|KEY)[^`]*`/gi,
        "[redacted]",
    );
    const bounded = sanitized || DEFAULT_MESSAGES[kind];
    return bounded.length > MAX_MESSAGE_LENGTH ? `${bounded.slice(0, MAX_MESSAGE_LENGTH)}…` : bounded;
}
