import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { rm as fsRm, mkdtemp as fsMkdtemp, mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import {
    activateInput,
    CLI_PATH,
    DENO_CONFIG_PATH,
    EVIDENCE,
    pendingTriage,
    planWrittenInput,
    projectFixture,
    readRecordBytes,
    spawnAttachedCli,
    triageReportInput,
} from "../../shared/attached/attached-test-fixture.ts";
import {
    type AttachedJsonObject,
    type AttachedJsonValue,
    type AttachedOperationName,
    type AttachedOperationResult,
} from "../../shared/attached/operations.ts";
import { type AttachedWorkflowRecord } from "../../shared/attached/record-store.ts";

import process from "node:process";

type Carrier = (operation: AttachedOperationName, input: AttachedJsonObject) => Promise<AttachedOperationResult>;

function schemaObject(value: AttachedJsonValue | undefined): AttachedJsonObject {
    assert(value !== null && typeof value === "object" && !Array.isArray(value));
    return value;
}

/** Assert the schema that a real MCP client receives, not a locally constructed descriptor. */
function assertReviewPayloadSchema(schema: AttachedJsonObject) {
    const payload = schemaObject(schemaObject(schema.properties).payload);
    const properties = schemaObject(payload.properties);
    const finding = schemaObject(schemaObject(properties.findings).items);
    assertEquals(finding.additionalProperties, false);
    assertEquals(finding.required, ["title"]);
    assertEquals(finding.properties, {
        id: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 4096 },
        requirement: { type: "string", minLength: 1, maxLength: 4096 },
        evidence: { type: "string", minLength: 1, maxLength: 4096 },
        status: { type: "string", enum: ["new", "fix_confirmed", "fix_rejected"] },
        resolved: { type: "boolean" },
        rejectionReason: { type: "string", minLength: 1, maxLength: 4096 },
        origin: { type: "string", enum: ["missed_original", "repair_regression"] },
    });
    const advisory = schemaObject(schemaObject(properties.advisories).items);
    assertEquals(advisory.additionalProperties, false);
    assertEquals(advisory.required, ["title"]);
    assertEquals(advisory.properties, {
        title: { type: "string", minLength: 1, maxLength: 4096 },
        detail: { type: "string", minLength: 1, maxLength: 4096 },
    });
    const note = schemaObject(schemaObject(properties.integrationNotes).items);
    assertEquals(note.additionalProperties, false);
    assertEquals(note.required, ["check"]);
    assertEquals(note.properties, {
        check: { type: "string", minLength: 1, maxLength: 4096 },
        where: { type: "string", minLength: 1, maxLength: 4096 },
    });
}

/** Each project generates its own workflow and action IDs; compare everything else. */
function withoutGeneratedIds(results: AttachedOperationResult[], workflowId: string) {
    const actionIds = results.flatMap((result) => {
        const action = result.workflow?.nextAction;
        return action && "actionId" in action ? [action.actionId] : [];
    });
    return results.map((result) => {
        let text = JSON.stringify(result).replaceAll(workflowId, "<workflowId>");
        for (const actionId of actionIds) text = text.replaceAll(actionId, "<actionId>");
        return JSON.parse(text);
    });
}

async function runJourney(carrier: Carrier) {
    const activated = await carrier("activate", activateInput());
    const ids = pendingTriage(activated);
    const steps = [
        activated,
        await carrier("status", { workflowId: ids.workflowId }),
        await carrier("triage_report", triageReportInput({ ...ids, expectedRevision: 2, operationId: "op-stale" })),
        await carrier("triage_report", triageReportInput(ids)),
        await carrier("triage_report", triageReportInput(ids)),
        await carrier("status", { workflowId: ids.workflowId }),
    ];
    return withoutGeneratedIds(steps, ids.workflowId);
}

