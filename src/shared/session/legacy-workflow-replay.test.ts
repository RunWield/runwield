import { assertEquals, assertExists } from "@std/assert";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";
import { tuiSessionSidebarProjection } from "../../ui/tui/session-sidebar.ts";

for (const planState of ["verified", "implemented", "missing", "different-id"] as const) {
    Deno.test(`legacy sidebar reconciles completion only from the same Plan: ${planState}`, async () => {
        await withRuntimeCommandFixture("legacy-sidebar-", async ({ homeDir, projectRoot }) => {
            const fixture = await makeManagedSessionFixture({
                home: homeDir,
                projectRoot,
                assistantMessages: ["Saved legacy reply."],
                workflowContext: {
                    planId: "sample-id",
                    planName: "sample",
                    status: "ready_for_work",
                    routingIntent: "PLANNED_CHANGE",
                    complexity: "MEDIUM",
                },
            });
            const handle = fixture.openRuntime("tui", "legacy-reader");
            try {
                if (planState !== "missing") {
                    await savePlan(projectRoot, "sample", "# Sample\n", {
                        planId: planState === "different-id" ? "other-id" : "sample-id",
                        classification: "PLANNED_CHANGE",
                        status: planState === "different-id" ? "verified" : planState,
                    });
                }
                const before = await readTranscriptEvidence(fixture.transcriptPath);
                const synced = await handle.runtime.synchronizeManagedSession(handle.adoptedSessionId, {
                    replayFromStart: true,
                });
                assertEquals(synced.ok, true);
                // TUI startup refreshes project context through a metadata-only activation.
                await handle.runtime.setProjectStateContext(handle.adoptedSessionId, "");
                const snapshot = handle.runtime.getSessionSnapshot(handle.adoptedSessionId);
                assertEquals(
                    snapshot?.workflowContext?.status,
                    planState === "verified" ? "verified" : "ready_for_work",
                );
                assertExists(snapshot);
                const sidebar = tuiSessionSidebarProjection(snapshot).workflow;
                assertEquals(
                    sidebar?.stages.find((stage) => stage.id === "completion")?.state,
                    planState === "verified" ? "completed" : "upcoming",
                );
                assertEquals(await readTranscriptEvidence(fixture.transcriptPath), before);
                if (planState === "verified") {
                    const currentPlan = await loadPlan(projectRoot, "sample");
                    assertExists(currentPlan);
                    await savePlan(projectRoot, "sample", "# Sample reopened\n", {
                        planId: "sample-id",
                        classification: "PLANNED_CHANGE",
                        status: "implemented",
                    }, { expectedRevision: currentPlan.revision });
                    await handle.runtime.synchronizeManagedSession(handle.adoptedSessionId, { replayFromStart: true });
                    assertEquals(
                        handle.runtime.getSessionSnapshot(handle.adoptedSessionId)?.workflowContext?.status,
                        "ready_for_work",
                    );
                    assertEquals(await readTranscriptEvidence(fixture.transcriptPath), before);
                }
            } finally {
                await handle.close();
                await fixture.cleanup();
            }
        });
    });
}
