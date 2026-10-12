import { assert, assertEquals } from "@std/assert";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../session/session-runtime.ts";
import { setCustomSetting } from "../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "./metrics.js";
import { UsageReporter } from "./usage-reporting.ts";

Deno.test("a real managed text prompt records human activity independently of presentation events", async () => {
    await withRuntimeCommandFixture("usage-human-provenance-", async (fixture) => {
        fixture.setModelResponse("A fixture response.");
        await setCustomSetting("workflowMetrics", true, "project", fixture.projectRoot);
        const runtime = createSessionRuntime({ sessionStore: null, ownerProcessKind: "test" });
        try {
            const created = await runtime.createInteractiveSession({
                cwd: fixture.projectRoot,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            runtime.markPromptReadyAgent(created.sessionId, { agentName: "router" });
            const result = await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "A private user prompt.",
            });
            assertEquals(result.ok, true);
            await drainWorkflowMetrics();
            const contents = await Deno.readTextFile(getWorkflowMetricsFilePath(fixture.projectRoot));
            const rows = contents.trim().split("\n").map((line) => JSON.parse(line));
            assert(rows.some((row) => row.event === "execution_started" && row.userInitiated === true));
            assertEquals(contents.includes("private user prompt"), false);
            const now = Date.now();
            const period = {
                start: new Date(now - 86400000).toISOString().slice(0, 10),
                end: new Date(now + 2 * 86400000).toISOString().slice(0, 10),
            };
            assertEquals(new UsageReporter().query([fixture.projectRoot], period, "UTC").totals.activeDays, 1);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
