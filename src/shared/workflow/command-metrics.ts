/**
 * @module shared/workflow/command-metrics
 * Records structured observation events for slash commands across TUI, ACP, and Workspace.
 */

import { drainWorkflowMetrics, recordWorkflowMetric } from "./metrics.ts";

export type SlashCommandKind = "builtin" | "template" | "skill";
export type SlashCommandSurface = "tui" | "workspace" | "acp";
export type SlashCommandOutcome = "succeeded" | "failed" | "canceled" | "rejected";

export interface SlashCommandStartOptions {
    invocationId?: string;
    command: string;
    alias?: string;
    kind: SlashCommandKind;
    surface: SlashCommandSurface;
    projectRoot: string;
    sessionId?: string;
    requestId?: string;
    executionId?: string;
}

export interface SlashCommandFinishOptions {
    invocationId: string;
    command: string;
    alias?: string;
    kind: SlashCommandKind;
    surface: SlashCommandSurface;
    projectRoot: string;
    sessionId?: string;
    requestId?: string;
    executionId?: string;
    outcome: SlashCommandOutcome;
    durationMs: number;
    errorReason?: string | null;
}

export class SlashCommandMetricsTracker {
    readonly invocationId: string;
    readonly command: string;
    readonly alias?: string;
    readonly kind: SlashCommandKind;
    readonly surface: SlashCommandSurface;
    readonly projectRoot: string;
    readonly sessionId?: string;
    readonly requestId?: string;
    readonly executionId?: string;
    private startedAt: number;
    private finished = false;
    private dispatched = false;

    constructor(options: SlashCommandStartOptions) {
        this.invocationId = options.invocationId || `cmd_${crypto.randomUUID()}`;
        this.command = options.command;
        this.alias = options.alias;
        this.kind = options.kind;
        this.surface = options.surface;
        this.projectRoot = options.projectRoot;
        this.sessionId = options.sessionId;
        this.requestId = options.requestId;
        this.executionId = options.executionId;
        this.startedAt = Date.now();
    }

    async recordStart(phase: "start" | "opened" = "start"): Promise<void> {
        this.startedAt = Date.now();
        await recordWorkflowMetric(
            {
                v: 2,
                category: "command",
                event: "command_started",
                recorderId: this.invocationId,
                seq: 0,
                phase,
                commandId: this.invocationId,
                command: this.command,
                ...(this.alias ? { alias: this.alias } : {}),
                kind: this.kind,
                sourceSurface: this.surface,
                ...(this.sessionId ? { sessionId: this.sessionId } : {}),
                ...(this.requestId ? { requestId: this.requestId } : {}),
                ...(this.executionId ? { executionId: this.executionId } : {}),
            },
            this.projectRoot,
        );
    }

    async recordDispatched(): Promise<void> {
        if (this.finished || this.dispatched) return;
        this.dispatched = true;
        await recordWorkflowMetric({
            v: 2,
            category: "command",
            event: "command_dispatched",
            recorderId: this.invocationId,
            seq: 1,
            phase: "dispatched",
            commandId: this.invocationId,
            command: this.command,
            ...(this.alias ? { alias: this.alias } : {}),
            kind: this.kind,
            sourceSurface: this.surface,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.requestId ? { requestId: this.requestId } : {}),
            ...(this.executionId ? { executionId: this.executionId } : {}),
        }, this.projectRoot);
    }

    async recordFinish(options: {
        outcome: SlashCommandOutcome;
        errorReason?: string | null;
        executionId?: string;
    }): Promise<void> {
        if (this.finished) return;
        this.finished = true;
        const durationMs = Math.max(0, Date.now() - this.startedAt);
        await recordWorkflowMetric(
            {
                v: 2,
                category: "command",
                event: "command_finished",
                recorderId: this.invocationId,
                seq: this.dispatched ? 2 : 1,
                phase: options.outcome === "rejected" ? "rejected" : "finish",
                commandId: this.invocationId,
                command: this.command,
                ...(this.alias ? { alias: this.alias } : {}),
                kind: this.kind,
                sourceSurface: this.surface,
                ...(this.sessionId ? { sessionId: this.sessionId } : {}),
                ...(this.requestId ? { requestId: this.requestId } : {}),
                executionId: options.executionId || this.executionId,
                outcome: options.outcome,
                durationMs,
                errorReason: options.errorReason ?? null,
            },
            this.projectRoot,
        );
        await drainWorkflowMetrics(100);
    }
}

export async function recordSlashCommandMetric(
    event: SlashCommandStartOptions & {
        phase: "start" | "opened" | "dispatched" | "finish";
        outcome?: SlashCommandOutcome;
        durationMs?: number;
        dispatched?: boolean;
        errorReason?: string | null;
    },
): Promise<void> {
    const invocationId = event.invocationId || `cmd_${crypto.randomUUID()}`;
    if (event.phase !== "finish") {
        await recordWorkflowMetric(
            {
                v: 2,
                category: "command",
                event: event.phase === "dispatched" ? "command_dispatched" : "command_started",
                recorderId: invocationId,
                seq: event.phase === "dispatched" ? 1 : 0,
                phase: event.phase,
                commandId: invocationId,
                command: event.command,
                ...(event.alias ? { alias: event.alias } : {}),
                kind: event.kind,
                sourceSurface: event.surface,
                ...(event.sessionId ? { sessionId: event.sessionId } : {}),
                ...(event.requestId ? { requestId: event.requestId } : {}),
                ...(event.executionId ? { executionId: event.executionId } : {}),
            },
            event.projectRoot,
        );
    } else {
        await recordWorkflowMetric(
            {
                v: 2,
                category: "command",
                event: "command_finished",
                recorderId: invocationId,
                seq: event.dispatched ? 2 : 1,
                phase: event.outcome === "rejected" ? "rejected" : "finish",
                commandId: invocationId,
                command: event.command,
                ...(event.alias ? { alias: event.alias } : {}),
                kind: event.kind,
                sourceSurface: event.surface,
                ...(event.sessionId ? { sessionId: event.sessionId } : {}),
                ...(event.requestId ? { requestId: event.requestId } : {}),
                ...(event.executionId ? { executionId: event.executionId } : {}),
                outcome: event.outcome || "succeeded",
                durationMs: event.durationMs ?? 0,
                errorReason: event.errorReason ?? null,
            },
            event.projectRoot,
        );
    }
    if (event.phase === "finish") await drainWorkflowMetrics(100);
}
