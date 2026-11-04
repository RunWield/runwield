import { test } from "node:test";
import { fauxAssistantMessage, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { setCompactionKeepRecentTokens } from "../../shared/settings.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import type { CommandContext } from "../registry.js";
import { runCompactCommand } from "./index.ts";

type NotifyRunWieldEvent = NonNullable<CommandContext["notifyRunWieldEvent"]>;
interface Notification {
    event: Parameters<NotifyRunWieldEvent>[0];
    options: Parameters<NotifyRunWieldEvent>[1];
}

for (const outcome of ["success", "failure", "canceled"] as const) {
    test(`compact command reports ${outcome} from a real Session and restores usable context`, async () => {
        await withRuntimeCommandFixture(
            `compact-command-${outcome}-`,
            async ({ projectRoot, setModelResponseFactory, setModelResponseFactories }) => {
                await setCompactionKeepRecentTokens(1);
                const runtime = createSessionRuntime();
                const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
                const messages: string[] = [];
                const notifications: Notification[] = [];
                try {
                    setModelResponseFactory(() =>
                        fauxAssistantMessage(fauxText("Keep this original decision. ".repeat(3500))),
                    );
                    assertEquals(
                        (await runtime.promptUserTurn(sessionId, { initialRequest: "Record the decision." })).ok,
                        true,
                    );
                    setModelResponseFactory(() => fauxAssistantMessage(fauxText("Keep this recent decision.")));
                    assertEquals(
                        (await runtime.promptUserTurn(sessionId, { initialRequest: "Record another decision." })).ok,
                        true,
                    );
                    await runtime.renameSession(sessionId, "Compact Session");
                    let modelRequest = "";
                    const compactionResponse: FauxResponseFactory = (context) => {
                        modelRequest += JSON.stringify(context.messages);
                        if (outcome === "canceled") runtime.cancelSession(sessionId);
                        return outcome === "failure"
                            ? fauxAssistantMessage(fauxText(""), {
                                  stopReason: "error",
                                  errorMessage: "model unavailable",
                              })
                            : fauxAssistantMessage(fauxText("Summary retains the original decision."));
                    };
                    setModelResponseFactories([compactionResponse, compactionResponse]);
                    const result = await runCompactCommand(["keep", "decisions"], {
                        sessionId,
                        sessionRuntime: runtime,
                        uiAPI: {
                            appendSystemMessage: (message) => {
                                messages.push(message);
                            },
                            appendAgentMessageStart: () => ({ appendText: () => {} }),
                            requestRender: () => {},
                            promptSelect: () => Promise.resolve(null),
                            promptText: () => Promise.resolve(null),
                            showModelSelector: () => {},
                            abortActivePrompt: () => {},
                        },
                        notifyRunWieldEvent: (event, options) => {
                            notifications.push({ event, options });
                        },
                    });
                    assertEquals(
                        result,
                        outcome === "success" ? "succeeded" : outcome === "canceled" ? "canceled" : "failed",
                        messages.join("\n"),
                    );
                    assertStringIncludes(modelRequest, "keep decisions");
                    assertStringIncludes(
                        messages.join("\n"),
                        outcome === "success"
                            ? "Session compacted."
                            : outcome === "canceled"
                              ? "Compaction cancelled."
                              : "Compaction failed:",
                    );
                    if (outcome === "success")
                        assertStringIncludes(messages.join("\n"), "Summary retains the original decision.");
                    assertEquals(notifications, [
                        { event: "compactionFinished", options: { sessionName: "Compact Session" } },
                    ]);
                    setModelResponseFactory((context) => {
                        const input = JSON.stringify(context.messages);
                        assertStringIncludes(
                            input,
                            outcome === "success"
                                ? "Summary retains the original decision."
                                : "Keep this original decision.",
                        );
                        return fauxAssistantMessage(fauxText("Ready to continue."));
                    });
                    assertEquals(
                        (
                            await runtime.promptUserTurn(sessionId, {
                                initialRequest: "Continue from the saved decisions.",
                            })
                        ).ok,
                        true,
                    );
                } finally {
                    await runtime.closeAllSessionsWhenIdle();
                }
            },
        );
    });
}
