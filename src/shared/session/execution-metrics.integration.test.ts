import { test } from "node:test";
import { readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";
import { createSessionRuntime } from "./session-runtime.ts";
import { HostedSession } from "./hosted-session.js";
import {
    drainSessionCompactionMetrics,
    ensureRootAgentSession,
    runIsolatedAgentSession,
    runRootTurn,
} from "./session.js";

async function readMetrics(projectRoot: string) {
    await drainWorkflowMetrics();
    return (await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8")).trim()
        .split("\n").map((line) => JSON.parse(line));
}

test("disabled recording leaves no Project JSONL after a real Agent turn", async () => {
    await withRuntimeCommandFixture("metrics-opt-out-", async ({ projectRoot, setModelResponse }) => {
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        setModelResponse("No metric should be written.");
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "guide" });
            assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "Answer briefly." })).ok, true);
            await drainWorkflowMetrics();
            await assertRejects(() => fsStat(getWorkflowMetricsFilePath(projectRoot)), Error, "ENOENT");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("real mixed-tool turn reconstructs ordered calls and batch children from shuffled JSONL", async () => {
    await withRuntimeCommandFixture("metrics-mixed-real-", async ({ projectRoot, setModelResponseFactories }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        await fsWriteFile(`${projectRoot}/readme.txt`, "Safe fixture content.\n");
        setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("read", { path: "readme.txt" })),
            () =>
                fauxAssistantMessage(fauxToolCall("memory", { action: "recall", scope: "project", query: "fixture" })),
            () =>
                fauxAssistantMessage(fauxToolCall("code_batch", {
                    operations: [
                        { op: "show", target: "FixtureSymbol" },
                        { op: "outline", file: "readme.txt" },
                        { op: "show", target: "FixtureSymbol" },
                    ],
                })),
            () => fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short" })),
            () => fauxAssistantMessage(fauxToolCall("read", { path: "readme.txt" })),
            () => fauxAssistantMessage(fauxToolCall("delegate_agent", { mode: "read", brief: "Inspect fixture." })),
            () => fauxAssistantMessage(fauxText("Child done.")),
            () => fauxAssistantMessage(fauxText("Parent done.")),
        ]);
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "Inspect safe tools." })).ok, true);
            const rows = (await readMetrics(projectRoot)).reverse();
            const parent = rows.find((row) => row.event === "execution_started" && row.executionKind === "root");
            const child = rows.find((row) => row.event === "execution_started" && row.executionKind === "delegated");
            assert(parent && child);
            const ordered = rows.filter((row) => row.executionId === parent.executionId)
                .sort((a, b) => a.seq - b.seq);
            const context = ordered.filter((row) =>
                row.event === "context_snapshot" &&
                ["execution_start", "turn_start", "turn_end"].includes(row.samplingPoint)
            );
            assert(context.length >= 3);
            assert(context.every((row) => typeof row.staticCategoryCounts?.toolsTokens === "number"));
            const starts = ordered.filter((row) => row.event === "tool_call_started");
            const names = starts.map((row) => row.toolName);
            assertEquals(names, ["read", "memory", "code_batch", "bash", "read", "delegate_agent"]);
            assertEquals(names.filter((name) => name === "read").length, 2);
            assertEquals(names.slice(1).map((name, index) => `${names[index]}->${name}`), [
                "read->memory",
                "memory->code_batch",
                "code_batch->bash",
                "bash->read",
                "read->delegate_agent",
            ]);
            const batch = starts.find((row) => row.toolName === "code_batch");
            assert(batch);
            assertEquals(
                ordered.filter((row) => row.event === "tool_operation" && row.parentCallId === batch.callId)
                    .map((row) => [row.operationIndex, row.batchKind]),
                [[0, "show"], [1, "outline"], [2, "show"]],
            );
            assertEquals(ordered.find((row) => row.event === "execution_finished")?.callCount, 6);
            assertEquals(child.parentExecutionId, parent.executionId);
            assertEquals(child.parentToolCallId, starts.at(-1)?.callId);
            assertEquals(
                rows.find((row) => row.event === "execution_finished" && row.executionId === child.executionId)
                    ?.callCount,
                0,
            );
            assertEquals(JSON.stringify(rows).includes("Inspect fixture."), false);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("real background delegate records its parent execution without surfacing child calls as root calls", async () => {
    await withRuntimeCommandFixture("metrics-delegation-", async ({ projectRoot, setModelResponseFactories }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("delegate_agent", {
                    mode: "read",
                    background: true,
                    brief: "Check a harmless fixture value.",
                })),
            () => fauxAssistantMessage(fauxText("Parent done.")),
            () => fauxAssistantMessage(fauxText("Child done.")),
        ]);
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "Delegate a read." })).ok, true);
            for (let i = 0; i < 400 && runtime.getSessionBackgroundTaskState(sessionId)?.active; i++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const rows = await readMetrics(projectRoot);
            const root = rows.find((row) => row.event === "execution_started" && row.executionKind === "root");
            const child = rows.find((row) => row.event === "execution_started" && row.executionKind === "delegated");
            assert(root && child, "both executions must be recorded");
            const parentCall = rows.find((row) =>
                row.event === "tool_call_started" && row.toolName === "delegate_agent"
            );
            assert(parentCall);
            assertEquals(child.parentExecutionId, root.executionId);
            assertEquals(child.parentToolCallId, parentCall.callId);
            assertEquals(child.taskId !== null, true);
            assertEquals(root.callCount, undefined);
            assertEquals(
                rows.find((row) => row.event === "execution_finished" && row.executionId === root.executionId)
                    ?.callCount,
                1,
            );
            assertEquals(JSON.stringify(rows).includes("Check a harmless fixture value"), false);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("two parallel background delegates retain their shared parent execution", async () => {
    await withRuntimeCommandFixture(
        "metrics-parallel-delegates-",
        async ({ projectRoot, setModelResponseFactories }) => {
            await setCustomSetting("workflowMetrics", true, "project", projectRoot);
            setModelResponseFactories([
                () =>
                    fauxAssistantMessage([
                        fauxToolCall("delegate_agent", { mode: "read", background: true, brief: "First fixture." }),
                        fauxToolCall("delegate_agent", { mode: "read", background: true, brief: "Second fixture." }),
                    ]),
                () => fauxAssistantMessage(fauxText("Parent done.")),
                () => fauxAssistantMessage(fauxText("Child done.")),
                () => fauxAssistantMessage(fauxText("Child done.")),
            ]);
            const runtime = createSessionRuntime();
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.switchAgent(sessionId, { agentName: "engineer" });
                assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "Delegate twice." })).ok, true);
                for (let i = 0; i < 400 && runtime.getSessionBackgroundTaskState(sessionId)?.active; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                const rows = await readMetrics(projectRoot);
                const root = rows.find((row) => row.event === "execution_started" && row.executionKind === "root");
                const children = rows.filter((row) =>
                    row.event === "execution_started" && row.executionKind === "delegated"
                );
                assert(root);
                assertEquals(children.length, 2);
                const parentCalls = rows.filter((row) =>
                    row.event === "tool_call_started" &&
                    row.executionId === root.executionId && row.toolName === "delegate_agent"
                );
                assertEquals(parentCalls.length, 2);
                assertEquals(new Set(children.map((row) => row.parentToolCallId)).size, 2);
                for (const child of children) {
                    assertEquals(child.parentExecutionId, root.executionId);
                    assert(parentCalls.some((call) => call.callId === child.parentToolCallId));
                    assert(child.taskId);
                }
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});

