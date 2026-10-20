import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

test("Workspace releases an idle retained owner after Stop cancels its task", async () => {
    await withRuntimeCommandFixture(
        "workspace-stop-owner-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            console.error("[DEBUG-stop-ci] fixture");
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            try {
                const source = join(projectRoot, "background-until-stop.mjs");
                await writeFile(source, "setInterval(() => {}, 1000);\n");
                console.error("[DEBUG-stop-ci] compiling");
                const executable = await writeRuntimeExecutableFixture(
                    join(projectRoot, "background-until-stop"),
                    source,
                );
                const command = platform === "win32" ? `"${executable}"` : `'${executable.replaceAll("'", "'\"'\"'")}'`;
                setModelResponseFactories([
                    () =>
                        fauxAssistantMessage(
                            fauxToolCall("background_task", {
                                action: "start",
                                command,
                            }),
                        ),
                    () => fauxAssistantMessage(fauxText("Parent finished.")),
                ]);
                console.error("[DEBUG-stop-ci] starting turn");
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
                console.error("[DEBUG-stop-ci] turn settled", operation.status);
                assertEquals(operation.status, "completed");
                const owner = service.runtime
                    .listSessions()
                    .find((entry) => entry.managed?.runwieldSessionId === fixture.session.runwieldSessionId);
                assert(owner);
                assertEquals(service.runtime.getSessionBackgroundTaskState(owner.id)?.active, 1);
                console.error("[DEBUG-stop-ci] cancelling");
                service.runtime.cancelSession(owner.id);
                for (let i = 0; i < 400 && service.runtime.getSessionSnapshot(owner.id); i++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                console.error("[DEBUG-stop-ci] stopped");
                assertEquals(service.runtime.getSessionSnapshot(owner.id), null);
            } finally {
                console.error("[DEBUG-stop-ci] closing service");
                await service.close();
                console.error("[DEBUG-stop-ci] service closed");
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});
