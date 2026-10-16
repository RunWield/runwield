import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder } from "./execution-metrics.ts";

test("saved observations reconstruct tool order, repeated use, batch children, and a zero-call delegate", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const root = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "session-mixed",
            executionId: "execution-root",
            agentName: "engineer",
            provider: "anthropic",
            model: "claude-sonnet",
            backend: "pi",
            sourceSurface: "tui",
            executionKind: "root",
            mode: "foreground",
        });
        await root.recordExecutionStart();
        await root.recordToolExposure(
            ["read", "memory", "code_batch", "bash", "delegate_agent"].map((name) => ({ name })),
        );
        const calls = [
            { id: "call-read-1", name: "read", args: { path: "/private/first.ts" } },
            { id: "call-memory", name: "memory", args: { action: "recall", query: "private phrase" } },
            {
                id: "call-batch",
                name: "code_batch",
                args: {
                    operations: [
                        { op: "show", target: "PrivateSymbol" },
                        { op: "outline", file: "/private/secret.ts" },
                        { op: "show", target: "PrivateSymbol" },
                    ],
                },
            },
            { id: "call-bash", name: "bash", args: { command: "git status --short /private/secret.ts" } },
            { id: "call-read-2", name: "read", args: { path: "/private/second.ts" } },
            { id: "call-delegate", name: "delegate_agent", args: { brief: "private delegate brief" } },
        ];
        for (const call of calls) {
            await root.recordToolStart(call.id, call.name, call.args);
            await root.recordToolFinish(call.id, call.name, {
                result: call.name === "code_batch"
                    ? {
                        details: {
                            results: [
                                { status: "success" },
                                { status: "error" },
                                { status: "truncated" },
                            ],
                        },
                    }
                    : { content: [{ type: "text", text: "private result" }] },
            });
        }
        await root.settleExecution("succeeded");
        const child = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "session-mixed",
            executionId: "execution-child",
            agentName: "researcher",
            provider: "anthropic",
            model: "claude-sonnet",
            backend: "pi",
            sourceSurface: "tui",
            executionKind: "delegated",
            mode: "foreground",
            parentExecutionId: root.executionId,
            parentToolCallId: "call-delegate",
        });
        await child.recordExecutionStart();
        await child.recordToolExposure([{ name: "read" }]);
        await child.settleExecution("succeeded");

        // Disk order is not the execution order. Only recorder-scoped sequences are authoritative.
        const saved = (await readMetrics()).reverse();
        const sequence = saved.filter((row) => row.recorderId === root.recorderId).sort((a, b) =>
            Number(a.seq) - Number(b.seq)
        );
        const observed = sequence.filter((row) => row.event === "tool_call_started").map((row) => row.toolName);
        assertEquals(observed, ["read", "memory", "code_batch", "bash", "read", "delegate_agent"]);
        assertEquals([observed[0], observed.at(-1)], ["read", "delegate_agent"]);
        assertEquals(observed.filter((name) => name === "read").length, 2);
        assertEquals(observed.slice(1).map((name, index) => `${observed[index]}->${name}`), [
            "read->memory",
            "memory->code_batch",
            "code_batch->bash",
            "bash->read",
            "read->delegate_agent",
        ]);
        assertEquals(
            sequence.filter((row) => row.event === "tool_operation" && row.parentCallId === "call-batch")
                .map((row) => [row.operationIndex, row.batchKind, row.status]),
            [
                [0, "show", "success"],
                [1, "outline", "error"],
                [2, "show", "truncated"],
            ],
        );
        assertEquals(
            sequence.filter((row) => row.event === "tool_call_started" && row.toolName === "code_batch").length,
            1,
        );
        assertEquals(sequence.find((row) => row.event === "execution_finished")?.callCount, 6);
        const childRows = saved.filter((row) => row.recorderId === child.recorderId);
        assertEquals(childRows.find((row) => row.event === "execution_started")?.parentExecutionId, root.executionId);
        assertEquals(childRows.find((row) => row.event === "execution_started")?.parentToolCallId, "call-delegate");
        assertEquals(childRows.find((row) => row.event === "execution_finished")?.callCount, 0);
        assert(!JSON.stringify(saved).includes("private"));
    });
});
