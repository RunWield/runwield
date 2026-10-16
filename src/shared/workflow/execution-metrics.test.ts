import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { recordWorkflowMetric } from "./metrics.js";
import { setCustomSetting } from "../settings.js";
import { SlashCommandMetricsTracker } from "./command-metrics.ts";
import {
    classifyMemoryOperation,
    estimateToolSchemaTokens,
    ExecutionMetricsRecorder,
    extractCodeBatchOperations,
    normalizeBashCommand,
    SessionContextMetricsRecorder,
} from "./execution-metrics.ts";

test("normalizeBashCommand normalizes simple and subcommand structures", () => {
    assertEquals(normalizeBashCommand("git status"), ["git status"]);
    assertEquals(normalizeBashCommand("git commit -m 'Initial commit'"), ["git commit"]);
    assertEquals(normalizeBashCommand("git diff HEAD~1"), ["git diff"]);
    assertEquals(normalizeBashCommand("git checkout -b feature/test"), ["git checkout"]);
    assertEquals(normalizeBashCommand("deno task test --filter abc"), ["deno task test"]);
    assertEquals(normalizeBashCommand("deno test -A --filter foo"), ["deno test"]);
    assertEquals(normalizeBashCommand("npm run build --prod"), ["npm run build"]);
    assertEquals(normalizeBashCommand("npm test"), ["npm test"]);
    assertEquals(normalizeBashCommand("cargo test --release"), ["cargo test"]);
    assertEquals(normalizeBashCommand("cargo build"), ["cargo build"]);
    assertEquals(normalizeBashCommand("pnpm run lint"), ["pnpm run lint"]);
    assertEquals(normalizeBashCommand("yarn build"), ["yarn build"]);
    assertEquals(normalizeBashCommand("ls -la /tmp"), ["ls"]);
    assertEquals(normalizeBashCommand("cat package.json"), ["cat"]);
});

test("normalizeBashCommand handles pipelines, logical chains, and redirects", () => {
    assertEquals(
        normalizeBashCommand("git status | grep modified"),
        ["git status", "grep"],
    );
    assertEquals(
        normalizeBashCommand("mkdir -p build && cd build && cmake .. || echo failed"),
        ["mkdir", "cd", "cmake", "echo"],
    );
    assertEquals(
        normalizeBashCommand("cat input.txt > output.txt 2>&1 ; rm -f input.txt"),
        ["cat", "rm"],
    );
});

test("normalizeBashCommand classifies command substitution and unbalanced quotes as unknown", () => {
    assertEquals(normalizeBashCommand("echo $(whoami)"), ["unknown"]);
    assertEquals(normalizeBashCommand("env sh -c 'git status'"), ["unknown"]);
    assertEquals(normalizeBashCommand("cat `pwd`/file"), ["unknown"]);
    assertEquals(normalizeBashCommand("echo 'unterminated quote"), ["unknown"]);
    assertEquals(normalizeBashCommand('echo "unterminated double quote'), ["unknown"]);
    assertEquals(normalizeBashCommand(""), ["unknown"]);
    assertEquals(normalizeBashCommand("   "), ["unknown"]);
});

test("classifyMemoryOperation identifies action and scope", () => {
    assertEquals(
        classifyMemoryOperation("memory", { action: "recall", query: "auth secret" }),
        { action: "recall", scope: "unified" },
    );
    assertEquals(
        classifyMemoryOperation("memory", { action: "store", content: "config key", scope: "global" }),
        { action: "store", scope: "global" },
    );
    assertEquals(
        classifyMemoryOperation("memory", { action: "delete", id: "mem-123" }),
        { action: "delete", scope: "project" },
    );
    assertEquals(
        classifyMemoryOperation({ CommandLine: "mnemoteca search -g some text" }),
        { action: "recall", scope: "global" },
    );
    assertEquals(
        classifyMemoryOperation({ CommandLine: "mnemoteca add 'remember this'" }),
        { action: "store", scope: "project" },
    );
    assertEquals(
        classifyMemoryOperation({ CommandLine: "mnemoteca delete abc-1" }),
        { action: "delete", scope: "project" },
    );
});

