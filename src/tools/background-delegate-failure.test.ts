import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../shared/session/hosted-session.js";
import { runIsolatedAgentSession } from "../shared/session/session.js";
import { createDelegateAgentTool } from "./delegate-agent.ts";

test("a failed background model turn reports failure and releases its reader lease", async () => {
    await withRuntimeCommandFixture(
        "background-delegate-failure-",
        async ({ projectRoot, setModelResponseFactories }) => {
            setModelResponseFactories([() => {
                throw Error("model failed");
            }]);
            const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
            const tool = createDelegateAgentTool({
                hostedSession: session,
                cwd: projectRoot,
                parentTools: ["read"],
                runIsolatedAgentSession,
            });
            try {
                const response = await tool.execute(
                    "delegate",
                    { mode: "read", background: true, brief: "Inspect." },
                    new AbortController().signal,
                    () => {},
                    {} as Parameters<typeof tool.execute>[4],
                );
                const id = response.details?.task_id;
                assert(id);
                const result = await session.backgroundTasks.wait(id);
                assertEquals(result.state, "failed");
                assertStringIncludes(result.error || "", "model failed");
                assertEquals(session.backgroundTasks.activeCount, 0);
                assertEquals(session.getDelegatedAgentLeaseState().readers, 0);
            } finally {
                await session.dispose();
            }
        },
    );
});
