import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";

test("a Session with no prior review reports no reference", async () => {
    await withRuntimeCommandFixture("reopen-empty-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        try {
            const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "planner" });
            assertEquals((await runtime.reopenPlanReview(sessionId)).kind, "no_reference");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