test("extractCodeBatchOperations parses show and outline child operations", () => {
    const rawArgs = {
        operations: [
            { op: "show", target: "MyClass" },
            { op: "outline", file: "src/utils.ts" },
        ],
    };
    const rawResult = {
        content: [{ type: "text", text: "batch result" }],
        details: {
            results: [
                { status: "success", truncated: false },
                { status: "error", error: "file not found" },
            ],
        },
    };
    const ops = extractCodeBatchOperations(rawArgs, rawResult);
    assertEquals(ops.length, 2);
    assertEquals(ops[0], {
        batchKind: "show",
        status: "success",
        truncated: false,
    });
    assertEquals(ops[1], {
        batchKind: "outline",
        status: "error",
        truncated: null,
    });
});

test("interrupted code_batch preserves known child results and marks unobserved children unavailable", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "batch-session",
            executionId: "batch-execution",
            agentName: "engineer",
            provider: "anthropic",
            model: "claude-sonnet",
            backend: "pi",
            sourceSurface: "tui",
            executionKind: "root",
            mode: "foreground",
        });
        const args = {
            operations: [{ op: "show", target: "Example" }, { op: "outline", file: "example.ts" }, {
                op: "show",
                target: "Example",
            }],
        };
        await recorder.recordToolStart("batch-interrupted", "code_batch", args);
        await recorder.recordToolFinish("batch-interrupted", "code_batch", {
            outcome: "canceled",
            result: { details: { results: [{ status: "success" }] } },
        });
        await recorder.settleExecution("canceled");
        const rows = await readMetrics();
        assertEquals(
            rows.filter((row) => row.event === "tool_operation")
                .map((row) => [row.parentCallId, row.operationIndex, row.batchKind, row.status]),
            [
                ["batch-interrupted", 0, "show", "success"],
                ["batch-interrupted", 1, "outline", "unavailable"],
                ["batch-interrupted", 2, "show", "unavailable"],
            ],
        );
        assertEquals(rows.find((row) => row.event === "tool_call_finished")?.outcome, "canceled");
    });
});

test("estimateToolSchemaTokens calculates non-zero schema and resident tokens", () => {
    const tool = {
        name: "test_tool",
        description: "A test tool for demonstration purposes",
        parameters: {
            type: "object",
            properties: {
                arg1: { type: "string", description: "First argument description" },
                arg2: { type: "number", description: "Second argument description" },
            },
            required: ["arg1"],
        },
    };
    const estimates = estimateToolSchemaTokens(tool);
    assert(estimates.schemaTokens > 0, "schemaTokens must be greater than zero");
    assert(estimates.residentTokens >= estimates.schemaTokens, "residentTokens must be >= schemaTokens");
});