test("the CLI and the MCP server return equal result objects for the same inputs", async () => {
    const cliProject = await projectFixture.checkout({ prefix: "runwield-attached-parity-cli-" });
    const mcpProject = await projectFixture.checkout({ prefix: "runwield-attached-parity-mcp-" });
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
        cwd: mcpProject,
        env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        stderr: "pipe",
    });
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        assertEquals(
            tools.tools.map((tool) => tool.name),
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
        for (const tool of tools.tools) {
            assertEquals(tool.inputSchema.required?.includes("evidence"), false);
            assertEquals(Object.hasOwn(tool.inputSchema.properties ?? {}, "evidence"), false);
        }

        const review = tools.tools.find((tool) => tool.name === "review_complete");
        assert(review);
        const reviewSchema: AttachedJsonObject = JSON.parse(JSON.stringify(review.inputSchema));
        assertReviewPayloadSchema(reviewSchema);
        const decision = tools.tools.find((tool) => tool.name === "validation_decision");
        assert(decision);
        const decisionSchema: AttachedJsonObject = JSON.parse(JSON.stringify(decision.inputSchema));
        const decisionPayload = schemaObject(schemaObject(decisionSchema.properties).payload);
        assertEquals(schemaObject(schemaObject(decisionPayload.properties).answer).additionalProperties, false);

        const viaCli = await runJourney(
            async (operation, input) => (await spawnAttachedCli(operation, cliProject, input)).result,
        );
        const viaMcp = await runJourney(async (operation, input) => {
            const { evidence: _evidence, ...withoutEvidence } = input;
            const called = await client.callTool({ name: operation, arguments: withoutEvidence });
            const result: AttachedOperationResult = JSON.parse(JSON.stringify(called.structuredContent));
            return result;
        });
        assertEquals(viaMcp, viaCli);
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        await fsRm(cliProject, { recursive: true }).catch(() => undefined);
        await fsRm(mcpProject, { recursive: true }).catch(() => undefined);
    }
});

test("MCP submits a Plan and records client and loaded plugin evidence without model-supplied versions", async () => {
    const projectRoot = await projectFixture.checkout({ prefix: "runwield-attached-mcp-plan-" });
    const pluginRoot = await fsMkdtemp(join(tmpdir(), "runwield-attached-plugin-"));
    await fsMkdir(join(pluginRoot, ".claude-plugin"));
    await fsWriteFile(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "9.8.7" }));
    const bin = join(pluginRoot, "bin");
    await fsMkdir(bin);
    for (const opener of ["open", "xdg-open"]) {
        await fsWriteFile(join(bin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
        cwd: projectRoot,
        env: {
            ...{ ...process.env },
            RUNWIELD_ATTACHED_PLUGIN_ROOT: pluginRoot,
            PATH: `${bin}:${process.env["PATH"]}`,
        },
        stderr: "pipe",
    });
    const client = new Client({ name: "claude-code", version: "2.1.292" });
    async function call(name: AttachedOperationName, input: AttachedJsonObject): Promise<AttachedOperationResult> {
        const { evidence: _evidence, ...argumentsWithoutEvidence } = input;
        const result = await client.callTool({ name, arguments: argumentsWithoutEvidence });
        return JSON.parse(JSON.stringify(result.structuredContent));
    }
    try {
        await client.connect(transport);
        const ids = pendingTriage(await call("activate", activateInput()));
        const triaged = await call("triage_report", triageReportInput(ids));
        assert(triaged.ok && triaged.workflow.nextAction.kind === "plan");
        await fsMkdir(join(projectRoot, "docs", "plans"), { recursive: true });
        await fsWriteFile(join(projectRoot, "docs", "plans", "dark-mode-toggle.md"), "# Toggle\n");
        const result = await call(
            "plan_written",
            planWrittenInput({
                workflowId: ids.workflowId,
                actionId: triaged.workflow.nextAction.actionId,
                expectedRevision: triaged.workflow.revision,
            }),
        );
        assert(result.ok);
        assertEquals(result.workflow.state, "awaiting_review");
        const record: AttachedWorkflowRecord = JSON.parse(await readRecordBytes(projectRoot, ids.workflowId));
        for (const accepted of Object.values(record.acceptedOperations)) {
            assertEquals(accepted.evidence.host, "claude-code");
            assertEquals(accepted.evidence.hostVersion, "2.1.292");
            assertEquals(accepted.evidence.adapterVersion, "9.8.7");
        }
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        await fsRm(pluginRoot, { recursive: true });
        await fsRm(projectRoot, { recursive: true });
    }
});
