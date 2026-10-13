import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../shared/session/hosted-session.js";
import { runIsolatedAgentSession } from "../shared/session/session.js";
import { createDelegateAgentTool } from "./delegate-agent.ts";
import { createTaskCompletedTool } from "./task-completed.ts";

test("completion settles a read-only delegate and releases its reader capacity", async () => {
    await withRuntimeCommandFixture("delegate-completion-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("A read-only handoff. " + "x".repeat(20_001));
        const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
        try {
            const delegate = createDelegateAgentTool({
                hostedSession: session,
                cwd: projectRoot,
                parentTools: ["read", "bash", "delegate_agent", "background_task"],
                runIsolatedAgentSession,
            });
            const launched = await delegate.execute(
                "delegate",
                {
                    mode: "read",
                    background: true,
                    brief: "Inspect briefly.",
                },
                new AbortController().signal,
                () => {},
                {} as Parameters<typeof delegate.execute>[4],
            );
            const taskId = launched.details?.task_id;
            assert(taskId);
            assertEquals(session.getDelegatedAgentLeaseState().readers, 1);
            const completion = createTaskCompletedTool({ hostedSession: session, agentName: "engineer" });
            // @ts-expect-error Direct tool execution does not use the extension context.
            const warning = await completion.execute("first", { message: "- Done." });
            assertEquals(warning.details.outcome, "rejected");
            assertStringIncludes(warning.content[0].type === "text" ? warning.content[0].text : "", taskId);
            // @ts-expect-error Direct tool execution does not use the extension context.
            const accepted = await completion.execute("retry", { message: "- Done." });
            assertEquals(accepted.details.outcome, "task_completed");
            assertEquals(session.backgroundTasks.activeCount, 0);
            assertEquals(session.getDelegatedAgentLeaseState().readers, 0);
            assertEquals(session.backgroundTasks.pendingCompletions(), []);
        } finally {
            await session.dispose();
        }
    });
});
