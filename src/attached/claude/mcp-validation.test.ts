import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { mkdir as fsMkdir, writeFile as fsWriteFile, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { attachedValidationFixture } from "../../shared/attached/validation-test-fixture.ts";
import {
    CLI_PATH,
    DENO_CONFIG_PATH,
    EVIDENCE,
    projectFixture,
    spawnAttachedCli,
    submitReview,
} from "../../shared/attached/attached-test-fixture.ts";
import { type AttachedJsonObject, type AttachedOperationResult } from "../../shared/attached/operations.ts";

import process from "node:process";

test("MCP status is compact by default and workers fetch complete current instructions", async () => {
    const fixture = await attachedValidationFixture();
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
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    const policy = "Exact home reviewer policy marker: preserve every instruction byte-for-byte.";
    try {
        const practice = join(getHomeDir(), ".wld/agents/shared-practice/review-practice.md");
        await fsMkdir(join(getHomeDir(), ".wld/agents/shared-practice"), { recursive: true });
        await fsWriteFile(practice, `---\nname: MCP reviewer policy\n---\n\n${policy}\n`);
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        assert(started.workflow.nextAction.request.kind === "reviewer");
        const requestPrompt = started.workflow.nextAction.request.prompt;
        await client.connect(transport);
        const plan = await submitReview(fixture.root);
        const planPoll = await client.callTool({
            name: "status",
            arguments: { workflowId: plan.workflowId },
        });
        const compactPlan: CompactStatus = JSON.parse(JSON.stringify(planPoll.structuredContent));
        assert(compactPlan.ok);
        assertEquals(compactPlan.workflow.nextAction.kind, "review");
        assertEquals(compactPlan.workflow.revision, plan.revision);
        assertEquals(Object.keys(JSON.parse(JSON.stringify(planPoll.structuredContent))).sort(), [
            "ok",
            "operation",
            "review",
            "workflow",
        ]);
        const planPollText = JSON.stringify(planPoll.structuredContent);
        const planNextAction = JSON.parse(planPollText).workflow.nextAction;
        assertEquals(Object.keys(planNextAction).sort(), ["actionId", "chatPending", "kind", "planName", "round"]);
        assert(
            planPollText.length < 5_000,
            `Compact Plan status returned ${planPollText.length} serialized characters`,
        );
        const fullPlanResponse = await client.callTool({ name: "status", arguments: { workflowId: plan.workflowId } });
        const fullPlan: AttachedOperationResult = JSON.parse(JSON.stringify(fullPlanResponse.structuredContent));
        assert(fullPlan.ok && fullPlan.workflow.nextAction.kind === "review");
        assertEquals(fullPlan.workflow.review?.status, "pending");

        const compactResponse = await client.callTool({
            name: "status",
            arguments: { workflowId: fixture.workflowId },
        });
        type CompactStatus = {
            ok: boolean;
            operation: string;
            workflow: {
                workflowId: string;
                revision: number;
                state: string;
                nextAction: { kind: string; actionId: string | null; round: number | null; chatPending: boolean };
                review: { round: number; status: string; outcome: string | null } | null;
            };
        };
        const compact: CompactStatus = JSON.parse(JSON.stringify(compactResponse.structuredContent));
        assert(compact.ok);
        assertEquals(compact.operation, "status");
        assertEquals(compact.workflow.workflowId, fixture.workflowId);
        assertEquals(compact.workflow.revision, started.workflow.revision);
        assertEquals(compact.workflow.nextAction.kind, "validation");
        assertEquals(compact.workflow.nextAction.chatPending, false);
        assertEquals(Object.keys(JSON.parse(JSON.stringify(compactResponse.structuredContent))).sort(), [
            "ok",
            "operation",
            "workflow",
        ]);
        assertEquals(Object.keys(compact.workflow).sort(), [
            "nextAction",
            "plan",
            "review",
            "revision",
            "state",
            "workflowId",
        ]);
        assertEquals(Object.keys(compact.workflow.nextAction).sort(), [
            "actionId",
            "chatPending",
            "instructionsAvailable",
            "kind",
            "request",
            "round",
        ]);
        const compactText = JSON.stringify(compactResponse.structuredContent);
        const contentText = JSON.stringify(compactResponse.content);
        assertStringIncludes(contentText, "workflowId");
        assertEquals(contentText.includes(policy), false);
        assert(compactText.length < 5_000, `Compact status returned ${compactText.length} serialized characters`);

        const instructionsResponse = await client.callTool({
            name: "get_instructions",
            arguments: { workflowId: fixture.workflowId, actionId: started.workflow.nextAction.actionId },
        });
        const instructions: { ok: boolean; workflowId: string; actionId: string; instructions: { text: string } } =
            JSON.parse(JSON.stringify(instructionsResponse.structuredContent));
        assert(instructions.ok);
        assertEquals(instructions.workflowId, fixture.workflowId);
        assertStringIncludes(instructions.instructions.text, policy);
        assertStringIncludes(instructions.instructions.text, requestPrompt);
        const artifactResponse = await client.callTool({
            name: "get_artifact",
            arguments: {
                workflowId: fixture.workflowId,
                actionId: started.workflow.nextAction.actionId,
                artifact: "prompt",
                maxBytes: 64,
            },
        });
        const artifact: { ok: boolean; content: string; truncated: boolean; nextOffsetBytes: number } = JSON.parse(
            JSON.stringify(artifactResponse.structuredContent),
        );
        assert(artifact.ok && artifact.truncated);
        assertEquals(artifact.content, requestPrompt.slice(0, 64));
        assertEquals(artifact.nextOffsetBytes, 64);
        const fullCli = await spawnAttachedCli("status", fixture.root, { workflowId: fixture.workflowId });
        assert(fullCli.result.ok && fullCli.result.instructions);
        assertEquals(instructions.instructions, fullCli.result.instructions);
        assertEquals(await fixture.ciCount(), 1);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fixture.close();
    }
});

test("MCP returns reviewer artifact references and pages the canonical diff", async () => {
    const fixture = await attachedValidationFixture();
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
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        const workflow = await fixture.status();
        const args = {
            operationId: "validation-parity",
            workflowId: workflow.workflowId,
            expectedRevision: workflow.revision,
            payload: {},
        };
        const cli = await spawnAttachedCli("start_validation", fixture.root, { ...args, evidence: EVIDENCE });
        const mcp = await client
            .connect(transport)
            .then(() => client.callTool({ name: "start_validation", arguments: args }));
        const received: AttachedOperationResult = JSON.parse(JSON.stringify(mcp.structuredContent));
        assert(received.ok && received.workflow.nextAction.kind === "validation");
        const action = received.workflow.nextAction;
        assert(action.request.kind === "reviewer");
        assert(cli.result.ok && cli.result.workflow.nextAction.kind === "validation");
        assertEquals(action.actionId, cli.result.workflow.nextAction.actionId);
        const handoffText = JSON.stringify(mcp.structuredContent);
        assertEquals(handoffText.includes("fullDiff"), false);
        assertEquals(handoffText.includes("repairDiff"), false);
        assertEquals("prompt" in action.request, false);
        assertStringIncludes(handoffText, "review_diff");
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
        assert(listCli.result.ok && listCli.result.diff);
        assertEquals(listCli.result.diff, listResult.diff);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fixture.close();
    }
});

