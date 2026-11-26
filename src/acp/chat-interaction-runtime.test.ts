import { seedPlan } from "../shared/testing/plan-state-fixture.ts";

import { test } from "node:test";
import { assertEquals } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { InteractiveSessionRuntime } from "@runwield/session-runtime/services";
import { SessionHost } from "@runwield/session-runtime/host";
import { openFileSessionStore } from "../shared/session/file-session-store.ts";
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from "@runwield/session-runtime/interactions";

for (const type of ["select", "text", "approval", "plan_review"] as const) {
    test(`ACP broker answers only active chat interaction types: ${type}`, async () => {
        await withRuntimeCommandFixture("acp-chat-broker-", async ({ projectRoot }) => {
            const sessionHost = new SessionHost();
            const runtime = new InteractiveSessionRuntime({
                sessionHost,
                sessionStore: openFileSessionStore(),
                ownsSessionStore: true,
                ownerProcessKind: "workspace",
                ownerInstanceId: crypto.randomUUID(),
            });
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot });
                const planId = crypto.randomUUID();
                if (type === "plan_review")
                    await seedPlan(projectRoot, "review-chat-boundary", "# Review", {
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
                    const session = sessionHost.requireSession(sessionId);
                    session.notificationSurface = "tui";
                    const source = type === "text" ? undefined : "acp";
                    const reply: RuntimeInteractionResponse =
                        type === "text"
                            ? { outcome: "text", value: "yes" }
                            : type === "approval"
                              ? { outcome: "accepted", value: true }
                              : { outcome: "selected", value: "yes" };
                    assertEquals(
                        runtime.answerInteraction(sessionId, "chat-question", reply, source),
                        type !== "plan_review",
                    );
                    assertEquals(
                        session.notificationSurface,
                        type === "plan_review" ? "tui" : (source ?? "tui"),
                    );
                    if (type === "plan_review") controller.abort();
                    assertEquals((await pending).outcome, type === "plan_review" ? "canceled" : reply.outcome);
                    assertEquals(runtime.answerInteraction(sessionId, "chat-question", reply, "acp"), false);
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
