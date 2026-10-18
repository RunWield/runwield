import { savePlan } from "../plan-store.js";
import { test } from "node:test";
import { assertEquals } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../shared/session/session-runtime.ts";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "../shared/session/session-runtime-interactions.js";

for (const type of ["select", "text", "approval", "plan_review"] as const) {
    test(`ACP broker answers only active chat interaction types: ${type}`, async () => {
        await withRuntimeCommandFixture("acp-chat-broker-", async ({ projectRoot }) => {
            const runtime = createSessionRuntime();
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot });
                const planId = crypto.randomUUID();
                if (type === "plan_review")
                    await savePlan(projectRoot, "review-chat-boundary", "# Review", {
                        planId,
                        status: "draft",
                        classification: "PLANNED_CHANGE",
                    });
                const opened = Promise.withResolvers<void>();
                const controller = new AbortController();
                runtime.setInteractionAdapter(sessionId, {
                    requestInteraction: (_request, signal) =>
                        new Promise<RuntimeInteractionResponse>((resolve) => {
                            signal?.addEventListener("abort", () => resolve({ outcome: "canceled" }), { once: true });
                            opened.resolve();
                        }),
                });
                const request: RuntimeInteractionRequest = {
                    id: "chat-question",
                    type,
                    prompt: "Continue?",
                    options: [{ value: "yes", label: "Yes" }],
                    _meta:
                        type === "plan_review"
                            ? { planId, planName: "review-chat-boundary", planningAgentName: "planner" }
                            : undefined,
                };
                const pending = runtime.requestInteraction(sessionId, request, controller.signal);
                try {
                    await opened.promise;
                    assertEquals(
                        runtime.answerInteraction(sessionId, "missing", { outcome: "selected", value: "yes" }),
                        false,
                    );
                    const reply: RuntimeInteractionResponse =
                        type === "text"
                            ? { outcome: "text", value: "yes" }
                            : type === "approval"
                              ? { outcome: "accepted", value: true }
                              : { outcome: "selected", value: "yes" };
                    assertEquals(runtime.answerInteraction(sessionId, "chat-question", reply), type !== "plan_review");
                    if (type === "plan_review") controller.abort();
                    assertEquals((await pending).outcome, type === "plan_review" ? "canceled" : reply.outcome);
                    assertEquals(runtime.answerInteraction(sessionId, "chat-question", reply), false);
                } finally {
                    controller.abort();
                    await pending;
                }
            } finally {
                await runtime.closeAllSessions();
            }
        });
    });
}
