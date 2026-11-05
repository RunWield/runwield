import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { archivePlan, loadArchivedPlan, loadPlan, savePlan, withPlanCatalogLock } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";
import type { UiAPI } from "../../ui/tui/types.js";
import { createTestWorktreeAttempt, git } from "../../shared/worktree-test-helpers.ts";
import { updateEntry } from "../../shared/worktree-registry.js";
import { runArchiveTransition } from "../../shared/workflow/state-transition.ts";
import { transitionFailureError } from "./transition-failure.ts";
import { archiveEpicWithChildren } from "./plan-epic-archive.ts";

test("Epic archive uses the child document in its planning worktree", async () => {
    await withRuntimeCommandFixture("archive-epic-child-authority-", async ({ projectRoot, homeDir }) => {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "tests@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
        await savePlan(projectRoot, "epic", "# Epic", { classification: "PROJECT", status: "verified" });
        await savePlan(projectRoot, "epic/repair", "# Catalog copy", {
            classification: "PLANNED_CHANGE",
            parentPlan: "epic",
            status: "draft",
            planId: "repair-id",
        });
        await git(projectRoot, ["add", "docs"]);
        await git(projectRoot, ["commit", "-m", "fixture Plans"]);
        const entry = await createTestWorktreeAttempt({
            projectRoot,
            planName: "epic/repair",
            planId: "repair-id",
            worktreeRoot: `${homeDir}/worktrees`,
        });
        await updateEntry(projectRoot, entry.id, { status: "planning" });
        const child = await loadPlan(entry.path, "epic/repair");
        if (!child) throw new Error("Missing fixture child");
        await savePlan(
            entry.path,
            "epic/repair",
            "# Current repair notes",
            { ...child.attrs, order: 14 },
            {
                expectedRevision: child.revision,
            },
        );
        const completed = Promise.withResolvers<string>();
        const uiAPI: UiAPI = {
            abortActivePrompt: () => {},
            appendSystemMessage: (message) => {
                if (message.startsWith("Archived Epic") || message.startsWith("Archive failed"))
                    completed.resolve(message);
            },
            appendAgentMessageStart: () => ({ appendText: () => {} }),
            requestRender: () => {},
            promptSelect: () => Promise.resolve("confirm"),
            promptText: () => Promise.resolve(null),
            showModelSelector: () => {},
        };
        const epic = await loadPlan(projectRoot, "epic");
        if (!epic) throw new Error("Missing fixture Epic");
        await archiveEpicWithChildren({ projectRoot, plan: { planName: "epic", attrs: epic.attrs }, uiAPI });
        const message = await Promise.race([
            completed.promise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Archive did not finish")), 5000)),
        ]);
        assertEquals(message.startsWith("Archived Epic"), true, message);
        const archivedChild = await loadArchivedPlan(entry.path, "epic/repair");
        assertEquals(archivedChild?.body, "# Current repair notes");
        assertEquals(archivedChild?.attrs.order, 14);
        assertEquals(await loadPlan(entry.path, "epic/repair"), null);
        assertEquals((await loadArchivedPlan(projectRoot, "epic"))?.body, "# Epic");
    });
});

test("stale archive metadata blocks without claiming an interrupted Plan update", async () => {
    await withRuntimeCommandFixture("archive-stale-metadata-", async ({ projectRoot }) => {
        await savePlan(projectRoot, "finished", "# Finished", { status: "verified" });
        const transition = await runArchiveTransition({
            projectRoot,
            planName: "finished",
            action: "archive",
            expectedRevision: "unread-revision",
            move: () => archivePlan(projectRoot, "finished"),
        });
        assertEquals(transition.status, "blocked");
        const message = transitionFailureError(transition, "Archive failed").message;
        assertEquals(message.includes("changed after this operation read it"), true);
        assertEquals(message.includes("Reload the Plan and retry"), true);
        assertEquals(message.includes("previous Plan update"), false);
        assertEquals(message.includes("plans doctor"), false);
        assertEquals((await loadPlan(projectRoot, "finished"))?.body, "# Finished");
        assertEquals(await loadArchivedPlan(projectRoot, "finished"), null);
    });
});

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
