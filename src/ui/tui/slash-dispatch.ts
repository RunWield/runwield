/**
 * @module ui/tui/slash-dispatch
 * Routes built-in slash commands, prompt templates, and skill macros.
 */

import type { EditorAPI, TuiAPI, UiAPI } from "./api.ts";
import type { ImageAttachment } from "../../shared/session/image-attachments.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { GenerationGuard } from "./generation-guard.ts";
import { setTerminalTitleForName } from "./terminal-title.ts";
import { notifyRunWieldEventQuietly } from "./system-notifications.ts";

const IMMEDIATE_BUILTIN_SLASH_COMMANDS_WHILE_STREAMING = new Set([
    "context",
    "copy",
    "exit",
    "export",
    "help",
    "name",
    "plan-review",
    "quit",
    "session",
    "share",
    "version",
]);

interface PromptTemplateMeta {
    name: string;
    argumentHint?: string;
    description?: string;
    model?: string;
    path?: string;
    source?: string;
}

export interface SkillMeta {
    name: string;
    description: string;
    path: string;
    source: "local" | "home" | "bundled" | "external";
    disableModelInvocation?: boolean;
}

interface NotificationOptions {
    sessionName?: string;
    agentName?: string;
}

type NotificationEventName = "agentStopped" | "planWritten" | "userInterview" | "compactionFinished";

interface ResolvedTemplateModel {
    ok: true;
    provider: string;
    id: string;
}

interface UnresolvedTemplateModel {
    ok: false;
}

export interface SlashContext {
    userRequest: string;
    savedImages: ImageAttachment[];
    sessionId: string;
    sessionRuntime: SessionRuntime;
    uiAPI: UiAPI;
    editor: EditorAPI;
    tui: TuiAPI;
    sessionStartedAt: string;
    originalHandleInput(data: string): void;
    initCommandAvailable: boolean;
    promptTemplateByName: Map<string, PromptTemplateMeta>;
    skills: SkillMeta[];
    chatPromptAgentName: string;
    resolveTemplateModel(templateModel: string): ResolvedTemplateModel | UnresolvedTemplateModel;
    replaceRuntimeSession?(nextSessionId: string): void;
    notifyRunWieldEvent?(eventName: string, options?: NotificationOptions): Promise<void> | void;
    dispatchExpandedUserRequest?(text: string, images: ImageAttachment[]): Promise<void>;
    beginOnboarding?(): Promise<void>;
    generationGuard: GenerationGuard;
}

type CommandRegistry = typeof import("../../cmd/registry.ts").commandRegistry;

function isNotificationEventName(eventName: string): eventName is NotificationEventName {
    return eventName === "agentStopped" || eventName === "planWritten" || eventName === "userInterview" ||
        eventName === "compactionFinished";
}

export function isImmediateBuiltinSlashCommandWhileStreaming(userRequest: string): boolean {
    if (!userRequest.startsWith("/")) return false;
    const [rawCommand] = userRequest.slice(1).split(" ");
    return IMMEDIATE_BUILTIN_SLASH_COMMANDS_WHILE_STREAMING.has(rawCommand.trim());
}

function maybeUpdateTitleForSlashCommand(runtime: SessionRuntime, sessionId: string): void {
    const snapshot = runtime.getSessionSnapshot(sessionId);
    if (snapshot && !snapshot.name) setTerminalTitleForName(undefined);
}

export async function handleSlashCommand(ctx: SlashContext): Promise<boolean> {
    const { userRequest } = ctx;
    if (!userRequest.startsWith("/")) return false;

    const [rawCommand, ...args] = userRequest.slice(1).split(" ");
    const command = rawCommand.trim();
    const thisGen = ctx.generationGuard.bump();
    const registryModule = await import("../../cmd/registry.ts");
    const builtinCommand = registryModule.getSlashCommandDefinition(command);

    if (builtinCommand?.name === "init" && !ctx.initCommandAvailable) {
        await recordRejectedBuiltin(ctx, "init", "unavailable");
        ctx.uiAPI.appendSystemMessage(
            "The /init command is unavailable because RunWield is already initialized for this project.",
        );
        return true;
    }

    if (builtinCommand) {
        maybeUpdateTitleForSlashCommand(ctx.sessionRuntime, ctx.sessionId);
        await dispatchBuiltin(
            ctx,
            builtinCommand.name,
            args,
            registryModule.commandRegistry,
            thisGen,
            command === builtinCommand.name ? undefined : command,
        );
        return true;
    }

    if (registryModule.getCommandDefinition(command)) {
        await recordRejectedBuiltin(ctx, command, "unavailable");
        ctx.uiAPI.appendSystemMessage(`Command /${command} is not available in this surface.`);
        return true;
    }

    const template = ctx.promptTemplateByName.get(command);
    if (template) {
        maybeUpdateTitleForSlashCommand(ctx.sessionRuntime, ctx.sessionId);
        await dispatchTemplate(ctx, template, args.join(" "), thisGen);
        return true;
    }

    if (command.startsWith("skill:")) {
        const skillName = command.slice(6);
        const skill = ctx.skills.find((candidate) => candidate.name === skillName);
        if (skill) {
            maybeUpdateTitleForSlashCommand(ctx.sessionRuntime, ctx.sessionId);
            await dispatchSkill(ctx, skill, args.join(" "), thisGen);
            return true;
        }
    }

    await recordRejectedBuiltin(ctx);
    ctx.uiAPI.appendSystemMessage(`Unknown command: /${command}`);
    return true;
}