test("isolated Reviewer delegates a nested child with its own execution identity", async () => {
    await withRuntimeCommandFixture("metrics-nested-delegate-", async ({ projectRoot, setModelResponseFactories }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("delegate_agent", { mode: "read", brief: "Inspect the fixture." })),
            () => fauxAssistantMessage(fauxText("Nested child done.")),
            () => fauxAssistantMessage(fauxText("Review done.")),
        ]);
        const hosted = new HostedSession({
            id: "reviewer-parent",
            cwd: projectRoot,
            sessionManager: SessionManager.inMemory(projectRoot),
        });
        try {
            await runIsolatedAgentSession({
                hostedSession: hosted,
                agentName: "reviewer",
                subAgentDefinition: { id: "reviewer", options: { reviewerMode: "discovery" } },
                userRequest: "Review this fixture with a delegated read.",
            });
            const rows = await readMetrics(projectRoot);
            const parent = rows.find((row) => row.event === "execution_started" && row.executionKind === "isolated");
            const child = rows.find((row) => row.event === "execution_started" && row.executionKind === "delegated");
            assert(parent && child);
            assertEquals(child.parentExecutionId, parent.executionId);
            assert(rows.some((row) =>
                row.event === "tool_call_started" && row.executionId === parent.executionId &&
                row.callId === child.parentToolCallId
            ));
            assertEquals(child.taskId, null);
        } finally {
            await hosted.dispose();
        }
    });
});

