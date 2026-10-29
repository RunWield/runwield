import { test } from "node:test";
import { ok as assert, strictEqual as equal } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import {
    CLI_PATH,
    activateInput,
    readRecordBytes,
    submitReview,
    withProject,
} from "../../shared/attached/attached-test-fixture.ts";
import type { AttachedCarrierResult } from "../../shared/attached/coordinator.ts";
import type { AttachedWorkflowRecord } from "../../shared/attached/record-store.ts";

function processEnvironment(): Record<string, string> {
    return Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
}

test("MCP inspection names a pending review without hosting it or changing the record", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const before = await readRecordBytes(root, workflow.workflowId);
        const bin = join(root, "browser-bin");
        await mkdir(bin);
        for (const name of ["open", "xdg-open"])
            await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: runtimeSourceArgs(["run", CLI_PATH, "attached", "mcp", "codex"]),
            cwd: root,
            env: { ...processEnvironment(), PATH: `${bin}:${process.env.PATH}` },
            stderr: "pipe",
        });
        const client = new Client({ name: "codex-mcp-client", version: "0.164.0-alpha.11.1" });
        try {
            await client.connect(transport);
            const called = await client.callTool({ name: "status", arguments: { inspectOnly: true } });
            const result: AttachedCarrierResult = JSON.parse(JSON.stringify(called.structuredContent));
            assert(result.ok && result.workflow);
            equal(result.workflow.plan?.planName, "dark-mode-toggle");
            equal(result.workflow.originHost, "claude-code");
            equal(result.workflow.nextAction.kind, "review");
            equal("review" in result, false);
            equal(await readRecordBytes(root, workflow.workflowId), before);
        } finally {
            await client.close().catch(() => undefined);
            await transport.close().catch(() => undefined);
        }
    });
});

for (const clientName of ["codex-mcp-client", "claude-code", "codex", "unrelated-client"]) {
    test(`the Codex carrier derives host identity from MCP initialization (${clientName})`, async () => {
        await withProject(async (root) => {
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: runtimeSourceArgs([
                    "run",
                    CLI_PATH,
                    "attached",
                    "mcp",
                    "codex",
                    "--adapter-version",
                    "9.7.5",
                    "--adapter-contract",
                    "1",
                ]),
                cwd: root,
                env: { ...processEnvironment(), RUNWIELD_ATTACHED_PLUGIN_ROOT: "/not-a-codex-plugin-root" },
                stderr: "pipe",
            });
            const client = new Client({ name: clientName, version: "0.164.0-alpha.11.1" });
            try {
                await client.connect(transport);
                // Deliberately include hostile model-supplied evidence; transport evidence must win.
                const called = await client.callTool({
                    name: "activate",
                    arguments: {
                        ...activateInput(),
                        evidence: {
                            host: "codex",
                            hostVersion: "99.0.0",
                            adapterVersion: "spoofed",
                            adapterContract: 99,
                        },
                    },
                });
                const result: AttachedCarrierResult = JSON.parse(JSON.stringify(called.structuredContent));
                if (clientName !== "codex-mcp-client") {
                    assert(!result.ok);
                    equal(result.rejection.code, "unsupported_host");
                    return;
                }
                assert(result.ok && result.workflow && result.instructions);
                equal(result.compatibility?.status, "untested_newer");
                assert(result.instructions.text.includes("RunWield in Codex"));
                const record: AttachedWorkflowRecord = JSON.parse(
                    await readRecordBytes(root, result.workflow.workflowId),
                );
                equal(record.evidence.host, "codex");
                equal(record.evidence.hostVersion, "0.164.0-alpha.11.1");
                equal(record.evidence.adapterVersion, "9.7.5");
                equal(record.evidence.adapterContract, 1);
                const status = await client.callTool({ name: "status", arguments: {} });
                const restored: AttachedCarrierResult = JSON.parse(JSON.stringify(status.structuredContent));
                assert(restored.ok && restored.workflow);
                equal(restored.workflow.workflowId, result.workflow.workflowId);
                equal(restored.instructions, undefined);
            } finally {
                await client.close().catch(() => undefined);
                await transport.close().catch(() => undefined);
            }
        });
    });
}

for (const adapterContract of [0, 2]) {
    test(`the Codex carrier rejects installed adapter contract ${adapterContract}`, async () => {
        await withProject(async (root) => {
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: runtimeSourceArgs([
                    "run",
                    CLI_PATH,
                    "attached",
                    "mcp",
                    "codex",
                    "--adapter-version",
                    "8.0.0",
                    "--adapter-contract",
                    String(adapterContract),
                ]),
                cwd: root,
                env: processEnvironment(),
                stderr: "pipe",
            });
            const client = new Client({ name: "codex-mcp-client", version: "0.164.0-alpha.11.1" });
            try {
                await client.connect(transport);
                const called = await client.callTool({ name: "activate", arguments: activateInput() });
                const result: AttachedCarrierResult = JSON.parse(JSON.stringify(called.structuredContent));
                assert(!result.ok);
                equal(result.rejection.code, "incompatible_adapter");
                assert(result.rejection.message.includes(adapterContract === 2 ? "Update RunWield Core" : "Codex"));
                const status = await client.callTool({ name: "status", arguments: {} });
                const restored: AttachedCarrierResult = JSON.parse(JSON.stringify(status.structuredContent));
                assert(!restored.ok);
                equal(restored.rejection.code, "workflow_not_found");
            } finally {
                await client.close().catch(() => undefined);
                await transport.close().catch(() => undefined);
            }
        });
    });
}