test("MCP actions and status do not inline oversized review artifacts", async () => {
    const fixture = await attachedValidationFixture();
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
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    const oversizedPlanMarker = "oversized-plan-body-marker-".repeat(3000);
    try {
        const planPath = join(fixture.cwd, "docs/plans/p.md");
        const plan = await fsReadFile(planPath, "utf8");
        await fsWriteFile(planPath, `${plan}\n${oversizedPlanMarker}`);
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        const before = await fixture.status();
        await client.connect(transport);
        const started = await client.callTool({
            name: "start_validation",
            arguments: {
                operationId: "oversized-review-start",
                workflowId: fixture.workflowId,
                expectedRevision: before.revision,
                payload: {},
            },
        });
        const startPayload = JSON.stringify({ content: started.content, structuredContent: started.structuredContent });
        assertEquals(
            startPayload.includes(oversizedPlanMarker),
            false,
            "start_validation inlined the Plan/diff payload",
        );
        assert(startPayload.length < 12_000, `start_validation returned ${startPayload.length} serialized characters`);

        const startResult: AttachedOperationResult = JSON.parse(JSON.stringify(started.structuredContent));
        assert(startResult.ok && startResult.workflow.nextAction.kind === "validation");
        assert(startResult.workflow.nextAction.request.kind === "reviewer");
        const diffList = await client.callTool({
            name: "review_diff",
            arguments: {
                operationId: "oversized-diff-list",
                workflowId: fixture.workflowId,
                expectedRevision: startResult.workflow.revision,
                payload: { actionId: startResult.workflow.nextAction.actionId, command: "list" },
            },
        });
        const listed: AttachedOperationResult = JSON.parse(JSON.stringify(diffList.structuredContent));
        assert(listed.ok && listed.diff);
        const diffPage = await client.callTool({
            name: "review_diff",
            arguments: {
                operationId: "oversized-diff-page",
                workflowId: fixture.workflowId,
                expectedRevision: listed.workflow.revision,
                payload: {
                    actionId: startResult.workflow.nextAction.actionId,
                    command: "show",
                    path: "docs/plans/p.md",
                    maxBytes: 1024,
                },
            },
        });
        const paged: AttachedOperationResult = JSON.parse(JSON.stringify(diffPage.structuredContent));
        assert(paged.ok && paged.diff);
        assertEquals(paged.diff.details.truncated, true);
        assertEquals(paged.diff.details.nextOffsetBytes, 1024);

        const status = await client.callTool({ name: "status", arguments: { workflowId: fixture.workflowId } });
        const statusPayload = JSON.stringify({ content: status.content, structuredContent: status.structuredContent });
        assertEquals(
            statusPayload.includes(oversizedPlanMarker),
            false,
            "default status inlined the Plan/diff payload",
        );
        assert(statusPayload.length < 12_000, `status returned ${statusPayload.length} serialized characters`);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fixture.close();
    }
});

