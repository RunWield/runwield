import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { SessionRuntime } from "./session-runtime.ts";
import { SessionHost } from "./session-host.ts";
import { openFileSessionStore } from "./file-session-store.ts";

test("portable runtime resumes provider context across close and reopen", async () => {
    await withRuntimeCommandFixture(
        "portable-turn-",
        async ({ projectRoot, setModelResponse, setModelResponseFactory }) => {
            setModelResponse("Portable turn completed.");
            const runtime = new SessionRuntime({
                sessionHost: new SessionHost(),
                sessionStore: openFileSessionStore(),
                ownerProcessKind: "test",
                ownerInstanceId: crypto.randomUUID(),
            });
            try {
                const id = await runtime.createPromptReadySession({ cwd: projectRoot });
                await runtime.promptUserTurn(id, { initialRequest: "Say hello." });
                equal(await runtime.getLastAssistantText(id), "Portable turn completed.");
                const managed = runtime.getSessionSnapshot(id)?.managed;
                ok(managed);
                await runtime.closeAllSessionsWhenIdle();
                const reopenedStore = openFileSessionStore();
                const saved = reopenedStore.getSessionById(managed.runwieldSessionId, managed.projectId);
                ok(saved);
                const reopened = new SessionRuntime({
                    sessionHost: new SessionHost(),
                    sessionStore: reopenedStore,
                    ownerProcessKind: "test",
                    ownerInstanceId: crypto.randomUUID(),
                });
                try {
                    const adopted = reopened.adoptManagedSession({ session: saved });
                    equal(await reopened.getLastAssistantText(adopted.sessionId), "Portable turn completed.");
                    let sawSavedUser = false;
                    let sawSavedAssistant = false;
                    let sawCurrentUser = false;
                    setModelResponseFactory((context) => {
                        sawSavedUser = context.messages.some((message) =>
                            message.role === "user" && JSON.stringify(message.content).includes("Say hello.")
                        );
                        sawSavedAssistant = context.messages.some((message) =>
                            message.role === "assistant" &&
                            JSON.stringify(message.content).includes("Portable turn completed.")
                        );
                        sawCurrentUser = context.messages.some((message) =>
                            message.role === "user" && JSON.stringify(message.content).includes("Continue.")
                        );
                        return fauxAssistantMessage(fauxText("Resumed turn completed."));
                    });
                    await reopened.promptUserTurn(adopted.sessionId, { initialRequest: "Continue." });
                    equal(await reopened.getLastAssistantText(adopted.sessionId), "Resumed turn completed.");
                    ok(sawSavedUser, "resumed provider receives the saved user request");
                    ok(sawSavedAssistant, "resumed provider receives the saved assistant response");
                    ok(sawCurrentUser, "resumed provider receives the continuation request");
                } finally {
                    await reopened.closeAllSessionsWhenIdle();
                }
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});
