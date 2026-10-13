import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execPath, platform } from "node:process";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { RuntimeEventTypes } from "./session-runtime-events.js";

test("Stop while the root is idle cancels independent work without a late model turn", async () => {
    await withRuntimeCommandFixture("background-stop-", async ({ projectRoot, setModelResponseFactories }) => {
        const release = join(projectRoot, "release-background");
        const script = join(projectRoot, "background.mjs");
        await writeFile(
            script,
            `
import { existsSync } from "node:fs";
while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
process.stdout.write("must not run\\n");
`,
        );
        const command = [execPath, ...["--no-env-file", "--no-install"], script]
            .map((value) => (platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\"'\"'")}'`))
            .join(" ");
        let modelCalls = 0;
        setModelResponseFactories([
            () => {
                modelCalls++;
                return fauxAssistantMessage(
                    fauxToolCall("background_task", {
                        action: "start",
                        command,
                    }),
                );
            },
            () => {
                modelCalls++;
                return fauxAssistantMessage(fauxText("Parent finished."));
            },
        ]);
        const runtime = createSessionRuntime({ ownerProcessKind: "test" });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
            let taskId = "";
            runtime.subscribeSessionEvents(created.sessionId, (event) => {
                if (event.type === RuntimeEventTypes.TOOL_END && event.toolName === "background_task") {
                    const details = event.details;
                    if (
                        details &&
                        typeof details === "object" &&
                        "task_id" in details &&
                        typeof details.task_id === "string"
                    )
                        taskId = details.task_id;
                }
            });
            assertEquals(
                (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Start a delayed job." })).ok,
                true,
            );
            assert(taskId);
            assertEquals(runtime.getSessionBackgroundTaskState(created.sessionId)?.active, 1);
            assertEquals(runtime.cancelSession(created.sessionId).aborted, true);
            for (
                let attempt = 0;
                attempt < 400 && runtime.getSessionBackgroundTaskState(created.sessionId)?.active;
                attempt++
            ) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(runtime.getSessionBackgroundTaskState(created.sessionId), { active: 0, pending: 0 });
            assertEquals(modelCalls, 2);
        } finally {
            await writeFile(release, "release after assertions");
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("Stop during generated turn acquisition prevents a late model request", async () => {
    await withRuntimeCommandFixture(
        "background-stop-acquisition-",
        async ({ projectRoot, setModelResponseFactories }) => {
            let modelCalls = 0;
            setModelResponseFactories([
                () => {
                    modelCalls++;
                    return fauxAssistantMessage(
                        fauxToolCall("background_task", {
                            action: "start",
                            command: "sleep 0.2; printf 'ready'",
                        }),
                    );
                },
                () => {
                    modelCalls++;
                    return fauxAssistantMessage(fauxText("Parent finished."));
                },
                () => {
                    modelCalls++;
                    return fauxAssistantMessage(fauxText("This turn must not run."));
                },
            ]);
            const runtime = createSessionRuntime({ ownerProcessKind: "test" });
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
                let parentEnded = false;
                let cancelled = false;
                runtime.subscribeSessionEvents(created.sessionId, (event) => {
                    if (event.type === RuntimeEventTypes.TURN_END) parentEnded = true;
                    if (event.type === RuntimeEventTypes.BUSY_CHANGED && event.busy && parentEnded && !cancelled) {
                        cancelled = true;
                        runtime.cancelSession(created.sessionId);
                    }
                });
                assertEquals(
                    (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Start a task." })).ok,
                    true,
                );
                for (let index = 0; index < 300 && !cancelled; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assertEquals(cancelled, true);
                await new Promise((resolve) => setTimeout(resolve, 400));
                assertEquals(modelCalls, 2);
                assertEquals(runtime.getSessionBackgroundTaskState(created.sessionId)?.pending, 0);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});
