/** Separate Core server and restricted host processes for the document MCP journey. */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ok as assert, strictEqual as equal } from "node:assert/strict";
import { inspectProjectIdentity } from "../project-identity.ts";
import { readPlanPackage } from "../plan-package-store.ts";
import { withPackageWorkflow } from "../workflow/package-workflow.ts";
import { runAttachedMcpServer } from "../../attached/mcp.ts";
import type { AttachedReadResult } from "./coordinator.ts";
import type { AttachedJsonObject } from "./operations.ts";

interface HostConfiguration {
    root: string;
    workflowId: string;
    actionId: string;
    planPath: string;
    recordPath: string;
    recordId: string;
    archivedId: string;
    foreignId: string;
    restrict: boolean;
}
interface RpcResponse {
    id: number;
    result: { structuredContent: AttachedReadResult; tools: { name: string }[] };
}
const config: HostConfiguration = JSON.parse(process.argv[3]);
if (process.argv[2] === "core") {
    const inspected = inspectProjectIdentity(config.root);
    assert(inspected.kind === "existing");
    const plan = await readPlanPackage(inspected.identity, { planId: "plan-one" });
    assert(plan.kind === "loaded");
    await withPackageWorkflow(
        config.root,
        { identity: inspected.identity, planId: "plan-one", expectedRevision: plan.metadata.revision },
        () => runAttachedMcpServer(config.root, "test", "codex", { version: "0.1.0", adapterContract: 1 }),
    );
} else {
    if (config.restrict) {
        for (const path of [config.planPath, config.recordPath]) {
            let denied = false;
            try {
                await readFile(path);
            } catch (error) {
                denied =
                    error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
            }
            assert(denied, `The host must be denied direct file access: ${path}`);
        }
    }
    const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    let sequence = 0;
    const rpc = async (method: string, params: AttachedJsonObject) => {
        const id = ++sequence;
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        while (true) {
            const line = await lines.next();
            assert(!line.done, "Core ended before replying");
            const response: RpcResponse = JSON.parse(line.value);
            if (response.id === id) return response.result;
        }
    };
    await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.164.0-alpha.11.1" },
    });
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await rpc("tools/list", {});
    for (const name of ["read_plan", "work_record_read", "work_record_search"])
        assert(listed.tools.some((tool) => tool.name === name));
    const call = async (name: string, extras: AttachedJsonObject = {}) =>
        (
            await rpc("tools/call", {
                name,
                arguments: { workflowId: config.workflowId, actionId: config.actionId, ...extras },
            })
        ).structuredContent;
    const plan = await call("read_plan");
    assert(plan.ok && "content" in plan, JSON.stringify(plan));
    assert(plan.content.includes("Canonical home Plan"));
    const search = await call("work_record_search", { query: "Canonical evidence", maxBytes: 31 });
    assert(search.ok && "documentRevision" in search, JSON.stringify(search));
    let searchText = search.content;
    let page = search;
    while (page.truncated) {
        const next = await call("work_record_search", {
            query: "Canonical evidence",
            maxBytes: 31,
            offsetBytes: page.nextOffsetBytes,
            documentRevision: search.documentRevision,
        });
        assert(next.ok && "documentRevision" in next, JSON.stringify(next));
        searchText += next.content;
        page = next;
    }
    const results: { records: { recordId: string }[]; staleRecordIds: string[] } = JSON.parse(searchText);
    equal(results.records.length, 1);
    equal(results.records[0].recordId, config.recordId);
    assert(results.staleRecordIds.includes(config.foreignId));
    const record = await call("work_record_read", { recordId: config.recordId });
    assert(record.ok && "content" in record);
    assert(record.content.includes("Canonical evidence"));
    for (const [name, extras] of [
        ["read_plan", { resource: "../plan.wld.json" }],
        ["read_plan", { actionId: "denied-action" }],
        ["work_record_read", { recordId: config.foreignId }],
        ["work_record_read", { recordId: config.archivedId }],
        ["work_record_search", { query: "Canonical evidence", actionId: "denied-action" }],
    ] as const) {
        const denied = await call(name, extras);
        assert(!denied.ok, JSON.stringify(denied));
        equal("content" in denied, false);
    }
    process.stderr.write(`DOCUMENT_HOST_OK ${config.restrict ? "filesystem-denied" : "tools-only"}\n`);
    process.exit(0);
}
