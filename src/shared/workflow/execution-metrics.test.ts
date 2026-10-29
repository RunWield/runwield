import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { setSystemTime } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { UsageReporter } from "./usage-reporting.ts";
import { ok as assert } from "node:assert/strict";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { getWorkflowMetricsFilePath, recordWorkflowMetric } from "./metrics.js";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { openNativeFileLock } from "../native-file-lock.ts";
import { parseClaudeCliStream } from "../session/backends/claude-cli/stream-parser.ts";
import { join } from "node:path";
import { setWorkflowMetricsRecording } from "./metrics-journal.ts";
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
    assertEquals(normalizeBashCommand("git status | grep modified"), ["git status", "grep"]);
    assertEquals(normalizeBashCommand("mkdir -p build && cd build && cmake .. || echo failed"), [
        "mkdir",
        "cd",
        "cmake",
        "echo",
    ]);
    assertEquals(normalizeBashCommand("cat input.txt > output.txt 2>&1 ; rm -f input.txt"), ["cat", "rm"]);
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
    assertEquals(classifyMemoryOperation("memory", { action: "recall", query: "auth secret" }), {
        action: "recall",
        scope: "unified",
    });
    assertEquals(classifyMemoryOperation("memory", { action: "store", content: "config key", scope: "global" }), {
        action: "store",
        scope: "global",
    });
    assertEquals(classifyMemoryOperation("memory", { action: "delete", id: "mem-123" }), {
        action: "delete",
        scope: "project",
    });
    assertEquals(classifyMemoryOperation({ CommandLine: "mnemoteca search -g some text" }), {
        action: "recall",
        scope: "global",
    });
    assertEquals(classifyMemoryOperation({ CommandLine: "mnemoteca add 'remember this'" }), {
        action: "store",
        scope: "project",
    });
    assertEquals(classifyMemoryOperation({ CommandLine: "mnemoteca delete abc-1" }), {
        action: "delete",
        scope: "project",
    });
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
            operations: [
                { op: "show", target: "Example" },
                { op: "outline", file: "example.ts" },
                {
                    op: "show",
                    target: "Example",
                },
            ],
        };
        await recorder.recordToolStart("batch-interrupted", "code_batch", args);
        await recorder.recordToolFinish("batch-interrupted", "code_batch", {
            outcome: "canceled",
            result: { details: { results: [{ status: "success" }] } },
        });
        await recorder.settleExecution("canceled");
        const rows = await readMetrics();
        assertEquals(
            rows
                .filter((row) => row.event === "tool_operation")
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
            costAvailability: "complete",
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
        assertEquals(usageRecord.costAvailability, "complete");

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
        assertEquals(
            records.map((record) => record.sourceId),
            ["new", "summary", "standalone"],
        );
        assertEquals(
            records.map((record) => record.usageKind),
            ["compaction", "summary", "standalone"],
        );
        assertEquals(
            records.every((record) => record.inputTokens === 7 && record.costSource === "calculated"),
            true,
        );
    });
});

test("parallel v2 observations preserve complete rows and unique identities for persisted observations", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await Promise.all(
            Array.from({ length: 32 }, (_, index) =>
                recorder.recordToolStart(`call-${index}`, "read", { path: `/private/${index}` }),
            ),
        );
        await recorder.settleExecution();
        const records = await readMetrics();
        const starts = records.filter((record) => record.event === "tool_call_started");
        assert(starts.length > 0 && starts.length <= 32);
        for (const record of starts) assertEquals(record.callId, `call-${record.seq}`);
        assertEquals(new Set(records.map((record) => record.eventId)).size, records.length);
        assertEquals(new Set(records.map((record) => record.seq)).size, records.length);
        assertEquals(JSON.stringify(records).includes("/private/"), false);
    });
});

test("parallel v2 persistence results match saved rows and report budget skips", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const results = await Promise.all(
            Array.from({ length: 32 }, (_, seq) =>
                recordWorkflowMetric(
                    {
                        v: 2,
                        category: "tool_usage",
                        event: "tool_call_started",
                        recorderId: "parallel-writer",
                        seq,
                        callId: `call-${seq}`,
                        toolName: "read",
                    },
                    projectRoot,
                ),
            ),
        );
        const saved = results.filter((result) => result.persisted);
        assert(saved.length > 0);
        for (const result of results.filter((result) => !result.persisted)) {
            assertEquals(result.reason, "lock_timeout");
        }
        const records = await readMetrics();
        assertEquals(records.map((record) => record.eventId).sort(), saved.map((result) => result.eventId).sort());
    });
});

