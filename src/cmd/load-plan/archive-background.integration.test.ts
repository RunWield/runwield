import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { loadArchivedPlan, loadPlan, savePlan, withPlanCatalogLock } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";
import type { UiAPI } from "../../ui/tui/types.js";

for (const epic of [false, true]) {
    test(`load-plan reopens its picker while ${epic ? "Epic" : "Plan"} archive waits for storage`, async () => {
        await withRuntimeCommandFixture("archive-background-", async ({ projectRoot }) => {
            await savePlan(projectRoot, "finished", "# Finished", {
                status: "verified",
                classification: epic ? "PROJECT" : "PLANNED_CHANGE",
            });
            await savePlan(projectRoot, "next-plan", "# Next", { status: "draft" });
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
            const release = Promise.withResolvers<void>();
            const locked = Promise.withResolvers<void>();
            const completed = Promise.withResolvers<void>();
            let holding: Promise<void> | undefined;
            let returned = false;
            const messages: string[] = [];
            let pickerOpened = false;
            const uiAPI: UiAPI = {
                abortActivePrompt: () => {},
                appendSystemMessage: (message) => {
                    messages.push(message);
                    if (message.startsWith("Archived")) completed.resolve();
                },
                appendAgentMessageStart: () => ({ appendText: () => {} }),
                requestRender: () => {},
                promptSelect: async (title, choices) => {
                    if (title === "Load plan:") {
                        pickerOpened = true;
                        assertEquals(
                            choices.map((choice) => choice.value),
                            ["next-plan"],
                        );
                        return null;
                    }
                    if (title.startsWith("Archive this Epic")) return "confirm";
                    if (holding) return epic ? "archive_epic" : "archive";
                    holding = withPlanCatalogLock(projectRoot, async () => {
                        locked.resolve();
                        await release.promise;
                    });
                    await locked.promise;
                    return epic ? "archive_epic" : "archive";
                },
                promptText: () => Promise.resolve(null),
                showModelSelector: () => {},
            };
            const running = runLoadPlanCommand(["finished"], { sessionRuntime: runtime, sessionId, uiAPI }).then(() => {
                returned = true;
            });
            try {
                await locked.promise;
                await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 500))]);
                assertEquals(returned, true, "Archive must not hold the menu while storage is locked");
                assertEquals(pickerOpened, true, "Archive must reopen Load Plan while storage is locked");
                await runLoadPlanCommand(["finished"], { sessionRuntime: runtime, sessionId, uiAPI });
                assertEquals(
                    messages.some((message) => message.startsWith("Archive is already running")),
                    true,
                );
                assertEquals(
                    messages.some((message) => message.startsWith("Archived")),
                    false,
                );
            } finally {
                release.resolve();
                await holding;
                await running;
                await Promise.race([
                    completed.promise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Archive did not finish")), 5000)),
                ]);
                assertEquals((await loadArchivedPlan(projectRoot, "finished"))?.attrs.archivedFromStatus, "verified");
                runtime.closeAllSessions();
            }
        });
    });
}

test("load-plan reports a background archive failure and keeps the active Plan", async () => {
    await withRuntimeCommandFixture("archive-background-failure-", async ({ projectRoot }) => {
        await savePlan(projectRoot, "finished", "# Finished", { status: "verified" });
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
        const failed = Promise.withResolvers<string>();
        const messages: string[] = [];
        const uiAPI: UiAPI = {
            abortActivePrompt: () => {},
            appendSystemMessage: (message) => {
                messages.push(message);
                if (message.startsWith("Archive failed for")) failed.resolve(message);
            },
            appendAgentMessageStart: () => ({ appendText: () => {} }),
            requestRender: () => {},
            promptSelect: async (title) => {
                if (title === "Load plan:") return null;
                await savePlan(projectRoot, "archived/finished", "# Earlier archive", { status: "verified" });
                return "archive";
            },
            promptText: () => Promise.resolve(null),
            showModelSelector: () => {},
        };
        try {
            await runLoadPlanCommand(["finished"], { sessionRuntime: runtime, sessionId, uiAPI });
            const message = await Promise.race([
                failed.promise,
                new Promise<string>((_, reject) =>
                    setTimeout(() => reject(new Error("No archive failure report")), 5000),
                ),
            ]);
            assertEquals(message.includes("Archived Plan already exists"), true);
            assertEquals((await loadPlan(projectRoot, "finished"))?.attrs.status, "verified");
            assertEquals(
                messages.some((entry) => entry.startsWith("Archived")),
                false,
            );
        } finally {
            runtime.closeAllSessions();
        }
    });
});
