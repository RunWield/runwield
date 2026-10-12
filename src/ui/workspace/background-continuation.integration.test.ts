import { assertEquals } from "../../testing/assertions.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

test("Workspace reuses the owning runtime Session for the next continuation", async () => {
    await withRuntimeCommandFixture(
        "workspace-retained-owner-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            const releasePath = join(projectRoot, "release-background-task");
            try {
                const source = join(projectRoot, "background-gate.mjs");
                await writeFile(
                    source,
                    `
import { existsSync } from "node:fs";
const releasePath = ${JSON.stringify(releasePath)};
const deadline = Date.now() + 30000;
while (!existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error("Background task was never released");
    await new Promise(resolve => setTimeout(resolve, 20));
}
console.log("workspace task done");
`,
                );
                const executable = await writeRuntimeExecutableFixture(join(projectRoot, "background-gate"), source);
                const command = platform === "win32" ? `"${executable}"` : `'${executable.replaceAll("'", "'\"'\"'")}'`;
                let taskId = "";
                setModelResponseFactories([
                    () =>
                        fauxAssistantMessage(
                            fauxToolCall("background_task", {
                                action: "start",
                                command,
                            }),
                        ),
                    () => fauxAssistantMessage(fauxText("First answer.")),
                    () => fauxAssistantMessage(fauxToolCall("background_task", { action: "status", task_id: taskId })),
                    () => fauxAssistantMessage(fauxText("Second answer.")),
                    (context) => {
                        assert(
                            JSON.stringify(context.messages).includes("workspace task done"),
                            "the automatic turn must receive the real completed helper output",
                        );
                        return fauxAssistantMessage(fauxText("Background result received."));
                    },
                    () => fauxAssistantMessage(fauxText("Continued after automatic cleanup.")),
                ]);
                const first = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: 0,
                    requestId: "first-retained-turn",
                    text: "First question.",
                });
                let firstResult = service.getOperation(first.operationId);
                for (let index = 0; index < 400 && firstResult.status === "running"; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    firstResult = service.getOperation(first.operationId);
                }
                assertEquals(firstResult.status, "completed", JSON.stringify(firstResult));
                assert(typeof firstResult.generation === "number");
                const firstHistory = await service.timeline(fixture.session.runwieldSessionId);
                const task = JSON.stringify(firstHistory.events).match(/"task_id"\s*:\s*"([0-9a-f-]+)"/);
                assert(task);
                taskId = task[1];
                const ownerId = service.runtime
                    .listSessions()
                    .find((entry) => entry.managed?.runwieldSessionId === fixture.session.runwieldSessionId)?.id;
                assert(ownerId);
                const second = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: firstResult.generation,
                    requestId: "second-retained-turn",
                    text: "Second question.",
                });
                let secondResult = service.getOperation(second.operationId);
                for (let index = 0; index < 400 && secondResult.status === "running"; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    secondResult = service.getOperation(second.operationId);
                }
                assertEquals(secondResult.status, "completed", JSON.stringify(secondResult));
                assertEquals(
                    service.runtime
                        .listSessions()
                        .find((entry) => entry.managed?.runwieldSessionId === fixture.session.runwieldSessionId)?.id,
                    ownerId,
                );
                assert(
                    JSON.stringify((await service.timeline(fixture.session.runwieldSessionId)).events).includes(taskId),
                );
                // Only now may the task settle and trigger its automatic result turn.
                // A fixed sleep races the second request on slower native runners.
                await writeFile(releasePath, "release\n");
                const generatedId = `background:${fixture.session.runwieldSessionId}:${taskId}`;
                let automatic = service.getOperation(generatedId);
                for (let index = 0; index < 600 && automatic.status !== "completed"; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    automatic = service.getOperation(generatedId);
                }
                assertEquals(automatic.status, "completed", JSON.stringify(automatic));
                assert(
                    JSON.stringify((await service.timeline(fixture.session.runwieldSessionId)).events).includes(
                        "Background result received.",
                    ),
                );
                let latestGeneration = service.store.inspectSessionActivation(fixture.session.runwieldSessionId)
                    .generation?.generation;
                for (let index = 0; index < 400 && latestGeneration === secondResult.generation; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    latestGeneration = service.store.inspectSessionActivation(fixture.session.runwieldSessionId)
                        .generation?.generation;
                }
                assert(typeof latestGeneration === "number");
                const third = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: latestGeneration,
                    requestId: "third-after-automatic-turn",
                    text: "Continue after the automatic result.",
                });
                let thirdResult = service.getOperation(third.operationId);
                for (let index = 0; index < 400 && thirdResult.status === "running"; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    thirdResult = service.getOperation(third.operationId);
                }
                assertEquals(thirdResult.status, "completed", JSON.stringify(thirdResult));
                for (
                    let index = 0;
                    index < 400 &&
                    service.runtime
                        .listSessions()
                        .some((entry) => entry.managed?.runwieldSessionId === fixture.session.runwieldSessionId);
                    index++
                ) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assertEquals(
                    service.runtime
                        .listSessions()
                        .some((entry) => entry.managed?.runwieldSessionId === fixture.session.runwieldSessionId),
                    false,
                );
            } finally {
                // Unblock the real child even if an earlier assertion failed.
                await writeFile(releasePath, "release\n").catch(() => {});
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});