test("real foreground delegate preserves parent links with no background task ID", async () => {
    await withRuntimeCommandFixture(
        "metrics-foreground-delegate-",
        async ({ projectRoot, setModelResponseFactories }) => {
            await setCustomSetting("workflowMetrics", true, "project", projectRoot);
            setModelResponseFactories([
                () =>
                    fauxAssistantMessage(fauxToolCall("delegate_agent", {
                        mode: "read",
                        brief: "Inspect the fixture.",
                    })),
                () => fauxAssistantMessage(fauxText("Child done.")),
                () => fauxAssistantMessage(fauxText("Parent done.")),
            ]);
            const runtime = createSessionRuntime();
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.switchAgent(sessionId, { agentName: "engineer" });
                assertEquals(
                    (await runtime.promptUserTurn(sessionId, { initialRequest: "Delegate foreground." })).ok,
                    true,
                );
                const rows = await readMetrics(projectRoot);
                const root = rows.find((row) => row.event === "execution_started" && row.executionKind === "root");
                const child = rows.find((row) =>
                    row.event === "execution_started" && row.executionKind === "delegated"
                );
                const parentCall = rows.find((row) =>
                    row.event === "tool_call_started" && row.toolName === "delegate_agent"
                );
                assert(root && child && parentCall);
                assertEquals(child.parentExecutionId, root.executionId);
                assertEquals(child.parentToolCallId, parentCall.callId);
                assertEquals(child.taskId, null);
                assertEquals(child.mode, "foreground");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});

test("manual compaction outside a model turn links context to command without inventing execution", async () => {
    await withRuntimeCommandFixture(
        "metrics-manual-compaction-",
        async ({ projectRoot, setModelResponseFactories }) => {
            await setCustomSetting("workflowMetrics", true, "project", projectRoot);
            setModelResponseFactories([
                () => fauxAssistantMessage(fauxText("Initial response with useful details. ".repeat(3500))),
                () => fauxAssistantMessage(fauxText("A second response with more useful details.")),
                () => fauxAssistantMessage(fauxText("Preserve useful details.")),
            ]);
            const hosted = new HostedSession({
                id: "manual-compaction",
                cwd: projectRoot,
                sessionManager: SessionManager.inMemory(projectRoot),
            });
            try {
                const root = await ensureRootAgentSession({ hostedSession: hosted, agentName: "guide" });
                await runRootTurn({ hostedSession: hosted, agentName: "guide", userRequest: "Say something useful." });
                await runRootTurn({
                    hostedSession: hosted,
                    agentName: "guide",
                    userRequest: "Keep another useful detail.",
                });
                hosted.activeCommandInvocationId = "cmd_manual";
                await root.compact();
                await drainSessionCompactionMetrics(root);
                const rows = await readMetrics(projectRoot);
                const start = rows.find((row) => row.event === "compaction_started" && row.reason === "manual");
                const end = rows.find((row) =>
                    row.event === "compaction_finished" && row.recorderId === start?.recorderId
                );
                assert(start && end, "manual compaction must have matching observations");
                assertEquals(start.executionId, undefined);
                assertEquals(end.executionId, undefined);
                assertEquals(start.commandId, "cmd_manual");
                assertEquals(end.outcome, "success");
                const compactionUsage = rows.filter((row) =>
                    row.event === "model_usage" &&
                    row.usageKind === "compaction" && row.commandId === "cmd_manual"
                );
                assertEquals(compactionUsage.length, 1);
                const snapshots = rows.filter((row) =>
                    row.recorderId === start.recorderId && row.event === "context_snapshot"
                );
                assertEquals(snapshots.map((row) => row.samplingPoint), ["before_compaction", "after_compaction"]);
                assertEquals(typeof snapshots[0].staticCategoryCounts.systemTokens, "number");
                assertEquals(typeof snapshots[0].staticCategoryCounts.toolsTokens, "number");
                assertEquals([snapshots[1].currentUsage, snapshots[1].usageState], [null, "unknown_after_compaction"]);
            } finally {
                await hosted.dispose();
            }
        },
    );
});

test("manual compaction cancellation saves a canceled result with no invented execution", async () => {
    await withRuntimeCommandFixture("metrics-manual-cancel-", async ({ projectRoot, setModelResponseFactories }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        setModelResponseFactories([
            () => fauxAssistantMessage(fauxText("Initial details. ".repeat(3500))),
            () => fauxAssistantMessage(fauxText("Additional details.")),
            () => fauxAssistantMessage(fauxText("Compaction response should not complete.")),
        ]);
        const hosted = new HostedSession({
            id: "manual-cancel",
            cwd: projectRoot,
            sessionManager: SessionManager.inMemory(projectRoot),
        });
        try {
            const root = await ensureRootAgentSession({ hostedSession: hosted, agentName: "guide" });
            await runRootTurn({ hostedSession: hosted, agentName: "guide", userRequest: "First turn." });
            await runRootTurn({ hostedSession: hosted, agentName: "guide", userRequest: "Second turn." });
            hosted.activeCommandInvocationId = "cmd_cancel";
            const unsubscribe = root.subscribe((event) => {
                if (event.type === "compaction_start" && event.reason === "manual") root.abortCompaction();
            });
            try {
                await root.compact().catch(() => undefined);
            } finally {
                unsubscribe();
            }
            await drainSessionCompactionMetrics(root);
            const rows = await readMetrics(projectRoot);
            const start = rows.find((row) =>
                row.event === "compaction_started" && row.reason === "manual" &&
                row.commandId === "cmd_cancel"
            );
            const finish = rows.find((row) =>
                row.event === "compaction_finished" && row.recorderId === start?.recorderId
            );
            assert(start && finish);
            assertEquals(finish.outcome, "canceled");
            assertEquals(finish.executionId, undefined);
        } finally {
            await hosted.dispose();
        }
    });
});

test("Runtime manual compaction carries the caller command ID into saved observations", async () => {
    await withRuntimeCommandFixture("metrics-runtime-compact-", async ({ projectRoot }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await assertRejects(
                () => runtime.compactSession(sessionId, undefined, "cmd_runtime"),
                Error,
                "Nothing to compact",
            );
            const rows = await readMetrics(projectRoot);
            const start = rows.find((row) => row.event === "compaction_started" && row.reason === "manual");
            const finish = rows.find((row) =>
                row.event === "compaction_finished" && row.recorderId === start?.recorderId
            );
            assert(start && finish);
            assertEquals(start.commandId, "cmd_runtime");
            assertEquals(finish.commandId, "cmd_runtime");
            assertEquals(finish.outcome, "error");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("manual compaction failure records an error without fabricating execution", async () => {
    await withRuntimeCommandFixture("metrics-manual-error-", async ({ projectRoot }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        const hosted = new HostedSession({
            id: "manual-error",
            cwd: projectRoot,
            sessionManager: SessionManager.inMemory(projectRoot),
        });
        try {
            const root = await ensureRootAgentSession({ hostedSession: hosted, agentName: "guide" });
            await assertRejects(() => root.compact(), Error, "Nothing to compact");
            await drainSessionCompactionMetrics(root);
            await drainWorkflowMetrics();
            const rows = (await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8")).trim()
                .split("\n").map((line) => JSON.parse(line));
            const start = rows.find((row) => row.event === "compaction_started" && row.reason === "manual");
            assert(start);
            const finish = rows.find((row) =>
                row.event === "compaction_finished" && row.recorderId === start.recorderId
            );
            assert(finish);
            assertEquals(finish.outcome, "error");
            assertEquals(finish.executionId, undefined);
        } finally {
            await hosted.dispose();
        }
    });
});
