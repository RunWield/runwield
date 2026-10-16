/** Separate remote process: all Session, tool and save behavior is production code. */
import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createMnemotecaTools, type MemoryParams } from "../../extensions/mnemoteca/tools.ts";
import { denoHelperBinaryExec } from "../../extensions/helper-binary-exec.ts";
import { assembleFinalSystemPrompt } from "../session/session.js";
import { loadAgentDef } from "../session/agents.js";
import { runSleepCommand, SYSTEM_SLEEP_MNEMOTECA_PORT } from "../../cmd/sleep/index.ts";
import { startInteractiveSession } from "../../ui/tui/chat-session.ts";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { configureRemotePersonalResources } from "./personal-resources.ts";
import { configureRemoteModelConnection } from "../models/model-registry.ts";
import { configureRemoteMemoryConnection } from "./memory-bridge.ts";
import { configureRemoteSettingsConnection } from "./settings-bridge.ts";
import { configureRemoteMcpConnection } from "./mcp-bridge.ts";
import { RemoteSessionControl, type RemoteSessionControlConnection } from "./session-control-client.ts";
import { createSessionRuntime } from "../session/session-runtime.ts";
import { HostedSession } from "../session/hosted-session.js";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildAgentSession } from "../session/session.js";
import { createRemoteRootSessionManager, getRemoteSessionSaveBridge } from "../session/root-session.js";
import { readImageRef } from "../session/image-attachments.ts";
import { runResumeCommand } from "../../cmd/resume/index.ts";

