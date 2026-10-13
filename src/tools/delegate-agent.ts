import { readFile as fsReadFile } from "node:fs/promises";
import { captureForegroundProcess } from "../shared/captured-process.ts";
/**
 * @module tools/delegate-agent
 * Context-isolated foreground Delegated Agent Session tool.
 */

import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AGENTS, SUBAGENTS } from "../constants.js";
import { formatProviderModelReference } from "../shared/models/model-validation.ts";
import {
    DELEGATED_READ_TOOLS,
    DELEGATED_ROLE_GENERAL,
    DELEGATED_ROLE_IDS,
    DELEGATED_WRITE_TOOLS,
    getDelegatedRole,
    loadSubAgentDefinition,
} from "../shared/session/subagent-definitions.ts";
import type {
    DelegatedAuthority,
    DelegatedRoleDefinition,
    DelegatedRoleId,
} from "../shared/session/subagent-definitions.ts";
import type { HostedSession } from "../shared/session/hosted-session.js";
import type { AgentDefinition } from "../shared/session/types.js";
import type { BashAllowedCommands } from "../shared/bash-command-policy.ts";
import { extractAssistantOutput } from "../shared/workflow/workflow-results.js";

type DelegationMode = "read" | "write";

const PARAMETERS = Type.Object({
    mode: StringEnum(["read", "write"], {
        description:
            "Delegation authority. Use read for investigation/review and write for one exclusive implementation task.",
    }),
    role: Type.Optional(StringEnum([...DELEGATED_ROLE_IDS], {
        description:
            "Optional Delegated Agent Role. Omit (or use 'general') for an unspecialized delegate. Use 'verification-adversary' to have a read-only delegate attack a draft Plan's outcomes, steps, and verification claims with the cheapest counterfeit implementation; a role's authority ceiling can reduce the requested mode.",
    })),
    background: Type.Optional(
        Type.Boolean({ description: "Run a read-only delegate without waiting for its result." }),
    ),
    brief: Type.String({
        minLength: 1,
        maxLength: 12000,
        description:
            "Self-contained bounded brief for the Delegated Agent. Include all paths, goals, constraints, and expected handoff details.",
    }),
}, { additionalProperties: false });

export interface DelegatedAgentSessionOptions {
    hostedSession: HostedSession;
    agentName: string;
    userRequest: string;
    cwd: string;
    subAgentDefinition: {
        id: typeof SUBAGENTS.DELEGATED | typeof SUBAGENTS.DELEGATED_READ;
        options: { delegatedRole: DelegatedRoleId };
    };
    toolNames: string[];
    inheritedBashAllowedCommands?: BashAllowedCommands;
    includeEditFallback: boolean;
    modelOverride?: string;
    thinkingLevelOverride?: ThinkingLevel;
    projectStateContext: string;
    background?: boolean;
    signal?: AbortSignal;
    parentToolCallId?: string;
    parentExecutionId?: string;
    taskId?: string;
}

type RunIsolatedAgentSession = (opts: DelegatedAgentSessionOptions) => Promise<AgentMessage[]>;

interface DelegateAgentToolOptions {
    hostedSession: HostedSession;
    cwd: string;
    parentTools: string[];
    bashAllowedCommands?: BashAllowedCommands;
    runIsolatedAgentSession: RunIsolatedAgentSession;
    modelOverride?: string;
    thinkingLevelOverride?: ThinkingLevel;
}

export interface DelegatedChangeEntry {
    path: string;
    status: string;
    contentHash: string | null;
}

export interface DelegatedChangeSnapshot {
    head: string | null;
    entries: DelegatedChangeEntry[];
}

interface PorcelainStatusEntry {
    status: string;
    path: string;
}

interface DelegateAgentDetails {
    ok: boolean;
    mode: DelegationMode;
    role: string;
    requestedAuthority?: DelegationMode;
    effectiveAuthority?: DelegationMode;
    roleAuthorityCeiling?: DelegatedAuthority;
    output?: string;
    task_id?: string;
    state?: import("../shared/session/background-tasks.ts").BackgroundTaskState;
    log_path?: string;
    tools?: string[];
    changedPaths?: string[] | null;
    changeAttributionComplete?: boolean;
    committedChangesDetected?: boolean;
    error?: string;
    validRoles?: DelegatedRoleId[];
}

