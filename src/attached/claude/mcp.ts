import { readFile as fsReadFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types";
import { runAttachedOperation } from "../../shared/attached/coordinator.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "../../shared/attached/review-host.ts";
import { ATTACHED_OPERATIONS } from "../../shared/attached/operations.ts";

/**
 * @module attached/claude/mcp
 * MCP stdio carrier for the Attached Workflow Coordinator, used by RunWield Connect for
 * Claude Code. One tool per coordinator operation; framing only, no workflow rules.
 */

import process from "node:process";

import plugin from "./plugin/.claude-plugin/plugin.json" with { type: "json" };

/** Serve coordinator operations over stdio until the host closes the stream. */
export async function runAttachedMcpServer(projectRoot: string, version: string): Promise<void> {
    const pluginRoot = process.env["RUNWIELD_ATTACHED_PLUGIN_ROOT"];
    const manifest = pluginRoot
        ? JSON.parse(await fsReadFile(`${pluginRoot}/.claude-plugin/plugin.json`, "utf8"))
        : plugin;
    if (typeof manifest.version !== "string" || !manifest.version.trim()) {
        throw new Error("RunWield plugin manifest must provide a version.");
    }
    const adapterVersion: string = manifest.version;
    let closing = false;
    const server = new Server({ name: "runwield-attached", version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: ATTACHED_OPERATIONS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema: {
                ...inputSchema,
                required: inputSchema.required.filter((field) => field !== "evidence"),
                properties: Object.fromEntries(
                    Object.entries(inputSchema.properties).filter(([field]) => field !== "evidence"),
                ),
                type: "object" as const,
            },
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const operation = ATTACHED_OPERATIONS.find((entry) => entry.name === request.params.name);
        if (!operation) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        const client = server.getClientVersion();
        const argumentsWithEvidence =
            operation.name === "status"
                ? (request.params.arguments ?? {})
                : {
                      ...request.params.arguments,
                      evidence: {
                          host: client?.name ?? "claude-code",
                          hostVersion: client?.version ?? "not-reported",
                          adapterVersion,
                      },
                  };
        const inputText = JSON.stringify(argumentsWithEvidence);
        const progressToken = request.params._meta?.progressToken;
        let progress = 0;
        const timer = setInterval(() => {
            if (closing) return;
            const message =
                "RunWield Core validation is still running. Waiting for the current check; no host action is needed.";
            const notification =
                progressToken !== undefined
                    ? server.notification({
                          method: "notifications/progress",
                          params: { progressToken, progress: ++progress, message },
                      })
                    : server.sendLoggingMessage({ level: "info", logger: "runwield", data: message });
            void notification.catch(() => {});
        }, 30_000);
        let coordinated;
        try {
            coordinated = await runAttachedOperation(operation.name, projectRoot, inputText);
        } finally {
            clearInterval(timer);
        }
        const canHost = !closing && (operation.name === "plan_written" || operation.name === "status");
        const review =
            canHost && coordinated.workflow ? await ensureReviewHosted(projectRoot, coordinated.workflow) : null;
        const refreshed =
            canHost && coordinated.workflow?.review?.status === "pending"
                ? await runAttachedOperation(
                      "status",
                      projectRoot,
                      JSON.stringify({ workflowId: coordinated.workflow.workflowId }),
                  )
                : null;
        const result = {
            ...coordinated,
            ...(refreshed?.workflow && { workflow: refreshed.workflow }),
            ...(refreshed?.instructions && { instructions: refreshed.instructions }),
            ...(review && { review }),
        };
        return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
            isError: !result.ok,
        };
    });

    const transport = new StdioServerTransport();
    const closed = new Promise<void>((resolve) => {
        transport.onclose = () => {
            closing = true;
            resolve();
        };
    });
    // The SDK transport handles data/error, but does not close itself on stdin EOF.
    const closeOnEnd = () => void transport.close();
    process.stdin.once("end", closeOnEnd);
    try {
        await server.connect(transport);
        await closed;
    } finally {
        process.stdin.off("end", closeOnEnd);
        await stopHostedAttachedReviews();
    }
}
