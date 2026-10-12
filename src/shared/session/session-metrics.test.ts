import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder } from "../workflow/execution-metrics.ts";

test("Delegated background session links parentToolCallId and taskId", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const parentExecutionId = "exec-root-1";
        const parentToolCallId = "call-delegate-42";
        const taskId = "task-bg-100";

        const delegatedRecorder = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "child-session",
            executionId: "exec-child-2",
            agentName: "researcher",
            backend: "pi",
            sourceSurface: "cli",
            executionKind: "delegated",
            mode: "background",
            parentExecutionId,
            parentToolCallId,
            taskId,
        });

        await delegatedRecorder.recordToolStart("call-read-1", "read", { path: "README.md" });
        await delegatedRecorder.recordToolFinish("call-read-1", "read", {
            result: "# Test Project",
            isError: false,
        });
        await delegatedRecorder.settleExecution("succeeded");

        const records = await readMetrics();
        for (const record of records) {
            assertEquals(record.parentExecutionId, parentExecutionId);
            assertEquals(record.parentToolCallId, parentToolCallId);
            assertEquals(record.taskId, taskId);
            assertEquals(record.executionKind, "delegated");
            assertEquals(record.mode, "background");
        }
    });
});