test("MCP status waits for a browser decision without polling full workflow content", async () => {
    const root = await projectFixture.checkout({ prefix: "runwield-mcp-review-wait-" });
    const workflow = await submitReview(root);
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
        env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        stderr: "pipe",
    });
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    try {
        await client.connect(transport);
        const initialResponse = await client.callTool({
            name: "status",
            arguments: { workflowId: workflow.workflowId },
        });
        const initial: {
            workflow: { revision: number; state: string };
            review: { url: string };
        } = JSON.parse(JSON.stringify(initialResponse.structuredContent));
        const timeoutResponse = await client.callTool({
            name: "status",
            arguments: { workflowId: workflow.workflowId, waitForRevision: initial.workflow.revision, timeoutMs: 20 },
        });
        const timedOut: { workflow: { revision: number } } = JSON.parse(
            JSON.stringify(timeoutResponse.structuredContent),
        );
        assertEquals(timedOut.workflow.revision, initial.workflow.revision);

        const startedAt = Date.now();
        const waiting = client.callTool({
            name: "status",
            arguments: {
                workflowId: workflow.workflowId,
                waitForRevision: initial.workflow.revision,
                timeoutMs: 10_000,
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const url = new URL(initial.review.url);
        const decision = await fetch(new URL(`/api/review/decision${url.search}`, url), {
            method: "POST",
            body: JSON.stringify({
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                reviewRevision: 0,
            }),
        });
        assertEquals(decision.status, 200);
        await decision.text();
        const completed = await waiting;
        const result: { workflow: { revision: number; state: string; nextAction: { kind: string } } } = JSON.parse(
            JSON.stringify(completed.structuredContent),
        );
        assert(result.workflow.revision > initial.workflow.revision);
        assertEquals(result.workflow.state, "plan_ready");
        assertEquals(result.workflow.nextAction.kind, "plan_ready");
        assert(Date.now() - startedAt < 5000, "Long-poll did not return soon after the browser decision.");
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fsRm(root, { recursive: true });
    }
});

test("Claude validation command requires fresh workers, direct MCP inspection, and no publication", async () => {
    const text = (await fsReadFile(new URL("./plugin/commands/validate.md", import.meta.url), "utf8")).replace(
        /\s+/g,
        " ",
    );
    for (const required of [
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
        "Do not map or reinterpret fields",
        "another fresh reviewer",
        "get_instructions",
        "get_pending_chat",
        "waitForRevision",
        "timeoutMs",
        "show the exact Core prompt",
        "before submitting any answer",
        "Do not guess",
        "chatPending",
    ]) {
        assertStringIncludes(text, required);
    }
    assertStringIncludes(text, "do not fabricate read receipts");
});

type PluginServerConfig = { timeout: number };
type PluginServersConfig = { runwield: PluginServerConfig };
type PluginMcpConfig = { mcpServers: PluginServersConfig };
test("the plugin backs up validation keep-alive with a long server timeout", async () => {
    const config: PluginMcpConfig = JSON.parse(
        await fsReadFile(new URL("./plugin/.mcp.json", import.meta.url), "utf8"),
    );
    assertEquals(config.mcpServers.runwield.timeout, 3_600_000);
});

for (const carrier of ["CLI", "MCP"] as const) {
    for (const operation of ["review_complete", "task_completed", "validation_decision"] as const) {
        test(`${carrier} executes ${operation} through Core instead of replaying a cached receipt`, async () => {
            const fixture = await attachedValidationFixture(
                operation === "validation_decision" ? { command: null } : {},
            );
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
            const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
            try {
                if (operation !== "task_completed") await fsWriteFile(join(fixture.cwd, "marker"), "pass");
                const started = await fixture.call("start_validation", await fixture.status());
                assert(started.ok && started.workflow.nextAction.kind === "validation");
                const action = started.workflow.nextAction;
                const payload: AttachedJsonObject =
                    operation === "review_complete"
                        ? { actionId: action.actionId, approved: true }
                        : operation === "task_completed"
                          ? { actionId: action.actionId, message: "- Added the marker to fix CI." }
                          : { actionId: action.actionId, answer: { outcome: "text", value: "sh verify.sh" } };
                if (operation === "task_completed") await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
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

test("compact recovery status preserves Core guidance and the next recovery action", async () => {
    const fixture = await attachedValidationFixture({ command: null });
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
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    try {
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        const canceled = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "canceled" },
        });
        assert(!canceled.ok && canceled.workflow?.nextAction.kind === "validation_recovery");
        const expected = canceled.workflow.nextAction;
        await client.connect(transport);
        const response = await client.callTool({ name: "status", arguments: { workflowId: fixture.workflowId } });
        const status: AttachedOperationResult = JSON.parse(JSON.stringify(response.structuredContent));
        assert(status.ok && status.workflow.nextAction.kind === "validation_recovery");
        assertEquals(status.workflow.nextAction.guidance, expected.guidance);
        assertEquals(status.workflow.nextAction.resultKind, expected.resultKind);
        assertEquals(status.workflow.nextAction.recovery, expected.recovery);
        assertEquals(await fixture.ciCount(), 0);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fixture.close();
    }
});
