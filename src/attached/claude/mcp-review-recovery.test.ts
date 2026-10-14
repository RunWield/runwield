import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import {
    CLI_PATH,
    DENO_CONFIG_PATH,
    planWrittenInput,
    runOperation,
    submitReview,
    withProject,
} from "../../shared/attached/attached-test-fixture.ts";
import {
    type AttachedJsonObject,
    type AttachedOperationName,
    type AttachedOperationResult,
} from "../../shared/attached/operations.ts";
import { type HostedAttachedReview } from "../../shared/attached/review-host.ts";

import process from "node:process";

type McpReviewResult = AttachedOperationResult & { review?: HostedAttachedReview };

async function connect(root: string) {
    const bin = join(root, ".fixture-bin");
    await fsMkdir(bin, { recursive: true });
    for (const name of ["open", "xdg-open"]) {
        await fsWriteFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
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
        cwd: root,
        env: { ...{ ...process.env }, PATH: `${bin}:${process.env["PATH"]}` },
        stderr: "pipe",
    });
    const client = new Client({ name: "claude-code", version: "2.1.292" });
    await client.connect(transport);
    return client;
}

async function call(client: Client, name: AttachedOperationName, input: AttachedJsonObject): Promise<McpReviewResult> {
    const { evidence: _evidence, ...args } = input;
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(JSON.stringify(result.structuredContent));
}

test("fresh MCP status restores the same pending round and transport close stops its endpoint", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const first = await connect(root);
        let original = "";
        try {
            const tools = await first.listTools();
            assertEquals(
                tools.tools.map(({ name }) => name),
                [
                    "activate",
                    "triage_report",
                    "status",
                    "plan_written",
                    "start_execution",
                    "task_completed",
                    "start_validation",
                    "review_diff",
                    "review_complete",
                    "validation_decision",
                ],
            );
            assertEquals(tools.tools.find(({ name }) => name === "status")?.inputSchema.required, []);
            const status = await call(first, "status", {});
            assert(status.ok && status.review);
            assertEquals(status.workflow.review, workflow.review);
            assertEquals(status.review.round, 1);
            original = status.review.url;
            const again = await call(first, "status", { workflowId: workflow.workflowId });
            assertEquals(again.review?.url, original);
        } finally {
            await first.close();
        }
        await assertRejects(() => fetch(original));
        const restored = await connect(root);
        try {
            const status = await call(restored, "status", {});
            assert(status.ok && status.review);
            assertEquals(status.workflow.review, workflow.review);
            assert(status.review.url !== original);
            const url = new URL(status.review.url);
            const posted = await fetch(new URL(`/api/review/deny${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({ feedback: "Use a selector.", reviewRevision: 0 }),
            });
            assertEquals(posted.status, 200);
            await posted.text();
        } finally {
            await restored.close();
        }
        const retrieval = await connect(root);
        try {
            const status = await call(retrieval, "status", {});
            assert(status.ok && status.workflow.nextAction.kind === "plan");
            assertEquals(status.workflow.nextAction.feedback, "Use a selector.");
            assertEquals(status.workflow.review?.status, "applied");
            assertEquals(status.review, undefined);
            assertEquals(status.instructions?.role, "planner");
            const submitted = await call(
                retrieval,
                "plan_written",
                planWrittenInput({
                    workflowId: workflow.workflowId,
                    actionId: status.workflow.nextAction.actionId,
                    expectedRevision: status.workflow.revision,
                    operationId: "round-two",
                }),
            );
            assert(submitted.ok && submitted.review);
            assertEquals(submitted.review.round, 2);
        } finally {
            await retrieval.close();
        }
        const status = await runOperation("status", root, { workflowId: workflow.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.review?.round, 2);
        assertEquals(status.workflow.review?.status, "pending");
    });
});

for (const closeBeforeStatus of [false, true]) {
    test(
        closeBeforeStatus
            ? "stdin EOF during status cannot create a late browser daemon"
            : "stdin EOF stops MCP-hosted review without a process signal",
        async () => {
            await withProject(async (root) => {
                await submitReview(root);
                const setup = await connect(root);
                await setup.close();
                const bin = join(root, ".fixture-bin");
                const child = spawnNativeProcess(process.execPath, {
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
                    cwd: root,
                    env: { ...{ ...process.env }, PATH: `${bin}:${process.env["PATH"]}` },
                    stdin: "piped",
                    stdout: "piped",
                    stderr: "null",
                });
                const writer = child.stdin.getWriter();
                const reader = child.stdout.getReader();
                const messages = [
                    {
                        jsonrpc: "2.0",
                        id: 1,
                        method: "initialize",
                        params: {
                            protocolVersion: "2025-11-25",
                            capabilities: {},
                            clientInfo: { name: "claude-code", version: "2.1.293" },
                        },
                    },
                    { jsonrpc: "2.0", method: "notifications/initialized" },
                    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } },
                ];
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    for (const message of messages) {
                        await writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
                    }
                    let buffer = "";
                    let url = "";
                    if (closeBeforeStatus) await writer.close();
                    while (!closeBeforeStatus && !url) {
                        const chunk = await reader.read();
                        assert(!chunk.done);
                        buffer += new TextDecoder().decode(chunk.value);
                        let newline;
                        while ((newline = buffer.indexOf("\n")) !== -1) {
                            const response = JSON.parse(buffer.slice(0, newline));
                            buffer = buffer.slice(newline + 1);
                            if (response.id === 2) {
                                url = response.result.structuredContent.review.url;
                                break;
                            }
                        }
                    }
                    if (!closeBeforeStatus) await writer.close();
                    const status = await Promise.race([
                        child.status,
                        new Promise<never>((_resolve, reject) => {
                            timer = setTimeout(
                                () => reject(new Error("MCP kept its browser server alive after stdin EOF")),
                                10000,
                            );
                        }),
                    ]);
                    assertEquals(status.code, 0);
                    if (url) await assertRejects(() => fetch(url));
                } finally {
                    clearTimeout(timer);
                    await writer.close().catch(() => {});
                    await reader.cancel().catch(() => {});
                    try {
                        child.kill("SIGTERM");
                    } catch {
                        /* Already exited. */
                    }
                    await child.status;
                }
            });
        },
    );
}
