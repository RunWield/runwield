import {
    type AgentSession,
    createAgentSession,
    createMcpExtension,
    DefaultResourceLoader,
    type ExtensionAPI,
    type ExtensionFactory,
    type LoadedMcpConfig,
    type ModelRuntime,
    SessionManager,
    type SettingsManager,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type McpTransport, StdioTransport } from "@earendil-works/pi-mcp";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio";
import { join } from "node:path";
import { getNativeModelRegistry } from "./model-registry.ts";

/** An approved executable and its process arguments and environment overrides. */
export interface McpStdioCommand {
    command: string;
    args: string[];
    env: Record<string, string>;
}

/** A server already admitted by the owning host. Location is displayed by the status command. */
export interface McpIntegrationServer extends McpStdioCommand {
    name: string;
    source: string;
    location?: string;
}

/** Supplies the session environment, admitted servers, and optional connection transport. */
export interface McpIntegrationStartOptions {
    cwd: string;
    agentDir: string;
    servers: readonly McpIntegrationServer[];
    settingsManager?: SettingsManager;
    modelRuntime?: ModelRuntime;
    /** Return a fresh transport for a server on each connection attempt. Undefined uses local stdio. */
    createTransport?: (serverName: string) => McpTransport | undefined;
}

/** Identifies a server that failed to connect and carries a message safe to show the user. */
export interface McpConnectionWarning {
    source: string;
    serverName: string;
    stage: "connection";
    message: string;
}

/** Returns the session’s MCP integration along with warnings from discovery. */
export interface McpIntegrationStartResult {
    integration: McpIntegration;
    warnings: McpConnectionWarning[];
}

/** Installs discovered tools in a root agent and lets the host detach that agent. */
export interface McpRootBinding {
    extensionFactory: ExtensionFactory;
    /** Stop sending definition updates to this Agent. The host still owns the connections. */
    dispose(): void;
}

/** Carries a status or error message from an MCP command for the host to display. */
export interface McpNotification {
    message: string;
    level: "info" | "warning" | "error";
}

/** Connections and tool discovery for one owning Session and its authorized root Agents. */
export interface McpIntegration {
    /** Snapshot of currently exposed Pi tools for callers such as external CLI bridges. */
    getTools(): ToolDefinition[];
    /** Register current and future definitions in an authorized root Agent's Pi pipeline. */
    bindRoot(toolNames?: readonly string[]): McpRootBinding | undefined;
    /** Run Pi's status or reconnect command without making a model request. */
    runCommand(args: string): Promise<McpNotification[]>;
    /** Wait for Pi to shut down the owned MCP connections and release the host. */
    close(): Promise<void>;
}

/** Build Pi's stdio transport with the minimal inherited environment. The caller owns its lifetime. */
export function createMcpStdioTransport(command: McpStdioCommand, cwd: string): McpTransport {
    return new StdioTransport({
        command: command.command,
        args: command.args,
        env: { ...getDefaultEnvironment(), ...command.env },
        inheritEnv: false,
        cwd,
        stderr: "pipe",
    });
}

/**
 * Session ownership and access boundary around Pi's built-in MCP extension.
 * The in-memory host never prompts a model. It lets Pi own connections and tool
 * updates across root Agent replacements, including external CLI Agents.
 */
class PiMcpIntegration implements McpIntegration {
    private session?: AgentSession;
    private readonly tools = new Map<string, ToolDefinition>();
    private readonly roots = new Set<WeakRef<ExtensionAPI>>();
    private closed = false;

    constructor(private readonly servers: readonly McpIntegrationServer[]) {}

    getTools(): ToolDefinition[] {
        return [...this.tools.values()].filter((tool) => tool.exposure !== "hidden");
    }

    bindRoot(toolNames: readonly string[] = []): McpRootBinding | undefined {
        if (!this.session) return;
        const allowedTools = new Set(toolNames);
        let root: WeakRef<ExtensionAPI> | undefined;
        const dispose = () => {
            if (root) this.roots.delete(root);
        };
        return {
            extensionFactory: (pi) => {
                for (const tool of this.tools.values()) pi.registerTool(tool);
                root = new WeakRef(pi);
                this.roots.add(root);
                pi.on("session_shutdown", dispose);
                // New MCP names must be permitted without granting late tools
                // from another extension authority beyond the Agent's policy.
                pi.on("before_agent_start", () => {
                    pi.setActiveTools([...allowedTools, ...this.getTools().map((tool) => tool.name)]);
                });
                pi.on("tool_call", (event) => {
                    if (
                        allowedTools.has(event.toolName) ||
                        this.getTools().some((tool) => tool.name === event.toolName)
                    )
                        return;
                    return { block: true, reason: `Tool ${event.toolName} is unavailable to this Agent.` };
                });
                const command = this.session?.extensionRunner?.getCommand("mcp");
                if (command) pi.registerCommand("mcp", command);
            },
            dispose,
        };
    }