export interface RuntimeClientInput {
    connection: RemoteSessionControlConnection;
    resources: string;
    memoryCollection: string;
    cwd: string;
}
export interface RuntimeClientCommand {
    kind:
        | "memory"
        | "core-prompt"
        | "sleep"
        | "mcp"
        | "handoff"
        | "reload"
        | "blocker"
        | "turn"
        | "turn-start"
        | "cancel"
        | "load"
        | "close"
        | "guard"
        | "upload"
        | "image-read"
        | "resume-command"
        | "load-start"
        | "close-session"
        | "snapshots"
        | "image-preflight-turn";
    text?: string;
    memory?: MemoryParams;
    sessionId?: string;
    image?: boolean;
    ref?: string;
    modelOverride?: string;
}
export interface RuntimeClientSnapshot {
    id: string;
    busy: boolean;
    disposed: boolean;
}
export interface RuntimeClientReport {
    kind: string;
    text?: string;
    activeAgent?: string | null;
    ok?: boolean;
    error?: string;
    sessionId?: string;
    savedId?: string;
    managed?: boolean;
    dormant?: boolean;
    ref?: string;
    base64?: string;
    errors?: string[];
    selectedId?: string;
    notices?: string[];
    snapshots?: RuntimeClientSnapshot[];
    closed?: boolean;
    preparedModelOverride?: string;
}
const lines = processLines(stdinStream());
const input: RuntimeClientInput = JSON.parse((await lines.read()).value || "{}");
configureRemotePersonalResources({ globalRoot: input.resources });
configureRemoteSettingsConnection(input.connection);
const clearMcp = configureRemoteMcpConnection(input.connection);
const clearMemory = configureRemoteMemoryConnection({ ...input.connection, collection: input.memoryCollection });
const clearModels = await configureRemoteModelConnection(input.connection);
const control = new RemoteSessionControl(input.connection);
const runtime = createSessionRuntime({ remoteSessionControl: control, ownerProcessKind: "test" });
let sessionId = await runtime.createPromptReadySession({ cwd: input.cwd, agentName: "remote-runtime" });
const report = (kind: string, ok?: boolean, error?: string) => {
    const snapshot = runtime.getSessionSnapshot(sessionId);
    console.log(
        JSON.stringify({
            kind,
            ok,
            error,
            sessionId,
            savedId: snapshot?.managed?.runwieldSessionId,
            managed: Boolean(snapshot?.managed),
            dormant: runtime.isManagedSessionDormant(sessionId),
        }),
    );
};
const pending: Promise<void>[] = [];
let turnTools: ToolDefinition[] | undefined;
try {
    report("ready");
    while (true) {
        const next = await lines.read();
        if (next.done) break;
        const command: RuntimeClientCommand = JSON.parse(next.value);
        if (command.kind === "close") break;
        try {
            if (command.kind === "turn-start") {
                pending.push(
                    runtime
                        .promptUserTurn(sessionId, {
                            initialRequest: command.text || "Call the slow MCP tool.",
                            agentName: "remote-runtime",
                            customTools: turnTools,
                        })
                        .then((result) => report("turn", result.ok, result.error)),
                );
                report("turn-started", true);
            } else if (command.kind === "cancel") {
                const result = runtime.cancelSession(sessionId);
                report("cancel", result.ok);
            } else if (command.kind === "memory") {
                if (!command.memory) throw new Error("Missing Memory operation");
                const [tool] = createMnemotecaTools({ cwd: input.cwd, exec: denoHelperBinaryExec });
                const result = await tool.execute(
                    "remote-memory",
                    command.memory,
                    undefined,
                    undefined,
                    {} as Parameters<typeof tool.execute>[4],
                );
                console.log(JSON.stringify({ kind: "memory", text: result.content, ok: true }));
            } else if (command.kind === "core-prompt") {
                const definition = await loadAgentDef("guide", input.cwd);
                const text = await assembleFinalSystemPrompt(
                    { ...definition, systemPrompt: "{{MEMORIES}}" },
                    [],
                    [],
                    input.cwd,
                );
                console.log(JSON.stringify({ kind: "core-prompt", text, ok: true }));
            } else if (command.kind === "sleep") {
                const notices: string[] = [];
                await runSleepCommand([], {
                    sessionId,
                    sessionRuntime: runtime,
                    uiAPI: { appendSystemMessage: (message) => notices.push(message) },
                    mnemotecaPort: SYSTEM_SLEEP_MNEMOTECA_PORT,
                    sessionPort: { startInteractiveSession },
                });
                console.log(
                    JSON.stringify({
                        kind: "sleep",
                        notices,
                        activeAgent: runtime.getSessionSnapshot(sessionId)?.activeAgent,
                    }),
                );
            } else if (command.kind === "blocker") {
                turnTools = [
                    {
                        name: "fixture_blocker",
                        label: "Fixture blocker",
                        description: "Wait for external release",
                        parameters: Type.Object({}),
                        executionMode: "sequential",
                        async execute() {
                            await writeFile(join(input.cwd, "block-started"), "started");
                            while (
                                !(await stat(join(input.cwd, "block-release")).then(
                                    () => true,
                                    () => false,
                                ))
                            ) {
                                await new Promise((resolve) => setTimeout(resolve, 5));
                            }
                            return { content: [{ type: "text", text: "Released" }], details: {} };
                        },
                    },
                ];
                report("blocker", true);
            } else if (command.kind === "handoff") {
                const result = await runtime.switchAgent(sessionId, { agentName: command.text || "remote-runtime" });
                report("handoff", result.ok, result.error);
            } else if (command.kind === "reload") {
                const result = await runtime.reloadSession(sessionId);
                report("reload", result.ok, result.error);
            } else if (command.kind === "mcp") {
                console.log(
                    JSON.stringify({
                        kind: "mcp",
                        notices: (await runtime.runMcpCommand(sessionId, command.text || "")).notifications.map(
                            (notice) => notice.message,
                        ),
                    }),
                );
            } else if (command.kind === "guard") {
                const errors: string[] = [];
                const hosted = new HostedSession({ id: crypto.randomUUID(), cwd: input.cwd });
                const missing = SessionManager.inMemory(input.cwd);
                hosted.setRootSessionManager(missing);
                try {
                    await buildAgentSession({
                        hostedSession: hosted,
                        cwd: input.cwd,
                        agentName: "remote-runtime",
                        sessionManager: missing,
                    });
                } catch (error) {
                    errors.push(String(error));
                }
                const operation = await control.create(crypto.randomUUID());
                let bridge: ReturnType<typeof getRemoteSessionSaveBridge>;
                try {
                    const other = await createRemoteRootSessionManager(input.cwd, control.sessionConnection(operation));
                    bridge = getRemoteSessionSaveBridge(other);
                    try {
                        await buildAgentSession({
                            hostedSession: hosted,
                            cwd: input.cwd,
                            agentName: "remote-runtime",
                            sessionManager: other,
                        });
                    } catch (error) {
                        errors.push(String(error));
                    }
                    await control.checkpoint(operation);
                } finally {
                    bridge?.close();
                }
                console.log(JSON.stringify({ kind: "guard", errors }));
            } else if (command.kind === "upload") {
                const image = await runtime.persistSessionImage(sessionId, {
                    base64: "AQIDBA==",
                    mimeType: "image/png",
                });
                console.log(JSON.stringify({ kind: "upload", ...image }));
            } else if (command.kind === "image-read") {
                const operation = await control.begin(command.sessionId || "");
                let bridge: ReturnType<typeof getRemoteSessionSaveBridge>;
                try {
                    const manager = await createRemoteRootSessionManager(
                        input.cwd,
                        control.sessionConnection(operation),
                    );
                    bridge = getRemoteSessionSaveBridge(manager);
                    const image = await readImageRef(command.ref || "", { cwd: input.cwd, sessionManager: manager });
                    await control.checkpoint(operation);
                    console.log(JSON.stringify({ kind: "image-read", ...image }));
                } finally {
                    bridge?.close();
                }
            } else if (command.kind === "snapshots") {
                console.log(JSON.stringify({ kind: "snapshots", snapshots: runtime.listSessions() }));
            } else if (command.kind === "load-start") {
                await runtime.closeAllSessionsWhenIdle();
                pending.push(
                    runtime.loadSession({ cwd: input.cwd, sessionId: command.sessionId || "" }).then(
                        (loaded) => {
                            sessionId = loaded.sessionId;
                            report("load", true);
                        },
                        (error: Error) => report("load", false, String(error)),
                    ),
                );
                report("load-started", true);
            } else if (command.kind === "close-session") {
                pending.push(
                    runtime.closeSession(command.sessionId || "").then(
                        (result) => console.log(JSON.stringify({ kind: "close-session", ...result })),
                        (error: Error) => report("close-session", false, String(error)),
                    ),
                );
                report("close-requested", true);
            } else if (command.kind === "resume-command") {
                const notices: string[] = [];
                let selectedId = "";
                await runResumeCommand([], {
                    sessionRuntime: runtime,
                    sessionId,
                    editor: { disableSubmit: false, setText() {} },
                    uiAPI: {
                        appendSystemMessage(message) {
                            notices.push(message);
                        },
                        promptSelect(_title, items) {
                            // Fixed human input at the UI boundary: select the presented id.
                            selectedId = items.find((item) => item.value === command.sessionId)?.value || "";
                            return Promise.resolve(selectedId || null);
                        },
                    },
                    replaceRuntimeSession(id) {
                        sessionId = id;
                    },
                });
                const snapshot = runtime.getSessionSnapshot(sessionId);
                console.log(
                    JSON.stringify({
                        kind: "resume-command",
                        ok: true,
                        selectedId,
                        notices,
                        savedId: snapshot?.managed?.runwieldSessionId,
                    }),
                );
            } else if (command.kind === "image-preflight-turn") {
                const initialImages = [
                    {
                        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        mimeType: "image/png",
                    },
                ];
                const preflight = await runtime.preflightUserTurnImages(sessionId, {
                    initialRequest: command.text || "Describe this image.",
                    agentName: "remote-runtime",
                    initialImages,
                    modelOverride: command.modelOverride,
                });
                if (!preflight.ok) throw new Error(preflight.message);
                const preparedModelOverride =
                    "preparedModelOverride" in preflight ? preflight.preparedModelOverride : undefined;
                console.log(JSON.stringify({ kind: "image-preflight", ok: true, preparedModelOverride }));
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: command.text || "Describe this image.",
                    agentName: "remote-runtime",
                    initialImages,
                    preparedModelOverride,
                });
                report("turn", result.ok, result.error);
            } else if (command.kind === "load") {
                await runtime.closeAllSessionsWhenIdle();
                sessionId = (await runtime.loadSession({ cwd: input.cwd, sessionId: command.sessionId || "" }))
                    .sessionId;
                report("load", true);
            } else {
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: command.text || "Read and write the remote project.",
                    agentName: "remote-runtime",
                    initialImages: command.image
                        ? [
                              {
                                  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                                  mimeType: "image/png",
                              },
                          ]
                        : [],
                });
                report("turn", result.ok, result.error);
            }
        } catch (error) {
            report(command.kind, false, String(error));
        }
    }
} finally {
    await Promise.all(pending);
    await runtime.closeAllSessionsWhenIdle();
    await clearMcp();
    clearModels();
    clearMemory();
    await lines.cancel();
    lines.releaseLock();
}
