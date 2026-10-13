import {
    type AgentSession,
    createAgentSession,
    createMcpExtension,
    DefaultResourceLoader,
    type ExtensionAPI,
    type ExtensionFactory,
    type McpExtensionOptions,
    SessionManager,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio";
import { join } from "node:path";
import { getSettingsDir, getSettingsManager } from "../settings.js";
import { getModelRegistry } from "../models/model-registry.ts";
import type { McpServerDefinition, McpWarning } from "./config.ts";

interface McpIntegrationStartOptions {
    cwd: string;
    servers: McpServerDefinition[];
}

interface McpIntegrationStartResult {
    integration: McpIntegration;
    warnings: McpWarning[];
}

interface McpRootBinding {
    extensionFactory: ExtensionFactory;
    dispose(): void;
}

interface McpNotification {
    message: string;
    level: "info" | "warning" | "error";
}

type LoadedMcpConfig = ReturnType<NonNullable<McpExtensionOptions["loadConfig"]>>;

/**
 * Session ownership and access boundary around Pi's built-in MCP extension.
 * The in-memory host never prompts a model. It lets Pi own connections and tool
 * updates across root Agent replacements, including external CLI Agents.
 */
export class McpIntegration {
    private session?: AgentSession;
    private readonly tools = new Map<string, ToolDefinition>();
    private readonly roots = new Set<WeakRef<ExtensionAPI>>();
    private closed = false;

    getTools(): ToolDefinition[] {
        return [...this.tools.values()].filter((tool) => tool.exposure !== "hidden");
    }

    /** Register Pi's definitions in a root session's normal tool pipeline. */
    bindRoot(toolNames: string[] = []): McpRootBinding | undefined {
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
                        allowedTools.has(event.toolName) || this.getTools().some((tool) => tool.name === event.toolName)
                    ) return;
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

    /** Pi's status/reconnect command, usable without making a model request. */
    async runCommand(args: string): Promise<McpNotification[]> {
        const runner = this.session?.extensionRunner;
        const command = runner?.getCommand("mcp");
        if (!runner || !command) return [{ message: "No MCP servers configured.", level: "info" }];
        const notifications: McpNotification[] = [];
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

export async function startMcpIntegration(options: McpIntegrationStartOptions): Promise<McpIntegrationStartResult> {
    const integration = new McpIntegration();
    const warnings: McpWarning[] = [];
    if (options.servers.length === 0) return { integration, warnings };
    const config: LoadedMcpConfig = {
        servers: options.servers.map((server) => ({
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
        logPath: join(getSettingsDir("global"), "mcp.log"),
        createTransport: (entry, cwd) => {
            if (!("command" in entry.config)) throw new Error("RunWield MCP configuration requires stdio.");
            return new StdioTransport({
                command: entry.config.command,
                args: entry.config.args,
                env: { ...getDefaultEnvironment(), ...entry.config.env },
                inheritEnv: false,
                cwd,
                stderr: "pipe",
            });
        },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: getSettingsDir("global"),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [(pi) =>
            mcp({
                ...pi,
                registerTool: (tool) => {
                    pi.registerTool(tool);
                    integration.syncTools();
                },
            })],
    });
    try {
        await resourceLoader.reload();
        const { session } = await createAgentSession({
            cwd: options.cwd,
            agentDir: getSettingsDir("global"),
            modelRuntime: await getModelRegistry().getRuntime(),
            settingsManager: getSettingsManager(options.cwd),
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
                for (const server of options.servers) {
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
