import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import { createSessionRuntime } from "./session-runtime.ts";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("managed deferred messages deliver once and canceled messages stay cleared after reopen", async () => {
    await withRuntimeCommandFixture(
        "managed-queue-lifecycle-",
        async ({ homeDir: home, projectRoot: cwd, setModelResponseFactories }) => {
            let modelCalls = 0;
            setModelResponseFactories([
                () => {
                    modelCalls += 1;
                    return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.2" }));
                },
                () => {
                    modelCalls += 1;
                    return fauxAssistantMessage(fauxText("Steering and deferred messages applied."));
                },
                () => {
                    modelCalls += 1;
                    return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 5" }));
                },
            ]);
            const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "managed-queue-lifecycle-owner",
            });
            try {
                store.registerProject({ root: cwd, now: () => "2026-01-01T00:00:01.000Z" });
                const created = await runtime.createInteractiveSession({ cwd, mode: "new" });
                await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
                const managed = runtime.getSessionSnapshot(created.sessionId)?.managed;
                if (!managed) throw new Error("Expected managed Session metadata");
                const statuses: string[] = [];
                let toolStarts = 0;
                let resolveFirstToolStarted = () => {};
                let resolveCanceledToolStarted = () => {};
                const firstToolStarted = new Promise<void>((resolve) => {
                    resolveFirstToolStarted = resolve;
                });
                const canceledToolStarted = new Promise<void>((resolve) => {
                    resolveCanceledToolStarted = resolve;
                });
                runtime.subscribeSessionEvents(created.sessionId, (event) => {
                    if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) statuses.push(event.status);
                    if (event.type === RuntimeEventTypes.TOOL_START) {
                        toolStarts += 1;
                        if (toolStarts === 1) resolveFirstToolStarted();
                        if (toolStarts === 2) resolveCanceledToolStarted();
                    }
                });

                const first = runtime.promptManagedSession(created.sessionId, {
                    initialRequest: "start the managed turn",
                    expectedGeneration: managed.generation,
                });
                await firstToolStarted;
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, true);

                const steeredText = "consume this steering message exactly once";
                assertEquals((await runtime.steerSession(created.sessionId, steeredText, [])).queued, true);
                const deliveredText = "deliver this deferred message exactly once";
                const queued = runtime.queueNextTurnMessage(created.sessionId, deliveredText, [], {
                    deliverWhenAvailable: true,
                });
                assertEquals(queued.queued, true);
                assertEquals((await first).ok, true);
                for (let attempt = 0; attempt < 1_000; attempt += 1) {
                    if (modelCalls === 2 && runtime.getQueuedMessages(created.sessionId).length === 0) break;
                    await delay(10);
                }
                assertEquals(modelCalls, 2);
                assertEquals(runtime.getQueuedMessages(created.sessionId), []);
                // The drain delivers the deferred message as its own turn (model call 3).
                // Wait for that turn to fire and settle before starting the canceled turn,
                // otherwise the canceled turn races the drain for the managed operation and
                // the deferred message is claimed but never reaches the transcript.
                for (let attempt = 0; attempt < 1_000; attempt += 1) {
                    if (modelCalls >= 3 && !runtime.getSessionSnapshot(created.sessionId)?.busy) break;
                    await delay(10);
                }
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, false);

                const canceledText = "cancel this message before delivery";
                const canceledTurn = runtime.promptManagedSession(created.sessionId, {
                    initialRequest: "start the turn that will be canceled",
                    expectedGeneration: runtime.getSessionSnapshot(created.sessionId)?.managed?.generation ?? null,
                });
                await canceledToolStarted;
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, true);
                runtime.queueNextTurnMessage(created.sessionId, canceledText, [], { deliverWhenAvailable: true });
                assertEquals(runtime.cancelSession(created.sessionId).ok, true);
                await canceledTurn;
                for (let attempt = 0; attempt < 1_000; attempt += 1) {
                    if (!runtime.getSessionSnapshot(created.sessionId)?.busy) break;
                    await delay(10);
                }
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, false);
                assertEquals(modelCalls, 3);
                assertEquals(runtime.getQueuedMessages(created.sessionId), []);
                assertEquals(statuses, ["queued", "queued", "consumed", "consumed", "queued", "dequeued"]);

                const cataloged = store.getSessionById(managed.runwieldSessionId);
                if (!cataloged) throw new Error("Expected cataloged Session");
                assertEquals(await runtime.closeSession(created.sessionId), { ok: true, closed: true });
                const reopened = await runtime.loadSession({
                    cwd,
                    sessionId: cataloged.piSessionId,
                    sessionPath: cataloged.transcriptPath,
                });
                assertEquals(runtime.getQueuedMessages(reopened.sessionId), []);
                const transcript = await fsReadFile(cataloged.transcriptPath, "utf8");
                assertEquals(transcript.split(deliveredText).length - 1, 1);
                assertEquals(transcript.includes(canceledText), false);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});