test("ExecutionMetricsRecorder writes exposure, tool start/finish, usage, snapshots, and settlement", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "test-session-123",
            executionId: "exec-abc",
            agentName: "engineer",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            backend: "claude-cli",
            sourceSurface: "workspace",
            executionKind: "root",
            mode: "foreground",
        });

        // 1. Record Tool Exposure (verify summary and individual tool records)
        const mockTools = [
            { name: "read", description: "Read file contents" },
            { name: "write", description: "Write file contents" },
            { name: "bash", description: "Execute bash commands" },
        ];
        await recorder.recordToolExposure(mockTools);

        // 2. Latency Points
        await recorder.recordResponseLatency("turn_start");
        await recorder.recordResponseLatency("first_text");

        // 3. Tool Call Start and Finish
        const callId = "call-1";
        await recorder.recordToolStart(callId, "bash", { command: "git status | grep M" });
        await recorder.recordToolFinish(callId, "bash", {
            result: "M modified.ts",
            isError: false,
        });

        // 4. Model Usage
        await recorder.recordModelUsage({
            sourceId: "usage-entry-1",
            inputTokens: 1200,
            outputTokens: 450,
            cacheReadTokens: 300,
            cacheWriteTokens: 100,
            costAmount: 0.0125,
            costCurrency: "USD",
            model: "claude-3-7-sonnet",
            usageKind: "turn",
            measurementAvailability: "complete",
        });

        // 5. Context Snapshot
        await recorder.recordContextSnapshot({
            capacity: 200000,
            currentUsage: 25000,
            samplingPoint: "turn_end",
            usageState: "normal",
        });

        // 6. Record turn finish latency
        await recorder.recordResponseLatency("turn_finish");

        // 7. Settle execution
        await recorder.settleExecution("succeeded");

        const records = await readMetrics();
        assert(records.length >= 7, `Expected at least 7 records, got ${records.length}`);

        // Verify sequence ordering and eventId
        let previousSeq = -1;
        for (const record of records) {
            assertEquals(record.v, 2);
            assert(["execution", "tool_usage", "model_usage", "context"].includes(record.category as string));
            assert(typeof record.eventId === "string" && (record.eventId as string).length > 0);
            assert(typeof record.seq === "number");
            assert((record.seq as number) > previousSeq, `Sequences must be monotonic: ${record.seq} > ${previousSeq}`);
            previousSeq = record.seq as number;
        }

        // Verify tool exposure summary
        const summary = records.find((r) => r.event === "tool_exposure_summary");
        assert(summary, "tool_exposure_summary must exist");
        assertEquals(summary.toolCount, 3);

        // Verify individual tool exposure
        const exposureBash = records.find((r) => r.event === "tool_exposure" && r.toolName === "bash");
        assert(exposureBash, "tool_exposure for bash must exist");
        assertEquals(exposureBash.schemaTokens, 0);

        // Verify tool start & operations
        const startRecord = records.find((r) => r.event === "tool_call_started");
        assert(startRecord, "tool_call_started must exist");
        assertEquals(startRecord.callId, callId);
        assertEquals(startRecord.toolName, "bash");

        const opRecord = records.find((r) => r.event === "tool_operation");
        assert(opRecord, "tool_operation must exist for bash pipeline");
        assertEquals(opRecord.parentCallId, callId);
        assertEquals(opRecord.commandLabel, "git status");

        // Verify tool finish
        const finishRecord = records.find((r) => r.event === "tool_call_finished");
        assert(finishRecord, "tool_call_finished must exist");
        assertEquals(finishRecord.callId, callId);
        assertEquals(finishRecord.outcome, "success");
        assert((finishRecord.durationMs as number) >= 0);
        assert((finishRecord.resultBytes as number) > 0);

        // Verify model usage
        const usageRecord = records.find((r) => r.event === "model_usage");
        assert(usageRecord, "model_usage must exist");
        assertEquals(usageRecord.inputTokens, 1200);
        assertEquals(usageRecord.outputTokens, 450);
        assertEquals(usageRecord.cacheReadTokens, 300);
        assertEquals(usageRecord.cacheWriteTokens, 100);
        assertEquals(usageRecord.costAmount, 0.0125);

        // Verify execution finished
        const endRecord = records.find((r) => r.event === "execution_finished");
        assert(endRecord, "execution_finished must exist");
        assertEquals(endRecord.outcome, "succeeded");
        assertEquals(endRecord.callCount, 1);
    });
});

