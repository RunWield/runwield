import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadPlan, savePlan } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";

Deno.test("load-plan offers code review again after closing, including in a fresh Session", async () => {
    await withRuntimeCommandFixture("code-review-close-", async ({ projectRoot, setModelResponseFactory }) => {
        setModelResponseFactory(() => {
            throw new Error("Closing or reopening review must not run an Agent turn");
        });
        await savePlan(projectRoot, "review-later", "# Review later\n", {
            classification: "PLANNED_CHANGE",
            status: "reviewed",
            executionMode: "non_git_in_place",
            humanReviewMode: "ask",
            humanReviewDecision: null,
            affectedPaths: [],
        });
        const implementationPath = join(projectRoot, "implementation.txt");
        await Deno.writeTextFile(implementationPath, "ready for review\n");
        const offers: string[] = [];
        let reviews = 0;
        for (const choice of ["close", "close", "open"]) {
            const runtime = createSessionRuntime();
            const messages: string[] = [];
            try {
                const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
                runtime.setInteractionAdapter(sessionId, {
                    requestInteraction(request) {
                        if (request.type === "code_review") {
                            reviews++;
                            return { outcome: "canceled" };
                        }
                        assertEquals(request.type, "select");
                        if (request.prompt.includes("code review before merge")) {
                            assertEquals(request.options?.map((option) => option.value), ["open", "skip", "close"]);
                            offers.push(request.prompt);
                            return { outcome: "selected", value: choice };
                        }
                        assertStringIncludes(request.prompt, "Pick Retry to open it again");
                        return { outcome: "selected", value: "stop" };
                    },
                });
                runtime.subscribeSessionEvents(sessionId, (event) => {
                    if ("message" in event && typeof event.message === "string") messages.push(event.message);
                });
                await runLoadPlanCommand([join(projectRoot, "docs/plans/review-later.md")], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: {
                        abortActivePrompt: () => {},
                        appendSystemMessage: (message) => messages.push(message),
                        appendAgentMessageStart: () => ({ appendText: () => {} }),
                        requestRender: () => {},
                        promptSelect: (prompt) => {
                            assertStringIncludes(prompt, "Plan recovery (reviewed)");
                            return Promise.resolve("validate");
                        },
                        promptText: () => Promise.resolve(null),
                        showModelSelector: () => {},
                    },
                    editor: {
                        disableSubmit: true,
                        setText: () => {},
                        setAutocompleteProvider: () => {},
                        handleInput: () => {},
                    },
                });
                const plan = await loadPlan(projectRoot, "review-later");
                assertEquals(plan?.attrs.status, "reviewed", messages.join("\n"));
                assertEquals(plan?.attrs.humanReviewDecision, null);
                assertEquals(await Deno.readTextFile(implementationPath), "ready for review\n");
                if (choice === "close") {
                    assertEquals(reviews, 0);
                    assertStringIncludes(messages.join("\n"), "/load-plan review-later");
                }
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        }
        assertEquals(offers.length, 3);
        assertEquals(new Set(offers).size, 1);
        assertEquals(reviews, 1);
    });
});
