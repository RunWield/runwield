import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { createReplayEvents } from "./session-transcript-projection.js";
import { RuntimeEventTypes } from "./session-runtime-events.js";

test("a completed task steers the busy parent root once before its next model request", async () => {
    await withRuntimeCommandFixture("background-busy-delivery-", async ({ projectRoot, setModelResponseFactories }) => {
        let nextRequest = "";
        let calls = 0;
        setModelResponseFactories([
            () => {
                calls++;
                return fauxAssistantMessage(fauxToolCall("background_task", {
                    action: "start",
                    command: "sleep 0.15; printf 'busy result'",
                }));
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.5" }));
            },
            (context: TranscriptContext) => {
                calls++;
                nextRequest = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxText("Busy parent received task output."));
            },
        ]);
        const runtime = createSessionRuntime({ ownerProcessKind: "test" });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
            const startGeneration = runtime.getSessionSnapshot(created.sessionId)?.managed?.generation ?? 0;
            assertEquals(
                (await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "Keep working while the command runs.",
                })).ok,
                true,
            );
            assertStringIncludes(nextRequest, "busy result");
            assertEquals(calls, 3);
            const snapshot = runtime.getSessionSnapshot(created.sessionId);
            const store = openFileSessionStore();
            try {
                const saved = store.getSessionById(snapshot?.managed?.runwieldSessionId || "");
                assert(saved);
                const entries = (await fsReadFile(saved.transcriptPath, "utf8")).trim().split("\n").map((line) =>
                    JSON.parse(line)
                );
                const replay = createReplayEvents("busy", entries);
                const generated = replay.filter((event) =>
                    event.type === RuntimeEventTypes.USER_MESSAGE && event.origin === "background_task_result"
                );
                assertEquals(generated.length, 1);
                assertStringIncludes(generated[0].text, "busy result");
                assert(generated[0].taskId);
            } finally {
                store.close();
            }
            assertEquals(runtime.getSessionBackgroundTaskState(created.sessionId)?.pending, 0);
            assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed?.generation, startGeneration + 1);
            assert(nextRequest.includes("Background task"));
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("a busy root receives task output rather than its foreground delegated child", async () => {
    await withRuntimeCommandFixture("background-parent-target-", async ({ projectRoot, setModelResponseFactories }) => {
        let parentRequest = "";
        let childRequest = "";
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("background_task", {
                    action: "start",
                    command: "sleep 0.15; printf 'root-only task result'",
                })),
            () => fauxAssistantMessage(fauxToolCall("delegate_agent", { mode: "read", brief: "Inspect briefly." })),
            async (context: TranscriptContext) => {
                childRequest = JSON.stringify(context.messages);
                await new Promise((resolve) => setTimeout(resolve, 500));
                return fauxAssistantMessage(fauxText("Child inspection finished."));
            },
            (context: TranscriptContext) => {
                parentRequest = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxText("Parent received its task result."));
            },
        ]);
        const runtime = createSessionRuntime({ ownerProcessKind: "test" });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
            const startGeneration = runtime.getSessionSnapshot(created.sessionId)?.managed?.generation ?? 0;
            assertEquals(
                (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Use both helpers." })).ok,
                true,
            );
            assertStringIncludes(parentRequest, "root-only task result");
            assertEquals(childRequest.includes("root-only task result"), false);
            assertEquals(runtime.getSessionBackgroundTaskState(created.sessionId)?.pending, 0);
            assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed?.generation, startGeneration + 1);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
