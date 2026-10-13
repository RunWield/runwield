import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../shared/session/hosted-session.js";
import { runIsolatedAgentSession } from "../shared/session/session.js";
import { createDelegateAgentTool } from "./delegate-agent.ts";

test("background read delegation returns before an isolated child model turn settles", async () => {
    await withRuntimeCommandFixture("background-delegate-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("A read-only handoff. " + "x".repeat(20_001));
        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
        const tool = createDelegateAgentTool({
            hostedSession,
            cwd: projectRoot,
            parentTools: ["read", "bash", "delegate_agent", "background_task"],
            runIsolatedAgentSession,
        });
        try {
            const result = await tool.execute(
                "background-delegate",
                {
                    mode: "read",
                    background: true,
                    brief: "Return a short handoff.",
                },
                new AbortController().signal,
                () => {},
                {} as Parameters<typeof tool.execute>[4],
            );
            assertEquals(result.details?.ok, true);
            const taskId = result.details?.task_id;
            assert(taskId);
            assertEquals(hostedSession.backgroundTasks.status(taskId).state, "running");
            assertEquals(hostedSession.getDelegatedAgentLeaseState().readers, 1);
            assertEquals(hostedSession.getActiveSteeringTargetSession(), null);
            hostedSession.dehydrateManagedSession();
            assertEquals(hostedSession.getDelegatedAgentLeaseState().readers, 1);
            const settled = await hostedSession.backgroundTasks.wait(taskId);
            assertEquals(settled.state, "completed", JSON.stringify(settled));
            assertEquals(settled.output, undefined);
            assertStringIncludes(await fsReadFile(settled.log_path, "utf8"), "x".repeat(20_001));
            assertEquals(hostedSession.getDelegatedAgentLeaseState().readers, 0);
        } finally {
            await hostedSession.dispose();
        }
    });
});