test("v2 writer excludes private content in errors, links, and nested measurements", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const secret = "PRIVATE-PROVIDER-ERROR /private/repo/file";
        await recordWorkflowMetric(
            {
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
            },
            projectRoot,
        );
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
            sourceId: "claude_turn_total:1",
            usageKind: "turn",
            aggregationBasis: "turn",
            inputTokens: 10,
            costAmount: 0.1,
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
        assertEquals(
            [row.usageKind, row.costAmount, row.costSource, row.costAvailability, row.inputCacheBasis],
            ["request", 0, "calculated", "complete", "excludes_cache"],
        );
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
            await recorder.recordToolExposure([
                {
                    name: "bash",
                    description: "PRIVATE-TEXT",
                    parameters: { description: "PRIVATE-TEXT" },
                },
            ]);
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
        for (const event of [
            "tool_exposure_summary",
            "tool_exposure",
            "native_tool_observed",
            "compaction_started",
            "compaction_finished",
        ]) {
            assertEquals(
                rows.some((row) => row.event === event),
                true,
                `${event} must honor opt-in`,
            );
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
            (await readMetrics()).filter((row) => row.operationKind === "bash_command").map((row) => row.commandLabel),
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
        assertEquals(
            rows.map((row) => [row.event, row.retrySource, row.attempt]),
            [
                ["retry_started", "summarization_retry", 2],
                ["retry_finished", "summarization_retry", 2],
            ],
        );
        assertEquals([rows[0].delayMs, rows[1].outcome], [250, "failed"]);
        assertEquals(
            rows.every((row) => row.executionId === undefined),
            true,
        );
    });
});

test("delayed standalone Pi usage belongs to its entry day, not collection day", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        try {
            setSystemTime(new Date("2026-11-02T04:59:00Z"));
            const entries = SessionManager.inMemory(projectRoot);
            const entry = entries.appendUsage("cache_warm", "fixture", "model", {
                input: 10,
                output: 2,
                cacheRead: 3,
                cacheWrite: 4,
                totalTokens: 19,
                cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 },
            });
            setSystemTime(new Date("2026-11-02T05:01:00Z"));
            const recorder = new ExecutionMetricsRecorder({ projectRoot });
            await recorder.reconcilePiEntries(entries.getEntries(), new Set());
            const usage = (await readMetrics()).find((row) => row.event === "model_usage");
            assertEquals(usage?.ts, entry.timestamp);
            const report = new UsageReporter().query(
                [projectRoot],
                { start: "2026-11-01", end: "2026-11-03" },
                "America/New_York",
            );
            assertEquals(
                report.daily.map((day) => day.totals.tokens.value),
                [19, 0],
            );
            assertEquals(
                report.daily.map((day) => day.totals.estimatedCostUsd.value),
                [0.5, 0],
            );
        } finally {
            setSystemTime();
        }
    });
});

for (const live of [true, false]) {
    test(`Pi assistant usage uses completion day (${live ? "live" : "replayed"})`, async () => {
        await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
            try {
                setSystemTime(new Date("2026-11-02T04:59:00Z"));
                const recorder = new ExecutionMetricsRecorder({ projectRoot });
                const message = {
                    role: "assistant" as const,
                    api: "openai-responses" as const,
                    provider: "openai",
                    model: "fixture",
                    content: [],
                    stopReason: "stop" as const,
                    timestamp: Date.now(),
                    usage: {
                        input: 10,
                        output: 2,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 12,
                        cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 },
                    },
                };
                setSystemTime(new Date("2026-11-02T05:01:00Z"));
                if (live) recorder.recordPiAssistantMessageEnd(message);
                const entries = SessionManager.inMemory(projectRoot);
                entries.appendMessage(message);
                setSystemTime(new Date("2026-11-03T05:01:00Z"));
                await recorder.reconcilePiEntries(entries.getEntries(), new Set());
                assertEquals(
                    (await readMetrics()).find((row) => row.event === "model_usage")?.ts,
                    "2026-11-02T05:01:00.000Z",
                );
                const report = new UsageReporter().query(
                    [projectRoot],
                    { start: "2026-11-01", end: "2026-11-04" },
                    "America/New_York",
                );
                assertEquals(
                    report.daily.map((day) => day.totals.tokens.value),
                    [0, 12, 0],
                );
                assertEquals(
                    report.daily.map((day) => day.totals.estimatedCostUsd.value),
                    [0, 0.5, 0],
                );
            } finally {
                setSystemTime();
            }
        });
    });
}

