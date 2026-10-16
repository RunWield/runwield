import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../shared/session/hosted-session.js";
import { runIsolatedAgentSession } from "../shared/session/session.js";
import { createDelegateAgentTool } from "./delegate-agent.ts";

test("background delegates share shell slots and synchronous reader leases and release them on cancellation", async () => {
    await withRuntimeCommandFixture(
        "background-delegate-slots-",
        async ({ projectRoot, setModelResponseFactories }) => {
            let release = () => {};
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            setModelResponseFactories(Array.from({ length: 3 }, () => async () => {
                await gate;
                return fauxAssistantMessage(fauxText("reader done"));
            }));
            const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
            const synchronous = session.acquireDelegatedAgentLease("read");
            const tool = createDelegateAgentTool({
                hostedSession: session,
                cwd: projectRoot,
                parentTools: ["read"],
                runIsolatedAgentSession,
            });
            const start = async () => {
                const response = await tool.execute(
                    "delegate",
                    { mode: "read", background: true, brief: "Inspect." },
                    new AbortController().signal,
                    () => {},
                    {} as Parameters<typeof tool.execute>[4],
                );
                return response.details;
            };
            try {
                const shells = Array.from(
                    { length: 3 },
                    () => session.backgroundTasks.startShell({ command: "sleep 20", cwd: projectRoot }),
                );
                const first = await start();
                const second = await start();
                assert(first?.task_id && second?.task_id);
                assertEquals(session.backgroundTasks.activeCount, 5);
                assertEquals(session.getDelegatedAgentLeaseState().readers, 3);
                const full = await start();
                assertEquals(full?.ok, false);
                assertStringIncludes(full?.error || "", "maximum is 5");
                await session.backgroundTasks.cancel(shells[0].task_id);
                const readerFull = await start();
                assertEquals(readerFull?.ok, false);
                assertStringIncludes(readerFull?.error || "", "maximum is 3");
                await session.backgroundTasks.cancel(first.task_id);
                release();
                assertEquals((await session.backgroundTasks.wait(second.task_id)).state, "completed");
                assertEquals(session.getDelegatedAgentLeaseState().readers, 1);
            } finally {
                release();
                synchronous();
                await session.dispose();
            }
        },
    );
});