test("ExecutionMetricsRecorder handles >40 tools with individual exposure records", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "test-session-45",
            executionId: "exec-45-tools",
            agentName: "planner",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            backend: "claude-cli",
            sourceSurface: "cli",
            executionKind: "root",
            mode: "foreground",
        });

        // 45 tools
        const mockTools = Array.from({ length: 45 }, (_, i) => ({
            name: `tool_${i}`,
            description: `Description for tool_${i}`,
        }));

        await recorder.recordToolExposure(mockTools);
        await recorder.settleExecution("succeeded");

        const records = await readMetrics();
        const summary = records.find((r) => r.event === "tool_exposure_summary");
        assert(summary, "tool_exposure_summary must exist");
        assertEquals(summary.toolCount, 45);

        const individualExposures = records.filter((r) => r.event === "tool_exposure");
        assertEquals(individualExposures.length, 45, "All 45 tool exposures must be recorded without truncation");
    });
});

test("duplicate tool observations leave one start and one terminal record", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await recorder.recordToolStart("one", "read");
        await recorder.recordToolStart("one", "read");
        await recorder.recordToolFinish("one", "read", { result: "ok" });
        await recorder.recordToolFinish("one", "read", { result: "private duplicate" });
        await recorder.recordToolFinish("orphan", "read", { result: "private orphan" });
        await recorder.settleExecution();
        const records = await readMetrics();
        assertEquals(records.filter((record) => record.event === "tool_call_started").length, 1);
        assertEquals(records.filter((record) => record.event === "tool_call_finished").length, 1);
        assertEquals(records.find((record) => record.event === "execution_finished")?.callCount, 1);
    });
});

test("Pi usage reconciliation excludes history and deduplicates entry IDs", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        const usage = {
            input: 7,
            output: 2,
            cacheRead: 3,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
        };
        const entries = [
            { id: "old", type: "usage", usage, kind: "cache_warm", provider: "anthropic", model: "claude" },
            { id: "new", type: "compaction", usage },
            { id: "summary", type: "branch_summary", usage },
            { id: "standalone", type: "usage", usage, kind: "cache_warm", provider: "anthropic", model: "claude" },
        ] as Parameters<typeof recorder.reconcilePiEntries>[0];
        await recorder.reconcilePiEntries(entries, new Set(["old"]));
        await recorder.reconcilePiEntries(entries, new Set(["old"]));
        await recorder.settleExecution("failed", "failed");
        const records = (await readMetrics()).filter((record) => record.event === "model_usage");
        assertEquals(records.map((record) => record.sourceId), ["new", "summary", "standalone"]);
        assertEquals(records.map((record) => record.usageKind), ["compaction", "summary", "standalone"]);
        assertEquals(records.every((record) => record.inputTokens === 7 && record.costSource === "calculated"), true);
    });
});

test("parallel v2 observations leave complete JSONL rows with unique observation identities", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await Promise.all(
            Array.from(
                { length: 32 },
                (_, index) => recorder.recordToolStart(`call-${index}`, "read", { path: `/private/${index}` }),
            ),
        );
        await recorder.settleExecution();
        const records = await readMetrics();
        assertEquals(records.filter((record) => record.event === "tool_call_started").length, 32);
        assertEquals(new Set(records.map((record) => record.eventId)).size, records.length);
        assertEquals(new Set(records.map((record) => record.seq)).size, records.length);
        assertEquals(JSON.stringify(records).includes("/private/"), false);
    });
});

test("v2 writer excludes private content in errors, links, and nested measurements", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const secret = "PRIVATE-PROVIDER-ERROR /private/repo/file";
        await recordWorkflowMetric({
            v: 2,
            category: "execution",
            event: "execution_finished",
            recorderId: "rec-1",
            seq: 0,
            executionId: secret,
            reason: secret,
            outcome: "failed",
            agent: secret,
            coverage: { tools: "complete", usage: secret, private: secret },
            staticCategoryCounts: { systemTokens: secret },
            details: { secret },
        }, projectRoot);
        const records = await readMetrics();
        assertEquals(records.length, 1);
        assertEquals(JSON.stringify(records).includes(secret), false);
        assertEquals(records[0].reason, undefined);
        assertEquals(records[0].coverage, { tools: "complete" });
    });
});

