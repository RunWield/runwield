import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types";
import { attachedValidationFixture } from "../../shared/attached/validation-test-fixture.ts";
import { CLI_PATH, DENO_CONFIG_PATH } from "../../shared/attached/attached-test-fixture.ts";
import { type AttachedOperationResult } from "../../shared/attached/operations.ts";

import process from "node:process";

test("slow real CI sends MCP progress every 30 seconds and stops after the result", async () => {
    const fixture = await attachedValidationFixture({ command: "sh -c 'sleep 65; exit 0'" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--quiet",
            "--no-check",
            "--config",
            DENO_CONFIG_PATH,
            CLI_PATH,
            "attached",
            "mcp",
        ]),
        cwd: fixture.root,
        env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        stderr: "pipe",
    });
    const client = new Client({ name: "claude-code", version: "progress-test" });
    const ticks: number[] = [];
    // Observe notifications even after the SDK removes the request's progress callback.
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
        assertEquals(notification.params.progressToken, "slow-validation-progress");
        ticks.push(Date.now());
    });
    try {
        await client.connect(transport);
        const workflow = await fixture.status();
        const started = Date.now();
        const response = await client.callTool(
            {
                name: "start_validation",
                _meta: { progressToken: "slow-validation-progress" },
                arguments: {
                    operationId: "slow-validation",
                    workflowId: workflow.workflowId,
                    expectedRevision: workflow.revision,
                    payload: {},
                },
            },
            undefined,
            { timeout: 90_000 },
        );
        const result: AttachedOperationResult = JSON.parse(JSON.stringify(response.structuredContent));
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        assertEquals(ticks.length, 2);
        assert(ticks[0] - started >= 29_000);
        assert(ticks[1] - ticks[0] >= 29_000);
        await new Promise((resolve) => setTimeout(resolve, 30_500));
        assertEquals(ticks.length, 2);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fixture.close();
    }
});
