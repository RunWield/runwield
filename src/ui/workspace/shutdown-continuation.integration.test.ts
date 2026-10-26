import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

test("Workspace shutdown cancels an active turn before draining accepted work", async () => {
    await withRuntimeCommandFixture(
        "workspace-shutdown-active-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let releaseTurn = () => {};
            let enteredTurn = () => {};
            const entered = new Promise<void>((resolve) => {
                enteredTurn = resolve;
            });
            const held = new Promise<void>((resolve) => {
                releaseTurn = resolve;
            });
            try {
                setModelResponseFactory(async (context, options) => {
                    options?.signal?.addEventListener("abort", releaseTurn, { once: true });
                    if (options?.signal?.aborted) releaseTurn();
                    enteredTurn();
                    await held;
                    return fixture.recordedModelResponse("Turn stopped.")(context);
                });
                await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: 0,
                    requestId: "shutdown-active-turn",
                    text: "Wait for cancellation.",
                });
                await entered;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const result = await Promise.race([
                        service.close().then(() => "closed"),
                        new Promise<string>((resolve) => {
                            timer = setTimeout(() => resolve("stuck"), 1000);
                        }),
                    ]);
                    assertEquals(result, "closed");
                } finally {
                    clearTimeout(timer);
                }
            } finally {
                releaseTurn();
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace shutdown cancels a pending browser question without an answer", async () => {
    await withRuntimeCommandFixture(
        "workspace-shutdown-question-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let operationId = "";
            try {
                setModelResponseFactories([
                    () =>
                        fauxAssistantMessage(
                            fauxToolCall("user_interview", {
                                question: { type: "yes_no", prompt: "Continue?" },
                            }),
                        ),
                    () => fauxAssistantMessage(fauxText("Stopped.")),
                ]);
                const started = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: 0,
                    requestId: "shutdown-browser-question",
                    text: "Ask before continuing.",
                });
                operationId = started.operationId;
                let operation = service.getOperation(operationId);
                for (let i = 0; i < 400 && !operation.liveInteraction; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    operation = service.getOperation(operationId);
                }
                assertEquals(operation.liveInteraction?.request.type, "select");
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const result = await Promise.race([
                        service.close().then(() => "closed"),
                        new Promise<string>((resolve) => {
                            timer = setTimeout(() => resolve("stuck"), 1000);
                        }),
                    ]);
                    assertEquals(result, "closed");
                } finally {
                    clearTimeout(timer);
                }
            } finally {
                if (service.getOperation(operationId)?.status === "running") {
                    await service.cancelOperation({ operationId });
                }
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace shutdown settles an accepted continuation before closing its store", async () => {
    await withRuntimeCommandFixture(
        "workspace-shutdown-continuation-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let releaseTurn = () => {};
            const held = new Promise<void>((resolve) => {
                releaseTurn = resolve;
            });
            try {
                setModelResponseFactory(async (context) => {
                    await held;
                    return fixture.recordedModelResponse("Turn settled before shutdown.")(context);
                });
                const started = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: 0,
                    requestId: "shutdown-during-turn",
                    text: "Continue before shutdown.",
                });
                const closing = service.close();
                releaseTurn();
                await closing;
                assertEquals(service.store.getOperationReceipt(started.operationId)?.status, "completed");
            } finally {
                releaseTurn();
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});
