import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { attachedValidationFixture } from "../../shared/attached/validation-test-fixture.ts";
import { CLI_PATH, DENO_CONFIG_PATH, EVIDENCE, spawnAttachedCli } from "../../shared/attached/attached-test-fixture.ts";
import type { AttachedJsonObject, AttachedOperationResult } from "../../shared/attached/operations.ts";

Deno.test("CLI and MCP return the same durable validation handoff and direct diff receipt", async () => {
    const fixture = await attachedValidationFixture();
    const transport = new StdioClientTransport({
        command: Deno.execPath(),
        args: ["run", "-A", "--quiet", "--no-check", "--config", DENO_CONFIG_PATH, CLI_PATH, "attached", "mcp"],
        cwd: fixture.root,
        env: Deno.env.toObject(),
        stderr: "pipe",
    });
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    try {
        await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
        const workflow = await fixture.status();
        const args = {
            operationId: "validation-parity",
            workflowId: workflow.workflowId,
            expectedRevision: workflow.revision,
            payload: {},
        };
        const cli = await spawnAttachedCli("start_validation", fixture.root, { ...args, evidence: EVIDENCE });
        const mcp = await client.connect(transport).then(() =>
            client.callTool({ name: "start_validation", arguments: args })
        );
        const received: AttachedOperationResult = JSON.parse(JSON.stringify(mcp.structuredContent));
        assertEquals(received, cli.result);
        assert(received.ok && received.workflow.nextAction.kind === "validation");
        const action = received.workflow.nextAction;
        assert(action.request.kind === "reviewer");
        const listed = await client.callTool({
            name: "review_diff",
            arguments: {
                ...args,
                operationId: "diff-list-parity",
                expectedRevision: received.workflow.revision,
                payload: { actionId: action.actionId, command: "list" },
            },
        });
        const listResult: AttachedOperationResult = JSON.parse(JSON.stringify(listed.structuredContent));
        assert(listResult.ok && listResult.diff);
        assertEquals(listResult.diff.coverage, undefined);
        const listCli = await spawnAttachedCli("review_diff", fixture.root, {
            ...args,
            evidence: EVIDENCE,
            operationId: "diff-list-parity",
            expectedRevision: received.workflow.revision,
            payload: { actionId: action.actionId, command: "list" },
        });
        assertEquals(listCli.result, listResult);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fixture.close();
    }
});

Deno.test("Claude validation command requires fresh workers, direct MCP inspection, and no publication", async () => {
    const text = (await Deno.readTextFile(new URL("./plugin/commands/validate.md", import.meta.url))).replace(
        /\s+/g,
        " ",
    );
    for (
        const required of [
            "fresh",
            "review_diff",
            "review_complete",
            "task_completed",
            "validation_decision",
            "MCP_TOOL_TIMEOUT=600000",
            "code_review",
            "recorder",
            "work_record_completed",
            "delivered",
            "Do not claim Verified",
            "tool's payload schema verbatim",
            "Do not invent a schema or field names",
            "do not map or reinterpret its fields yourself",
            "another fresh reviewer",
        ]
    ) {
        assertStringIncludes(text, required);
    }
    assertStringIncludes(text, "do not fabricate read receipts");
});

type PluginServerConfig = { timeout: number };
type PluginServersConfig = { runwield: PluginServerConfig };
type PluginMcpConfig = { mcpServers: PluginServersConfig };
Deno.test("the plugin backs up validation keep-alive with a long server timeout", async () => {
    const config: PluginMcpConfig = JSON.parse(await Deno.readTextFile(new URL("./plugin/.mcp.json", import.meta.url)));
    assertEquals(config.mcpServers.runwield.timeout, 3_600_000);
});

for (const carrier of ["CLI", "MCP"] as const) {
    for (const operation of ["review_complete", "task_completed", "validation_decision"] as const) {
        Deno.test(`${carrier} executes ${operation} through Core instead of replaying a cached receipt`, async () => {
            const fixture = await attachedValidationFixture(
                operation === "validation_decision" ? { command: null } : {},
            );
            const transport = new StdioClientTransport({
                command: Deno.execPath(),
                args: ["run", "-A", "--quiet", "--no-check", "--config", DENO_CONFIG_PATH, CLI_PATH, "attached", "mcp"],
                cwd: fixture.root,
                env: Deno.env.toObject(),
                stderr: "pipe",
            });
            const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
            try {
                if (operation !== "task_completed") await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
                const started = await fixture.call("start_validation", await fixture.status());
                assert(started.ok && started.workflow.nextAction.kind === "validation");
                const action = started.workflow.nextAction;
                const payload: AttachedJsonObject = operation === "review_complete"
                    ? { actionId: action.actionId, approved: true }
                    : operation === "task_completed"
                    ? { actionId: action.actionId, message: "- Added the marker to fix CI." }
                    : { actionId: action.actionId, answer: { outcome: "text", value: "sh verify.sh" } };
                if (operation === "task_completed") await Deno.writeTextFile(join(fixture.cwd, "marker"), "fixed");
                const args = {
                    operationId: `execute-${carrier}-${operation}`,
                    workflowId: fixture.workflowId,
                    expectedRevision: started.workflow.revision,
                    payload,
                };
                let result: AttachedOperationResult;
                if (carrier === "CLI") {
                    result = (await spawnAttachedCli(operation, fixture.root, { ...args, evidence: EVIDENCE })).result;
                } else {
                    await client.connect(transport);
                    const response = await client.callTool({ name: operation, arguments: args });
                    result = JSON.parse(JSON.stringify(response.structuredContent));
                }
                assert(result.ok && result.workflow.nextAction.kind === "validation", JSON.stringify(result));
                assertEquals(result.operation, operation);
                assertEquals(result.workflow.nextAction.request.kind, "reviewer");
                assert(result.workflow.revision > started.workflow.revision);
                if (operation === "review_complete") {
                    const request = result.workflow.nextAction.request;
                    assert(request.kind === "reviewer");
                    assertEquals(request.identity.correctionCount, 1);
                }
                assertEquals(await fixture.ciCount(), operation === "task_completed" ? 2 : 1);
            } finally {
                await client.close().catch(() => {});
                await transport.close().catch(() => {});
                await fixture.close();
            }
        });
    }
}