import { SlashCommandMetricsTracker } from "../../shared/workflow/command-metrics.ts";

async function recordRejectedBuiltin(
    ctx: SlashContext,
    command = "unknown",
    reason = "unknown_command",
): Promise<void> {
    const root = ctx.sessionRuntime.getSessionSnapshot(ctx.sessionId)?.cwd;
    if (!root) return;
    const tracker = new SlashCommandMetricsTracker({
        command,
        kind: "builtin",
        surface: "tui",
        projectRoot: root,
        sessionId: ctx.sessionId,
    });
    await tracker.recordStart();
    await tracker.recordFinish({ outcome: "rejected", errorReason: reason });
}

async function dispatchBuiltin(
    ctx: SlashContext,
    command: string,
    args: string[],
    commandRegistry: CommandRegistry,
    thisGen: number,
    alias?: string,
): Promise<void> {
    const projectRoot = ctx.sessionRuntime.getSessionSnapshot?.(ctx.sessionId)?.cwd;
    const tracker = projectRoot
        ? new SlashCommandMetricsTracker({
            command,
            alias,
            kind: "builtin",
            surface: "tui",
            projectRoot,
            sessionId: ctx.sessionId,
        })
        : null;
    const picker = (command === "agent" || command === "model") && args.length === 0;
    await tracker?.recordStart(picker ? "opened" : "start");
    if (!picker) await tracker?.recordDispatched();
    const commandUiAPI: SlashContext["uiAPI"] = picker
        ? {
            ...ctx.uiAPI,
            async promptSelect(...selectionArgs) {
                const selection = await ctx.uiAPI.promptSelect(...selectionArgs);
                if (selection) await tracker?.recordDispatched();
                return selection;
            },
        }
        : ctx.uiAPI;
    let outcome: "succeeded" | "failed" | "canceled" | "rejected" = "succeeded";
    let errorReason: string | null = null;
    try {
        const notifyRunWieldEvent = ctx.notifyRunWieldEvent || ((eventName: string, options?: NotificationOptions) => {
            if (!isNotificationEventName(eventName)) return;
            return notifyRunWieldEventQuietly(eventName, options);
        });
        const result = await commandRegistry[command].execute(args, {
            uiAPI: commandUiAPI,
            editor: ctx.editor,
            sessionId: ctx.sessionId,
            sessionRuntime: ctx.sessionRuntime,
            sessionStartedAt: ctx.sessionStartedAt,
            commandInvocationId: tracker?.invocationId,
            tui: ctx.tui,
            originalHandleInput: ctx.originalHandleInput,
            replaceRuntimeSession: ctx.replaceRuntimeSession,
            notifyRunWieldEvent,
            beginOnboarding: ctx.beginOnboarding,
            slashSurface: "tui",
        });
        if (result === "failed" || result === "canceled" || result === "rejected") outcome = result;
    } catch (error) {
        outcome = "failed";
        errorReason = error instanceof Error ? error.message : String(error);
        if (ctx.generationGuard.isCurrent(thisGen)) {
            ctx.uiAPI.appendSystemMessage(`Error: ${errorReason}`);
        }
    } finally {
        await tracker?.recordFinish({
            outcome,
            errorReason: outcome === "failed" ? "failed" : outcome === "rejected" ? "rejected" : null,
        });
    }
}

async function dispatchExpandedInput(
    ctx: SlashContext,
    expandedText: string,
    images: ImageAttachment[],
): Promise<void> {
    if (!ctx.dispatchExpandedUserRequest) throw new Error("Expanded commands require the runtime submission surface.");
    await ctx.dispatchExpandedUserRequest(expandedText, images);
}

async function dispatchSkill(
    ctx: SlashContext,
    _skill: SkillMeta,
    _additionalInstructions: string,
    thisGen: number,
): Promise<void> {
    try {
        await dispatchExpandedInput(ctx, ctx.userRequest, ctx.savedImages);
    } catch (error) {
        if (ctx.generationGuard.isCurrent(thisGen)) {
            ctx.uiAPI.appendSystemMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

async function dispatchTemplate(
    ctx: SlashContext,
    _template: PromptTemplateMeta,
    _additionalInstructions: string,
    thisGen: number,
): Promise<void> {
    try {
        await dispatchExpandedInput(ctx, ctx.userRequest, ctx.savedImages);
    } catch (error) {
        if (ctx.generationGuard.isCurrent(thisGen)) {
            ctx.uiAPI.appendSystemMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
