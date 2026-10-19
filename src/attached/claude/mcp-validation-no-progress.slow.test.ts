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

test("slow CI without a progress token sends no progress notifications", async () => {
    const fixture = await attachedValidationFixture({ command: "sh -c 'sleep 35; exit 0'" });
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
    const client = new Client({ name: "claude-code", version: "no-progress-test" });
    let progress = 0;
    client.setNotificationHandler(ProgressNotificationSchema, () => {
        progress++;
    });
    try {
        await client.connect(transport);
        const workflow = await fixture.status();
        const response = await client.callTool(
            {
                name: "start_validation",
                arguments: {
                    operationId: "silent-validation",
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
        assertEquals(progress, 0);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fixture.close();
    }
});