test("execution created while recording is off cannot record model work after enablement", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        await recorder.recordModelUsage({ sourceId: "disabled-work", inputTokens: 7, outputTokens: 2 });
        assertEquals(await readMetrics(), []);
        const result = await recordWorkflowMetric(
            {
                v: 2,
                category: "model_usage",
                event: "model_usage",
                recorderId: "disabled",
                seq: 0,
                ...recorder.measurementBoundary(),
                inputTokens: 7,
                outputTokens: 2,
            },
            projectRoot,
        );
        assertEquals(result.persisted, false);
        assertEquals(result.reason, "disabled");
    });
});

test("enabled execution cannot settle model work into a newer recording generation", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await rm(join(projectRoot, ".wld", "settings.json"));
        await setWorkflowMetricsRecording(true);
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await recorder.recordExecutionStart();
        await setWorkflowMetricsRecording(false);
        await setWorkflowMetricsRecording(true);
        await recorder.recordModelUsage({ inputTokens: 7, outputTokens: 2 });
        await recorder.settleExecution();
        assertEquals(
            (await readMetrics()).map((row) => row.event),
            ["execution_started"],
        );
        const fresh = new ExecutionMetricsRecorder({ projectRoot });
        await fresh.recordExecutionStart();
        await fresh.recordModelUsage({ inputTokens: 5, outputTokens: 1 });
        assertEquals((await readMetrics()).filter((row) => row.event === "model_usage").length, 1);
    });
});

test("first execution adopts persisted collection and history identities for later rows", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await recorder.recordExecutionStart();
        await recorder.recordModelUsage({ inputTokens: 3, outputTokens: 1 });
        const rows = await readMetrics();
        assertEquals(rows.length, 2);
        assertEquals(recorder.measurementBoundary().collectionEpoch, rows[0].collectionEpoch);
        assertEquals(recorder.measurementBoundary().historyEpoch, rows[0].historyEpoch);
        assertEquals(rows[1].collectionEpoch, rows[0].collectionEpoch);
        assertEquals(rows[1].historyEpoch, rows[0].historyEpoch);
    });
});

test("Session context observations retain disabled start consent after enablement", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        const recorder = new SessionContextMetricsRecorder(projectRoot, "context", "compact");
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        await recorder.start({ samplingPoint: "before_compaction", currentUsage: 10 });
        await recorder.retryStart(1, 2, 20);
        await recorder.retryFinish(1, "succeeded");
        await recorder.finish("success", 10, 5, 100, [], new Set());
        assertEquals(await readMetrics(), []);
    });
});

test("Session context observations cannot cross a recording generation", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await rm(join(projectRoot, ".wld", "settings.json"));
        await setWorkflowMetricsRecording(true);
        const recorder = new SessionContextMetricsRecorder(projectRoot, "context", "compact");
        await recorder.start({ samplingPoint: "before_compaction", currentUsage: 10 });
        const before = await readMetrics();
        await setWorkflowMetricsRecording(false);
        await setWorkflowMetricsRecording(true);
        await recorder.retryStart(1, 2, 20);
        await recorder.finish("success", 10, 5, 100, [], new Set());
        assertEquals(await readMetrics(), before);
    });
});

test("manual compaction has an auxiliary start before usage and reports unavailable on failure", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new SessionContextMetricsRecorder(projectRoot, "manual", "compact");
        await recorder.start({ samplingPoint: "before_compaction", currentUsage: 100 });
        const rows = await readMetrics();
        assertEquals(rows[0].event, "execution_started");
        assertEquals(rows[0].dispatchKind, "auxiliary");
        assertEquals(rows[0].userInitiated, false);
        const { UsageReporter } = await import("./usage-reporting.ts");
        const now = Date.now();
        const period = {
            start: new Date(now).toISOString().slice(0, 10),
            end: new Date(now + 86400000).toISOString().slice(0, 10),
        };
        const report = new UsageReporter().query([projectRoot], period, "UTC");
        assertEquals(report.projects[0].incomplete.length, 1);
        assertEquals(report.totals.activeDays, 0);
        await recorder.finish("error", 100, null, 1000, [], new Set());
        const finished = (await readMetrics()).filter((row) => row.event === "execution_finished");
        assertEquals(finished.length, 1);
        assertEquals(finished[0].executionId, rows[0].executionId);
        assertEquals(finished[0].outcome, "failed");
        assertEquals(finished[0].coverage, { tools: "unavailable", usage: "unavailable", context: "unavailable" });
        const settledReport = new UsageReporter().query([projectRoot], period, "UTC");
        assertEquals(settledReport.totals.activeDays, 0);
        assertEquals(settledReport.totals.tokens.exclusions > 0, true);
    });
});