test("CLI detail usage remains explicitly non-additive and repeated sources do not change coverage", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        const detail = {
            sourceId: "msg_1",
            usageKind: "request" as const,
            aggregationBasis: "alternative" as const,
            inputTokens: 8,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costAmount: 0.08,
            costSource: "reported" as const,
        };
        await recorder.recordModelUsage(detail);
        await recorder.recordModelUsage({ ...detail, outputTokens: null });
        await recorder.recordModelUsage({
            ...detail,
            sourceId: "claude_turn_total",
            usageKind: "turn",
            aggregationBasis: "turn",
            inputTokens: 10,
            costAmount: 0.10,
        });
        await recorder.settleExecution();
        const records = await readMetrics();
        assertEquals(
            records.filter((record) => record.event === "model_usage").map((record) => record.aggregationBasis),
            ["alternative", "turn"],
        );
        assertEquals(
            (records.find((record) => record.event === "execution_finished")?.coverage as { usage: string }).usage,
            "complete",
        );
    });
});

test("shell normalization rejects dynamic arithmetic and unfinished chains", () => {
    assertEquals(normalizeBashCommand("echo $[1+1]"), ["unknown"]);
    assertEquals(normalizeBashCommand("git status |"), ["unknown"]);
    assertEquals(normalizeBashCommand("git status && ; echo done"), ["unknown"]);
});

test("unified Memory recall and absent batch truncation preserve unknown measurements", () => {
    assertEquals(classifyMemoryOperation("memory", { action: "recall", scope: "project" }), {
        action: "recall",
        scope: "unified",
    });
    assertEquals(extractCodeBatchOperations({ operations: [{ op: "show" }] })[0].truncated, null);
});

test("reconciled Pi tool-result usage retains zero cost and observed turn identity", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot, sessionId: "pi-usage" });
        await recorder.recordResponseLatency("turn_start");
        const usage = {
            input: 30,
            output: 4,
            cacheRead: 2,
            cacheWrite: 0,
            totalTokens: 36,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const entry = {
            id: "tool-usage",
            parentId: null,
            timestamp: new Date().toISOString(),
            type: "message" as const,
            message: {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read",
                content: [],
                isError: true,
                timestamp: Date.now(),
                usage,
            },
        };
        recorder.associatePiTurnEntries(
            [entry as Parameters<typeof recorder.reconcilePiEntries>[0][number]],
            new Set(),
        );
        await recorder.reconcilePiEntries(
            [entry as Parameters<typeof recorder.reconcilePiEntries>[0][number]],
            new Set(),
        );
        await recorder.settleExecution("failed");
        const row = (await readMetrics()).find((record) => record.event === "model_usage");
        assert(row);
        assertEquals([row.usageKind, row.costAmount, row.costSource, row.inputCacheBasis], [
            "request",
            0,
            "calculated",
            "excludes_cache",
        ]);
        assertEquals(typeof row.turnId, "string");
    });
});

test("native duplicate source and bridge rejections keep one safe observation and truthful reason", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await recorder.recordNativeToolInfo({ toolName: "view_file", stepIndex: 2 });
        await recorder.recordNativeToolInfo({ toolName: "view_file", stepIndex: 2, status: "success" });
        await recorder.recordToolStart("bridge-call", "read");
        await recorder.recordNativeToolInfo({ toolName: "read", callId: "bridge-call" });
        await recorder.recordBridgeMessage({
            role: "toolResult",
            toolCallId: "bridge-call",
            toolName: "read",
            content: [],
            details: { reason: "invalid arguments for read: secret path" },
            isError: true,
            timestamp: Date.now(),
        });
        await recorder.recordToolStart("closed-call", "read");
        await recorder.recordBridgeMessage({
            role: "toolResult",
            toolCallId: "closed-call",
            toolName: "read",
            content: [],
            details: { reason: "an accepted terminal lifecycle call already closed the gate for this turn" },
            isError: true,
            timestamp: Date.now(),
        });
        await recorder.settleExecution("failed");
        const rows = await readMetrics();
        assertEquals(rows.filter((row) => row.event === "native_tool_observed").length, 1);
        assertEquals(rows.find((row) => row.event === "native_tool_observed")?.stepIndex, 2);
        assertEquals(rows.find((row) => row.event === "tool_call_finished")?.reason, "invalid_arguments");
        assertEquals(
            rows.find((row) => row.callId === "closed-call" && row.event === "tool_call_finished")?.reason,
            "gate_closed",
        );
        assertEquals(JSON.stringify(rows).includes("secret path"), false);
    });
});

