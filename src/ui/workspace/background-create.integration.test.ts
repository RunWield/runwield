import { assertEquals } from "../../testing/assertions.ts";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

test("Workspace retains a newly created Session until its task result is saved", async () => {
    await withRuntimeCommandFixture(
        "workspace-background-create-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            try {
                setModelResponseFactories([
                    () =>
                        fauxAssistantMessage(fauxToolCall("background_task", {
                            action: "start",
                            command: "sleep 0.5; printf 'created task result\\n'",
                        })),
                    () => fauxAssistantMessage(fauxText("I started a task.")),
                    () => fauxAssistantMessage(fauxText("Created task result received.")),
                ]);
                const created = await service.createSession({
                    projectId: fixture.project.projectId,
                    requestId: "new-background-session",
                    text: "Start an independent command and finish.",
                });
                let operation = service.getOperation(created.operationId);
                for (let index = 0; index < 500 && operation.status === "running"; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    operation = service.getOperation(created.operationId);
                }
                assertEquals(operation.status, "completed", JSON.stringify(operation));
                const id = operation.runwieldSessionId;
                assert(id);
                const history = await service.timeline(id, { projectId: fixture.project.projectId });
                const task = JSON.stringify(history.events).match(/"task_id"\s*:\s*"([0-9a-f-]+)"/);
                assert(task);
                const generatedId = `background:${id}:${task[1]}`;
                let automatic = service.getOperation(generatedId);
                for (let index = 0; index < 600 && automatic.status !== "completed"; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    automatic = service.getOperation(generatedId);
                }
                assertEquals(automatic.status, "completed", JSON.stringify(automatic));
                const completedHistory = await service.timeline(id, { projectId: fixture.project.projectId });
                assert(JSON.stringify(completedHistory.events).includes("Created task result received."));
            } finally {
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace history replay does not revive completed background operations after task_completed", async () => {
    await withRuntimeCommandFixture(
        "workspace-background-replay-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            const gates = [1, 2].map((index) => `${projectRoot}/release-task-${index}`);
            const waitForCompletion = async (operationId: string) => {
                let operation = service.getOperation(operationId);
                for (let index = 0; index < 600 && operation.status !== "completed"; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    operation = service.getOperation(operationId);
                }
                assertEquals(operation.status, "completed", JSON.stringify(operation));
                return operation;
            };
            try {
                setModelResponseFactories([
                    ...gates.map((gate) => () =>
                        fauxAssistantMessage(fauxToolCall("background_task", {
                            action: "start",
                            command: `while [ ! -f '${gate}' ]; do sleep 0.02; done; printf 'review finished\\n'`,
                        }))
                    ),
                    () => fauxAssistantMessage(fauxText("Reviews started.")),
                    () => fauxAssistantMessage(fauxText("First review received.")),
                    () => fauxAssistantMessage(fauxText("Second review received.")),
                    () => fauxAssistantMessage(fauxToolCall("task_completed", { message: "Operation complete." })),
                    () => fauxAssistantMessage(fauxText("Follow-up received.")),
                ]);
                const created = await service.createSession({
                    projectId: fixture.project.projectId,
                    requestId: "create-with-two-tasks",
                    text: "Start two independent reviews.",
                    agentName: "operator",
                });
                const initial = await waitForCompletion(created.operationId);
                const id = initial.runwieldSessionId;
                assert(id);
                const initialHistory = await service.timeline(id, { projectId: fixture.project.projectId });
                const taskIds = [
                    ...new Set(
                        [...JSON.stringify(initialHistory.events).matchAll(/"task_id"\s*:\s*"([0-9a-f-]+)"/g)]
                            .map((match) => match[1]),
                    ),
                ];
                assertEquals(taskIds.length, 2);
                const generatedIds = taskIds.map((taskId) => `background:${id}:${taskId}`);
                for (const [index, gate] of gates.entries()) {
                    await fsWriteFile(gate, "ready");
                    await waitForCompletion(generatedIds[index]);
                }
                // Wait for real runtime disposal so continuation reloads the saved history.
                for (
                    let index = 0;
                    index < 600 &&
                    service.runtime.listSessions().some((entry) => entry.managed?.runwieldSessionId === id);
                    index++
                ) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assertEquals(
                    service.runtime.listSessions().some((entry) => entry.managed?.runwieldSessionId === id),
                    false,
                );
                const continueSession = async (requestId: string, text: string) => {
                    const generation = service.store.inspectSessionActivation(id).generation?.generation;
                    assert(typeof generation === "number");
                    const started = await service.startContinuation({
                        projectId: fixture.project.projectId,
                        runwieldSessionId: id,
                        expectedGeneration: generation,
                        requestId,
                        text,
                    });
                    return await waitForCompletion(started.operationId);
                };
                await continueSession("complete-operation", "Finish the operation.");
                for (const operationId of generatedIds) {
                    assertEquals(service.getOperation(operationId).status, "completed");
                }
                const completedHistory = await service.timeline(id, { projectId: fixture.project.projectId });
                assert(JSON.stringify(completedHistory.events).includes("Operation complete."));
                const live = await service.liveSession(fixture.project.projectId, id);
                assertEquals(live.state, "idle");
                assertEquals(live.operation, null);
                await continueSession("follow-up", "Continue this conversation.");
                const followUpHistory = await service.timeline(id, { projectId: fixture.project.projectId });
                assert(JSON.stringify(followUpHistory.events).includes("Follow-up received."));
            } finally {
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});
