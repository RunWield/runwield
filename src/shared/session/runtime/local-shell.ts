import { AGENTS } from "../../../constants.js";
import { normalizeRuntimeToolResult, RuntimeEventTypes } from ".././session-runtime-events.js";
import { describeRuntimeTool } from ".././tool-event-title.ts";
import { spawnForegroundShell } from "../../foreground-process.ts";

import { getRuntimeRootAgentSession } from "./support.ts";

import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";
import type { RuntimeManagedOperations } from "./managed-operations.ts";
import type { RuntimeAgentSettings } from "./agent-settings.ts";

interface LocalBashMessage {
    role: "bashExecution";
    command: string;
    output: string;
    exitCode: number;
    cancelled: boolean;
    truncated: boolean;
    timestamp: number;
    excludeFromContext: boolean;
}

interface LocalShellResult {
    ok: boolean;
    exitCode: number;
    output: string;
    error?: string;
    canceled?: boolean;
    toolCallId?: string;
}

type RuntimeEventsDependency = Pick<RuntimeEvents, "emitSessionEvent">;
type RuntimeLifecycleDependency = Pick<RuntimeLifecycle, "hasPendingProject">;
type RuntimeManagedOperationsDependency = Pick<
    RuntimeManagedOperations,
    "currentCapability" | "hasPendingCreationProof" | "runManagedOperation"
>;
type RuntimeAgentSettingsDependency = Pick<RuntimeAgentSettings, "activateSessionAgent">;