test("each new metric family obeys opt-out and omits private tool and command content", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        const emit = async () => {
            const recorder = new ExecutionMetricsRecorder({ projectRoot, sessionId: "privacy-session" });
            await recorder.recordExecutionStart();
            await recorder.recordToolExposure([{
                name: "bash",
                description: "PRIVATE-TEXT",
                parameters: { description: "PRIVATE-TEXT" },
            }]);
            await recorder.recordNativeToolInfo({ toolName: "Read", callId: "native-privacy", status: "success" });
            await recorder.recordToolStart("call-privacy", "bash", { command: "echo PRIVATE-TEXT" });
            await recorder.recordToolFinish("call-privacy", "bash", {
                result: { content: [{ type: "text", text: "PRIVATE-TEXT" }] },
            });
            await recorder.recordModelUsage({ inputTokens: 3, outputTokens: 0 });
            await recorder.recordContextSnapshot({ samplingPoint: "turn_end", capacity: 1024, currentUsage: 3 });
            await recorder.recordCompaction({ reason: "threshold", phase: "start" });
            await recorder.recordCompaction({ reason: "threshold", phase: "end", outcome: "success" });
            await recorder.recordRetryStart({
                retrySource: "summarization_retry",
                attempt: 1,
                maxAttempts: 3,
                delayMs: 4,
            });
            await recorder.settleExecution();
            const command = new SlashCommandMetricsTracker({
                projectRoot,
                command: "export",
                kind: "builtin",
                surface: "tui",
            });
            await command.recordStart();
            await command.recordFinish({ outcome: "failed", errorReason: "failed" });
        };
        await emit();
        assertEquals(await readMetrics(), []);
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        await emit();
        const rows = await readMetrics();
        assertEquals(
            new Set(rows.map((row) => row.category)),
            new Set(["execution", "tool_usage", "model_usage", "context", "command"]),
        );
        for (
            const event of [
                "tool_exposure_summary",
                "tool_exposure",
                "native_tool_observed",
                "compaction_started",
                "compaction_finished",
            ]
        ) {
            assertEquals(rows.some((row) => row.event === event), true, `${event} must honor opt-in`);
        }
        assertEquals(JSON.stringify(rows).includes("PRIVATE-TEXT"), false);
    });
});

test("known package-task labels survive the writer", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await recorder.recordToolStart("npm-call", "bash", { command: "npm run build && pnpm run lint" });
        await recorder.recordToolFinish("npm-call", "bash");
        await recorder.settleExecution();
        assertEquals(
            (await readMetrics()).filter((row) => row.operationKind === "bash_command")
                .map((row) => row.commandLabel),
            ["npm run build", "pnpm run lint"],
        );
    });
});

test("standalone summary retry retains source, index, delay and settled outcome", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new SessionContextMetricsRecorder(projectRoot, "summary-session", null);
        await recorder.retryStart(2, 3, 250);
        await recorder.retryFinish(2, "failed");
        const rows = await readMetrics();
        assertEquals(rows.map((row) => [row.event, row.retrySource, row.attempt]), [
            ["retry_started", "summarization_retry", 2],
            ["retry_finished", "summarization_retry", 2],
        ]);
        assertEquals([rows[0].delayMs, rows[1].outcome], [250, "failed"]);
        assertEquals(rows.every((row) => row.executionId === undefined), true);
    });
});
