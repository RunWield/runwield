import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import { createSessionRuntime } from "./session-runtime.ts";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("closeSession waits for the outer managed operation before disposal", async () => {
    await withRuntimeCommandFixture(
        "close-awaits-operation-",
        async ({ homeDir: home, projectRoot: cwd, setModelResponseFactory }) => {
            setModelResponseFactory(
                () => fauxAssistantMessage(fauxText("Managed prompt completed. ".repeat(500))),
            );
            const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "close-awaits-operation-owner",
            });
            let prompt: Promise<{ ok: boolean; turns: number; error?: string }> | null = null;
            try {
                store.registerProject({ root: cwd, now: () => "2026-01-01T00:00:01.000Z" });
                const created = await runtime.createInteractiveSession({ cwd, mode: "new" });
                await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
                const managed = runtime.getSessionSnapshot(created.sessionId)?.managed;
                if (!managed) throw new Error("Expected managed Session metadata");
                const cataloged = store.getSessionById(managed.runwieldSessionId);
                if (!cataloged) throw new Error("Expected cataloged Session");
                let operationSettled = false;
                const closeEventSettlement: boolean[] = [];
                runtime.subscribeSessionEvents(created.sessionId, (event) => {
                    if (event.type === RuntimeEventTypes.SESSION_CLOSED) {
                        closeEventSettlement.push(operationSettled);
                    }
                });

                prompt = runtime.promptManagedSession(created.sessionId, {
                    initialRequest: "hold the managed operation open",
                    expectedGeneration: managed.generation,
                }).finally(() => {
                    operationSettled = true;
                });
                for (let attempt = 0; attempt < 1_000; attempt += 1) {
                    if (runtime.getSessionSnapshot(created.sessionId)?.busy) break;
                    await delay(10);
                }
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, true);

                let closeSettled = false;
                const close = runtime.closeSession(created.sessionId).then((result) => {
                    closeSettled = true;
                    return result;
                });
                await delay(10);
                assertEquals(closeSettled, false);
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, true);

                assertEquals((await prompt).ok, true);
                assertEquals(await close, { ok: true, closed: true });
                assertEquals(runtime.getSessionSnapshot(created.sessionId), null);
                assertEquals(closeEventSettlement, [true]);
                assertEquals(
                    store.inspectSessionActivation(managed.runwieldSessionId).activation?.state,
                    "idle",
                );
                const transcript = await fsReadFile(cataloged.transcriptPath, "utf8");
                assertEquals(transcript.includes("hold the managed operation open"), true);

                const reopened = await runtime.loadSession({
                    cwd,
                    sessionId: cataloged.piSessionId,
                    sessionPath: cataloged.transcriptPath,
                });
                assertEquals(reopened.sessionManagerId, cataloged.piSessionId);
                assertEquals(await runtime.closeSession(reopened.sessionId), { ok: true, closed: true });
            } finally {
                if (prompt) await prompt.catch(() => undefined);
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});