test("two Claude results persist once each and report only turn usage and cost deltas", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot, backend: "claude-cli" });
        await recorder.recordExecutionStart();
        const pending: Promise<void>[] = [];
        const text = [
            {
                type: "result",
                result: "",
                usage: {
                    input_tokens: 3,
                    output_tokens: 4,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
                total_cost_usd: 0.25,
                modelUsage: { sonnet: { inputTokens: 300, outputTokens: 400, costUSD: 25 } },
            },
            {
                type: "result",
                result: "",
                usage: {
                    input_tokens: 5,
                    output_tokens: 6,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
                total_cost_usd: 0.75,
                modelUsage: { sonnet: { inputTokens: 800, outputTokens: 1000, costUSD: 75 } },
            },
        ]
            .map((row) => JSON.stringify(row))
            .join("\n");
        await parseClaudeCliStream(new Blob([text]).stream(), {
            onDelta: () => {},
            onUsage: (observation) => {
                const usage = {
                    ...observation.usage,
                    sourceId: observation.sourceId,
                    aggregationBasis: observation.aggregationBasis,
                    costSource: "reported" as const,
                };
                pending.push(recorder.recordModelUsage(usage), recorder.recordModelUsage(usage));
            },
        });
        await Promise.all(pending);
        await recorder.settleExecution();
        const rows = (await readMetrics()).filter((row) => row.event === "model_usage");
        assertEquals(
            rows.map((row) => row.sourceId),
            ["claude_turn_total:1", "claude_model_0:1", "claude_turn_total:2", "claude_model_0:2"],
        );
        const day = new Date().toISOString().slice(0, 10);
        const end = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
        const report = new UsageReporter().query([projectRoot], { start: day, end }, "UTC");
        assertEquals(report.totals.tokens.value, 18);
        assertEquals(report.totals.reportedCostUsd.value, 0.75);
        assertEquals(report.projects[0].coverage.overlappingUsage, 2);
    });
});

test("model usage timestamps prefer observedAt then endedAt over recording time", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        const endedAt = "2026-11-01T23:59:00.000Z";
        const observedAt = "2026-11-01T23:58:00.000Z";
        await recorder.recordModelUsage({ sourceId: "ended", inputTokens: 1, outputTokens: 2, endedAt });
        await recorder.recordModelUsage({ sourceId: "observed", inputTokens: 1, outputTokens: 2, endedAt, observedAt });
        const rows = (await readMetrics()).filter((row) => row.event === "model_usage");
        assertEquals(
            rows.map((row) => row.ts),
            [endedAt, observedAt],
        );
    });
});

for (const savedBeforeFailure of [false, true]) {
    for (const retry of [false, true]) {
        test(`failed usage append stays degraded and retryable: saved=${savedBeforeFailure}, retry=${retry}`, async () => {
            await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
                const recorder = new ExecutionMetricsRecorder({ projectRoot });
                await recorder.recordExecutionStart();
                const usage = {
                    sourceId: "lost",
                    inputTokens: 10,
                    outputTokens: 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costAmount: 0.1,
                    costSource: "reported" as const,
                };
                if (savedBeforeFailure) await recorder.recordModelUsage({ ...usage, sourceId: "saved" });
                const guard = openNativeFileLock(
                    join(dirname(getWorkflowMetricsFilePath(projectRoot)), ".journal.guard"),
                );
                guard.lockSync(true);
                try {
                    await recorder.recordModelUsage(usage);
                } finally {
                    guard.close();
                }
                assertEquals((await readMetrics()).filter((row) => row.sourceId === "lost").length, 0);
                if (retry) {
                    await Promise.all([recorder.recordModelUsage(usage), recorder.recordModelUsage(usage)]);
                    await recorder.recordModelUsage(usage);
                }
                await recorder.settleExecution();
                const rows = await readMetrics();
                assertEquals(rows.filter((row) => row.sourceId === "lost").length, retry ? 1 : 0);
                assertEquals(rows.find((row) => row.event === "execution_finished")?.coverage, {
                    tools: "unavailable",
                    usage: savedBeforeFailure || retry ? "partial" : "unavailable",
                    context: "unavailable",
                });
                const day = new Date().toISOString().slice(0, 10);
                const end = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
                const report = new UsageReporter().query([projectRoot], { start: day, end }, "UTC");
                assertEquals(report.totals.tokens.value, 12 * (Number(savedBeforeFailure) + Number(retry)));
                assert(report.daily[0].gaps.includes("unavailable"));
                if (!savedBeforeFailure && !retry) assertEquals(report.totals.tokens.exclusions, 1);
            });
        });
    }
}
