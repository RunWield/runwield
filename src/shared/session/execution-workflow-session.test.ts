import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "./hosted-session.js";
import { restoreExecutionWorkflow } from "./execution-workflow-recovery.ts";
import { recordExecutionWorkflowSnapshot } from "./execution-workflow-session.ts";
import type { ActiveExecutionWorkflow } from "../types.js";

type SnapshotCase = "active" | "paused" | "stopped" | "cleared";
for (const state of ["active", "paused", "stopped", "cleared"] as SnapshotCase[]) {
    test(`execution snapshot restores ${state} state after branch compaction`, async () => {
        await withRuntimeCommandFixture("workflow-snapshot-", async ({ projectRoot }) => {
            const manager = SessionManager.inMemory(projectRoot);
            const session = new HostedSession({ cwd: projectRoot, sessionManager: manager });
            const workflow: ActiveExecutionWorkflow = {
                planName: "snapshot-plan",
                executionAgent: "engineer",
                triageMeta: { classification: "PLANNED_CHANGE" },
                executionStarted: true,
                projectRoot,
                executionCwd: projectRoot,
                ...(state === "paused" ? { pairPauseReason: "canceled" } : {}),
                ...(state === "stopped" ? { pairPauseReason: "stop", pairStopRequested: true } : {}),
            };
            session.setActiveExecutionWorkflow(workflow);
            if (state === "cleared") session.clearActiveExecutionWorkflow();
            const resumed = new HostedSession({ cwd: projectRoot, sessionManager: manager });
            await restoreExecutionWorkflow(resumed);
            assertEquals(resumed.getActiveExecutionWorkflow(), state === "cleared" ? null : workflow);
            // The snapshot hook writes the current state into a new compacted branch.
            const compacted = SessionManager.inMemory(projectRoot);
            session.setRootSessionManager(compacted);
            recordExecutionWorkflowSnapshot(session);
            const restored = new HostedSession({ cwd: projectRoot, sessionManager: compacted });
            await restoreExecutionWorkflow(restored);
            assertEquals(restored.getActiveExecutionWorkflow(), state === "cleared" ? null : workflow);
            const size = compacted.getEntries().length;
            await restoreExecutionWorkflow(restored);
            assertEquals(compacted.getEntries().length, size);
        });
    });
}