type DelegateAgentResult = AgentToolResult<DelegateAgentDetails> & { isError?: boolean };

function errorMessage(value: null | undefined | string | number | boolean | Error): string {
    return value instanceof Error ? value.message : String(value);
}

/**
 * @param {string[]} parentTools
 * @param {"read" | "write"} mode
 * @returns {string[]}
 */
export function resolveDelegatedToolNames(parentTools: string[], mode: DelegationMode): string[] {
    const allowed = new Set(mode === "read" ? DELEGATED_READ_TOOLS : DELEGATED_WRITE_TOOLS);
    return [...new Set(parentTools)].filter((toolName) => allowed.has(toolName));
}

/**
 * @param {import('../shared/session/subagent-definitions.ts').DelegatedRoleId} [role]
 * @returns {Promise<import('../shared/session/types.js').AgentDefinition>}
 */
export async function loadDelegatedAgentPrompt(
    role: DelegatedRoleId = DELEGATED_ROLE_GENERAL,
    mode: DelegationMode = "write",
): Promise<AgentDefinition> {
    return await loadSubAgentDefinition(mode === "read" ? SUBAGENTS.DELEGATED_READ : SUBAGENTS.DELEGATED, {
        delegatedRole: role,
    });
}

/**
 * A role's authority ceiling is the most authority that role may receive; the effective
 * delegation mode is the intersection of what the caller asked for and what the role allows.
 *
 * @param {"read" | "write"} requestedMode
 * @param {import('../shared/session/subagent-definitions.ts').DelegatedAuthority} authorityCeiling
 * @returns {"read" | "write"}
 */
export function resolveEffectiveDelegationMode(
    requestedMode: DelegationMode,
    authorityCeiling: DelegatedAuthority,
): DelegationMode {
    return authorityCeiling === "read" ? "read" : requestedMode;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
    const output = await captureForegroundProcess("git", { args, cwd });
    if (output.code !== 0) {
        throw new Error(new TextDecoder().decode(output.stderr).trim() || `git ${args.join(" ")} failed`);
    }
    return new TextDecoder().decode(output.stdout);
}

/**
 * @param {string} cwd
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function hashWorktreeFile(cwd: string, path: string): Promise<string | null> {
    try {
        const bytes = await fsReadFile(join(cwd, path));
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
        return null;
    }
}

/**
 * @param {string} line
 * @returns {PorcelainStatusEntry | null}
 */
function parsePorcelainLine(line: string): PorcelainStatusEntry | null {
    if (!line.trim()) return null;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath) return null;
    const renameParts = rawPath.split(" -> ");
    return { status, path: renameParts[renameParts.length - 1] };
}

/**
 * @param {string} cwd
 * @returns {Promise<DelegatedChangeSnapshot | null>}
 */
