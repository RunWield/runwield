import { holdPlanFixtureCatalogLock } from "../../shared/testing/plan-state-fixture.ts";
import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../../shared/testing/retained-plan-fixture.ts";
import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";

import { archiveSavedPlan } from "../../plan-store/index.ts";
import { loadArchivedPlan, loadPlan } from "../../shared/testing/plan-query-fixture.ts";

import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";
import type { UiAPI } from "../../ui/tui/api.ts";
import { createTestWorktreeAttempt, git } from "../../shared/worktree-test-helpers.ts";
import { updateEntry } from "../../shared/worktree-registry.ts";
import { ok, rejects } from "node:assert/strict";

import { archiveEpicWithChildren } from "./plan-epic-archive.ts";

test("Epic archive uses the child document in its planning worktree", async () => {
    await withRuntimeCommandFixture("archive-epic-child-authority-", async ({ projectRoot, homeDir }) => {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "tests@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
        return await withRetainedPlanFixture(projectRoot, async () => {
            await seedPlan(projectRoot, "epic", "# Epic", { classification: "PROJECT", status: "verified" });
            await seedPlan(projectRoot, "epic/repair", "# Catalog copy", {
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
            await seedPlan(
                entry.path,
                "epic/repair",
                "# Current repair notes",
                { ...child.attrs, order: 14 },
                {
                    expectedRevision: child.revision,
                },
            );
            const completed = Promise.withResolvers<string>();
            const messages: string[] = [];
            const uiAPI: UiAPI = {
                abortActivePrompt: () => {},
                appendSystemMessage: (message) => {
                    messages.push(message);
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
            ok(
                await archiveEpicWithChildren({ projectRoot, plan: { planName: "epic", attrs: epic.attrs }, uiAPI }),
                messages.join("\n"),
            );
            const timeout = AbortSignal.timeout(30000);
            const message = await Promise.race([
                completed.promise,
                new Promise<string>((_, reject) =>
                    timeout.addEventListener(
                        "abort",
                        () => reject(new Error(`Archive did not finish: ${messages.join("\n")}`)),
                        { once: true },
                    ),
                ),
            ]);
            assertEquals(message.startsWith("Archived Epic"), true, message);
            const archivedChild = await loadArchivedPlan(entry.path, "epic/repair");
            assertEquals(archivedChild?.body, "# Current repair notes");
            assertEquals(archivedChild?.attrs.order, 14);
            assertEquals(await loadPlan(entry.path, "epic/repair"), null);
            assertEquals((await loadArchivedPlan(projectRoot, "epic"))?.body, "# Epic");
        });
    });
});

test("stale archive metadata blocks without claiming an interrupted Plan update", async () => {
    await withRuntimeCommandFixture("archive-stale-metadata-", async ({ projectRoot }) => {
        await seedPlan(projectRoot, "finished", "# Finished", { status: "verified" });
        await rejects(
            archiveSavedPlan(projectRoot, "finished", { expectedRevision: "unread-revision" }),
            (error: Error) => {
                assertEquals(error.message.includes("changed after this operation read it"), true);
                assertEquals(error.message.includes("Reload the Plan and retry"), true);
                assertEquals(error.message.includes("previous Plan update"), false);
                assertEquals(error.message.includes("plans doctor"), false);
                return true;
            },
        );
        assertEquals((await loadPlan(projectRoot, "finished"))?.body, "# Finished");
        assertEquals(await loadArchivedPlan(projectRoot, "finished"), null);
    });
});

for (const epic of [false, true]) {
    test(`load-plan reopens its picker while ${epic ? "Epic" : "Plan"} archive waits for storage`, async () => {
        await withRuntimeCommandFixture("archive-background-", async ({ projectRoot }) => {
            await withRetainedPlanFixture(projectRoot, async () => {
                await seedPlan(projectRoot, "finished", "# Finished", {
                    status: "verified",
                    classification: epic ? "PROJECT" : "PLANNED_CHANGE",
                });
                await seedPlan(projectRoot, "next-plan", "# Next", { status: "draft" });
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
                        holding = holdPlanFixtureCatalogLock(projectRoot, async () => {
                            locked.resolve();
                            await release.promise;
                        });
                        await locked.promise;
                        return epic ? "archive_epic" : "archive";
                    },
                    promptText: () => Promise.resolve(null),
                    showModelSelector: () => {},
                };
                const running = runLoadPlanCommand(["finished"], { sessionRuntime: runtime, sessionId, uiAPI }).then(
                    () => {
                        returned = true;
                    },
                );
                try {
                    await Promise.race([
                        locked.promise,
                        running.then(() => {
                            throw new Error(`Archive menu did not acquire storage: ${messages.join("\n")}`);
                        }),
                    ]);
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
                    assertEquals(
                        (await loadArchivedPlan(projectRoot, "finished"))?.attrs.archivedFromStatus,
                        "verified",
                    );
                    runtime.closeAllSessions();
                }
            });
        });
    });
}

test("load-plan reports a background archive failure and keeps the active Plan", async () => {
    await withRuntimeCommandFixture("archive-background-failure-", async ({ projectRoot }) => {
        await withRetainedPlanFixture(projectRoot, async () => {
            await seedPlan(projectRoot, "finished", "# Finished", { status: "verified" });
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
                    await seedPlan(projectRoot, "archived/finished", "# Earlier archive", { status: "verified" });
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
});
