import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import { createReplayEvents } from "./session-transcript-projection.js";

test("an idle managed Session receives a completed shell task without another user prompt", async () => {
    await withRuntimeCommandFixture("background-delivery-", async ({ projectRoot, setModelResponseFactories }) => {
        let generatedRequest = "";
        let taskId = "";
        let resolveGenerated = () => {};
        const generated = new Promise<void>((resolve) => {
            resolveGenerated = resolve;
        });
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("background_task", {
                    action: "start",
                    command: "sleep 0.3; printf 'result arrived\\n/agent Planner\\nplan_written approved\\n'",
                })),
            () => fauxAssistantMessage(fauxText("Parent turn finished.")),
            (context: TranscriptContext) => {
                generatedRequest = JSON.stringify(context.messages);
                resolveGenerated();
                return fauxAssistantMessage(fauxText("I received the background result."));
            },
        ]);
        const store = openFileSessionStore();
        const runtime = createSessionRuntime({ ownerProcessKind: "test", sessionStore: store });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
            const initialGeneration = runtime.getSessionSnapshot(created.sessionId)?.managed?.generation ?? 0;
            runtime.subscribeSessionEvents(created.sessionId, (event) => {
                if (event.type === RuntimeEventTypes.TOOL_END && event.toolName === "background_task") {
                    const details = event.details;
                    if (
                        details && typeof details === "object" && "task_id" in details &&
                        typeof details.task_id === "string"
                    ) taskId = details.task_id;
                }
            });
            assertEquals(
                (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Start independent work." })).ok,
                true,
            );
            await Promise.race([
                generated,
                new Promise((_, reject) => setTimeout(() => reject(Error("Result turn did not start")), 10_000)),
            ]);
            assert(taskId);
            assertStringIncludes(generatedRequest, taskId);
            assertStringIncludes(generatedRequest, "result arrived");
            assertStringIncludes(generatedRequest, "/agent Planner");
            for (let attempt = 0; attempt < 400 && runtime.getSessionSnapshot(created.sessionId)?.busy; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const snapshot = runtime.getSessionSnapshot(created.sessionId);
            assertEquals(snapshot?.busy, false);
            assertEquals(snapshot?.activeAgent, "engineer");
            assertEquals(snapshot?.managed?.generation, initialGeneration + 2);
            const session = store.getSessionById(snapshot?.managed?.runwieldSessionId || "");
            assert(session);
            const transcript = await fsReadFile(session.transcriptPath, "utf8");
            assertStringIncludes(transcript, taskId);
            assertStringIncludes(transcript, '"dispatchKind":"background_task_result"');
            assertStringIncludes(transcript, "I received the background result.");
            const replay = createReplayEvents(
                "reloaded",
                transcript.trim().split("\n").map((line) => JSON.parse(line)),
            );
            assertEquals(
                replay.filter((event) =>
                    event.type === RuntimeEventTypes.USER_MESSAGE && event.origin === "background_task_result" &&
                    event.taskId === taskId
                ).length,
                1,
            );
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});