export class RuntimeLocalShell {
    private events!: RuntimeEventsDependency;
    private lifecycle!: RuntimeLifecycleDependency;
    private managedOperations!: RuntimeManagedOperationsDependency;
    private settings!: RuntimeAgentSettingsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        lifecycle: RuntimeLifecycleDependency,
        managedOperations: RuntimeManagedOperationsDependency,
        settings: RuntimeAgentSettingsDependency,
    ) {
        this.events = events;
        this.lifecycle = lifecycle;
        this.managedOperations = managedOperations;
        this.settings = settings;
    }
    async runLocalShellCommand(
        sessionId: string,
        options: { command: string; userRequest?: string; persist?: boolean },
    ): Promise<LocalShellResult | import("./types.ts").ManagedOperationRunFailure> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, exitCode: 1, output: "", error: "not_found" };
        const command = String(options?.command || "").trim();
        if (!command) return { ok: false, exitCode: 1, output: "", error: "empty_command" };
        if (this.managedOperations.hasPendingCreationProof(sessionId) || this.lifecycle.hasPendingProject(sessionId)) {
            await this.settings.activateSessionAgent(session, { agentName: AGENTS.ROUTER });
            return await this.runLocalShellCommand(sessionId, options);
        }
        const managed = session.getManagedMetadata?.();
        const activeCapability = this.managedOperations.currentCapability(sessionId);
        if (managed && activeCapability) {
            return await this.runLocalShellCommandInSession(session, options, activeCapability);
        }
        if (managed && !session.getRootSessionManager?.()) {
            return await this.managedOperations.runManagedOperation(
                sessionId,
                {
                    name: "local_shell",
                    options: { expectedGeneration: managed.generation ?? undefined },
                    activateAgent: false,
                },
                async ({ capability }) => await this.runLocalShellCommandInSession(session, options, capability),
            );
        }
        if (managed) {
            return { ok: false, exitCode: 1, output: "", error: "managed_operation_in_progress" };
        }
        return await this.runLocalShellCommandInSession(session, options, null);
    }

    async runLocalShellCommandInSession(
        session: import(".././hosted-session.js").HostedSession,
        options: { command: string; userRequest?: string; persist?: boolean },
        capability: import(".././managed-operation.ts").ManagedOperationCapability | null,
    ) {
        const sessionId = session.id;
        const command = String(options?.command || "").trim();
        const persist = options.persist !== false && !session.isTurnActive();
        const userRequest = options.userRequest || `!${command}`;
        const toolCallId = `bash-${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const runtimeTool = {
            ...describeRuntimeTool("bash", { command }),
            title: `${userRequest.startsWith("!!") ? "!!" : "!"} ${command}`,
        };
        const interactionId = `local-shell:${toolCallId}`;
        const abortController = new AbortController();
        let canceled = false;
        let output = "";
        let exitCode = 1;

        const abort = () => {
            canceled = true;
            if (!abortController.signal.aborted) abortController.abort();
        };
        abortController.signal.addEventListener("abort", abort, { once: true });
        capability?.signal?.addEventListener("abort", abort, { once: true });
        session.addActiveInteraction(interactionId, { abortController });

        if (persist) {
            this.events.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.USER_MESSAGE,
                text: userRequest,
                images: [],
            });
        }
        this.events.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.TOOL_START,
            toolCallId,
            ...runtimeTool,
            args: { command },
        });

        try {
            // The foreground-process module owns the wrapper shell's process
            // group, so cancellation terminates the whole descendant tree, not
            // only `sh -c`.
            const shell = spawnForegroundShell({
                command,
                cwd: session.cwd,
                env: { PWD: session.cwd },
                signal: abortController.signal,
            });

            /** @param {ReadableStream<Uint8Array>} stream */
            const readStream = async (stream: ReadableStream<Uint8Array>) => {
                const reader = stream.getReader();
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (canceled) continue;
                        output += new TextDecoder().decode(value);
                        this.events.emitSessionEvent(sessionId, {
                            type: RuntimeEventTypes.TOOL_UPDATE,
                            toolCallId,
                            ...runtimeTool,
                            ...normalizeRuntimeToolResult(output),
                        });
                    }
                } finally {
                    reader.releaseLock();
                }
            };

            // The streams settle when the process tree dies, so final output and
            // active-interaction cleanup never race a still-running descendant.
            const [outcome] = await Promise.all([
                shell.done,
                readStream(shell.stdout),
                readStream(shell.stderr),
            ]);
            if (outcome.terminatedBy) canceled = true;
            exitCode = canceled ? 130 : outcome.exitCode ?? 1;
        } catch (error) {
            if (!canceled) {
                output += `Error starting process: ${error instanceof Error ? error.message : String(error)}\n`;
            }
            exitCode = canceled ? 130 : 1;
        } finally {
            abortController.signal.removeEventListener("abort", abort);
            capability?.signal?.removeEventListener("abort", abort);
            session.removeActiveInteraction(interactionId);
        }

        const finalText = canceled ? `${output}\n[RunWield] Command canceled by user.` : output;
        this.events.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.TOOL_END,
            toolCallId,
            ...runtimeTool,
            ...normalizeRuntimeToolResult(finalText),
            isError: canceled || exitCode !== 0,
            durationMs: Date.now() - startedAt,
        });
        if (canceled) {
            this.events.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.SYSTEM_STATUS,
                message: "Bash command canceled.",
            });
        } else if (persist) {
            this.recordLocalToolExchange(session, {
                userRequest,
                toolCallId,
                command,
                output,
                exitCode,
                isError: exitCode !== 0,
            });
        }

        return { ok: !canceled && exitCode === 0, exitCode, output, canceled, toolCallId };
    }

    recordLocalToolExchange(
        session: import(".././hosted-session.js").HostedSession,
        exchange: {
            userRequest: string;
            toolCallId: string;
            command: string;
            output: string;
            exitCode: number;
            isError: boolean;
        },
    ) {
        const manager = session.getRootSessionManager();
        const bashResult = {
            output: exchange.output,
            exitCode: exchange.exitCode,
            cancelled: false,
            truncated: false,
        };
        const agentSession = getRuntimeRootAgentSession(session);
        if (agentSession?.recordBashResult) {
            agentSession.recordBashResult(exchange.command, bashResult, { excludeFromContext: false });
            return { ok: true };
        }
        const bashMessage: LocalBashMessage = {
            role: "bashExecution",
            command: exchange.command,
            output: bashResult.output,
            exitCode: bashResult.exitCode,
            cancelled: bashResult.cancelled,
            truncated: bashResult.truncated,
            timestamp: Date.now(),
            excludeFromContext: false,
        };
        if (manager?.appendMessage) {
            manager.appendMessage(bashMessage);
            return { ok: true };
        }
        if (manager?.addMessage) {
            manager.addMessage(bashMessage);
            return { ok: true };
        }
        return { ok: false, error: "not_found" };
    }
}
