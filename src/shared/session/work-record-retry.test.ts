import { assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { listWorkRecords } from "../work-records/index.ts";
import { createSessionRuntime } from "./session-runtime.ts";

Deno.test("record retry belongs to the active Session and cancellation preserves delivered code", async () => {
    await withRuntimeCommandFixture("record-retry-cancel-", async ({ projectRoot, setModelResponseFactory }) => {
        await savePlan(projectRoot, "delivered", "# Delivered", {
            planId: "delivered",
            classification: "PLANNED_CHANGE",
            status: "verified",
        });
        let release = () => {};
        let entered = () => {};
        const started = new Promise<void>((resolve) => entered = resolve);
        const held = new Promise<void>((resolve) => release = resolve);
        setModelResponseFactory(async () => {
            entered();
            await held;
            return fauxAssistantMessage(
                fauxToolCall("work_record_completed", {
                    title: "Too late",
                    summary: "Canceled work must not write this.",
                }),
            );
        });
        const runtime = createSessionRuntime({ ownerProcessKind: "test" });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const retry = runtime.retryWorkRecord(sessionId, "delivered");
            await started;
            assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, true);
            assertEquals(runtime.cancelSession(sessionId).aborted, true);
            release();
            const result = await retry;
            assertEquals(result.status, "failed");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, false);
            assertEquals((await loadPlan(projectRoot, "delivered"))?.attrs.status, "verified");
            assertEquals((await listWorkRecords(projectRoot)).length, 0);
        } finally {
            release();
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
