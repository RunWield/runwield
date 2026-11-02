import { test } from "node:test";
import { ok as assert, deepStrictEqual as equal } from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import {
    CLI_PATH,
    activateInput,
    readRecordBytes,
    triageReportInput,
    runOperation,
    withProject,
} from "./attached-test-fixture.ts";
import { compactResult, compactStatus } from "./presentation.ts";
import type { AttachedCarrierResult } from "./coordinator.ts";
import type { AttachedWorkflowRecord } from "./record-store.ts";

interface TextBlock {
    type: string;
    text: string;
}

for (const host of ["claude-code", "codex"] as const) {
    for (const version of host === "codex"
        ? ["0.164.1", "0.165.0", "not-reported"]
        : ["2.99.0", "3.0.0", "not-reported"]) {
        test(`${host} ${version} MCP responses stay quiet while preserving assessment evidence`, async () => {
            await withProject(async (root) => {
                const transport = new StdioClientTransport({
                    command: process.execPath,
                    args: runtimeSourceArgs([
                        "run",
                        CLI_PATH,
                        "attached",
                        "mcp",
                        ...(host === "codex" ? ["codex"] : []),
                    ]),
                    cwd: root,
                    env: Object.fromEntries(
                        Object.entries(process.env).filter(
                            (entry): entry is [string, string] => entry[1] !== undefined,
                        ),
                    ),
                    stderr: "pipe",
                });
                const client = new Client({ name: host === "codex" ? "codex-mcp-client" : host, version });
                try {
                    await client.connect(transport);
                    async function call(name: string, args = {}, expectedOk = true) {
                        const called = await client.callTool({ name, arguments: args });
                        const result: AttachedCarrierResult = JSON.parse(JSON.stringify(called.structuredContent));
                        equal(result.ok, expectedOk, JSON.stringify(result));
                        assert(!("compatibility" in result));
                        const content: TextBlock[] = JSON.parse(JSON.stringify(called.content));
                        assert(content.length > 0);
                        for (const block of content) {
                            if (block.type === "text") equal(JSON.parse(block.text), result);
                        }
                        return result;
                    }
                    const empty = await call("status", { inspectOnly: true }, false);
                    equal(empty.workflow, undefined);
                    const active = await call("activate", activateInput());
                    assert(active.ok && active.workflow?.nextAction.kind === "triage");
                    const ids = {
                        workflowId: active.workflow.workflowId,
                        actionId: active.workflow.nextAction.actionId,
                    };
                    await call("get_instructions", ids);
                    await call("triage_report", triageReportInput(ids));
                    await call("status", { workflowId: ids.workflowId });
                    const record: AttachedWorkflowRecord = JSON.parse(await readRecordBytes(root, ids.workflowId));
                    equal(record.evidence.hostVersion, version);
                    equal(
                        record.evidence.compatibility?.status,
                        version === "not-reported"
                            ? "version_not_reported"
                            : ["0.165.0", "3.0.0"].includes(version)
                              ? "untested_newer"
                              : "compatible",
                    );
                    assert(
                        Object.values(record.acceptedOperations).every(
                            (entry) => entry.evidence.hostVersion === version,
                        ),
                    );
                } finally {
                    await client.close().catch(() => undefined);
                    await transport.close().catch(() => undefined);
                }
            });
        });
    }
}

test("saved legacy routine compatibility messages are omitted without rewriting the source result", async () => {
    await withProject(async (root) => {
        const active = await runOperation("activate", root, activateInput());
        assert(active.ok);
        for (const status of ["compatible", "untested_newer", "version_not_reported"] as const) {
            const legacy: AttachedCarrierResult = {
                ...active,
                compatibility: { status, matrixVersion: 1, message: "Legacy routine notice" },
            };
            for (const projected of [compactResult(legacy), compactStatus(legacy, null)]) {
                assert(!("compatibility" in projected));
                assert(!JSON.stringify(projected).includes("Legacy routine notice"));
            }
            equal(legacy.compatibility?.message, "Legacy routine notice");
        }
    });
});
