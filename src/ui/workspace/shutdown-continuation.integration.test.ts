import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

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