    syncTools(): void {
        for (const { definition } of this.session?.extensionRunner?.getAllRegisteredTools() ?? []) {
            if (this.tools.get(definition.name) === definition) continue;
            this.tools.set(definition.name, definition);
            for (const root of this.roots) {
                const pi = root.deref();
                if (pi) pi.registerTool(definition);
                else this.roots.delete(root);
            }
        }
    }

    setSession(session: AgentSession): void {
        this.session = session;
    }

    async runCommand(args: string): Promise<McpNotification[]> {
        const runner = this.session?.extensionRunner;
        const command = runner?.getCommand("mcp");
        const locations: McpNotification[] = this.servers
            .filter((server) => server.location)
            .map((server) => ({
                message: `${server.name}: ${server.location}`,
                level: "info",
            }));
        if (!runner || !command) {
            return locations.length ? locations : [{ message: "No MCP servers configured.", level: "info" }];
        }
        const notifications: McpNotification[] = [...locations];
        const context = runner.createCommandContext();
        await command.handler(args, {
            ...context,
            ui: {
                ...context.ui,
                notify: (message, level = "info") => {
                    notifications.push({ message, level });
                },
            },
        });
        return notifications;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
            this.session?.dispose();
            this.roots.clear();
            this.tools.clear();
        }
    }
}

/** Start native MCP discovery using the host's admitted server list and an in-memory Pi session. */
export async function startMcpIntegration(options: McpIntegrationStartOptions): Promise<McpIntegrationStartResult> {
    const { createTransport } = options;
    const activeServers = options.servers.map((server) => ({
        ...server,
        args: [...server.args],
        env: { ...server.env },
    }));
    const integration = new PiMcpIntegration(activeServers);
    const warnings: McpConnectionWarning[] = [];
    if (activeServers.length === 0) return { integration, warnings };
    const config: LoadedMcpConfig = {
        servers: activeServers.map((server) => ({
            name: server.name,
            config: { command: server.command, args: server.args, env: server.env, exposure: "direct" },
            source: server.source,
            scope: "extension",
        })),
        autoEnableCodemode: false,
        errors: [],
    };
    const mcp = createMcpExtension({
        loadConfig: () => config,
        logPath: join(options.agentDir, "mcp.log"),
        createTransport: (entry, cwd) => {
            const transport = createTransport?.(entry.name);
            if (transport) return transport;
            if (!("command" in entry.config)) throw new Error("RunWield MCP configuration requires stdio.");
            const { command, args = [], env = {} } = entry.config;
            return createMcpStdioTransport({ command, args, env }, cwd);
        },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: options.agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
            (pi) =>
                mcp({
                    ...pi,
                    registerTool: (tool) => {
                        pi.registerTool(tool);
                        integration.syncTools();
                    },
                }),
        ],
    });
    try {
        await resourceLoader.reload();
        const { session } = await createAgentSession({
            cwd: options.cwd,
            agentDir: options.agentDir,
            modelRuntime: options.modelRuntime ?? (await getNativeModelRegistry().getRuntime()),
            settingsManager: options.settingsManager,
            sessionManager: SessionManager.inMemory(options.cwd),
            tools: [],
            resourceLoader,
        });
        integration.setSession(session);
        const runner = session.extensionRunner;
        if (!runner) throw new Error("Pi MCP extension did not load.");
        const uiContext = {
            ...runner.getUIContext(),
            notify: (message: string, type?: "info" | "warning" | "error") => {
                if (type !== "warning" && type !== "error") return;
                // Startup errors can include credentials or argv. Keep automatic
                // diagnostics redacted; Pi's manager provides explicit inspection.
                for (const server of activeServers) {
                    if (!message.includes(`${server.name}:`) && !message.startsWith("MCP failed to load:")) continue;
                    warnings.push({
                        source: server.source,
                        serverName: server.name,
                        stage: "connection",
                        message: "MCP server failed. Use /mcp to inspect the connection.",
                    });
                }
            },
        };
        await session.bindExtensions({ uiContext });
        // The official manager waits for discovery. Calling its status action
        // completes startup without a model turn or a second connection path.
        const command = runner.getCommand("mcp");
        if (!command) throw new Error("Pi MCP command did not load.");
        await command.handler("", runner.createCommandContext());
        return { integration, warnings };
    } catch (error) {
        await integration.close();
        throw error;
    }
}
