import { rm } from "node:fs/promises";
import { makeTempDirectory } from "../../../../testing/temp-file.ts";
import { test } from "node:test";
import { assertEquals } from "../../../../testing/assertions.ts";
import { cleanupReviewAgentState, createReviewAgentState, reviewAgentApi } from "./review-agent-handlers.js";

test("Guide uses the current lazy review workspace on each invocation", async () => {
    const original = await makeTempDirectory();
    const worktree = await makeTempDirectory();
    const directories: string[] = [];
    const state = createReviewAgentState({
        cwd: original,
        token: "guide-cwd",
        reviewPayload: { agentCwd: original, rawPatch: "" },
        runGuideCommand: (_prompt, _signal, cwd) => {
            directories.push(cwd);
            return Promise.resolve({ stdout: "{}", provider: "fixture" });
        },
    });
    try {
        for (const agentCwd of [original, worktree, "", 42]) {
            state.reviewPayload.agentCwd = agentCwd;
            const url = new URL("http://localhost/api/agents/jobs");
            const response = await reviewAgentApi(
                new Request(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ provider: "guide" }),
                }),
                url,
                state,
            );
            if (!response) throw new Error("Expected launch response");
            const { job } = await response.json();
            await state.jobs.get(job.id)?.done;
            assertEquals(job.cwd, typeof agentCwd === "string" && agentCwd ? agentCwd : original);
        }
        assertEquals(directories, [original, worktree, original, original]);
    } finally {
        await cleanupReviewAgentState(state);
        await rm(original, { recursive: true });
        await rm(worktree, { recursive: true });
    }
});
