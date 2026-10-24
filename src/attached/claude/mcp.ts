import { readFile as fsReadFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types";
import { readAttachedAction, readStatus, runAttachedOperation } from "../../shared/attached/coordinator.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "../../shared/attached/review-host.ts";
import { ATTACHED_OPERATIONS } from "../../shared/attached/operations.ts";
import { actionId, compactResult, compactStatus } from "../../shared/attached/presentation.ts";
import process from "node:process";
import plugin from "./plugin/.claude-plugin/plugin.json" with { type: "json" };
import adapter from "./plugin/runwield-adapter.json" with { type: "json" };

/**
 * @module attached/claude/mcp
 * MCP stdio carrier for the Attached Workflow Coordinator, used by RunWield Connect for
 * Claude Code. One tool per coordinator operation; framing only, no workflow rules.
 */

const MAX_STATUS_WAIT_MS = 30_000;
const STATUS_POLL_INTERVAL_MS = 200;

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
    let contract = adapter;
    if (pluginRoot) {
        try {
            contract = JSON.parse(await fsReadFile(`${pluginRoot}/runwield-adapter.json`, "utf8"));
        } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            // Plugins published before the adapter descriptor use the pre-contract format.
            contract = { adapterContract: 0 };
        }
    }
    const adapterContract: number = contract.adapterContract;
    let closing = false;
    const server = new Server({ name: "runwield-attached", version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
            ...ATTACHED_OPERATIONS.map(({ name, description, inputSchema }) => ({
                name,
                description:
                    name === "status"
                        ? "Read compact workflow state by default. Use timeoutMs and waitForRevision to wait for a browser decision; the result returns when state changes or the wait expires. Fetch role instructions with get_instructions."
                        : description,
                inputSchema: {
                    ...inputSchema,
                    required: inputSchema.required.filter((field) => field !== "evidence"),
                    properties: {
                        ...Object.fromEntries(
                            Object.entries(inputSchema.properties).filter(([field]) => field !== "evidence"),
                        ),
                        ...(name === "status" && {
                            waitForRevision: { type: "integer", minimum: 0 },
                            timeoutMs: { type: "integer", minimum: 0, maximum: MAX_STATUS_WAIT_MS },
                        }),
                    },
                    type: "object" as const,
                },
            })),
            {
                name: "get_instructions",
                description:
                    "Fetch complete Core instructions or the exact decision prompt and options for the current action. The action ID must still be current. Call this from the worker that will perform the action, or from the coordinator before presenting a decision to the user.",
                inputSchema: {
                    type: "object" as const,
                    additionalProperties: false,
                    required: ["workflowId", "actionId"],
                    properties: {
                        workflowId: { type: "string", minLength: 1 },
                        actionId: { type: "string", minLength: 1 },
                    },
                },
            },
            {
                name: "get_artifact",
                description:
                    "Read a bounded UTF-8 page of the current action's prompt, execution report, or repair report. Continue with nextOffsetBytes until truncated is false. Use review_diff for diff inspection receipts.",
                inputSchema: {
                    type: "object" as const,
                    additionalProperties: false,
                    required: ["workflowId", "actionId", "artifact"],
                    properties: {
                        workflowId: { type: "string", minLength: 1 },
                        actionId: { type: "string", minLength: 1 },
                        artifact: { type: "string", enum: ["prompt", "execution_report", "repair_report"] },
                        offsetBytes: { type: "integer", minimum: 0 },
                        maxBytes: { type: "integer", minimum: 4, maximum: 65536 },
                    },
                },
            },
            {
                name: "get_pending_chat",
                description: "Fetch the oldest pending review chat turn after compact status reports chatPending.",
                inputSchema: {
                    type: "object" as const,
                    additionalProperties: false,
                    required: ["workflowId", "actionId"],
                    properties: {
                        workflowId: { type: "string", minLength: 1 },
                        actionId: { type: "string", minLength: 1 },
                    },
                },
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (["get_instructions", "get_pending_chat", "get_artifact"].includes(request.params.name)) {
            const input = request.params.arguments ?? {};
            if (typeof input.workflowId !== "string" || typeof input.actionId !== "string") {
                throw new McpError(ErrorCode.InvalidParams, `${request.params.name} requires workflowId and actionId.`);
            }
            const artifact = input.artifact;
            if (
                request.params.name === "get_artifact" &&
                artifact !== "prompt" &&
                artifact !== "execution_report" &&
                artifact !== "repair_report"
            ) {
                throw new McpError(ErrorCode.InvalidParams, "Use prompt, execution_report, or repair_report.");
            }
            for (const key of ["offsetBytes", "maxBytes"]) {
                if (input[key] !== undefined && typeof input[key] !== "number") {
                    throw new McpError(ErrorCode.InvalidParams, `${key} must be an integer.`);
                }
            }
            const result = await readAttachedAction({
                projectRoot,
                workflowId: input.workflowId,
                actionId: input.actionId,
                content:
                    request.params.name === "get_artifact" &&
                    (artifact === "prompt" || artifact === "execution_report" || artifact === "repair_report")
                        ? artifact
                        : request.params.name === "get_instructions"
                          ? "instructions"
                          : "chat",
                offsetBytes: typeof input.offsetBytes === "number" ? input.offsetBytes : undefined,
                maxBytes: typeof input.maxBytes === "number" ? input.maxBytes : undefined,
            });
            return {
                content: [{ type: "text" as const, text: JSON.stringify(result) }],
                structuredContent: result,
                isError: !result.ok,
            };
        }
        const operation = ATTACHED_OPERATIONS.find((entry) => entry.name === request.params.name);
        if (!operation) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        const client = server.getClientVersion();
        const requestArguments = request.params.arguments ?? {};
        const waitForRevision = operation.name === "status" ? requestArguments.waitForRevision : undefined;
        const timeoutMs = operation.name === "status" ? requestArguments.timeoutMs : undefined;
        if (
            (waitForRevision !== undefined &&
                (typeof waitForRevision !== "number" ||
                    !Number.isSafeInteger(waitForRevision) ||
                    waitForRevision < 0)) ||
            (timeoutMs !== undefined &&
                (typeof timeoutMs !== "number" ||
                    !Number.isSafeInteger(timeoutMs) ||
                    timeoutMs < 0 ||
                    timeoutMs > MAX_STATUS_WAIT_MS))
        ) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Use waitForRevision >= 0 and timeoutMs between 0 and ${MAX_STATUS_WAIT_MS}.`,
            );
        }
        if (typeof timeoutMs === "number" && timeoutMs > 0 && typeof waitForRevision !== "number") {
            throw new McpError(ErrorCode.InvalidParams, "timeoutMs requires waitForRevision.");
        }
        const statusArguments =
            operation.name === "status"
                ? Object.fromEntries(
                      Object.entries(requestArguments).filter(
                          ([key]) => !["summaryOnly", "waitForRevision", "timeoutMs"].includes(key),
                      ),
                  )
                : requestArguments;
        const argumentsWithEvidence =
            operation.name === "status"
                ? statusArguments
                : {
                      ...request.params.arguments,
                      evidence: {
                          host: client?.name ?? "claude-code",
                          hostVersion: client?.version ?? "not-reported",
                          adapterVersion,
                          adapterContract,
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
        if (
            operation.name === "status" &&
            typeof timeoutMs === "number" &&
            timeoutMs > 0 &&
            typeof waitForRevision === "number" &&
            coordinated.workflow &&
            coordinated.workflow.revision === waitForRevision &&
            ["review", "code_review"].includes(coordinated.workflow.nextAction.kind)
        ) {
            const workflowId = coordinated.workflow.workflowId;
            const expectedActionId = actionId(coordinated.workflow.nextAction, coordinated.workflow);
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(STATUS_POLL_INTERVAL_MS, deadline - Date.now())),
                );
                const latest = await readStatus({
                    projectRoot,
                    workflowId,
                });
                const latestActionId = latest.workflow ? actionId(latest.workflow.nextAction, latest.workflow) : null;
                coordinated = latest;
                if (
                    !latest.workflow ||
                    latest.workflow.revision !== waitForRevision ||
                    latestActionId !== expectedActionId
                ) {
                    break;
                }
            }
        }
        const canHost = !closing;
        const review =
            canHost && coordinated.workflow
                ? await ensureReviewHosted(
                      projectRoot,
                      coordinated.workflow,
                      undefined,
                      coordinated.ok ? coordinated.reviewReply : undefined,
                  )
                : null;
        const refreshed =
            canHost && coordinated.workflow?.review?.status === "pending"
                ? await readStatus({ projectRoot, workflowId: coordinated.workflow.workflowId })
                : null;
        const current = {
            ...coordinated,
            ...(refreshed?.workflow && { workflow: refreshed.workflow }),
            ...(review && { review }),
        };
        const result = operation.name === "status" ? compactStatus(current, review) : compactResult(current);
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
