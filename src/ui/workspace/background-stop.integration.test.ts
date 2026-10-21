import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
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
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            try {
                const source = join(projectRoot, "background-until-stop.mjs");
                const watchdogPath = join(projectRoot, "background-watchdog-fired");
                // Bound failed cleanup without letting a natural exit satisfy Stop.
                await writeFile(
                    source,
                    `import { writeFileSync } from "node:fs";
setTimeout(() => { writeFileSync(${JSON.stringify(watchdogPath)}, "expired"); process.exit(1); }, 30_000);
setInterval(() => {}, 1000);
`,
                );
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
                const owner = service.runtime
                    .listSessions()
                    .find((entry) => entry.managed?.runwieldSessionId === fixture.session.runwieldSessionId);
                assert(owner);
                assertEquals(service.runtime.getSessionBackgroundTaskState(owner.id)?.active, 1);
                service.runtime.cancelSession(owner.id);
                for (let i = 0; i < 400 && service.runtime.getSessionSnapshot(owner.id); i++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assertEquals(service.runtime.getSessionSnapshot(owner.id), null);
                const watchdogFired = await readFile(watchdogPath).then(
                    () => true,
                    (error: NodeJS.ErrnoException) => {
                        if (error.code === "ENOENT") return false;
                        throw error;
                    },
                );
                assertEquals(watchdogFired, false, "Stop must cancel the task before its fixture watchdog exits");
            } finally {
                await service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});