export async function captureDelegatedChangeSnapshot(cwd: string): Promise<DelegatedChangeSnapshot | null> {
    try {
        const [head, output] = await Promise.all([
            runGit(cwd, ["rev-parse", "HEAD"]).then((value) => value.trim()).catch(() => null),
            runGit(cwd, ["status", "--porcelain", "--untracked-files=all"]),
        ]);
        const entries = [];
        for (const line of output.split("\n")) {
            const parsed = parsePorcelainLine(line);
            if (!parsed) continue;
            entries.push({
                path: parsed.path,
                status: parsed.status,
                contentHash: await hashWorktreeFile(cwd, parsed.path),
            });
        }
        return { head, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
    } catch {
        return null;
    }
}

/**
 * @param {string} cwd
 * @returns {Promise<string[] | null>}
 */
export async function captureDelegatedChangedPaths(cwd: string): Promise<string[] | null> {
    const snapshot = await captureDelegatedChangeSnapshot(cwd);
    return snapshot ? snapshot.entries.map((entry) => entry.path) : null;
}

/**
 * @param {DelegatedChangeSnapshot | DelegatedChangeEntry[] | null} snapshot
 * @returns {DelegatedChangeSnapshot | null}
 */
function normalizeDelegatedChangeSnapshot(
    snapshot: DelegatedChangeSnapshot | DelegatedChangeEntry[] | null,
): DelegatedChangeSnapshot | null {
    if (!snapshot) return null;
    if (Array.isArray(snapshot)) return { head: null, entries: snapshot };
    return snapshot;
}

/**
 * @param {DelegatedChangeSnapshot | DelegatedChangeEntry[] | null} before
 * @param {DelegatedChangeSnapshot | DelegatedChangeEntry[] | null} after
 * @returns {string[] | null}
 */
export function diffDelegatedChangeSnapshot(
    before: DelegatedChangeSnapshot | DelegatedChangeEntry[] | null,
    after: DelegatedChangeSnapshot | DelegatedChangeEntry[] | null,
): string[] | null {
    const normalizedBefore = normalizeDelegatedChangeSnapshot(before);
    const normalizedAfter = normalizeDelegatedChangeSnapshot(after);
    if (!normalizedAfter) return null;
    if (normalizedBefore?.head && normalizedAfter.head && normalizedBefore.head !== normalizedAfter.head) return null;
    if (!normalizedBefore) return normalizedAfter.entries.map((entry) => entry.path);
    const beforeSignatures = new Map(
        normalizedBefore.entries.map((entry) => [entry.path, `${entry.status}\0${entry.contentHash || ""}`]),
    );
    const afterSignatures = new Map(
        normalizedAfter.entries.map((entry) => [entry.path, `${entry.status}\0${entry.contentHash || ""}`]),
    );
    return [...new Set([...beforeSignatures.keys(), ...afterSignatures.keys()])]
        .filter((path) => beforeSignatures.get(path) !== afterSignatures.get(path))
        .sort();
}

/**
 * @param {DelegatedChangeSnapshot | DelegatedChangeEntry[] | null} before
 * @param {DelegatedChangeSnapshot | DelegatedChangeEntry[] | null} after
 * @returns {boolean}
 */
function delegatedHeadChanged(
    before: DelegatedChangeSnapshot | DelegatedChangeEntry[] | null,
    after: DelegatedChangeSnapshot | DelegatedChangeEntry[] | null,
): boolean {
    const normalizedBefore = normalizeDelegatedChangeSnapshot(before);
    const normalizedAfter = normalizeDelegatedChangeSnapshot(after);
    return Boolean(normalizedBefore?.head && normalizedAfter?.head && normalizedBefore.head !== normalizedAfter.head);
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateToolText(text: string): string {
    const trimmed = text.trim();
    return trimmed.length > 20000 ? `${trimmed.slice(0, 19950)}\n\n[Delegated output truncated]` : trimmed;
}

/**
 * @param {import('../shared/session/hosted-session.js').HostedSession} hostedSession
 * @param {string | undefined} explicitOverride
 * @returns {string | undefined}
 */
function resolveDelegatedModelOverride(
    hostedSession: HostedSession,
    explicitOverride: string | undefined,
): string | undefined {
    if (explicitOverride) return explicitOverride;
    if (hostedSession.isUserModelOverride()) return undefined;
    const activeModel = hostedSession.getActiveModelState();
    return activeModel.model ? formatProviderModelReference(activeModel) : undefined;
}

function resolveDelegatedThinkingLevelOverride(
    hostedSession: HostedSession,
    explicitOverride: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
    return explicitOverride || hostedSession.getThinkingLevel() || undefined;
}

/**
 * Role context for the child's user request. A general delegation adds nothing, so its
 * request text stays byte-identical to pre-role delegation.
 *
 * @param {import('../shared/session/subagent-definitions.ts').DelegatedRoleDefinition} role
 * @param {"read" | "write"} requestedMode
 * @param {"read" | "write"} effectiveMode
 * @returns {string[]}
 */
function roleRequestLines(
    role: DelegatedRoleDefinition,
    requestedMode: DelegationMode,
    effectiveMode: DelegationMode,
): string[] {
    if (role.id === DELEGATED_ROLE_GENERAL) return [];
    const lines = [`Delegated role: ${role.id}`];
    if (effectiveMode !== requestedMode) {
        lines.push(
            `The parent requested ${requestedMode} mode; the ${role.id} role has a ${role.authorityCeiling}-only authority ceiling, so this session runs as ${effectiveMode}.`,
        );
    }
    return lines;
}

/**
 * @param {DelegateAgentToolOptions} opts
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition}
 */
export function createDelegateAgentTool(opts: DelegateAgentToolOptions) {
    if (!opts.hostedSession) throw new Error("createDelegateAgentTool: hostedSession is required");
    if (!opts.cwd) throw new Error("createDelegateAgentTool: cwd is required");
    if (!opts.runIsolatedAgentSession) throw new Error("createDelegateAgentTool: runIsolatedAgentSession is required");
    return defineTool<typeof PARAMETERS, DelegateAgentDetails>({
        name: "delegate_agent",
        label: "Delegate Agent",
        description:
            "Run a bounded context-isolated Delegated Agent Session. Use mode 'read' for investigation/review and mode 'write' for one exclusive synchronous implementation task. Set background: true for independent read-only work and inspect its final task result before relying on it.",
        parameters: PARAMETERS,
        async execute(toolCallId, params, signal, _onUpdate, _ctx): Promise<DelegateAgentResult> {
            const requestedMode: DelegationMode = params.mode === "write" ? "write" : "read";
            const requestedRole = typeof params.role === "string" && params.role ? params.role : DELEGATED_ROLE_GENERAL;
            const brief = typeof params.brief === "string" ? params.brief.trim() : "";
            if (!brief) {
                return {
                    content: [{ type: "text" as const, text: "Delegation failed: brief is required." }],
                    details: { ok: false, mode: requestedMode, role: requestedRole, error: "brief_required" },
                    isError: true,
                };
            }

            if (params.background && requestedMode === "write") {
                return {
                    content: [{ type: "text" as const, text: "Background delegation requires requested read mode." }],
                    details: { ok: false, mode: requestedMode, role: requestedRole, error: "background_write_denied" },
                    isError: true,
                };
            }
            const role = getDelegatedRole(requestedRole);
            if (!role) {
                const message = `Delegation failed: unknown role "${requestedRole}". Valid roles: ${
                    DELEGATED_ROLE_IDS.join(", ")
                }.`;
                return {
                    content: [{ type: "text" as const, text: message }],
                    details: {
                        ok: false,
                        mode: requestedMode,
                        role: requestedRole,
                        error: "unknown_role",
                        validRoles: [...DELEGATED_ROLE_IDS],
                    },
                    isError: true,
                };
            }

            const mode = resolveEffectiveDelegationMode(requestedMode, role.authorityCeiling);
            const childTools = resolveDelegatedToolNames(opts.parentTools, mode);
            const definitionId = mode === "read" ? SUBAGENTS.DELEGATED_READ : SUBAGENTS.DELEGATED;
            const userRequest = [
                `Delegation mode: ${mode}`,
                ...roleRequestLines(role, requestedMode, mode),
                "",
                "You are running as a context-isolated child. Complete only the brief below and return a concise handoff.",
                "",
                "## Brief",
                brief,
            ].join("\n");
            const modelOverride = resolveDelegatedModelOverride(opts.hostedSession, opts.modelOverride);
            const thinkingLevelOverride = resolveDelegatedThinkingLevelOverride(
                opts.hostedSession,
                opts.thinkingLevelOverride,
            );
            if (params.background) {
                try {
                    signal?.throwIfAborted();
                    const status = opts.hostedSession.backgroundTasks.startDelegate({
                        hostedSession: opts.hostedSession,
                        agentName: AGENTS.DELEGATED,
                        userRequest,
                        cwd: opts.cwd,
                        subAgentDefinition: { id: definitionId, options: { delegatedRole: role.id } },
                        toolNames: childTools,
                        inheritedBashAllowedCommands: opts.bashAllowedCommands,
                        includeEditFallback: false,
                        modelOverride,
                        thinkingLevelOverride,
                        projectStateContext: opts.hostedSession.getProjectStateContext(),
                        parentToolCallId: toolCallId,
                        parentExecutionId: opts.hostedSession.getToolExecutionId(toolCallId),
                    });
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(status) }],
                        details: { ok: true, mode, role: role.id, ...status },
                    };
                } catch (error) {
                    const message = errorMessage(error instanceof Error ? error : String(error));
                    return {
                        content: [{ type: "text" as const, text: `Delegation failed: ${message}` }],
                        details: { ok: false, mode, role: role.id, error: message },
                        isError: true,
                    };
                }
            }
            let release: (() => void) | undefined;
            let beforeSnapshot: DelegatedChangeSnapshot | null = null;
            try {
                release = opts.hostedSession.acquireDelegatedAgentLease(mode);
                beforeSnapshot = mode === "write" ? await captureDelegatedChangeSnapshot(opts.cwd) : null;
                signal?.throwIfAborted?.();
                const messages = await opts.runIsolatedAgentSession({
                    hostedSession: opts.hostedSession,
                    agentName: AGENTS.DELEGATED,
                    userRequest,
                    cwd: opts.cwd,
                    subAgentDefinition: {
                        id: definitionId,
                        options: { delegatedRole: role.id },
                    },
                    toolNames: childTools,
                    inheritedBashAllowedCommands: opts.bashAllowedCommands,
                    includeEditFallback: mode === "write",
                    modelOverride,
                    thinkingLevelOverride,
                    projectStateContext: opts.hostedSession.getProjectStateContext(),
                    signal,
                    parentToolCallId: toolCallId,
                    parentExecutionId: opts.hostedSession.getToolExecutionId(toolCallId),
                });
                const output = truncateToolText(
                    extractAssistantOutput(messages) || "(Delegated Agent returned no text.)",
                );
                const afterSnapshot = mode === "write" ? await captureDelegatedChangeSnapshot(opts.cwd) : null;
                const changedPaths = mode === "write"
                    ? diffDelegatedChangeSnapshot(beforeSnapshot, afterSnapshot)
                    : undefined;
                const committedChangesDetected = mode === "write"
                    ? delegatedHeadChanged(beforeSnapshot, afterSnapshot)
                    : undefined;
                return {
                    content: [{ type: "text" as const, text: output }],
                    details: {
                        ok: true,
                        mode,
                        role: role.id,
                        requestedAuthority: requestedMode,
                        effectiveAuthority: mode,
                        roleAuthorityCeiling: role.authorityCeiling,
                        output,
                        tools: childTools,
                        changedPaths,
                        changeAttributionComplete: mode === "write"
                            ? Boolean(beforeSnapshot && afterSnapshot && !committedChangesDetected)
                            : undefined,
                        committedChangesDetected,
                    },
                };
            } catch (error) {
                const afterSnapshot = mode === "write" && release
                    ? await captureDelegatedChangeSnapshot(opts.cwd)
                    : null;
                const changedPaths = mode === "write" && release
                    ? diffDelegatedChangeSnapshot(beforeSnapshot, afterSnapshot)
                    : undefined;
                const committedChangesDetected = mode === "write" && release
                    ? delegatedHeadChanged(beforeSnapshot, afterSnapshot)
                    : undefined;
                const caughtMessage = errorMessage(error instanceof Error ? error : String(error));
                const message = `Delegation failed: ${caughtMessage}`;
                return {
                    content: [{ type: "text" as const, text: message }],
                    details: {
                        ok: false,
                        mode,
                        role: role.id,
                        requestedAuthority: requestedMode,
                        effectiveAuthority: mode,
                        roleAuthorityCeiling: role.authorityCeiling,
                        error: caughtMessage,
                        tools: childTools,
                        changedPaths,
                        changeAttributionComplete: mode === "write" && release
                            ? Boolean(beforeSnapshot && afterSnapshot && !committedChangesDetected)
                            : undefined,
                        committedChangesDetected,
                    },
                    isError: true,
                };
            } finally {
                release?.();
            }
        },
    });
}
