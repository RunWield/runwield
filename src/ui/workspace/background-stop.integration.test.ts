import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

test("Workspace releases an idle retained owner after Stop cancels its task", async () => {
    await withRuntimeCommandFixture(
        "workspace-stop-owner-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            try {
                setModelResponseFactories([
                    () =>
                        fauxAssistantMessage(fauxToolCall("background_task", {
                            action: "start",
                            command: "sleep 5; printf late",
                        })),
                    () => fauxAssistantMessage(fauxText("Parent finished.")),
                ]);
                const started = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: 0,
                    requestId: "stop-retained-owner",
                    text: "Start a delayed task.",
                });
                let operation = service.getOperation(started.operationId);
                for (let i = 0; i < 400 && operation.status === "running"; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    operation = service.getOperation(started.operationId);
                }
                assertEquals(operation.status, "completed");
                const owner = service.runtime.listSessions().find((entry) =>
                    entry.managed?.runwieldSessionId === fixture.session.runwieldSessionId
                );
                assert(owner);
                assertEquals(service.runtime.getSessionBackgroundTaskState(owner.id)?.active, 1);
                service.runtime.cancelSession(owner.id);
                for (let i = 0; i < 400 && service.runtime.getSessionSnapshot(owner.id); i++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assertEquals(service.runtime.getSessionSnapshot(owner.id), null);
            } finally {
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});
