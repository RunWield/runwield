import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import { runPlanReviewCommand } from "./index.ts";

test("/plan-review reports the live URL published by the review surface without another presentation", async () => {
    await withRuntimeCommandFixture("plan-review-command-", async ({ homeDir, projectRoot }) => {
        const ownerStore = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: ownerStore, ownerProcessKind: "test" });
        const pending = Promise.withResolvers<{ outcome: "canceled" }>();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            let presentations = 0;
            let originalCallbackUrl = "";
            const presented = Promise.withResolvers<void>();
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction(request) {
                    presentations++;
                    const ready = request._meta?.onSurfaceReady;
                    if (typeof ready === "function") {
                        ready({ url: "http://127.0.0.1:4321/review?token=test", opened: true });
                    }
                    presented.resolve();
                    return pending.promise;
                },
            });
            const original = runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                _meta: {
                    planId: "plan-id",
                    planName: "target",
                    planningAgentName: "planner",
                    onSurfaceReady: (surface: { url: string }) => {
                        originalCallbackUrl = surface.url;
                    },
                },
            });
            await presented.promise;
            const messages: string[] = [];
            await runPlanReviewCommand([], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: {
                    appendSystemMessage: (message: string) => {
                        messages.push(message);
                    },
                    appendAgentMessageStart: () => ({ appendText: () => {} }),
                    requestRender: () => {},
                    promptSelect: () => Promise.resolve(null),
                    promptText: () => Promise.resolve(null),
                    showModelSelector: () => {},
                    abortActivePrompt: () => {},
                },
            });
            assertEquals(presentations, 1);
            assertEquals(originalCallbackUrl, "http://127.0.0.1:4321/review?token=test");
            assertStringIncludes(messages.join("\n"), "http://127.0.0.1:4321/review?token=test");
            pending.resolve({ outcome: "canceled" });
            await original;
        } finally {
            pending.resolve({ outcome: "canceled" });
            await runtime.closeAllSessionsWhenIdle();
            ownerStore.close();
        }
    });
});
